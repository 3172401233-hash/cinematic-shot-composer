'use strict';

const { FrameClock } = require('./src/frame-clock');
const { composeTimeline, KNOWN_TRANSITIONS, camerasCompatible } = require('./src/composer');
const { buildStateAt } = require('./src/seek');

module.exports = {
  FrameClock,
  composeTimeline,
  buildStateAt,
  KNOWN_TRANSITIONS,
  camerasCompatible,
};
