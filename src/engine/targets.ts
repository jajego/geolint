import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import fg from 'fast-glob';

import { assertGlob, matchesGlob, normalizePath } from '../config/glob.js';
import { normalizeFilePath, resolveFileConfig } from '../config/resolve.js';
import { GeoLintTargetError } from './errors.js';
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
    if (entry.isFile()) return 'file';
    if (entry.isDirectory()) return 'directory';
    return undefined;
  } catch {
    return undefined;
  }
}

async function expand(pattern: string, cwd: string): Promise<string[]> {
  assertGlob(pattern);
  const normalizedPattern = normalizePath(pattern);
  const paths = await fg(normalizedPattern, {
    cwd,
    absolute: true,
    onlyFiles: false,
    caseSensitiveMatch: true,
    braceExpansion: true,
    dot: false,
    extglob: false,
    followSymbolicLinks: false,
    globstar: true,
  });
  const files = (
    await Promise.all(
      paths.map(async (path) =>
        (await explicitPathKind(path)) === 'file' ? path : undefined,
      ),
    )
  ).filter((path): path is string => path !== undefined);
  const logicalPaths = await Promise.all(
    files.map((path) => canonicalLogicalPath(path, cwd)),
  );
  return logicalPaths.filter((path) =>
    matchesGlob(normalizeFilePath(cwd, path), [normalizedPattern]),
  );
}

/** Restores filesystem casing without resolving symlink targets. */
async function canonicalLogicalPath(
  path: string,
  cwd: string,
): Promise<string> {
  const segments = normalizePath(relative(cwd, path)).split('/');
  let current = resolve(cwd);
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    try {
      const entries = await readdir(current, { withFileTypes: true });
      const entry =
        entries.find((candidate) => candidate.name === segment) ??
        entries.find(
          (candidate) => candidate.name.toLowerCase() === segment.toLowerCase(),
        );
      if (!entry) return path;
      current = join(current, entry.name);
    } catch {
      return path;
    }
  }
  return current;
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
  resolved.sort((left, right) => {
    if (left.filePath < right.filePath) return -1;
    if (left.filePath > right.filePath) return 1;
    return 0;
  });
  if (resolved.length === 0 && !explicit) {
    throw new GeoLintTargetError(
      'No files matched config.files after ignores.',
      'GEOLINT_NO_TARGETS',
    );
  }
  return resolved;
}
