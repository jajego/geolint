import { readFile } from 'node:fs/promises';
import { createJiti } from 'jiti';
import { dirname, extname, resolve } from 'node:path';

import { mergeConfig } from './merge.js';
import { getPreset } from './presets.js';
import { validateConfig } from './validate.js';
import { GeoLintConfigError } from '../engine/errors.js';
import type { GeoLintConfig } from '../types/config.js';

function isConfig(value: unknown): value is GeoLintConfig {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function loadConfig(path: string): Promise<GeoLintConfig> {
  const absolutePath = resolve(path);
  try {
    const imported: unknown =
      extname(absolutePath) === '.json'
        ? JSON.parse(await readFile(absolutePath, 'utf8'))
        : await createJiti(dirname(absolutePath), {
            interopDefault: true,
          }).import(absolutePath);
    const loaded =
      isConfig(imported) &&
      Object.keys(imported).length === 1 &&
      'default' in imported
        ? imported.default
        : imported;
    if (!isConfig(loaded))
      throw new Error('The default export must be an object.');
    validateConfig(loaded);
    return loaded;
  } catch (error) {
    if (error instanceof GeoLintConfigError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    const code =
      isRecordWithCode(error) && error.code === 'ENOENT'
        ? 'GEOLINT_CONFIG_NOT_FOUND'
        : 'GEOLINT_INVALID_CONFIG';
    throw new GeoLintConfigError(
      `Unable to load ${absolutePath}: ${detail}`,
      code,
    );
  }
}

function isRecordWithCode(error: unknown): error is { code: unknown } {
  return error !== null && typeof error === 'object' && 'code' in error;
}

export async function resolveConfigExtends(
  config: GeoLintConfig,
  baseDirectory: string,
  seen: ReadonlySet<string> = new Set(),
): Promise<GeoLintConfig> {
  validateConfig(config);
  let merged: GeoLintConfig = {};
  for (const reference of config.extends ?? []) {
    const preset = getPreset(reference);
    if (preset) {
      const identity = `preset:${reference}`;
      if (seen.has(identity)) circular(reference);
      merged = mergeConfig(
        merged,
        await resolveConfigExtends(
          preset,
          baseDirectory,
          new Set(seen).add(identity),
        ),
      );
      continue;
    }
    const jiti = createJiti(baseDirectory, { interopDefault: true });
    let path: string;
    try {
      path = jiti.resolve(reference);
    } catch {
      throw new GeoLintConfigError(
        `Cannot resolve config extension "${reference}" from ${baseDirectory}.`,
        'GEOLINT_CONFIG_NOT_FOUND',
      );
    }
    if (seen.has(path)) circular(reference);
    const inherited = await loadConfig(path);
    merged = mergeConfig(
      merged,
      await resolveConfigExtends(
        inherited,
        dirname(path),
        new Set(seen).add(path),
      ),
    );
  }
  return mergeConfig(merged, config);
}

function circular(reference: string): never {
  throw new GeoLintConfigError(
    `Circular config extends: ${reference}`,
    'GEOLINT_CIRCULAR_CONFIG',
  );
}

export async function loadConfigWithExtends(
  path: string,
): Promise<GeoLintConfig> {
  const absolutePath = resolve(path);
  return resolveConfigExtends(
    await loadConfig(absolutePath),
    dirname(absolutePath),
    new Set([absolutePath]),
  );
}
