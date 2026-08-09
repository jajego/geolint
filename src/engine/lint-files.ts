import { stat } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';

import { resolveTargets, type ResolvedTarget } from './targets.js';
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
import { WorkerPool } from '../workers/pool.js';
import { deserializeWorkerError } from '../workers/errors.js';
import type {
  SerializedResolvedPolicy,
  WorkerLintTask,
  WorkerPluginReference,
} from '../workers/protocol.js';
import {
  lintResolvedBytes,
  lintResolvedFile,
  type ParserStrategy,
  type ResolvedSourceOptions,
} from './lint-input.js';
import {
  GeoLintBatchError,
  GeoLintCapabilityError,
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
  readonly workers?: number;
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

function pluginReferences(
  target: ResolvedTarget,
): readonly WorkerPluginReference[] | undefined {
  const references: WorkerPluginReference[] = [];
  for (const [namespace, plugin] of Object.entries(target.config.plugins)) {
    if (!plugin.meta.moduleUrl || !plugin.meta.exportName) return undefined;
    references.push({
      namespace,
      moduleUrl: plugin.meta.moduleUrl,
      exportName: plugin.meta.exportName,
      apiVersion: 1,
    });
  }
  return references;
}

function serializedPolicy(target: ResolvedTarget): SerializedResolvedPolicy {
  const config = target.config;
  return {
    projectRoot: config.projectRoot,
    rules: config.rules,
    budgets: config.budgets,
    regression: config.regression,
    diagnostics: config.diagnostics,
    overrides: [],
  };
}

interface WorkerDecision {
  readonly available: number;
  readonly files: number;
  readonly mode: string;
  readonly count: number;
  readonly reason: string;
}

async function workerDecision(
  targets: readonly ResolvedTarget[],
  requested: number | undefined,
): Promise<WorkerDecision> {
  const available = availableParallelism();
  const files = targets.filter((target) => target.kind === 'file');
  const mode = requested === undefined ? 'auto' : String(requested);
  let effective = 1;
  let reason = 'workload below worker threshold';
  const nonReloadable = files
    .flatMap((target) => Object.entries(target.config.plugins))
    .find(([, plugin]) => !plugin.meta.moduleUrl || !plugin.meta.exportName);
  if (requested === 1) reason = 'explicit workers=1';
  else if (targets.some((target) => target.kind === 'stdin'))
    reason = 'stdin is single-threaded';
  else if (nonReloadable) {
    if (requested && requested > 1)
      throw new GeoLintCapabilityError(
        `Worker parallelism requires reloadable plugin ${JSON.stringify(nonReloadable[0])}.`,
        'GEOLINT_CAPABILITY_PLUGIN_NOT_RELOADABLE',
      );
    reason = `plugin ${JSON.stringify(nonReloadable[0])} is not reloadable`;
  } else if (requested && requested > 1) {
    effective = Math.min(requested, available, files.length);
    reason = 'explicit worker count';
  } else if (files.length >= 4 && available >= 2) {
    const sizes = await Promise.all(
      files.map((target) =>
        stat(target.absolutePath)
          .then((entry) => entry.size)
          .catch(() => 0),
      ),
    );
    const averageBytes =
      sizes.reduce((total, size) => total + size, 0) / sizes.length;
    if (averageBytes >= 5_000_000) {
      effective = Math.min(4, available, files.length);
      reason = 'large multi-file workload';
    }
  }
  return { available, files: files.length, mode, count: effective, reason };
}

function debugWorkerDecision(
  decision: WorkerDecision,
  debug: ((message: string) => void) | undefined,
): void {
  debug?.(`worker mode: ${decision.mode}`);
  debug?.(`available parallelism: ${decision.available}`);
  debug?.(`eligible files: ${decision.files}`);
  debug?.(`effective workers: ${decision.count}`);
  debug?.(`worker reason: ${decision.reason}`);
}

function workerTasks(
  targets: readonly ResolvedTarget[],
  parser: ParserStrategy,
  baseline: BaselineV1 | undefined,
): readonly WorkerLintTask[] {
  return targets.map((target, taskId): WorkerLintTask => {
    if (target.kind !== 'file')
      throw new GeoLintInternalError(
        'Stdin cannot be dispatched to a Worker.',
        'GEOLINT_WORKER_STDIN',
      );
    const plugins = pluginReferences(target);
    if (!plugins)
      throw new GeoLintCapabilityError(
        'Worker task contains a non-reloadable plugin.',
        'GEOLINT_CAPABILITY_PLUGIN_NOT_RELOADABLE',
      );
    const options = sourceOptions(target, parser, baseline);
    return {
      protocolVersion: 1,
      type: 'lint',
      taskId,
      absolutePath: target.absolutePath,
      filePath: target.filePath,
      policy: serializedPolicy(target),
      plugins,
      parser,
      ...(options.baseline ? { baseline: options.baseline } : {}),
    };
  });
}

function cloneable(tasks: readonly WorkerLintTask[]): boolean {
  try {
    for (const task of tasks) structuredClone(task);
    return true;
  } catch {
    return false;
  }
}

async function executeWorkers(
  tasks: readonly WorkerLintTask[],
  workerCount: number,
): Promise<{
  files: readonly FileLintResult[];
  errors: readonly GeoLintError[];
}> {
  let pool: WorkerPool;
  try {
    pool = await WorkerPool.create(workerCount);
  } catch (cause) {
    throw new GeoLintInternalError(
      'Could not start GeoLint Workers.',
      'GEOLINT_WORKER_FAILURE',
      { cause },
    );
  }
  try {
    const outcomes = await pool.run(tasks).catch((cause: unknown) => {
      throw new GeoLintInternalError(
        'Could not dispatch a GeoLint Worker task.',
        'GEOLINT_WORKER_FAILURE',
        { cause },
      );
    });
    return {
      files: outcomes.flatMap((outcome) =>
        outcome.type === 'lint-result' ? [outcome.result] : [],
      ),
      errors: outcomes.flatMap((outcome) =>
        outcome.type === 'error' ? [deserializeWorkerError(outcome.error)] : [],
      ),
    };
  } finally {
    await pool.terminate();
  }
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
  let decision = await workerDecision(targets, options.workers);
  if (decision.count > 1) {
    const tasks = workerTasks(targets, parser, baseline);
    if (!cloneable(tasks)) {
      if (options.workers && options.workers > 1)
        throw new GeoLintCapabilityError(
          'Worker task is not structured-clone-safe.',
          'GEOLINT_CAPABILITY_WORKER_TASK_NOT_CLONEABLE',
        );
      decision = {
        ...decision,
        count: 1,
        reason: 'resolved task not structured-clone-safe',
      };
      options.debug?.(
        'Worker parallelism disabled because the resolved worker task is not structured-clone-safe.',
      );
    } else {
      debugWorkerDecision(decision, options.debug);
      const parallel = await executeWorkers(tasks, decision.count);
      files.push(...parallel.files);
      errors.push(...parallel.errors);
    }
  }
  if (decision.count <= 1) {
    debugWorkerDecision(decision, options.debug);
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
  }
  const result = createLintResult(files, startedAt);
  if (errors.length > 0) throw new GeoLintBatchError(errors, result);
  return result;
}

export function lintFiles(options: LintFilesOptions = {}): Promise<LintResult> {
  return executeLintFiles(options);
}
