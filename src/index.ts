import type { GeoLintConfig } from './types/config.js';

export type {
  DiagnosticLimitConfig,
  GeoLintConfig,
  GeoLintOverride,
  GeoLintRuntimeContext,
  ResolvedConfig,
  ResolvedFileConfig,
} from './types/config.js';
export { resolveFileConfig } from './config/resolve.js';
export { resolveRuntimeConfig } from './config/runtime.js';

/** Defines a GeoLint configuration without changing its inferred type. */
export function defineConfig<const T extends GeoLintConfig>(config: T): T {
  return config;
}
