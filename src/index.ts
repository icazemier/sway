import { sway as swayBase } from './sway.js';
import { swayAllSettled } from './sway-all-settled.js';
import { swayMap } from './sway-map.js';

export const sway = Object.assign(swayBase, {
  allSettled: swayAllSettled,
  map: swayMap,
});

export { AdaptiveController } from './adaptive-controller.js';
export type { SwayOptions, SwayResult, SwayStats } from './interfaces.js';
