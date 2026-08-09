import { readFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';

import { resolveTargets } from '../cli/targets.js';
import { resolveRuntimeConfig } from '../config/runtime.js';
import { DiagnosticCollector } from '../engine/diagnostics.js';
import {
  GeoLintIOError,
  GeoLintInputError,
  GeoLintTargetError,
} from '../engine/errors.js';
import { createExecutionRequirements } from '../engine/requirements.js';
import { decodeSource } from '../input/decode-source.js';
import { parseBufferedJSON } from '../parser/buffered-json.js';
import { scanGeoJSON } from '../scanner/scan.js';
import type { ConfigRuntimeOptions } from '../config/runtime.js';
import type {
  FileSummary,
  JsonValueType,
  SummaryFactName,
} from '../types/semantic.js';
import { deserializeWorkerError } from '../workers/errors.js';
import { WorkerPool } from '../workers/pool.js';
import type { WorkerSnapshotTask } from '../workers/protocol.js';
import {
  loadBaseline,
  regressionIdentity,
  resolveBaselinePath,
  writeBaselineAtomic,
} from './baseline-io.js';
import {
  createBaseline,
  geometryTypeOrder,
  propertyTypeOrder,
  type BaselineFileEntry,
  type BaselineV1,
} from './schema.js';

const snapshotFacts = Object.freeze([
  'featureCount',
  'vertexCount',
  'propertyStats',
  'geometryStats',
  'idStats',
] as const satisfies readonly SummaryFactName[]);

export interface SnapshotEntryChange {
  readonly filePath: string;
  readonly before?: BaselineFileEntry;
  readonly after?: BaselineFileEntry;
}

export interface SnapshotProposal {
  readonly mode: 'full' | 'partial';
  readonly baselinePath: string;
  readonly added: readonly SnapshotEntryChange[];
  readonly updated: readonly SnapshotEntryChange[];
  readonly removed: readonly SnapshotEntryChange[];
  readonly unchanged: readonly string[];
}

export interface SnapshotResult {
  readonly proposal: SnapshotProposal;
  readonly baseline: BaselineV1;
}

export interface SnapshotOptions extends ConfigRuntimeOptions {
  readonly targets?: readonly string[];
  readonly baselinePath?: string;
  readonly noIgnore?: boolean;
  readonly workers?: number;
}

export function snapshotWorkerCount(
  requestedWorkers: number | undefined,
  targetCount: number,
  parallelism = availableParallelism(),
): number {
  return Math.min(requestedWorkers ?? 1, parallelism, targetCount);
}

function complete(summary: FileSummary): boolean {
  return (
    summary.completeness.facts.fileBytes === 'complete' &&
    snapshotFacts.every(
      (fact) => summary.completeness.facts[fact] === 'complete',
    )
  );
}

export function baselineEntryFromSummary(
  summary: FileSummary,
): BaselineFileEntry {
  if (!complete(summary)) {
    throw new GeoLintInputError(
      `Cannot snapshot ${summary.filePath}: required baseline facts are incomplete.`,
      'GEOLINT_SNAPSHOT_INCOMPLETE',
    );
  }
  const featureGeometryTypes: BaselineFileEntry['featureGeometryTypes'] =
    Object.fromEntries(
      geometryTypeOrder.flatMap((type) => {
        const count = summary.featureGeometryTypes!.get(type);
        return count === undefined ? [] : [[type, count]];
      }),
    );
  const properties = Object.create(null) as Record<
    string,
    {
      present: number;
      missing: number;
      types: Partial<Record<JsonValueType, number>>;
    }
  >;
  for (const key of [...summary.propertyStats!.keys()].sort()) {
    const source = summary.propertyStats!.get(key)!;
    const types: Partial<Record<JsonValueType, number>> = {};
    for (const type of propertyTypeOrder) {
      const count = source.types.get(type);
      if (count !== undefined) types[type] = count;
    }
    properties[key] = {
      present: source.present,
      missing: source.missing,
      types,
    };
  }
  return {
    bytes: summary.bytes!,
    featureCount: summary.featureCount,
    totalVertices: summary.totalVertices,
    largestFeatureVertices: summary.largestFeatureVertices!,
    featureGeometryTypes,
    properties,
    ids: {
      missing: summary.ids!.missing,
      duplicates: summary.ids!.duplicateCount,
      string: summary.ids!.stringCount,
      number: summary.ids!.numberCount,
    },
    nullGeometries: summary.nullGeometryCount!,
  };
}

export async function captureSnapshotFile(
  absolutePath: string,
  filePath: string,
): Promise<BaselineFileEntry> {
  let source: Buffer;
  try {
    source = await readFile(absolutePath);
  } catch (error) {
    throw new GeoLintIOError(
      `Could not read snapshot target ${absolutePath}.`,
      'GEOLINT_SNAPSHOT_READ_FAILED',
      { cause: error },
    );
  }
  let text: string;
  try {
    text = decodeSource(source);
  } catch (error) {
    throw new GeoLintInputError(
      `Cannot snapshot ${filePath}: input is not valid UTF-8.`,
      'GEOLINT_SNAPSHOT_INVALID_ENCODING',
      { cause: error },
    );
  }
  const parsed = parseBufferedJSON(text);
  if (!parsed.ok) {
    throw new GeoLintInputError(
      `Cannot snapshot ${filePath}: input is not valid JSON.`,
      'GEOLINT_SNAPSHOT_INVALID_JSON',
    );
  }
  const summary = scanGeoJSON(parsed.value, {
    filePath,
    sourceBytes: source.byteLength,
    diagnostics: new DiagnosticCollector(filePath),
    requirements: createExecutionRequirements({
      facts: snapshotFacts,
      exactFileBytes: true,
    }),
  });
  return baselineEntryFromSummary(summary);
}

function entryText(entry: BaselineFileEntry): string {
  return JSON.stringify(entry);
}

function proposal(
  mode: 'full' | 'partial',
  baselinePath: string,
  before: BaselineV1,
  after: BaselineV1,
  targeted: ReadonlySet<string>,
): SnapshotProposal {
  const added: SnapshotEntryChange[] = [];
  const updated: SnapshotEntryChange[] = [];
  const removed: SnapshotEntryChange[] = [];
  const unchanged: string[] = [];
  const keys = new Set([
    ...Object.keys(before.files),
    ...Object.keys(after.files),
  ]);
  for (const filePath of [...keys].sort()) {
    const oldEntry = before.files[filePath];
    const newEntry = after.files[filePath];
    if (!oldEntry && newEntry) added.push({ filePath, after: newEntry });
    else if (oldEntry && !newEntry)
      removed.push({ filePath, before: oldEntry });
    else if (
      oldEntry &&
      newEntry &&
      entryText(oldEntry) !== entryText(newEntry)
    ) {
      updated.push({ filePath, before: oldEntry, after: newEntry });
    } else if (targeted.has(filePath)) unchanged.push(filePath);
  }
  return {
    mode,
    baselinePath,
    added,
    updated,
    removed,
    unchanged,
  };
}

export async function snapshotBaseline(
  options: SnapshotOptions = {},
): Promise<SnapshotResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const config = await resolveRuntimeConfig(options);
  const mode = options.targets === undefined ? 'full' : 'partial';
  const targets = await resolveTargets(
    config,
    options.targets,
    cwd,
    options.noIgnore,
  );
  if (targets.some((target) => target.kind !== 'file')) {
    throw new GeoLintTargetError(
      'Snapshot targets must be files, not stdin.',
      'GEOLINT_INVALID_SNAPSHOT_TARGET',
    );
  }
  const baselinePath = options.baselinePath
    ? resolve(cwd, options.baselinePath)
    : resolveBaselinePath(config);
  const before = await loadBaseline(baselinePath);
  const captured = Object.create(null) as Record<string, BaselineFileEntry>;
  const workerCount = snapshotWorkerCount(options.workers, targets.length);
  if (workerCount > 1) {
    const tasks = targets.map((target, taskId): WorkerSnapshotTask => ({
      protocolVersion: 1,
      type: 'snapshot',
      taskId,
      absolutePath: target.absolutePath,
      filePath: regressionIdentity(target.filePath),
    }));
    const pool = await WorkerPool.create(workerCount);
    try {
      const outcomes = await pool.run(tasks);
      for (const outcome of outcomes) {
        if (outcome.type === 'error')
          throw deserializeWorkerError(outcome.error);
        if (outcome.type === 'snapshot-result') {
          captured[tasks[outcome.taskId]!.filePath] = outcome.result;
        }
      }
    } finally {
      await pool.terminate();
    }
  } else {
    for (const target of targets) {
      const identity = regressionIdentity(target.filePath);
      captured[identity] = await captureSnapshotFile(
        target.absolutePath,
        identity,
      );
    }
  }
  const files = mode === 'full' ? captured : { ...before.files, ...captured };
  const after = createBaseline(files);
  const targeted = new Set(Object.keys(captured));
  const result = {
    proposal: proposal(mode, baselinePath, before, after, targeted),
    baseline: after,
  };
  await writeBaselineAtomic(baselinePath, after);
  return result;
}
