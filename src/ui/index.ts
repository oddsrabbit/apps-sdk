/**
 * Entry point for the shared leaderboard UI.
 *
 * Two consumption paths, because the games are built two different ways:
 *
 *  - TypeScript games (rabbit-globe, rabbit-words) import from
 *    `../../src/ui/leaderboard` and esbuild bundles it into their `main.js`,
 *    the same way they already import the schemas.
 *  - Vanilla-JS games (2048, solitaire) are copied verbatim by the build and
 *    have no bundler, so they load `dist/leaderboard-v1.js` as a script tag and
 *    reach it through `window.OddsRabbitUI`.
 *
 * Kept out of the SDK bundle on purpose: `sdk-v1.js` is loaded by every game
 * including the four with no leaderboard, and UI code has no business in a
 * transport library.
 */

import {
  createLeaderboardPanel,
  leaderboardAvatar,
  openLeaderboardModal,
  pinnedFromRank,
} from './leaderboard';
import { createSeasonTab, currentPeriod, formatPeriod } from './season';

export {
  createLeaderboardPanel,
  leaderboardAvatar,
  openLeaderboardModal,
  pinnedFromRank,
} from './leaderboard';
export type {
  LeaderboardModal,
  LeaderboardModalOptions,
  LeaderboardOptions,
  LeaderboardPanel,
  LeaderboardPrompt,
  LeaderboardRow,
  LeaderboardTab,
  PinnedRank,
} from './leaderboard';

export { createSeasonTab, currentPeriod, formatPeriod } from './season';
export type { SeasonTabOptions } from './season';

export interface OddsRabbitUIGlobal {
  createLeaderboardPanel: typeof createLeaderboardPanel;
  openLeaderboardModal: typeof openLeaderboardModal;
  leaderboardAvatar: typeof leaderboardAvatar;
  pinnedFromRank: typeof pinnedFromRank;
  createSeasonTab: typeof createSeasonTab;
  currentPeriod: typeof currentPeriod;
  formatPeriod: typeof formatPeriod;
}

declare global {
  interface Window {
    OddsRabbitUI?: OddsRabbitUIGlobal;
  }
}

// Same install guard as the SDK: a second script tag must not replace a live
// instance, since a game may already hold a reference to the first.
if (typeof window !== 'undefined' && !window.OddsRabbitUI) {
  window.OddsRabbitUI = {
    createLeaderboardPanel,
    openLeaderboardModal,
    leaderboardAvatar,
    pinnedFromRank,
    createSeasonTab,
    currentPeriod,
    formatPeriod,
  };
}
