import { relative, resolve } from 'node:path';

import { matchesGlob, normalizePath } from './glob.js';
import { mergeConfig, mergeOverride } from './merge.js';
import { getPreset } from './presets.js';
import { GeoLintConfigError } from '../engine/errors.js';
import type {
  GeoLintConfig,
  ResolvedConfig,
  ResolvedFileConfig,
} from '../types/config.js';

export function normalizeFilePath(
  projectRoot: string,
  fileName: string,
): string {
  return (
    normalizePath(relative(projectRoot, resolve(projectRoot, fileName))) || '.'
  );
}

export function resolveConfig(
  config: GeoLintConfig,
  projectRoot: string,
  resolveExtension: (
    reference: string,
  ) => GeoLintConfig | undefined = getPreset,
  seen = new Set<string>(),
): ResolvedConfig {
  let merged: GeoLintConfig = {};
  for (const reference of config.extends ?? []) {
    if (seen.has(reference)) {
      throw new GeoLintConfigError(
        `Circular config extends: ${reference}`,
        'GEOLINT_CIRCULAR_CONFIG',
      );
    }
    const inherited = resolveExtension(reference);
    if (!inherited) {
      throw new GeoLintConfigError(
        `Cannot resolve config extension "${reference}".`,
        'GEOLINT_CONFIG_NOT_FOUND',
      );
    }
    const nextSeen = new Set(seen).add(reference);
    merged = mergeConfig(
      merged,
      resolveConfig(inherited, projectRoot, resolveExtension, nextSeen),
    );
  }
  merged = mergeConfig(merged, config);
  const resolvedConfig: ResolvedConfig = {
    projectRoot: resolve(projectRoot),
    plugins: Object.freeze({ ...merged.plugins }),
    rules: Object.freeze({ ...merged.rules }),
    budgets: Object.freeze({ ...merged.budgets }),
    regression: Object.freeze({ ...merged.regression }),
    diagnostics: Object.freeze({ ...merged.diagnostics }),
    overrides: Object.freeze([...(merged.overrides ?? [])]),
    ...(merged.files ? { files: merged.files } : {}),
    ...(merged.ignores ? { ignores: merged.ignores } : {}),
  };
  return Object.freeze(resolvedConfig);
}

export function resolveFileConfig(
  config: ResolvedConfig,
  fileName: string,
): ResolvedFileConfig {
  const filePath = normalizeFilePath(config.projectRoot, fileName);
  let merged: GeoLintConfig = config;
  const matchingOverrides: number[] = [];
  config.overrides.forEach((override, index) => {
    if (
      matchesGlob(filePath, override.files) &&
      !matchesGlob(filePath, override.ignores ?? [])
    ) {
      merged = mergeOverride(merged, override);
      matchingOverrides.push(index);
    }
  });
  return Object.freeze({
    ...resolveConfig(merged, config.projectRoot),
    filePath,
    matchingOverrides: Object.freeze(matchingOverrides),
  });
}
