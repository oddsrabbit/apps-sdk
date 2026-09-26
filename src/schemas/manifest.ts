import { z } from 'zod';

export const SDK_VERSIONS = ['1'] as const;
export const AppSdkVersionSchema = z.enum(SDK_VERSIONS);
export type AppSdkVersion = z.infer<typeof AppSdkVersionSchema>;

export const BRIDGE_SCOPES = [
  'bridge:storage',
  'bridge:share',
  'bridge:notifications',
  'bridge:social',
] as const;
export const AppScopeSchema = z.enum(BRIDGE_SCOPES);
export type AppScope = z.infer<typeof AppScopeSchema>;

export const APP_SURFACES = ['games'] as const;
export const AppSurfaceSchema = z.enum(APP_SURFACES);
export type AppSurface = z.infer<typeof AppSurfaceSchema>;

/** A visit's `kind`, as in `visits.record` (and gifts). */
const SOCIAL_KIND_PATTERN = /^[a-z0-9-]{1,32}$/;
export const VISIT_LINES_MAX = 16;
export const VISIT_LINE_MAX = 80;

/**
 * One push/bell line per visit `kind`, with exactly one `{username}`
 * placeholder: `{ snack: '{username} came by and left a snack.' }`. The
 * manifest is admin-registered, so the lines are reviewed once; nothing a game
 * sends at runtime reaches the push. An unknown kind, or no map, gets
 * "{username} came to visit." The server ignores a map that breaks these rules.
 */
export const VisitLinesSchema = z
  .record(
    z.string().regex(SOCIAL_KIND_PATTERN),
    z
      .string()
      .min(1)
      .max(VISIT_LINE_MAX)
      .refine((line) => line.split('{username}').length === 2, {
        message: 'A visit line needs exactly one {username}.',
      })
      .refine((line) => !/[\x00-\x1F\x7F]/.test(line), {
        message: 'A visit line is one line of plain text.',
      })
  )
  .refine((lines) => Object.keys(lines).length <= VISIT_LINES_MAX, {
    message: `At most ${VISIT_LINES_MAX} visit kinds.`,
  });

/** Copy for `bridge:social` notices. Optional; only apps with that scope use it. */
export const AppSocialManifestSchema = z.object({
  visitLines: VisitLinesSchema.optional(),
});

export const AppManifestSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  developer: z.string().min(1).max(64),
  homepage: z.string().url().optional(),
  icon: z.string().url().optional(),
  surface: AppSurfaceSchema,
  appUrl: z.string().url(),
  sdkVersion: AppSdkVersionSchema,
  scopes: z.array(AppScopeSchema),
  version: z.string().regex(/^\d+\.\d+\.\d+(-[\w.]+)?$/),
  updatedAt: z.string().datetime(),
  social: AppSocialManifestSchema.optional(),
});

export type AppManifest = z.infer<typeof AppManifestSchema>;
