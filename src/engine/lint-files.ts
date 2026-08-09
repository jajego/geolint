import { resolve } from 'node:path';

import { resolveTargets, type ResolvedTarget } from '../cli/targets.js';
import {
  resolveRuntimeConfig,
  type ConfigRuntimeOptions,
} from '../config/runtime.js';
import {
  loadBaseline,
  regressionIdentity,
  resolveBaselinePath,
} from '../regression/baseline-io.js';
import { hasEnabledRegression } from '../regression/compare.js';
import type { BaselineV1 } from '../regression/schema.js';
import type { GeoLintRuntimeContext } from '../types/config.js';
import type { FileLintResult, LintResult } from '../types/semantic.js';
import { geolintVersion } from '../version.js';
import {
  lintResolvedBytes,
  lintResolvedFile,
  type ParserStrategy,
  type ResolvedSourceOptions,
} from './lint-input.js';
import {
  GeoLintBatchError,
  GeoLintError,
  GeoLintInternalError,
} from './errors.js';

export interface LintFilesOptions extends GeoLintRuntimeContext {
  readonly targets?: readonly string[];
}

export interface BatchExecutionOptions
  extends LintFilesOptions, ConfigRuntimeOptions {
  readonly noIgnore?: boolean;
  readonly parser?: ParserStrategy;
  readonly stdinFilename?: string;
  readonly stdinBytes?: Uint8Array;
  readonly baselinePath?: string;
  readonly debug?: (message: string) => void;
}

export function createLintResult(
  files: readonly FileLintResult[],
  startedAt: number,
): LintResult {
  return Object.freeze({
    schemaVersion: 1,
    geolintVersion,
    files: Object.freeze([...files]),
    errorCount: files.reduce((total, file) => total + file.errorCount, 0),
    warningCount: files.reduce((total, file) => total + file.warningCount, 0),
    suppressedDiagnosticCount: files.reduce(
      (total, file) =>
        total +
        file.suppressedDiagnostics.reduce(
          (fileTotal, item) => fileTotal + item.suppressedCount,
          0,
        ),
      0,
    ),
    skippedPolicyCount: files.reduce(
      (total, file) => total + file.skippedPolicies.length,
      0,
    ),
    durationMs: performance.now() - startedAt,
  });
}

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function operationalError(error: unknown): GeoLintError {
  return error instanceof GeoLintError
    ? error
    : new GeoLintInternalError(
        error instanceof Error ? error.message : String(error),
        'GEOLINT_INTERNAL_ERROR',
        { cause: error },
      );
}

function sourceOptions(
  target: ResolvedTarget,
  parser: ParserStrategy,
  baseline: BaselineV1 | undefined,
): ResolvedSourceOptions {
  const enabled = hasEnabledRegression(target.config.regression);
  const entry = enabled
    ? baseline?.files[regressionIdentity(target.filePath)]
    : undefined;
  return {
    filePath: target.filePath,
    config: target.config,
    parser,
    ...(entry ? { baseline: entry } : {}),
  };
}

export async function executeLintFiles(
  options: BatchExecutionOptions = {},
): Promise<LintResult> {
  const startedAt = performance.now();
  const cwd = resolve(options.cwd ?? process.cwd());
  const config = await resolveRuntimeConfig(options);
  const targets = await resolveTargets(
    config,
    options.targets,
    cwd,
    options.noIgnore,
    options.stdinFilename,
  );
  const parser = options.parser ?? 'auto';
  const regression = targets.some((target) =>
    hasEnabledRegression(target.config.regression),
  );
  const baselinePath = options.baselinePath
    ? resolve(cwd, options.baselinePath)
    : resolveBaselinePath(config);
  const baseline = regression ? await loadBaseline(baselinePath) : undefined;
  options.debug?.(`project root: ${config.projectRoot}`);
  options.debug?.(
    `targets: ${targets.map(({ filePath }) => filePath).join(', ')}`,
  );
  options.debug?.(`parser: ${parser}`);
  if (regression) options.debug?.(`baseline: ${baselinePath}`);

  const files: FileLintResult[] = [];
  const errors: GeoLintError[] = [];
  let stdinBytes = options.stdinBytes;
  for (const target of targets) {
    try {
      const resolved = sourceOptions(target, parser, baseline);
      if (target.kind === 'file') {
        files.push(await lintResolvedFile(target.absolutePath, resolved));
      } else {
        stdinBytes ??= await readStdin();
        files.push(lintResolvedBytes(stdinBytes, resolved));
      }
    } catch (error) {
      errors.push(operationalError(error));
    }
  }
  const result = createLintResult(files, startedAt);
  if (errors.length > 0) throw new GeoLintBatchError(errors, result);
  return result;
}

export function lintFiles(options: LintFilesOptions = {}): Promise<LintResult> {
  return executeLintFiles(options);
}
