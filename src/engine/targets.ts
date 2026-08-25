import { lstat as lstatCallback, stat as statCallback } from 'node:fs';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { glob, type FileSystemAdapter } from 'tinyglobby';

import {
  assertGlob,
  compileGlobMatcher,
  normalizePath,
} from '../config/glob.js';
import {
  compileFileConfigResolver,
  normalizeFilePath,
  resolveFileConfig,
} from '../config/resolve.js';
import { GeoLintTargetError } from './errors.js';
import type { ResolvedConfig, ResolvedFileConfig } from '../types/config.js';
import type { Dirent } from 'node:fs';

const REALPATH_CONCURRENCY = 8;

interface TargetResolutionContext {
  // These Promise caches exist for one resolveTargets() call. Prefix checks
  // and result-casing work share in-flight directory reads.
  readonly casingDirectoryReads: Map<string, Promise<Dirent[]>>;
  readonly physicalPathResolutions: Map<string, Promise<string>>;
}

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

/** Internal benchmark hook; never exposed from the package entry point. */
export interface TargetResolutionProfile {
  readonly realpathConcurrency?: number;
  record(phase: string, durationMs: number): void;
  count(name: string, amount?: number): void;
}

async function measured<T>(
  profile: TargetResolutionProfile | undefined,
  phase: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (!profile) return operation();
  const startedAt = performance.now();
  const value = await operation();
  profile.record(phase, performance.now() - startedAt);
  return value;
}

async function explicitPathKind(
  path: string,
  profile?: TargetResolutionProfile,
): Promise<'file' | 'directory' | undefined> {
  try {
    profile?.count('lstat');
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) {
      profile?.count('stat');
      return (await stat(path)).isFile() ? 'file' : undefined;
    }
    if (entry.isFile()) return 'file';
    if (entry.isDirectory()) return 'directory';
    return undefined;
  } catch {
    return undefined;
  }
}

function symlinkCompatibleFileSystem(): FileSystemAdapter {
  return {
    // tinyglobby resolves directory links by default. GeoLint deliberately does
    // not traverse them, while file links retain their logical path.
    realpath(
      path: string,
      callback: (error: Error | null, path: string) => void,
    ) {
      lstatCallback(path, (lstatError, entry) => {
        if (lstatError) return callback(lstatError, path);
        if (!entry.isSymbolicLink()) return callback(null, path);
        statCallback(path, (statError, target) => {
          if (statError) return callback(statError, path);
          if (target.isDirectory())
            return callback(
              new Error('GeoLint does not traverse directory links.'),
              path,
            );
          return callback(null, path);
        });
      });
    },
  } as FileSystemAdapter;
}

function isDynamicGlobSegment(segment: string): boolean {
  return [...segment].some((character) => '*?[]{}'.includes(character));
}

/** Returns only ignores that exclude every descendant of a literal subtree. */
function traversalSafeIgnores(ignores: readonly string[]): string[] {
  return ignores.flatMap((ignore) => {
    const segments = normalizePath(ignore).split('/');
    if (
      segments.length < 2 ||
      segments.at(-1) !== '**' ||
      segments
        .slice(0, -1)
        .some(
          (segment) =>
            segment === '' ||
            segment === '.' ||
            segment === '..' ||
            isDynamicGlobSegment(segment),
        )
    )
      return [];
    return [normalizePath(ignore)];
  });
}

/** Stops at the first dynamic segment; later segments are tinyglobby's job. */
function staticGlobPrefix(pattern: string): string {
  const segments: string[] = [];
  for (const segment of normalizePath(pattern).split('/')) {
    if (isDynamicGlobSegment(segment)) break;
    segments.push(segment);
  }
  return segments.join('/');
}

async function exactStaticPrefixCase(
  pattern: string,
  cwd: string,
  context: TargetResolutionContext,
  profile?: TargetResolutionProfile,
): Promise<boolean> {
  const prefix = staticGlobPrefix(pattern);
  if (!prefix) return true;
  const path = resolve(cwd, prefix);
  let current = resolve(cwd);
  for (const segment of normalizePath(relative(cwd, path)).split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      current = resolve(current, '..');
      continue;
    }
    try {
      profile?.count('staticPrefixComponents');
      let entriesPromise = context.casingDirectoryReads.get(current);
      if (!entriesPromise) {
        profile?.count('staticPrefixReaddir');
        entriesPromise = readdir(current, { withFileTypes: true });
        context.casingDirectoryReads.set(current, entriesPromise);
      } else profile?.count('staticPrefixCacheHits');
      if (!(await entriesPromise).some((entry) => entry.name === segment))
        return false;
      current = join(current, segment);
    } catch {
      return false;
    }
  }
  return true;
}

