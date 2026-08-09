import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, cpus, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getPreset } from '../config/presets.js';
import { resolveConfig, resolveFileConfig } from '../config/resolve.js';
import { DiagnosticCollector } from '../engine/diagnostics.js';
import { lintResolvedFile } from '../engine/lint-input.js';
import { createExecutionRequirements } from '../engine/requirements.js';
import { parseBufferedJSON } from '../parser/buffered-json.js';
import { baselineEntryFromSummary } from '../regression/snapshot.js';
import { scanGeoJSON } from '../scanner/scan.js';
import type { GeoLintConfig } from '../types/config.js';
import type { FileLintResult } from '../types/semantic.js';
import { createFixture } from './fixtures.js';
import { median, round } from './metrics.js';
import {
  PrototypeWorkerPool,
  type PrototypeWorkerTask,
} from './worker-prototype.js';
import { WorkerPool } from '../workers/pool.js';
import type {
  SerializedResolvedPolicy,
  WorkerLintTask,
} from '../workers/protocol.js';

type WorkloadId =
  | 'many-small-100'
  | 'medium-10'
  | 'large-buffered-4'
  | 'large-buffered-8'
  | 'large-source-aware-4'
  | 'large-source-aware-8'
  | 'feature-heavy-4'
  | 'regression-10';
type ExecutionMode = 'main' | 'worker-1' | 'worker-2' | 'worker-4' | 'worker-8';

interface WorkloadDefinition {
  readonly id: WorkloadId;
  readonly fileCount: number;
  readonly source: string;
  readonly expectedVerticesPerFile: number;
  readonly profile: 'recommended' | 'source-aware' | 'regression';
  readonly parser: 'auto';
}

interface Sample {
  readonly totalMs: number;
  readonly readyMs: number;
  readonly executionMs: number;
  readonly firstTaskMs: number;
  readonly peakRssBytes: number;
}

export interface WorkerFeasibilityResult {
  readonly id: WorkloadId;
  readonly mode: ExecutionMode;
  readonly workerCount: number;
  readonly availableParallelism: number;
  readonly fileCount: number;
  readonly totalSourceBytes: number;
  readonly sampleCount: number;
  readonly samplesMs: readonly number[];
  readonly medianMs: number;
  readonly readyMedianMs: number;
  readonly executionMedianMs: number;
  readonly firstTaskMedianMs: number;
  readonly filesPerSecond: number;
  readonly megabytesPerSecond: number;
  readonly peakRssBytes: number;
  readonly speedupVsMain?: number;
}

interface WorkerFeasibilityArtifact {
  readonly schemaVersion: 1;
  readonly architecture: 'prototype' | 'production';
  readonly environment: {
    readonly node: string;
    readonly platform: NodeJS.Platform;
    readonly arch: string;
    readonly cpuModel: string;
    readonly availableParallelism: number;
    readonly logicalCpuCount: number;
    readonly totalMemoryBytes: number;
  };
  readonly results: readonly WorkerFeasibilityResult[];
}

const workloadIds: readonly WorkloadId[] = [
  'many-small-100',
  'medium-10',
  'large-buffered-4',
  'large-buffered-8',
  'large-source-aware-4',
  'large-source-aware-8',
  'feature-heavy-4',
  'regression-10',
];
const modes: readonly ExecutionMode[] = [
  'main',
  'worker-1',
  'worker-2',
  'worker-4',
  'worker-8',
];

function multipoint(count: number): string {
  return JSON.stringify({
    type: 'MultiPoint',
    coordinates: Array.from({ length: count }, (_, index) => [
      (index % 360) - 180,
      (index % 180) - 90,
    ]),
  });
}

