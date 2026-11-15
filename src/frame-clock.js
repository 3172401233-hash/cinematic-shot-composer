'use strict';

/**
 * FrameClock 把时间轴划分为若干恒定帧率的分段，负责 秒 <-> 帧号 的换算。
 *
 * fps 可以是：
 *   - 数字：整条时间轴恒定帧率；
 *   - [{ fps, from }]：分段帧率，from 为该分段起始秒数（第一段必须从 0 开始）。
 *
 * 帧号全局单调递增。每个分段的帧偏移量按 round((from[i+1]-from[i]) * fps[i])
 * 累计，因此帧率切换点本身也对齐到整数帧，不会出现跨段错一帧的问题。
 */
class FrameClock {
  constructor(fps) {
    const raw = typeof fps === 'number' ? [{ fps, from: 0 }] : fps;
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new TypeError('FrameClock: fps 必须是正数或分段数组');
    }
    const sorted = raw
      .map((seg) => ({ fps: seg.fps, from: seg.from ?? 0 }))
      .sort((a, b) => a.from - b.from);
    if (sorted[0].from !== 0) {
      throw new RangeError('FrameClock: 第一个帧率分段必须从 0 秒开始');
    }
    let offset = 0;
    this.segments = sorted.map((seg, i) => {
      if (!(seg.fps > 0)) throw new RangeError(`FrameClock: 非法帧率 ${seg.fps}`);
      if (i > 0 && seg.from <= sorted[i - 1].from) {
        throw new RangeError('FrameClock: 分段 from 必须严格递增');
      }
      const built = { fps: seg.fps, from: seg.from, frameOffset: offset };
      if (i + 1 < sorted.length) {
        offset += Math.round((sorted[i + 1].from - seg.from) * seg.fps);
      }
      return built;
    });
  }

  segmentAtTime(time) {
    let seg = this.segments[0];
    for (const s of this.segments) {
      if (s.from <= time) seg = s;
      else break;
    }
    return seg;
  }

  segmentAtFrame(frame) {
    let seg = this.segments[0];
    for (const s of this.segments) {
      if (s.frameOffset <= frame) seg = s;
      else break;
    }
    return seg;
  }

  /** 秒 -> 帧号（四舍五入到最近帧，负时间钳到 0）。 */
  frameAt(time) {
    if (!(time > 0)) return 0;
    const seg = this.segmentAtTime(time);
    return seg.frameOffset + Math.round((time - seg.from) * seg.fps);
  }

  /** 帧号 -> 该帧起始秒数。 */
  timeAt(frame) {
    const f = Math.max(0, Math.floor(frame));
    const seg = this.segmentAtFrame(f);
    return seg.from + (f - seg.frameOffset) / seg.fps;
  }

  /** 时长（秒）在该时刻所处分段下换算成的帧数。 */
  framesForDuration(atTime, duration) {
    return this.frameAt(atTime + duration) - this.frameAt(atTime);
  }
}

module.exports = { FrameClock };