async function expand(
  patterns: readonly string[],
  cwd: string,
  context: TargetResolutionContext,
  ignores: readonly string[] = [],
  profile?: TargetResolutionProfile,
): Promise<string[]> {
  const normalizedPatterns = patterns.map((pattern) => {
    assertGlob(pattern);
    return normalizePath(pattern);
  });
  const caseValidPatterns = (
    await Promise.all(
      normalizedPatterns.map(async (pattern) =>
        (await exactStaticPrefixCase(pattern, cwd, context, profile))
          ? pattern
          : undefined,
      ),
    )
  ).filter((pattern): pattern is string => pattern !== undefined);
  if (caseValidPatterns.length === 0) return [];
  profile?.count('tinyGlob');
  const paths = await measured(profile, 'tinyGlob', () =>
    glob(caseValidPatterns, {
      cwd,
      absolute: true,
      onlyFiles: true,
      caseSensitiveMatch: true,
      braceExpansion: true,
      dot: false,
      extglob: false,
      expandDirectories: false,
      followSymbolicLinks: true,
      globstar: true,
      ignore: ignores.map(normalizePath),
      fs: symlinkCompatibleFileSystem(),
    }),
  );
  profile?.count('tinyGlobCandidates', paths.length);
  const casingStartedAt = profile ? performance.now() : 0;
  const logicalPaths = await Promise.all(
    paths.map((path) => canonicalLogicalPath(path, cwd, context, profile)),
  );
  if (profile) {
    const casingDuration = performance.now() - casingStartedAt;
    profile.record('casing', casingDuration);
    profile.record('casingReaddir', casingDuration);
  }
  return logicalPaths;
}