function workload(id: WorkloadId): WorkloadDefinition {
  if (id === 'many-small-100')
    return {
      id,
      fileCount: 100,
      source: multipoint(100),
      expectedVerticesPerFile: 100,
      profile: 'recommended',
      parser: 'auto',
    };
  if (id === 'medium-10' || id === 'regression-10')
    return {
      id,
      fileCount: 10,
      source: createFixture('points-100k').source,
      expectedVerticesPerFile: 100_000,
      profile: id === 'regression-10' ? 'regression' : 'recommended',
      parser: 'auto',
    };
  if (id === 'feature-heavy-4')
    return {
      id,
      fileCount: 4,
      source: createFixture('tiny-features-100k').source,
      expectedVerticesPerFile: 100_000,
      profile: 'recommended',
      parser: 'auto',
    };
  const sourceAware = id.startsWith('large-source-aware');
  return {
    id,
    fileCount: id.endsWith('-4') ? 4 : 8,
    source: createFixture('points-1m').source,
    expectedVerticesPerFile: 1_000_000,
    profile: sourceAware ? 'source-aware' : 'recommended',
    parser: 'auto',
  };
}

function configFor(profile: WorkloadDefinition['profile']): GeoLintConfig {
  const recommended = getPreset('geolint/recommended')!;
  return {
    ...recommended,
    rules: {
      ...recommended.rules,
      ...(profile === 'source-aware'
        ? { 'coordinate-precision': 'error' as const }
        : {}),
    },
    ...(profile === 'regression'
      ? {
          regression: {
            thresholds: { totalVerticesIncrease: { percentage: 0 } },
          },
        }
      : {}),
  };
}

function validateResults(
  definition: WorkloadDefinition,
  results: readonly FileLintResult[],
): void {
  if (
    results.length !== definition.fileCount ||
    results.some(
      (result) =>
        result.errorCount !== 0 ||
        result.summary?.totalVertices !== definition.expectedVerticesPerFile,
    )
  )
    throw new Error(
      `Worker feasibility invariant failed for ${definition.id}.`,
    );
}

async function sampleMain(
  tasks: readonly PrototypeWorkerTask[],
  definition: WorkloadDefinition,
): Promise<Sample> {
  let peakRssBytes = process.memoryUsage().rss;
  const poll = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }, 5);
  const startedAt = performance.now();
  let firstTaskMs = 0;
  const results: FileLintResult[] = [];
  try {
    for (const task of tasks) {
      results.push(
        await lintResolvedFile(task.absolutePath, {
          filePath: task.filePath,
          config: task.config,
          parser: task.parser,
          ...(task.baseline ? { baseline: task.baseline } : {}),
        }),
      );
      if (firstTaskMs === 0) firstTaskMs = performance.now() - startedAt;
    }
  } finally {
    clearInterval(poll);
  }
  const totalMs = performance.now() - startedAt;
  validateResults(definition, results);
  return {
    totalMs,
    readyMs: 0,
    executionMs: totalMs,
    firstTaskMs,
    peakRssBytes,
  };
}

async function sampleWorkers(
  tasks: readonly PrototypeWorkerTask[],
  definition: WorkloadDefinition,
  workerCount: number,
): Promise<Sample> {
  let peakRssBytes = process.memoryUsage().rss;
  const poll = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }, 5);
  const startedAt = performance.now();
  let pool: PrototypeWorkerPool | undefined;
  try {
    pool = await PrototypeWorkerPool.create(workerCount);
    const readyMs = pool.readyMs;
    const batch = await pool.run(tasks);
    validateResults(definition, batch.results);
    await pool.terminate();
    pool = undefined;
    return {
      totalMs: performance.now() - startedAt,
      readyMs,
      executionMs: batch.elapsedMs,
      firstTaskMs: batch.firstTaskMs,
      peakRssBytes,
    };
  } finally {
    clearInterval(poll);
    if (pool) await pool.terminate();
  }
}

function productionTask(task: PrototypeWorkerTask): WorkerLintTask {
  const config = task.config;
  const policy: SerializedResolvedPolicy = {
    projectRoot: config.projectRoot,
    rules: config.rules,
    budgets: config.budgets,
    regression: config.regression,
    diagnostics: config.diagnostics,
    overrides: [],
  };
  return {
    protocolVersion: 1,
    type: 'lint',
    taskId: task.taskId,
    absolutePath: task.absolutePath,
    filePath: task.filePath,
    policy,
    plugins: [],
    parser: task.parser,
    ...(task.baseline ? { baseline: task.baseline } : {}),
  };
}

