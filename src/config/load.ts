import { readFile } from 'node:fs/promises';
import { createJiti } from 'jiti';
import { dirname, extname, resolve } from 'node:path';

import { mergeConfig } from './merge.js';
import { getPreset } from './presets.js';
import { GeoLintConfigError } from '../engine/errors.js';
import type { GeoLintConfig } from '../types/config.js';

function isConfig(value: unknown): value is GeoLintConfig {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function loadConfig(path: string): Promise<GeoLintConfig> {
  const absolutePath = resolve(path);
  try {
    const loaded =
      extname(absolutePath) === '.json'
        ? JSON.parse(await readFile(absolutePath, 'utf8'))
        : await createJiti(dirname(absolutePath), {
            interopDefault: true,
          }).import(absolutePath);
    if (!isConfig(loaded))
      throw new Error('The default export must be an object.');
    return loaded;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new GeoLintConfigError(
      `Unable to load ${absolutePath}: ${detail}`,
      'GEOLINT_INVALID_CONFIG',
    );
  }
}

async function expandConfig(
  config: GeoLintConfig,
  baseDirectory: string,
  seen: ReadonlySet<string>,
): Promise<GeoLintConfig> {
  let merged: GeoLintConfig = {};
  for (const reference of config.extends ?? []) {
    const preset = getPreset(reference);
    if (preset) {
      merged = mergeConfig(
        merged,
        await expandConfig(preset, baseDirectory, seen),
      );
      continue;
    }
    const jiti = createJiti(baseDirectory, { interopDefault: true });
    const path = jiti.resolve(reference);
    if (seen.has(path)) {
      throw new GeoLintConfigError(
        `Circular config extends: ${reference}`,
        'GEOLINT_CIRCULAR_CONFIG',
      );
    }
    const inherited = await loadConfig(path);
    merged = mergeConfig(
      merged,
      await expandConfig(inherited, dirname(path), new Set(seen).add(path)),
    );
  }
  return mergeConfig(merged, { ...config, extends: [] });
}

export async function loadConfigWithExtends(
  path: string,
): Promise<GeoLintConfig> {
  const absolutePath = resolve(path);
  return expandConfig(
    await loadConfig(absolutePath),
    dirname(absolutePath),
    new Set([absolutePath]),
  );
}
