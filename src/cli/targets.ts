import { lstat, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import fg from 'fast-glob';

import { assertGlob, matchesGlob } from '../config/glob.js';
import { normalizeFilePath, resolveFileConfig } from '../config/resolve.js';
import { GeoLintTargetError } from '../engine/errors.js';
import type { ResolvedConfig, ResolvedFileConfig } from '../types/config.js';

export type ResolvedTarget =
  | {
      readonly kind: 'file';
      readonly filePath: string;
      readonly absolutePath: string;
      readonly config: ResolvedFileConfig;
    }
  | {
      readonly kind: 'stdin';
      readonly filePath: string;
      readonly absolutePath: '-';
      readonly config: ResolvedFileConfig;
    };

async function explicitPathKind(
  path: string,
): Promise<'file' | 'directory' | undefined> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) {
      return (await stat(path)).isFile() ? 'file' : undefined;
    }
    return entry.isFile()
      ? 'file'
      : entry.isDirectory()
        ? 'directory'
        : undefined;
  } catch {
    return undefined;
  }
}

async function expand(pattern: string, cwd: string): Promise<string[]> {
  assertGlob(pattern);
  const paths = await fg(pattern, {
    cwd,
    absolute: true,
    onlyFiles: true,
    caseSensitiveMatch: true,
    dot: false,
    followSymbolicLinks: false,
  });
  const canonicalPaths = await Promise.all(
    paths.map((path) => realpath(path).catch(() => path)),
  );
  return paths.filter((_, index) =>
    matchesGlob(normalizeFilePath(cwd, canonicalPaths[index]!), [pattern]),
  );
}

async function collectExplicit(
  targets: readonly string[],
  cwd: string,
): Promise<{ files: string[]; stdin: boolean }> {
  const files: string[] = [];
  let stdin = false;
  for (const target of targets) {
    if (target === '-') {
      stdin = true;
      continue;
    }
    const literal = resolve(cwd, target);
    const kind = await explicitPathKind(literal);
    if (kind === 'file') files.push(literal);
    else if (kind === 'directory')
      files.push(...(await expand('**/*.geojson', literal)));
    else {
      const matches = await expand(target, cwd);
      if (matches.length === 0) {
        throw new GeoLintTargetError(
          `No files matched "${target}".`,
          'GEOLINT_UNMATCHED_TARGET',
        );
      }
      files.push(...matches);
    }
  }
  return { files, stdin };
}

async function collectConfigured(config: ResolvedConfig): Promise<string[]> {
  if (!config.files?.length) {
    throw new GeoLintTargetError(
      'No targets were provided and config.files is unset.',
      'GEOLINT_NO_TARGETS',
    );
  }
  const matches = (
    await Promise.all(
      config.files.map((pattern) => expand(pattern, config.projectRoot)),
    )
  ).flat();
  if (matches.length === 0) {
    throw new GeoLintTargetError(
      'No files matched config.files.',
      'GEOLINT_NO_TARGETS',
    );
  }
  return matches;
}

function baseFileConfig(
  config: ResolvedConfig,
  filePath: string,
): ResolvedFileConfig {
  return Object.freeze({
    ...config,
    filePath,
    matchingOverrides: Object.freeze([]),
  });
}

export async function resolveTargets(
  config: ResolvedConfig,
  targets: readonly string[] | undefined,
  cwd: string,
  noIgnore = false,
  stdinFilename?: string,
): Promise<readonly ResolvedTarget[]> {
  const explicit = targets !== undefined;
  const collected = explicit
    ? await collectExplicit(targets, resolve(cwd))
    : { files: await collectConfigured(config), stdin: false };
  if (explicit && collected.files.length === 0 && !collected.stdin) {
    throw new GeoLintTargetError(
      'No targets were provided.',
      'GEOLINT_NO_TARGETS',
    );
  }

  const byRealPath = new Map<
    string,
    { filePath: string; absolutePath: string }
  >();
  for (const absolutePath of collected.files) {
    const filePath = normalizeFilePath(config.projectRoot, absolutePath);
    if (!noIgnore && matchesGlob(filePath, config.ignores ?? [])) continue;
    const real = await realpath(absolutePath).catch(() => absolutePath);
    const previous = byRealPath.get(real);
    if (!previous || filePath < previous.filePath) {
      byRealPath.set(real, { filePath, absolutePath });
    }
  }

  const resolved: ResolvedTarget[] = [...byRealPath.values()].map(
    ({ filePath, absolutePath }) => ({
      kind: 'file',
      filePath,
      absolutePath,
      config: resolveFileConfig(config, filePath),
    }),
  );
  if (collected.stdin) {
    const filePath = stdinFilename
      ? normalizeFilePath(config.projectRoot, stdinFilename)
      : '<stdin>';
    resolved.push({
      kind: 'stdin',
      filePath,
      absolutePath: '-',
      config: stdinFilename
        ? resolveFileConfig(config, stdinFilename)
        : baseFileConfig(config, filePath),
    });
  }
  resolved.sort((left, right) =>
    left.filePath < right.filePath
      ? -1
      : left.filePath > right.filePath
        ? 1
        : 0,
  );
  if (resolved.length === 0 && !explicit) {
    throw new GeoLintTargetError(
      'No files matched config.files after ignores.',
      'GEOLINT_NO_TARGETS',
    );
  }
  return resolved;
}
