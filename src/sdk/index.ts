import { OddsRabbitSDK, type OddsRabbitGlobal } from './sdk';

export type { OddsRabbitGlobal } from './sdk';
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