async function sampleProductionWorkers(
  tasks: readonly PrototypeWorkerTask[],
  definition: WorkloadDefinition,
  workerCount: number,
): Promise<Sample> {
  let peakRssBytes = process.memoryUsage().rss;
  const poll = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }, 5);
  const startedAt = performance.now();
  let pool: WorkerPool | undefined;
  try {
    const readyStartedAt = performance.now();
    pool = await WorkerPool.create(workerCount);
    const readyMs = performance.now() - readyStartedAt;
    const executionStartedAt = performance.now();
    const outcomes = await pool.run(tasks.map(productionTask));
    const executionMs = performance.now() - executionStartedAt;
    const results = outcomes.flatMap((outcome) =>
      outcome.type === 'lint-result' ? [outcome.result] : [],
    );
    const failure = outcomes.find((outcome) => outcome.type === 'error');
    if (failure?.type === 'error') throw new Error(failure.error.message);
    validateResults(definition, results);
    const firstTaskMs = pool.firstTaskMs;
    await pool.terminate();
    pool = undefined;
    return {
      totalMs: performance.now() - startedAt,
      readyMs,
      executionMs,
      firstTaskMs,
      peakRssBytes,
    };
  } finally {
    clearInterval(poll);
    if (pool) await pool.terminate();
  }
}

async function prepareTasks(
  directory: string,
  definition: WorkloadDefinition,
): Promise<readonly PrototypeWorkerTask[]> {
  const baseConfig = resolveConfig(configFor(definition.profile), directory);
  const paths = Array.from({ length: definition.fileCount }, (_, index) =>
    join(directory, `map-${index}.geojson`),
  );
  await Promise.all(paths.map((path) => writeFile(path, definition.source)));
  let baseline: PrototypeWorkerTask['baseline'];
  if (definition.profile === 'regression') {
    const parsed = parseBufferedJSON(definition.source);
    if (!parsed.ok) throw new Error('Regression fixture is invalid.');
    const summary = scanGeoJSON(parsed.value, {
      filePath: 'map-0.geojson',
      sourceBytes: Buffer.byteLength(definition.source),
      diagnostics: new DiagnosticCollector('map-0.geojson'),
      requirements: createExecutionRequirements({
        facts: [
          'featureCount',
          'vertexCount',
          'propertyStats',
          'geometryStats',
          'idStats',
        ],
        exactFileBytes: true,
      }),
    });
    baseline = baselineEntryFromSummary(summary);
  }
  return paths.map((absolutePath, taskId) => {
    const config = resolveFileConfig(baseConfig, absolutePath);
    return {
      protocolVersion: 1,
      taskId,
      absolutePath,
      filePath: config.filePath,
      config,
      parser: definition.parser,
      ...(baseline ? { baseline } : {}),
    };
  });
}

