import { sway as swayBase } from './sway.js';
import { swayAllSettled } from './sway-all-settled.js';
import { swayMap } from './sway-map.js';

type Sway = typeof swayBase & {
  allSettled: typeof swayAllSettled;
  map: typeof swayMap;
};

export const sway: Sway = Object.assign(swayBase, {
  allSettled: swayAllSettled,
  map: swayMap,
});

export { AdaptiveController } from './adaptive-controller.js';
export type { SwayOptions, SwayResult, SwayStats } from './interfaces.js';
