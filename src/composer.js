'use strict';

const { FrameClock } = require('./frame-clock');

/**
 * 内置转场类型。blends=true 表示转场窗口内两路画面会混合，
 * 因此要求相邻镜头的相机控制兼容；blends=false（cut / 黑场 fade）
 * 在任一帧都只有单一相机持有者，天然安全。
 */
const KNOWN_TRANSITIONS = {
  cut: { blends: false },
  fade: { blends: false },
  dissolve: { blends: true },
  wipe: { blends: true },
};

function camerasCompatible(a, b) {
  if (!a || !b) return true; // 未声明相机轨道的镜头不参与兼容性约束
  if (a.control === b.control) return true;
  const list = a.compatibleWith || [];
  return list.includes(b.control);
}

/**
 * 编排入口。
 *
 * input = {
 *   fps: number | [{ fps, from }],
 *   cameras: { [id]: { control, compatibleWith? } },
 *   shots: [{ id, start, end, camera?, priority? }],
 *   transitions: [{ from, to, type, duration }],   // from/to 为相邻镜头 id
 *   cues: [{ id, kind: 'dialogue'|'subtitle', start, end, text?, ... }],
 *   audio: [{ id, track?, kind: 'oneshot'|'sustained', start, end? }],
 *   allowedTransitions: string[]                   // 缺省允许全部内置类型
 * }
 *
 * 返回帧对齐时间线；所有无法调和的输入都降级处理并记入 diagnostics，
 * 不会抛出（只有结构性错误如非法 fps 才抛）。
 */
function composeTimeline(input) {
  const clock = new FrameClock(input.fps ?? 30);
  const diagnostics = [];
  const cameras = input.cameras || {};
  const allowed = new Set(input.allowedTransitions || Object.keys(KNOWN_TRANSITIONS));

  const shots = normalizeShots(input.shots || [], clock, diagnostics);
  const transitions = resolveTransitions(
    shots, input.transitions || [], cameras, allowed, clock, diagnostics,
  );
  const cues = normalizeCues(input.cues || [], clock, diagnostics);
  const audio = normalizeAudio(input.audio || [], clock, diagnostics);

  let durationFrames = 0;
  for (const s of shots) durationFrames = Math.max(durationFrames, s.endFrame);
  for (const c of cues) durationFrames = Math.max(durationFrames, c.endFrame);
  for (const a of audio) durationFrames = Math.max(durationFrames, a.endFrame ?? a.startFrame);

  return { clock, durationFrames, shots, transitions, cues, audio, diagnostics };
}

/**
 * 镜头规范化：
 * 1. 起止时间量化到帧；量化后长度 <= 0 的镜头丢弃（zero-length-shot）。
 * 2. 重叠区域按 priority 高者优先、并列时输入顺序靠后者优先切分，
 *    输出互不重叠、按帧升序的镜头段（overlap-resolved）。
 */
function normalizeShots(rawShots, clock, diagnostics) {
  const quantized = [];
  rawShots.forEach((shot, index) => {
    const startFrame = clock.frameAt(shot.start);
    const endFrame = clock.frameAt(shot.end);
    if (endFrame <= startFrame) {
      diagnostics.push({
        code: 'shot/zero-length',
        shot: shot.id,
        message: `镜头 ${shot.id} 量化后长度为 ${endFrame - startFrame} 帧，已丢弃`,
      });
      return;
    }
    quantized.push({
      id: shot.id,
      camera: shot.camera ?? null,
      priority: shot.priority ?? 0,
      order: index,
      startFrame,
      endFrame,
    });
  });

  const boundaries = new Set();
  for (const s of quantized) {
    boundaries.add(s.startFrame);
    boundaries.add(s.endFrame);
  }
  const sorted = [...boundaries].sort((a, b) => a - b);

  const segments = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const from = sorted[i];
    const to = sorted[i + 1];
    let winner = null;
    for (const s of quantized) {
      if (s.startFrame <= from && s.endFrame >= to) {
        if (!winner || s.priority > winner.priority ||
            (s.priority === winner.priority && s.order > winner.order)) {
          winner = s;
        }
      }
    }
    if (!winner) continue;
    const last = segments[segments.length - 1];
    if (last && last.id === winner.id && last.endFrame === from) {
      last.endFrame = to; // 同一镜头相邻小段合并
    } else {
      segments.push({
        id: winner.id,
        camera: winner.camera,
        priority: winner.priority,
        startFrame: from,
        endFrame: to,
      });
    }
  }

  const ids = new Set();
  for (const s of segments) {
    if (ids.has(s.id)) {
      diagnostics.push({
        code: 'shot/overlap-resolved',
        shot: s.id,
        message: `镜头 ${s.id} 与其他镜头重叠，已按优先级切分为多段`,
      });
    }
    ids.add(s.id);
  }
  const overlapped = quantized.filter((q) => {
    return quantized.some((o) => o !== q && o.startFrame < q.endFrame && q.startFrame < o.endFrame);
  });
  for (const q of overlapped) {
    if (!diagnostics.some((d) => d.code === 'shot/overlap-resolved' && d.shot === q.id)) {
      diagnostics.push({
        code: 'shot/overlap-resolved',
        shot: q.id,
        message: `镜头 ${q.id} 与其他镜头重叠，已按优先级切分`,
      });
    }
  }

  for (const s of segments) {
    s.start = clock.timeAt(s.startFrame);
    s.end = clock.timeAt(s.endFrame);
  }
  return segments;
}

