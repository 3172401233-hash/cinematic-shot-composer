'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { composeTimeline, buildStateAt } = require('../index');

function makeTimeline() {
  return composeTimeline({
    fps: 10,
    cameras: {
      camA: { control: 'scripted' },
      camB: { control: 'scripted' },
    },
    shots: [
      { id: 's1', start: 0, end: 2, camera: 'camA' },
      { id: 's2', start: 2, end: 5, camera: 'camB' },
      // 5..6 为间隙
      { id: 's3', start: 6, end: 8, camera: 'camA' },
    ],
    transitions: [{ from: 's1', to: 's2', type: 'dissolve', duration: 1 }],
    cues: [{ id: 'sub1', kind: 'subtitle', start: 1, end: 7, text: '跨镜头字幕' }],
    audio: [
      { id: 'bgm', track: 'music', kind: 'sustained', start: 0, end: 8 },
      { id: 'rain', track: 'ambience', kind: 'sustained', start: 1, end: 7 },
      { id: 'hit', track: 'sfx', kind: 'oneshot', start: 2 },
    ],
  });
}

test('跳到持续事件中部时按偏移恢复', () => {
  const tl = makeTimeline();
  const state = buildStateAt(tl, 3.5); // 帧 35
  assert.equal(state.frame, 35);
  assert.equal(state.shot.id, 's2');

  const bgm = state.audio.sustained.find((r) => r.event.id === 'bgm');
  assert.equal(bgm.offsetFrames, 35);
  assert.ok(Math.abs(bgm.offsetSeconds - 3.5) < 1e-9);

  const rain = state.audio.sustained.find((r) => r.event.id === 'rain');
  assert.equal(rain.offsetFrames, 25);
  assert.ok(Math.abs(rain.offsetSeconds - 2.5) < 1e-9);

  assert.deepEqual(Object.keys(state.audio.byTrack).sort(), ['ambience', 'music']);
});

test('oneshot 只在触发帧触发，跳过去不补触发', () => {
  const tl = makeTimeline();
  assert.deepEqual(buildStateAt(tl, 2.0).audio.triggered.map((e) => e.id), ['hit']);
  assert.deepEqual(buildStateAt(tl, 2.1).audio.triggered, []);
  assert.deepEqual(buildStateAt(tl, 4.9).audio.triggered, []);
});

test('转场窗口内任意帧都只有一个相机持有者，且在切点换主', () => {
  const tl = makeTimeline(); // dissolve 窗口为帧 [15, 25)，切点 20
  for (let f = 15; f < 25; f++) {
    const state = buildStateAt(tl, f, 'frames');
    assert.ok(state.camera.transition, `帧 ${f} 应处于转场中`);
    const expected = f < 20 ? 'camA' : 'camB';
    assert.equal(state.camera.owner, expected, `帧 ${f} 相机持有者`);
  }
  // 转场窗口外恢复镜头自身相机
  assert.equal(buildStateAt(tl, 14, 'frames').camera.owner, 'camA');
  assert.equal(buildStateAt(tl, 25, 'frames').camera.owner, 'camB');
});

test('跨镜头字幕在镜头边界两侧都保持激活', () => {
  const tl = makeTimeline();
  for (const t of [1.9, 2.0, 2.1, 5.5, 6.9]) {
    const state = buildStateAt(tl, t);
    assert.ok(state.cues.some((c) => c.id === 'sub1'), `t=${t} 字幕应激活`);
  }
  assert.ok(!buildStateAt(tl, 7.0).cues.some((c) => c.id === 'sub1'));
});

test('镜头间隙内 seek 返回空镜头但持续音频仍可恢复', () => {
  const tl = makeTimeline();
  const state = buildStateAt(tl, 5.5);
  assert.equal(state.shot, null);
  assert.equal(state.camera.owner, null);
  assert.ok(state.audio.sustained.some((r) => r.event.id === 'bgm'));
});

test('seek 目标越界时钳制到时间线范围', () => {
  const tl = makeTimeline();
  assert.equal(buildStateAt(tl, -5).frame, 0);
  assert.equal(buildStateAt(tl, 999).frame, tl.durationFrames);
});

test('帧率变化下 seek 偏移换算仍按帧对齐', () => {
  const tl = composeTimeline({
    fps: [{ fps: 24, from: 0 }, { fps: 30, from: 10 }],
    shots: [{ id: 's1', start: 0, end: 20 }],
    audio: [{ id: 'bgm', track: 'music', kind: 'sustained', start: 8, end: 12 }],
  });
  // bgm 起帧 192，止帧 240 + 2*30 = 300
  const ev = tl.audio[0];
  assert.deepEqual([ev.startFrame, ev.endFrame], [192, 300]);
  const state = buildStateAt(tl, 10.5); // 帧 240 + 15 = 255
  const resumed = state.audio.sustained[0];
  assert.equal(resumed.offsetFrames, 63);
  assert.ok(Math.abs(resumed.offsetSeconds - 2.5) < 1e-9);
});
