import { z } from 'zod';

export const SDK_VERSIONS = ['1'] as const;
export const AppSdkVersionSchema = z.enum(SDK_VERSIONS);
export type AppSdkVersion = z.infer<typeof AppSdkVersionSchema>;

export const BRIDGE_SCOPES = ['bridge:storage', 'bridge:share'] as const;
export const AppScopeSchema = z.enum(BRIDGE_SCOPES);
export type AppScope = z.infer<typeof AppScopeSchema>;

export const APP_SURFACES = ['games'] as const;
export const AppSurfaceSchema = z.enum(APP_SURFACES);
export type AppSurface = z.infer<typeof AppSurfaceSchema>;

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
});

export type AppManifest = z.infer<typeof AppManifestSchema>;