/**
 * 转场解析。只作用于帧边界完全相接的镜头段之间。
 * 非法情况一律降级为 cut 并记录诊断：
 *   - transition/unknown-type     类型未实现
 *   - transition/not-allowed      不在 allowedTransitions 白名单
 *   - transition/incompatible     混合类转场遇到不兼容相机
 *   - transition/clamped          时长超过相邻镜头长度，截断
 * 转场窗口以切点为中心：前半属于 outgoing，后半属于 incoming，
 * 任一帧都只有一个相机持有者。
 */
function resolveTransitions(segments, rawTransitions, cameras, allowed, clock, diagnostics) {
  const specs = new Map();
  for (const t of rawTransitions) {
    specs.set(`${t.from}->${t.to}`, t);
  }

  const transitions = [];
  for (let i = 0; i + 1 < segments.length; i++) {
    const out = segments[i];
    const inc = segments[i + 1];
    if (out.endFrame !== inc.startFrame) continue; // 有间隙，无转场
    if (out.id === inc.id) continue;               // 同一镜头的切分段

    const spec = specs.get(`${out.id}->${inc.id}`) || { type: 'cut', duration: 0 };
    let type = spec.type || 'cut';
    let durationFrames = clock.framesForDuration(out.end, spec.duration || 0);

    if (!KNOWN_TRANSITIONS[type]) {
      diagnostics.push({
        code: 'transition/unknown-type',
        from: out.id, to: inc.id, type,
        message: `未知转场类型 ${type}，已降级为 cut`,
      });
      type = 'cut';
      durationFrames = 0;
    } else if (!allowed.has(type)) {
      diagnostics.push({
        code: 'transition/not-allowed',
        from: out.id, to: inc.id, type,
        message: `转场 ${type} 不在允许列表，已降级为 cut`,
      });
      type = 'cut';
      durationFrames = 0;
    } else if (KNOWN_TRANSITIONS[type].blends &&
               !camerasCompatible(cameras[out.camera], cameras[inc.camera])) {
      diagnostics.push({
        code: 'transition/incompatible',
        from: out.id, to: inc.id, type,
        message: `转场 ${type} 需要混合画面，但相机 ${out.camera} 与 ${inc.camera} 控制不兼容，已降级为 cut`,
      });
      type = 'cut';
      durationFrames = 0;
    }

    if (durationFrames > 0) {
      const maxFrames = 2 * Math.min(out.endFrame - out.startFrame, inc.endFrame - inc.startFrame);
      if (durationFrames > maxFrames) {
        diagnostics.push({
          code: 'transition/clamped',
          from: out.id, to: inc.id, type,
          message: `转场时长 ${durationFrames} 帧超过相邻镜头可容纳的 ${maxFrames} 帧，已截断`,
        });
        durationFrames = maxFrames;
      }
    }

    const boundary = out.endFrame;
    const before = Math.floor(durationFrames / 2);
    transitions.push({
      from: out.id,
      to: inc.id,
      type,
      boundaryFrame: boundary,
      startFrame: boundary - before,
      endFrame: boundary - before + durationFrames,
      durationFrames,
    });
  }
  return transitions;
}

/** cue 帧对齐；零长度丢弃。字幕跨镜头无需特殊处理——cue 层独立于镜头层。 */
function normalizeCues(rawCues, clock, diagnostics) {
  const cues = [];
  for (const cue of rawCues) {
    const startFrame = clock.frameAt(cue.start);
    const endFrame = clock.frameAt(cue.end);
    if (endFrame <= startFrame) {
      diagnostics.push({
        code: 'cue/zero-length',
        cue: cue.id,
        message: `cue ${cue.id} 量化后长度为零，已丢弃`,
      });
      continue;
    }
    cues.push({ ...cue, startFrame, endFrame });
  }
  return cues.sort((a, b) => a.startFrame - b.startFrame);
}

/** 音频事件帧对齐；sustained 必须有 end，oneshot 只记录触发帧。 */
function normalizeAudio(rawAudio, clock, diagnostics) {
  const events = [];
  for (const ev of rawAudio) {
    const kind = ev.kind || (ev.end != null ? 'sustained' : 'oneshot');
    const startFrame = clock.frameAt(ev.start);
    if (kind === 'sustained') {
      const endFrame = clock.frameAt(ev.end);
      if (endFrame <= startFrame) {
        diagnostics.push({
          code: 'audio/zero-length',
          audio: ev.id,
          message: `持续音频 ${ev.id} 量化后长度为零，已丢弃`,
        });
        continue;
      }
      events.push({ ...ev, kind, track: ev.track ?? 'default', startFrame, endFrame });
    } else {
      events.push({ ...ev, kind: 'oneshot', track: ev.track ?? 'default', startFrame, endFrame: null });
    }
  }
  return events.sort((a, b) => a.startFrame - b.startFrame);
}

module.exports = { composeTimeline, KNOWN_TRANSITIONS, camerasCompatible };
