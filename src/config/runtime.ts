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
  let path: string | undefined;
  if (typeof supplied === 'string') path = resolve(cwd, supplied);
  else if (!options.noConfig) path = await discoverConfig(cwd);
  let config: GeoLintConfig;
  if (typeof supplied === 'object')
    config = await resolveConfigExtends(supplied, cwd);
  else if (path) config = await loadConfigWithExtends(path);
  else
    config = await resolveConfigExtends(getPreset('geolint/recommended')!, cwd);
  return resolveConfig(config, path ? dirname(path) : cwd);
}
