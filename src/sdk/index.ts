import { OddsRabbitSDK, type OddsRabbitGlobal } from './sdk';

export type {
  OddsRabbitGlobal,
  MatchCreatePayload,
  MatchJoinPayload,
  MatchListPayload,
  MatchMovePayload,
  MatchWatchOptions,
  MatchView,
  MatchSummary,
  MatchPlayer,
  MatchLastMove,
  MatchStatus,
  MatchPlayerStatus,
  MatchListFilter,
  MatchNudgeResult,
  InvitablePlayer,
  GiftSendPayload,
  Showcase,
  Gift,
  GiftSendResult,
  GiftClaimResult,
  ShowcasePublishResult,
  VisitRecordPayload,
  Visit,
  VisitRecordResult,
  VisitSeenResult,
} from './sdk';
export { MATCH_ERROR_CODES, SOCIAL_ERROR_CODES, GIFT_ERROR_CODES, VISIT_ERROR_CODES } from './sdk';
export type {
  BridgeUser,
  AppColorScheme,
  AppHapticType,
  AppLifecycleEvent,
} from '../schemas/messages';

const sdk = new OddsRabbitSDK();

export const OddsRabbit: OddsRabbitGlobal = sdk;

declare global {
  interface Window {
    OddsRabbit?: OddsRabbitGlobal;
  }
}

if (typeof window !== 'undefined' && !window.OddsRabbit) {
  window.OddsRabbit = sdk;
  attachToHost();
}

/**
 * Tell the host page this document is loaded, from the game's <head> where the
 * SDK script sits: the host reads `<meta name="oddsrabbit-chrome">` and sets
 * the game's --oddsrabbit-safe-* / --oddsrabbit-chrome-* before its first
 * paint, instead of on load. The meta must come before the SDK's <script>.
 * Same-origin hosts only; anywhere else this is a no-op and the host falls
 * back to doing it on load. See docs/game-header-guidelines.md.
 */
function attachToHost(): void {
  if (typeof document === 'undefined' || window.parent === window) return;
  try {
    const host = (window.parent as { OddsRabbitHost?: { attachGame(doc: Document): void } })
      .OddsRabbitHost;
    host?.attachGame(document);
  } catch {
    // Cross-origin parent.
  }
}
