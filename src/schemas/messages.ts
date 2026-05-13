import { z } from 'zod';

export const STORAGE_KEY_MAX_LENGTH = 256;
export const STORAGE_VALUE_MAX_BYTES = 16 * 1024;

export const HAPTIC_TYPES = ['light', 'medium', 'success', 'error'] as const;
export const AppHapticTypeSchema = z.enum(HAPTIC_TYPES);
export type AppHapticType = z.infer<typeof AppHapticTypeSchema>;

export const LIFECYCLE_EVENTS = ['pause', 'resume', 'terminating'] as const;
export const AppLifecycleEventSchema = z.enum(LIFECYCLE_EVENTS);
export type AppLifecycleEvent = z.infer<typeof AppLifecycleEventSchema>;

export const COLOR_SCHEMES = ['light', 'dark'] as const;
export const AppColorSchemeSchema = z.enum(COLOR_SCHEMES);
export type AppColorScheme = z.infer<typeof AppColorSchemeSchema>;

const StorageKey = z.string().min(1).max(STORAGE_KEY_MAX_LENGTH);
const StorageValue = z.string().max(STORAGE_VALUE_MAX_BYTES);
const CorrelationId = z.string().min(1).max(128);

export const BridgeRequestSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('storage.get'),
    correlationId: CorrelationId,
    payload: z.object({ key: StorageKey }),
  }),
  z.object({
    type: z.literal('storage.set'),
    correlationId: CorrelationId,
    payload: z.object({ key: StorageKey, value: StorageValue }),
  }),
  z.object({
    type: z.literal('storage.delete'),
    correlationId: CorrelationId,
    payload: z.object({ key: StorageKey }),
  }),
  z.object({
    type: z.literal('aggregate.count'),
    correlationId: CorrelationId,
    payload: z.object({ key: StorageKey, value: StorageKey }),
  }),
  z.object({
    type: z.literal('actions.share'),
    correlationId: CorrelationId,
    payload: z.object({
      title: z.string().max(140).optional(),
      text: z.string().max(2000).optional(),
    }),
  }),
  z.object({
    type: z.literal('actions.haptic'),
    correlationId: CorrelationId,
    payload: z.object({ type: AppHapticTypeSchema }),
  }),
  z.object({
    type: z.literal('actions.requestSignIn'),
    correlationId: CorrelationId,
    payload: z
      .object({
        reason: z.string().min(1).max(200).optional(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal('session.refresh'),
    correlationId: CorrelationId,
  }),
  z.object({
    type: z.literal('ready'),
    correlationId: CorrelationId,
  }),
]);

export type BridgeRequest = z.infer<typeof BridgeRequestSchema>;
export type BridgeRequestType = BridgeRequest['type'];

export const BridgeErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});

export type BridgeError = z.infer<typeof BridgeErrorSchema>;

export const BridgeResponseSchema = z.object({
  type: z.literal('response'),
  correlationId: CorrelationId,
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: BridgeErrorSchema.optional(),
});

export type BridgeResponse = z.infer<typeof BridgeResponseSchema>;

export const BridgeLifecycleMessageSchema = z.object({
  type: z.literal('lifecycle'),
  event: AppLifecycleEventSchema,
});

export type BridgeLifecycleMessage = z.infer<
  typeof BridgeLifecycleMessageSchema
>;

export const BridgeUserSchema = z.object({
  uuid: z.string().uuid(),
  username: z.string().min(1).max(64),
});

export type BridgeUser = z.infer<typeof BridgeUserSchema>;

export const BridgeInitSchema = z.object({
  type: z.literal('init'),
  user: BridgeUserSchema.nullable(),
  sessionToken: z.string().nullable(),
  expiresAt: z.string().datetime().nullable(),
  // Optional so older outers (pre-theme rollout) still parse cleanly. SDK
  // consumers should treat missing as "unknown" and default their styling to
  // light. The host falls back to its own URL param when init omits it.
  colorScheme: AppColorSchemeSchema.optional(),
});

export type BridgeInit = z.infer<typeof BridgeInitSchema>;

export const BridgeOutboundSchema = z.discriminatedUnion('type', [
  BridgeResponseSchema,
  BridgeLifecycleMessageSchema,
  BridgeInitSchema,
]);

export type BridgeOutbound = z.infer<typeof BridgeOutboundSchema>;
