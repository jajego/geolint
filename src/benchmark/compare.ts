import { readFile } from 'node:fs/promises';

import type {
  BenchmarkArtifact,
  BenchmarkCaseResult,
  BenchmarkComparison,
  BenchmarkEnvironment,
} from './types.js';
import { benchmarkGroups } from './types.js';
import { median } from './metrics.js';

export interface BenchmarkCaseIncompatibility {
  readonly id: string;
  readonly reasons: readonly string[];
}

interface EnvironmentCompatibility {
  readonly compatible: boolean;
  readonly reasons: readonly string[];
  readonly warnings: readonly string[];
}

const benchmarkGroupSet = new Set<string>(benchmarkGroups);
const optionalNumericMetrics = [
  'megabytesPerSecond',
  'featuresPerSecond',
  'verticesPerSecond',
  'filesPerSecond',
  'peakRssBytes',
] as const;

function invalid(label: string, message: string): never {
  throw new Error(`Invalid ${label} benchmark artifact: ${message}`);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string {
  if (typeof value[key] !== 'string' || value[key] === '')
    invalid(label, `missing ${key}.`);
  return value[key];
}

function requiredNumber(
  value: Record<string, unknown>,
  key: string,
  label: string,
): number {
  if (typeof value[key] !== 'number' || !Number.isFinite(value[key]))
    invalid(label, `missing ${key}.`);
  return value[key];
}

function validateEnvironment(
  value: unknown,
  label: string,
): asserts value is BenchmarkEnvironment {
  const environment = record(value);
  if (!environment) invalid(label, 'missing environment.');
  for (const key of ['node', 'platform', 'arch', 'cpuModel'] as const)
    requiredString(environment, key, label);
  if (nodeMajor(requiredString(environment, 'node', label)) === undefined)
    invalid(label, 'environment node version is invalid.');
  const logicalCpuCount = requiredNumber(environment, 'logicalCpuCount', label);
  const totalMemoryBytes = requiredNumber(
    environment,
    'totalMemoryBytes',
    label,
  );
  if (logicalCpuCount <= 0 || totalMemoryBytes <= 0)
    invalid(label, 'environment CPU count and memory must be positive.');
}

function validateSamples(item: Record<string, unknown>, label: string): void {
  const sampleCount = requiredNumber(item, 'sampleCount', label);
  if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0)
    invalid(label, 'sampleCount must be a positive safe integer.');
  if (!validSamples(item.samplesMs) || item.samplesMs.length !== sampleCount) {
    invalid(label, 'samplesMs must contain sampleCount finite timings.');
  }
  const samples = item.samplesMs;
  const medianMs = requiredNumber(item, 'medianMs', label);
  const minMs = requiredNumber(item, 'minMs', label);
  const maxMs = requiredNumber(item, 'maxMs', label);
  if (
    medianMs <= 0 ||
    minMs !== Math.min(...samples) ||
    maxMs !== Math.max(...samples) ||
    medianMs !== median(samples)
  ) {
    invalid(label, 'timing summaries must match samplesMs.');
  }
}

function validSamples(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every(
      (sample) =>
        typeof sample === 'number' && Number.isFinite(sample) && sample >= 0,
    )
  );
}

function validateNumberRecord(value: unknown, label: string): void {
  const entries = record(value);
  if (!entries) invalid(label, 'expected an object.');
  for (const [key, count] of Object.entries(entries)) {
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0)
      invalid(label, `invalid ${key}.`);
  }
}

function validateOptionalNonNegativeFiniteNumber(
  value: Record<string, unknown>,
  key: string,
  label: string,
): void {
  if (
    value[key] !== undefined &&
    (typeof value[key] !== 'number' ||
      !Number.isFinite(value[key]) ||
      value[key] < 0)
  )
    invalid(label, `invalid ${key}.`);
}