async function runChild(
  id: WorkloadId,
  mode: ExecutionMode,
  production: boolean,
): Promise<WorkerFeasibilityResult> {
  const definition = workload(id);
  const directory = await mkdtemp(join(process.cwd(), '.worker-feasibility-'));
  try {
    const tasks = await prepareTasks(directory, definition);
    const workerCount =
      mode === 'main' ? 0 : Number(mode.slice('worker-'.length));
    const execute = () =>
      workerCount === 0
        ? sampleMain(tasks, definition)
        : production
          ? sampleProductionWorkers(tasks, definition, workerCount)
          : sampleWorkers(tasks, definition, workerCount);
    await execute();
    const totalSourceBytes =
      Buffer.byteLength(definition.source) * definition.fileCount;
    const count = totalSourceBytes >= 5_000_000 ? 3 : 5;
    const samples: Sample[] = [];
    for (let index = 0; index < count; index += 1)
      samples.push(await execute());
    const total = samples.map((sample) => sample.totalMs);
    const elapsedSeconds = median(total) / 1_000;
    return {
      id,
      mode,
      workerCount,
      availableParallelism: availableParallelism(),
      fileCount: definition.fileCount,
      totalSourceBytes,
      sampleCount: count,
      samplesMs: total.map(round),
      medianMs: round(median(total)),
      readyMedianMs: round(median(samples.map((sample) => sample.readyMs))),
      executionMedianMs: round(
        median(samples.map((sample) => sample.executionMs)),
      ),
      firstTaskMedianMs: round(
        median(samples.map((sample) => sample.firstTaskMs)),
      ),
      filesPerSecond: round(definition.fileCount / elapsedSeconds),
      megabytesPerSecond: round(totalSourceBytes / 1_000_000 / elapsedSeconds),
      peakRssBytes: Math.max(...samples.map((sample) => sample.peakRssBytes)),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function format(artifact: WorkerFeasibilityArtifact): string {
  const lines = [
    `GeoLint Phase 11 worker feasibility (${artifact.architecture})`,
    `${artifact.environment.node} · ${artifact.environment.platform}/${artifact.environment.arch} · ${artifact.environment.cpuModel}`,
    `available parallelism: ${artifact.environment.availableParallelism}`,
  ];
  for (const id of workloadIds) {
    lines.push('', id);
    for (const result of artifact.results.filter((item) => item.id === id)) {
      lines.push(
        `  ${result.mode.padEnd(8)} ${result.medianMs.toFixed(1)} ms · ${result.speedupVsMain?.toFixed(2) ?? '1.00'}× · ready ${result.readyMedianMs.toFixed(1)} ms · first ${result.firstTaskMedianMs.toFixed(1)} ms · ${(result.peakRssBytes / 1024 / 1024).toFixed(1)} MiB RSS`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const production = argv.includes('--production');
  const childIndex = argv.indexOf('--child');
  if (childIndex >= 0) {
    const id = argv[childIndex + 1] as WorkloadId | undefined;
    const mode = argv[childIndex + 2] as ExecutionMode | undefined;
    if (!id || !workloadIds.includes(id) || !mode || !modes.includes(mode))
      throw new TypeError('--child requires a valid workload and mode.');
    process.stdout.write(
      `${JSON.stringify(await runChild(id, mode, production))}\n`,
    );
    return;
  }

  const entry = fileURLToPath(import.meta.url);
  const results: WorkerFeasibilityResult[] = [];
  for (const id of workloadIds) {
    for (const mode of modes) {
      if (mode === 'worker-8' && availableParallelism() < 8) continue;
      const child = spawnSync(
        process.execPath,
        [entry, '--child', id, mode, ...(production ? ['--production'] : [])],
        {
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      if (child.status !== 0)
        throw new Error(
          `Worker feasibility child ${id}/${mode} failed (${child.status ?? child.signal}): ${child.stderr || child.error?.message || 'no error output'}`,
        );
      results.push(JSON.parse(child.stdout) as WorkerFeasibilityResult);
    }
  }
  const withSpeedup = results.map((result) => {
    const baseline = results.find(
      (candidate) => candidate.id === result.id && candidate.mode === 'main',
    )!;
    return {
      ...result,
      speedupVsMain: round(baseline.medianMs / result.medianMs),
    };
  });
  const processors = cpus();
  const artifact: WorkerFeasibilityArtifact = {
    schemaVersion: 1,
    architecture: production ? 'production' : 'prototype',
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpuModel: processors[0]?.model ?? 'unknown',
      availableParallelism: availableParallelism(),
      logicalCpuCount: processors.length,
      totalMemoryBytes: totalmem(),
    },
    results: withSpeedup,
  };
  const outputIndex = argv.indexOf('--output');
  const outputPath = outputIndex < 0 ? undefined : argv[outputIndex + 1];
  if (outputIndex >= 0 && !outputPath)
    throw new TypeError('--output requires a JSON file path.');
  if (outputPath) {
    const absolute = resolve(outputPath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, `${JSON.stringify(artifact, null, 2)}\n`);
  }
  process.stdout.write(format(artifact));
}

await main();
