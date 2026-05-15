import { sway as swayBase } from './sway.js';
import { swayAllSettled } from './sway-all-settled.js';

export const sway = Object.assign(swayBase, {
  allSettled: swayAllSettled,
});

export { AdaptiveController } from './adaptive-controller.js';
export type { SwayOptions, SwayResult, SwayStats } from './interfaces.js';
