'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { composeTimeline } = require('../index');

test('零长度镜头被丢弃并记录诊断', () => {
  const tl = composeTimeline({
    fps: 10,
    shots: [
      { id: 'ok', start: 0, end: 2 },
      { id: 'empty', start: 1.0, end: 1.04 }, // 量化后 10 -> 10 帧
    ],
  });
  assert.deepEqual(tl.shots.map((s) => s.id), ['ok']);
  assert.ok(tl.diagnostics.some((d) => d.code === 'shot/zero-length' && d.shot === 'empty'));
});

test('重叠镜头按优先级切分，并列时后输入者优先', () => {
  const tl = composeTimeline({
    fps: 10,
    shots: [
      { id: 'a', start: 0, end: 4, priority: 0 },
      { id: 'b', start: 2, end: 6, priority: 1 },
    ],
  });
  assert.deepEqual(
    tl.shots.map((s) => [s.id, s.startFrame, s.endFrame]),
    [['a', 0, 20], ['b', 20, 60]],
  );
  assert.ok(tl.diagnostics.some((d) => d.code === 'shot/overlap-resolved'));

  const tie = composeTimeline({
    fps: 10,
    shots: [
      { id: 'c', start: 0, end: 2 },
      { id: 'd', start: 0, end: 2 },
    ],
  });
  assert.deepEqual(tie.shots.map((s) => s.id), ['d']);
});

test('非法转场降级为 cut', () => {
  const base = {
    fps: 10,
    shots: [
      { id: 's1', start: 0, end: 2 },
      { id: 's2', start: 2, end: 4 },
    ],
  };
  const unknown = composeTimeline({
    ...base,
    transitions: [{ from: 's1', to: 's2', type: 'zoom', duration: 1 }],
  });
  assert.equal(unknown.transitions[0].type, 'cut');
  assert.equal(unknown.transitions[0].durationFrames, 0);
  assert.ok(unknown.diagnostics.some((d) => d.code === 'transition/unknown-type'));

  const notAllowed = composeTimeline({
    ...base,
    allowedTransitions: ['cut', 'fade'],
    transitions: [{ from: 's1', to: 's2', type: 'dissolve', duration: 1 }],
  });
  assert.equal(notAllowed.transitions[0].type, 'cut');
  assert.ok(notAllowed.diagnostics.some((d) => d.code === 'transition/not-allowed'));
});

test('混合类转场遇到不兼容相机时降级为 cut', () => {
  const tl = composeTimeline({
    fps: 10,
    cameras: {
      camA: { control: 'scripted' },
      camB: { control: 'scripted' },
      camFree: { control: 'free' },
    },
    shots: [
      { id: 's1', start: 0, end: 2, camera: 'camA' },
      { id: 's2', start: 2, end: 5, camera: 'camB' },
      { id: 's3', start: 5, end: 8, camera: 'camFree' },
    ],
    transitions: [
      { from: 's1', to: 's2', type: 'dissolve', duration: 1 },
      { from: 's2', to: 's3', type: 'dissolve', duration: 1 },
    ],
  });
  const [ok, bad] = tl.transitions;
  assert.equal(ok.type, 'dissolve');
  assert.equal(ok.durationFrames, 10);
  assert.deepEqual([ok.startFrame, ok.boundaryFrame, ok.endFrame], [15, 20, 25]);
  assert.equal(bad.type, 'cut');
  assert.equal(bad.durationFrames, 0);
  assert.ok(tl.diagnostics.some((d) => d.code === 'transition/incompatible'));
});

test('转场时长超过相邻镜头时截断', () => {
  const tl = composeTimeline({
    fps: 10,
    shots: [
      { id: 's1', start: 0, end: 0.5 },
      { id: 's2', start: 0.5, end: 3 },
    ],
    transitions: [{ from: 's1', to: 's2', type: 'fade', duration: 4 }],
  });
  assert.equal(tl.transitions[0].durationFrames, 10); // 2 * min(5, 25)
  assert.ok(tl.diagnostics.some((d) => d.code === 'transition/clamped'));
});

test('字幕可跨镜头保持激活，零长度 cue 被丢弃', () => {
  const tl = composeTimeline({
    fps: 10,
    shots: [
      { id: 's1', start: 0, end: 2 },
      { id: 's2', start: 2, end: 5 },
    ],
    cues: [
      { id: 'sub1', kind: 'subtitle', start: 1, end: 4, text: '跨镜头字幕' },
      { id: 'sub2', kind: 'subtitle', start: 1, end: 1 },
    ],
  });
  assert.equal(tl.cues.length, 1);
  assert.deepEqual([tl.cues[0].startFrame, tl.cues[0].endFrame], [10, 40]);
  assert.ok(tl.diagnostics.some((d) => d.code === 'cue/zero-length'));
});

test('多条音频轨独立帧对齐，零长度持续音频被丢弃', () => {
  const tl = composeTimeline({
    fps: 10,
    shots: [{ id: 's1', start: 0, end: 8 }],
    audio: [
      { id: 'bgm', track: 'music', kind: 'sustained', start: 0, end: 8 },
      { id: 'rain', track: 'ambience', kind: 'sustained', start: 1, end: 7 },
      { id: 'hit', track: 'sfx', kind: 'oneshot', start: 2 },
      { id: 'bad', track: 'sfx', kind: 'sustained', start: 3, end: 3 },
    ],
  });
  assert.equal(tl.audio.length, 3);
  assert.deepEqual(
    tl.audio.map((e) => [e.id, e.startFrame, e.endFrame]),
    [['bgm', 0, 80], ['rain', 10, 70], ['hit', 20, null]],
  );
  assert.ok(tl.diagnostics.some((d) => d.code === 'audio/zero-length'));
  assert.equal(tl.durationFrames, 80);
});
