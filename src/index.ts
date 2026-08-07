import type { GeoLintConfig } from './types/config.js';

export type {
  DiagnosticLimitConfig,
  GeoLintConfig,
  GeoLintOverride,
} from './types/config.js';

/** Defines a GeoLint configuration without changing its inferred type. */
export function defineConfig<const T extends GeoLintConfig>(config: T): T {
  return config;
}
