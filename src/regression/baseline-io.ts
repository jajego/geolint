import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

import { GeoLintCapabilityError, GeoLintIOError } from '../engine/errors.js';
import type { ResolvedConfig } from '../types/config.js';
import {
  createBaseline,
  parseBaseline,
  serializeBaseline,
  type BaselineV1,
} from './schema.js';

export function resolveBaselinePath(config: ResolvedConfig): string {
  const configured = config.regression.baseline ?? '.geolint-baseline.json';
  return isAbsolute(configured)
    ? configured
    : resolve(config.projectRoot, configured);
}

export function regressionIdentity(filePath: string): string {
  if (
    filePath === '.' ||
    filePath.startsWith('<') ||
    filePath === '..' ||
    filePath.startsWith('../') ||
    isAbsolute(filePath) ||
    /^[A-Za-z]:\//.test(filePath)
  ) {
    throw new GeoLintCapabilityError(
      'Regression requires a filename that resolves beneath the project root.',
      'GEOLINT_CAPABILITY_REGRESSION_IDENTITY',
    );
  }
  return filePath.replaceAll('\\', '/');
}

export async function loadBaseline(path: string): Promise<BaselineV1> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return createBaseline({});
    }
    throw new GeoLintIOError(
      `Could not read GeoLint baseline at ${path}.`,
      'GEOLINT_BASELINE_READ_FAILED',
      { cause: error },
    );
  }
  return parseBaseline(text);
}

export async function writeBaselineAtomic(
  path: string,
  baseline: BaselineV1,
): Promise<void> {
  const directory = dirname(path);
  const temporary = resolve(
    directory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await mkdir(directory, { recursive: true });
    const serialized = serializeBaseline(baseline);
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new GeoLintIOError(
      `Could not replace GeoLint baseline at ${path}.`,
      'GEOLINT_BASELINE_WRITE_FAILED',
      { cause: error },
    );
  }
}