/** Restores filesystem casing without resolving symlink targets. */
async function canonicalLogicalPath(
  path: string,
  cwd: string,
  context: TargetResolutionContext,
  profile?: TargetResolutionProfile,
): Promise<string> {
  const segments = normalizePath(relative(cwd, path)).split('/');
  let current = resolve(cwd);
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    try {
      profile?.count('casingComponents');
      let entriesPromise = context.casingDirectoryReads.get(current);
      if (!entriesPromise) {
        profile?.count('casingReaddir');
        entriesPromise = readdir(current, { withFileTypes: true });
        context.casingDirectoryReads.set(current, entriesPromise);
      } else profile?.count('casingCacheHits');
      const entries = await entriesPromise;
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
  context: TargetResolutionContext,
  profile?: TargetResolutionProfile,
): Promise<{ files: string[]; stdin: boolean }> {
  const files: string[] = [];
  let stdin = false;
  for (const target of targets) {
    if (target === '-') {
      stdin = true;
      continue;
    }
    const literal = resolve(cwd, target);
    const kind = await explicitPathKind(literal, profile);
    if (kind === 'file') files.push(literal);
    else if (kind === 'directory')
      files.push(
        ...(await expand(['**/*.geojson'], literal, context, [], profile)),
      );
    else {
      const matches = await expand([target], cwd, context, [], profile);
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

async function collectConfigured(
  config: ResolvedConfig,
  context: TargetResolutionContext,
  noIgnore: boolean,
  profile?: TargetResolutionProfile,
): Promise<string[]> {
  if (!config.files?.length) {
    throw new GeoLintTargetError(
      'No targets were provided and config.files is unset.',
      'GEOLINT_NO_TARGETS',
    );
  }
  const authoritativeIgnores = noIgnore ? [] : (config.ignores ?? []);
  const traversalIgnores = traversalSafeIgnores(authoritativeIgnores);
  profile?.count('traversalPrunes', traversalIgnores.length);
  let matches = await expand(
    config.files,
    config.projectRoot,
    context,
    traversalIgnores,
    profile,
  );
  // Preserve the existing distinction between no configured matches and
  // configured matches removed by top-level ignores.
  if (matches.length === 0 && traversalIgnores.length)
    matches = await expand(
      config.files,
      config.projectRoot,
      context,
      [],
      profile,
    );
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
  profile?: TargetResolutionProfile,
): Promise<readonly ResolvedTarget[]> {
  const totalStartedAt = profile ? performance.now() : 0;
  const context: TargetResolutionContext = {
    casingDirectoryReads: new Map(),
    physicalPathResolutions: new Map(),
  };
  const explicit = targets !== undefined;
  const collected = await measured(profile, 'collection', async () =>
    explicit
      ? collectExplicit(targets!, resolve(cwd), context, profile)
      : {
          files: await collectConfigured(config, context, noIgnore, profile),
          stdin: false,
        },
  );
  if (explicit && collected.files.length === 0 && !collected.stdin) {
    throw new GeoLintTargetError(
      'No targets were provided.',
      'GEOLINT_NO_TARGETS',
    );
  }

  const logicalCandidates = new Map<
    string,
    { absolutePath: string; filePath: string }
  >();
  for (const absolutePath of collected.files) {
    const filePath = normalizeFilePath(config.projectRoot, absolutePath);
    logicalCandidates.set(filePath, { absolutePath, filePath });
  }

  const byRealPath = new Map<
    string,
    { filePath: string; absolutePath: string }
  >();
  const matchesIgnore = compileGlobMatcher(config.ignores ?? []);
  let policyMatching = 0;
  let deduplication = 0;
  const physicalCandidates: { absolutePath: string; filePath: string }[] = [];
  for (const { absolutePath, filePath } of logicalCandidates.values()) {
    const policyStartedAt = profile ? performance.now() : 0;
    const ignored = !noIgnore && matchesIgnore(filePath);
    if (profile) policyMatching += performance.now() - policyStartedAt;
    if (ignored) continue;
    physicalCandidates.push({ absolutePath, filePath });
  }
  const uniquePaths = [
    ...new Set(physicalCandidates.map(({ absolutePath }) => absolutePath)),
  ];
  const realpathStartedAt = profile ? performance.now() : 0;
  let nextPath = 0;
  // Benchmarks found 4–8 to be the performance/resource knee; higher values
  // had inconsistent marginal gains and add filesystem pressure.
  const concurrency = Math.min(
    Math.max(1, profile?.realpathConcurrency ?? REALPATH_CONCURRENCY),
    uniquePaths.length,
  );
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (nextPath < uniquePaths.length) {
        const absolutePath = uniquePaths[nextPath++]!;
        profile?.count('realpath');
        const physicalPath = realpath(absolutePath).catch(() => absolutePath);
        context.physicalPathResolutions.set(absolutePath, physicalPath);
        await physicalPath;
      }
    }),
  );
  profile?.count(
    'realpathCacheHits',
    physicalCandidates.length - uniquePaths.length,
  );
  if (profile)
    profile.record('realpath', performance.now() - realpathStartedAt);
  for (const { absolutePath, filePath } of physicalCandidates) {
    const real = await context.physicalPathResolutions.get(absolutePath)!;
    const dedupStartedAt = profile ? performance.now() : 0;
    const previous = byRealPath.get(real);
    if (!previous || filePath < previous.filePath) {
      byRealPath.set(real, { filePath, absolutePath });
    }
    if (previous) profile?.count('aliasesCollapsed');
    if (profile) deduplication += performance.now() - dedupStartedAt;
  }
  if (profile) {
    profile.record('deduplication', deduplication);
  }

  const finalizationStartedAt = profile ? performance.now() : 0;
  const policyBeforeFinalization = policyMatching;
  const resolveFile = compileFileConfigResolver(config);
  const resolved: ResolvedTarget[] = [...byRealPath.values()].map(
    ({ filePath, absolutePath }) => {
      const startedAt = profile ? performance.now() : 0;
      const config = resolveFile(filePath);
      if (profile) policyMatching += performance.now() - startedAt;
      return { kind: 'file', filePath, absolutePath, config };
    },
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
  if (profile) profile.record('policyMatching', policyMatching);
  if (profile)
    profile.record(
      'finalization',
      performance.now() -
        finalizationStartedAt -
        (policyMatching - policyBeforeFinalization),
    );
  if (profile) profile.record('total', performance.now() - totalStartedAt);
  if (resolved.length === 0 && !explicit) {
    throw new GeoLintTargetError(
      'No files matched config.files after ignores.',
      'GEOLINT_NO_TARGETS',
    );
  }
  return resolved;
}