function validateBenchmarkCase(
  value: unknown,
  index: number,
  label: string,
): asserts value is BenchmarkCaseResult {
  const caseLabel = `${label} case ${index}`;
  const item = record(value);
  if (!item) invalid(label, `case ${index} must be an object.`);
  for (const key of ['id', 'fixture', 'profile', 'strategy'] as const)
    requiredString(item, key, caseLabel);
  const group = requiredString(item, 'group', caseLabel);
  if (!benchmarkGroupSet.has(group)) invalid(caseLabel, 'unsupported group.');
  const sourceBytes = requiredNumber(item, 'sourceBytes', caseLabel);
  if (sourceBytes < 0) invalid(caseLabel, 'sourceBytes must be non-negative.');
  validateSamples(item, caseLabel);
  for (const key of optionalNumericMetrics)
    validateOptionalNonNegativeFiniteNumber(item, key, caseLabel);
  if (
    item.workerCount !== undefined &&
    (typeof item.workerCount !== 'number' ||
      !Number.isSafeInteger(item.workerCount) ||
      item.workerCount < 0)
  )
    invalid(label, `case ${index} has invalid workerCount.`);
  if (item.semanticCounts !== undefined)
    validateNumberRecord(
      item.semanticCounts,
      `${label} case ${index} semanticCounts`,
    );
  if (item.instrumentation !== undefined)
    validateNumberRecord(
      item.instrumentation,
      `${label} case ${index} instrumentation`,
    );
}

export function validateArtifact(
  value: unknown,
  label = 'input',
): asserts value is BenchmarkArtifact {
  const artifact = record(value);
  if (!artifact) invalid(label, 'expected an object.');
  if (artifact.schemaVersion !== 1)
    invalid(label, 'unsupported or missing schemaVersion (expected 1).');
  requiredString(artifact, 'geolintVersion', label);
  if (artifact.suite !== 'standard' && artifact.suite !== 'extended')
    invalid(label, 'unsupported or missing suite.');
  validateEnvironment(artifact.environment, label);
  if (!Array.isArray(artifact.cases)) invalid(label, 'missing cases.');
  const ids = new Set<string>();
  for (const [index, item] of artifact.cases.entries()) {
    validateBenchmarkCase(item, index, label);
    if (ids.has(item.id)) invalid(label, `duplicate case ID ${item.id}.`);
    ids.add(item.id);
  }
}

function nodeMajor(version: string): number | undefined {
  const match = /^v?(\d+)(?:\.\d+){0,2}$/.exec(version.trim());
  return match ? Number(match[1]) : undefined;
}

