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
  InvitablePlayer,
} from './sdk';
export { MATCH_ERROR_CODES } from './sdk';
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
}
