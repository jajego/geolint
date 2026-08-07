import { realpath, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import fg from 'fast-glob';

import { assertGlob, matchesGlob, normalizePath } from '../config/glob.js';
import { normalizeFilePath } from '../config/resolve.js';
import { GeoLintTargetError } from '../engine/errors.js';
import type { ResolvedConfig } from '../types/config.js';

export interface ResolvedTarget {
  readonly filePath: string;
  readonly absolutePath: string;
}

async function pathKind(
  path: string,
): Promise<'file' | 'directory' | undefined> {
  try {
    const info = await stat(path);
    return info.isFile()
      ? 'file'
      : info.isDirectory()
        ? 'directory'
        : undefined;
  } catch {
    return undefined;
  }
}

async function expand(pattern: string, cwd: string): Promise<string[]> {
  assertGlob(pattern);
  return fg(pattern, {
    cwd,
    absolute: true,
    onlyFiles: true,
    caseSensitiveMatch: true,
    dot: false,
    followSymbolicLinks: false,
  });
}

export async function resolveTargets(
  config: ResolvedConfig,
  targets: readonly string[] | undefined,
  cwd: string,
  noIgnore = false,
): Promise<readonly ResolvedTarget[]> {
  const root = resolve(cwd);
  const patterns = targets ?? config.files;
  if (!patterns?.length)
    throw new GeoLintTargetError(
      'No targets were provided and config.files is unset.',
      'GEOLINT_NO_TARGETS',
    );
  const candidates: string[] = [];
  for (const target of patterns) {
    if (target === '-') continue;
    const literal = resolve(root, target);
    const kind = await pathKind(literal);
    if (kind === 'file') candidates.push(literal);
    else if (kind === 'directory')
      candidates.push(...(await expand('**/*.geojson', literal)));
    else {
      const matches = await expand(target, root);
      if (targets && matches.length === 0)
        throw new GeoLintTargetError(
          `No files matched "${target}".`,
          'GEOLINT_UNMATCHED_TARGET',
        );
      candidates.push(...matches);
    }
  }
  const byRealPath = new Map<string, ResolvedTarget>();
  for (const absolutePath of candidates) {
    const filePath = normalizeFilePath(config.projectRoot, absolutePath);
    if (!noIgnore && matchesGlob(filePath, config.ignores ?? [])) continue;
    const real = await realpath(absolutePath).catch(() => absolutePath);
    const previous = byRealPath.get(real);
    if (!previous || filePath < previous.filePath)
      byRealPath.set(real, { filePath, absolutePath });
  }
  const resolved = [...byRealPath.values()].sort((left, right) =>
    left.filePath.localeCompare(right.filePath),
  );
  if (!resolved.length && !targets)
    throw new GeoLintTargetError(
      'No files matched config.files.',
      'GEOLINT_NO_TARGETS',
    );
  return resolved;
}

export function stdinTarget(): ResolvedTarget {
  return { filePath: '<stdin>', absolutePath: '-' };
}
