# cinematic-shot-composer

JavaScript 过场镜头编排库：把不同编辑器导出的镜头区间、相机轨道、对白/字幕 cue
和音频事件合并成**帧对齐**的时间线，并支持从任意 seek 位置重建播放状态。

## 用法

```js
const { composeTimeline, buildStateAt } = require('cinematic-shot-composer');

const timeline = composeTimeline({
  fps: [{ fps: 24, from: 0 }, { fps: 30, from: 10 }], // 支持帧率变化，也可传单个数字
  cameras: {
    camA: { control: 'scripted' },
    camB: { control: 'free' },
  },
  shots: [
    { id: 's1', start: 0, end: 2, camera: 'camA' },
    { id: 's2', start: 2, end: 5, camera: 'camB' },
  ],
  transitions: [{ from: 's1', to: 's2', type: 'dissolve', duration: 1 }],
  cues: [{ id: 'sub1', kind: 'subtitle', start: 1, end: 4, text: '跨镜头字幕' }],
  audio: [
    { id: 'bgm', track: 'music', kind: 'sustained', start: 0, end: 5 },
    { id: 'hit', track: 'sfx', kind: 'oneshot', start: 2 },
  ],
  allowedTransitions: ['cut', 'fade', 'dissolve', 'wipe'],
});

const state = buildStateAt(timeline, 3.5); // 或 buildStateAt(timeline, 84, 'frames')
```

## 编排规则

- **帧对齐**：所有起止时间经 `FrameClock` 量化到整数帧；帧率分段的切换点本身
  也对齐整数帧，帧号全局连续，不会在帧率变化处错开一帧。
- **重叠镜头**：按 `priority` 高者优先、并列时输入顺序靠后者优先切分为互不重叠
  的镜头段，记录诊断 `shot/overlap-resolved`。
- **零长度**：量化后长度为零的镜头 / cue / 持续音频直接丢弃，分别记录
  `shot/zero-length`、`cue/zero-length`、`audio/zero-length`。
- **转场约束**：未知类型、不在 `allowedTransitions` 白名单、或混合类转场
  （`dissolve`/`wipe`）遇到控制类型不兼容的相机时，一律降级为 `cut` 并记录诊断；
  时长超过相邻镜头可容纳范围时截断（`transition/clamped`）。转场窗口以切点为
  中心，前半归 outgoing、后半归 incoming，**任意帧都只有一个相机持有者**。
- **字幕跨镜头**：cue 层独立于镜头层，`startFrame <= f < endFrame` 即激活，
  跨镜头边界无需特殊处理。
- **多条音频**：事件按 `track` 分组，互不干扰；诊断不会中断编排。

## 跳播状态重建规则

`buildStateAt(timeline, target, unit?)` 在任意 seek 位置确定性地重建状态：

- **R1** 目标时间先量化到帧，并钳制在 `[0, durationFrames]`。
- **R2** 镜头归属：`startFrame <= f < endFrame`；落在镜头间隙时 `shot` 为 `null`。
- **R3** 相机单一持有：转场窗口内 `f < boundaryFrame` 归 outgoing，否则归
  incoming；任何帧都不会同时存在两套相机控制。
- **R4** cue（对白/字幕）：`startFrame <= f < endFrame` 即出现在 `state.cues`。
- **R5** sustained 音频：同 R4 判定激活，并给出 `offsetFrames` / `offsetSeconds`
  （seek 帧 − 事件起帧），播放器据此从事件内部偏移处续播，不重头播放。
- **R6** oneshot 音频：仅当 `f === startFrame` 时出现在 `audio.triggered`；
  被跳过的 oneshot 不补触发。

## 测试

```sh
node --test
```