function cpuModel(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function compareEnvironment(
  baseline: BenchmarkArtifact,
  current: BenchmarkArtifact,
): EnvironmentCompatibility {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const before = baseline.environment;
  const after = current.environment;
  if (before.platform !== after.platform) reasons.push('platform differs');
  if (before.arch !== after.arch) reasons.push('architecture differs');
  if (nodeMajor(before.node) !== nodeMajor(after.node))
    reasons.push('Node major version differs');
  if (cpuModel(before.cpuModel) !== cpuModel(after.cpuModel))
    reasons.push('CPU model differs');
  if (before.logicalCpuCount !== after.logicalCpuCount)
    warnings.push('logical CPU count differs');
  const memoryRatio =
    Math.max(before.totalMemoryBytes, after.totalMemoryBytes) /
    Math.max(1, Math.min(before.totalMemoryBytes, after.totalMemoryBytes));
  if (memoryRatio > 1.25)
    warnings.push('total system memory differs materially');
  return { compatible: reasons.length === 0, reasons, warnings };
}

function caseReasons(
  baseline: BenchmarkCaseResult,
  current: BenchmarkCaseResult,
): readonly string[] {
  const reasons: string[] = [];
  for (const key of [
    'fixture',
    'profile',
    'strategy',
    'sourceBytes',
  ] as const) {
    if (baseline[key] !== current[key]) reasons.push(`${key} differs`);
  }
  if (baseline.workerCount !== current.workerCount)
    reasons.push('workerCount differs');
  const keys = new Set([
    ...Object.keys(baseline.semanticCounts ?? {}),
    ...Object.keys(current.semanticCounts ?? {}),
  ]);
  for (const key of keys) {
    if (
      baseline.semanticCounts?.[
        key as keyof NonNullable<BenchmarkCaseResult['semanticCounts']>
      ] !==
      current.semanticCounts?.[
        key as keyof NonNullable<BenchmarkCaseResult['semanticCounts']>
      ]
    )
      reasons.push(`semanticCounts.${key} differs`);
  }
  return reasons;
}

export function compareArtifacts(
  baseline: BenchmarkArtifact,
  current: BenchmarkArtifact,
  thresholdPercent = 20,
): {
  readonly compatibleEnvironment: boolean;
  readonly environmentReasons: readonly string[];
  readonly environmentWarnings: readonly string[];
  readonly comparisons: readonly BenchmarkComparison[];
  readonly incompatibleCases: readonly BenchmarkCaseIncompatibility[];
  readonly addedCases: readonly string[];
  readonly removedCases: readonly string[];
} {
  validateArtifact(baseline, 'baseline');
  validateArtifact(current, 'current');
  const environment = compareEnvironment(baseline, current);
  const currentCases = new Map(current.cases.map((item) => [item.id, item]));
  const removedCases: string[] = [];
  const incompatibleCases: BenchmarkCaseIncompatibility[] = [];
  const comparisons: BenchmarkComparison[] = [];
  for (const before of baseline.cases) {
    const after = currentCases.get(before.id);
    if (!after) {
      removedCases.push(before.id);
      continue;
    }
    const reasons = caseReasons(before, after);
    if (reasons.length > 0) {
      incompatibleCases.push({ id: before.id, reasons });
      continue;
    }
    if (!environment.compatible) continue;
    for (const [metric, baselineValue, currentValue, lowerIsRegression] of [
      ['wallClockMs', before.medianMs, after.medianMs, false],
      [
        'megabytesPerSecond',
        before.megabytesPerSecond,
        after.megabytesPerSecond,
        true,
      ],
      ['peakRssBytes', before.peakRssBytes, after.peakRssBytes, false],
    ] as const) {
      if (
        typeof baselineValue !== 'number' ||
        typeof currentValue !== 'number' ||
        baselineValue <= 0
      )
        continue;
      const deltaPercent = (currentValue / baselineValue - 1) * 100;
      comparisons.push({
        id: before.id,
        metric,
        baseline: baselineValue,
        current: currentValue,
        deltaPercent,
        advisoryRegression: lowerIsRegression
          ? deltaPercent <= -thresholdPercent
          : deltaPercent >= thresholdPercent,
      });
    }
  }
  const baselineIds = new Set(baseline.cases.map((item) => item.id));
  const addedCases = current.cases
    .filter((item) => !baselineIds.has(item.id))
    .map((item) => item.id);
  return {
    compatibleEnvironment: environment.compatible,
    environmentReasons: environment.reasons,
    environmentWarnings: environment.warnings,
    comparisons,
    incompatibleCases,
    addedCases,
    removedCases,
  };
}

async function readArtifact(
  path: string,
  label: string,
): Promise<BenchmarkArtifact> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read ${label} benchmark artifact.`, {
      cause: error,
    });
  }
  validateArtifact(parsed, label);
  return parsed;
}

function environmentLine(artifact: BenchmarkArtifact): string {
  const environment = artifact.environment;
  return `${environment.platform} ${environment.arch}, Node ${nodeMajor(environment.node) ?? environment.node}, ${cpuModel(environment.cpuModel)}`;
}

export async function runComparison(argv: readonly string[]): Promise<string> {
  const [baselinePath, currentPath, rawThreshold] = argv;
  if (!baselinePath || !currentPath) {
    throw new TypeError(
      'Usage: benchmark:compare <baseline.json> <current.json> [threshold-percent]',
    );
  }
  const threshold = rawThreshold === undefined ? 20 : Number(rawThreshold);
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new TypeError('Comparison threshold must be a non-negative number.');
  }
  const baseline = await readArtifact(baselinePath, 'baseline');
  const current = await readArtifact(currentPath, 'current');
  const comparison = compareArtifacts(baseline, current, threshold);
  const lines = [
    `GeoLint benchmark comparison (${threshold}% advisory threshold)`,
  ];
  if (!comparison.compatibleEnvironment) {
    lines.push('Environment mismatch: timing comparison skipped.');
    lines.push(`Baseline: ${environmentLine(baseline)}`);
    lines.push(`Current: ${environmentLine(current)}`);
    lines.push(...comparison.environmentReasons.map((reason) => `  ${reason}`));
  }
  lines.push(
    ...comparison.environmentWarnings.map((warning) => `warning: ${warning}`),
  );
  lines.push(...comparison.removedCases.map((id) => `REMOVED ${id}`));
  lines.push(...comparison.addedCases.map((id) => `ADDED ${id}`));
  for (const item of comparison.incompatibleCases)
    lines.push(`INCOMPATIBLE ${item.id}: ${item.reasons.join(', ')}`);
  for (const item of comparison.comparisons) {
    lines.push(
      `${item.advisoryRegression ? 'ADVISORY ' : ''}${item.id} ${item.metric} ${item.baseline.toFixed(1)} → ${item.current.toFixed(1)} (${item.deltaPercent >= 0 ? '+' : ''}${item.deltaPercent.toFixed(1)}%)`,
    );
  }
  return `${lines.join('\n')}\n`;
}
