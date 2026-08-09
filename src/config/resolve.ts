import { relative, resolve } from 'node:path';

import { matchesGlob, normalizePath } from './glob.js';
import { mergeConfig, mergeOverride } from './merge.js';
import { validateConfig } from './validate.js';
import type {
  GeoLintConfig,
  ResolvedConfig,
  ResolvedFileConfig,
} from '../types/config.js';
import { stabilizePlugin } from '../plugins/plugin.js';

export function normalizeFilePath(
  projectRoot: string,
  fileName: string,
): string {
  const root = resolve(normalizePath(projectRoot));
  return (
    normalizePath(relative(root, resolve(root, normalizePath(fileName)))) || '.'
  );
}

export function resolveConfig(
  config: GeoLintConfig,
  projectRoot: string,
): ResolvedConfig {
  validateConfig(config);
  return finalizeConfig(mergeConfig({}, config), projectRoot);
}

function finalizeConfig(
  merged: GeoLintConfig,
  projectRoot: string,
): ResolvedConfig {
  const resolvedConfig: ResolvedConfig = {
    projectRoot: resolve(projectRoot),
    plugins: Object.freeze(
      Object.fromEntries(
        Object.entries(merged.plugins ?? {}).map(([namespace, plugin]) => [
          namespace,
          stabilizePlugin(plugin),
        ]),
      ),
    ),
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
    ...finalizeConfig(merged, config.projectRoot),
    filePath,
    matchingOverrides: Object.freeze(matchingOverrides),
  });
}
