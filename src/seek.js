'use strict';

/**
 * 跳播（seek）状态重建。
 *
 * 规则（与 README「跳播状态重建规则」一致）：
 *  R1 目标时间先量化到帧，并钳制在 [0, durationFrames]。
 *  R2 镜头归属：startFrame <= f < endFrame；落在间隙则 shot 为 null。
 *  R3 相机单一持有：转场窗口内，f < boundaryFrame 归 outgoing，
 *     否则归 incoming；任何帧都不会出现两个相机持有者。
 *  R4 cue（对白/字幕）：startFrame <= f < endFrame 即激活，可跨镜头。
 *  R5 sustained 音频：同 R4 判定激活，并给出 offsetFrames/offsetSeconds
 *     供播放器从事件内部偏移处续播。
 *  R6 oneshot 音频：仅当 f === startFrame 时出现在 triggered 中；
 *     跳过的 oneshot 不补触发。
 */
function buildStateAt(timeline, target, unit = 'seconds') {
  const { clock } = timeline;
  let frame = unit === 'frames' ? Math.round(target) : clock.frameAt(target);
  frame = Math.max(0, Math.min(frame, timeline.durationFrames));
  const time = clock.timeAt(frame);

  const shot = timeline.shots.find((s) => s.startFrame <= frame && frame < s.endFrame) || null;

  const transition = timeline.transitions.find(
    (t) => t.durationFrames > 0 && t.startFrame <= frame && frame < t.endFrame,
  ) || null;

  let cameraOwner = shot ? shot.camera : null;
  if (transition) {
    cameraOwner = frame < transition.boundaryFrame
      ? cameraOf(timeline, transition.from)
      : cameraOf(timeline, transition.to);
  }

  const cues = timeline.cues.filter((c) => c.startFrame <= frame && frame < c.endFrame);

  const triggered = [];
  const sustained = [];
  const byTrack = {};
  for (const ev of timeline.audio) {
    if (ev.kind === 'oneshot') {
      if (ev.startFrame === frame) triggered.push(ev);
      continue;
    }
    if (ev.startFrame <= frame && frame < ev.endFrame) {
      const offsetFrames = frame - ev.startFrame;
      const resumed = {
        event: ev,
        offsetFrames,
        offsetSeconds: clock.timeAt(ev.startFrame + offsetFrames) - clock.timeAt(ev.startFrame),
      };
      sustained.push(resumed);
      (byTrack[ev.track] ||= []).push(resumed);
    }
  }

  return {
    frame,
    time,
    shot,
    camera: { owner: cameraOwner, transition },
    cues,
    audio: { triggered, sustained, byTrack },
  };
}

function cameraOf(timeline, shotId) {
  const seg = timeline.shots.find((s) => s.id === shotId);
  return seg ? seg.camera : null;
}

module.exports = { buildStateAt };
