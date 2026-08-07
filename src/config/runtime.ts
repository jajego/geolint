import { dirname, resolve } from 'node:path';

import { discoverConfig } from './discover.js';
import { loadConfigWithExtends, resolveConfigExtends } from './load.js';
import { getPreset } from './presets.js';
import { resolveConfig } from './resolve.js';
import type {
  GeoLintConfig,
  GeoLintRuntimeContext,
  ResolvedConfig,
} from '../types/config.js';

export interface ConfigRuntimeOptions extends GeoLintRuntimeContext {
  noConfig?: boolean;
}

export async function resolveRuntimeConfig(
  options: ConfigRuntimeOptions = {},
): Promise<ResolvedConfig> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const supplied = options.config;
  const path =
    typeof supplied === 'string'
      ? resolve(cwd, supplied)
      : options.noConfig
        ? undefined
        : await discoverConfig(cwd);
  const config: GeoLintConfig =
    typeof supplied === 'object'
      ? await resolveConfigExtends(supplied, cwd)
      : path
        ? await loadConfigWithExtends(path)
        : await resolveConfigExtends(getPreset('geolint/recommended')!, cwd);
  return resolveConfig(config, path ? dirname(path) : cwd);
}
