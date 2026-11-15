'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FrameClock } = require('../index');

test('恒定帧率下时间量化到最近帧', () => {
  const clock = new FrameClock(30);
  assert.equal(clock.frameAt(0), 0);
  assert.equal(clock.frameAt(1), 30);
  assert.equal(clock.frameAt(1.016), 30); // 30.48 -> 30
  assert.equal(clock.frameAt(1.05), 32);  // 31.5 四舍五入
  assert.equal(clock.timeAt(30), 1);
});

test('帧率变化时帧号连续且切换点对齐整数帧', () => {
  const clock = new FrameClock([{ fps: 24, from: 0 }, { fps: 30, from: 10 }]);
  assert.equal(clock.frameAt(10), 240);
  assert.equal(clock.frameAt(11), 270);
  assert.equal(clock.timeAt(270), 11);
  // 跨分段的区间两端分别按各自帧率量化
  assert.equal(clock.frameAt(9.5), 228);
  assert.equal(clock.frameAt(10.5), 255);
});

test('帧率分段校验', () => {
  assert.throws(() => new FrameClock([{ fps: 24, from: 1 }]), /从 0 秒开始/);
  assert.throws(() => new FrameClock(0), /非法帧率/);
});

test('framesForDuration 按所处分段换算', () => {
  const clock = new FrameClock([{ fps: 24, from: 0 }, { fps: 30, from: 10 }]);
  assert.equal(clock.framesForDuration(0, 1), 24);
  assert.equal(clock.framesForDuration(10, 1), 30);
});
