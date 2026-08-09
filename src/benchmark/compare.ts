import { readFile } from 'node:fs/promises';

import type {
  BenchmarkArtifact,
  BenchmarkCaseResult,
  BenchmarkComparison,
} from './types.js';

export interface BenchmarkCaseIncompatibility {
  readonly id: string;
  readonly reasons: readonly string[];
}

interface EnvironmentCompatibility {
  readonly compatible: boolean;
  readonly reasons: readonly string[];
  readonly warnings: readonly string[];
}

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

export function validateArtifact(
  value: unknown,
  label = 'input',
): asserts value is BenchmarkArtifact {
  const artifact = record(value);
  if (!artifact) invalid(label, 'expected an object.');
  if (artifact.schemaVersion !== 1)
    invalid(label, 'unsupported or missing schemaVersion (expected 1).');
  const environment = record(artifact.environment);
  if (!environment) invalid(label, 'missing environment.');
  for (const key of ['node', 'platform', 'arch', 'cpuModel'] as const)
    requiredString(environment, key, label);
  if (nodeMajor(environment.node as string) === undefined)
    invalid(label, 'environment node version is invalid.');
  for (const key of ['logicalCpuCount', 'totalMemoryBytes'] as const)
    requiredNumber(environment, key, label);
  if (
    (environment.logicalCpuCount as number) <= 0 ||
    (environment.totalMemoryBytes as number) <= 0
  )
    invalid(label, 'environment CPU count and memory must be positive.');
  if (!Array.isArray(artifact.cases)) invalid(label, 'missing cases.');
  const ids = new Set<string>();
  for (const [index, value] of artifact.cases.entries()) {
    const item = record(value);
    if (!item) invalid(label, `case ${index} must be an object.`);
    for (const key of ['id', 'fixture', 'profile', 'strategy'] as const)
      requiredString(item, key, `${label} case ${index}`);
    for (const key of ['sourceBytes', 'sampleCount', 'medianMs'] as const)
      requiredNumber(item, key, `${label} case ${index}`);
    if (
      (item.sourceBytes as number) < 0 ||
      (item.sampleCount as number) <= 0 ||
      (item.medianMs as number) <= 0
    )
      invalid(label, `case ${index} has unusable timing metadata.`);
    if (ids.has(item.id as string))
      invalid(label, `duplicate case ID ${item.id}.`);
    ids.add(item.id as string);
    if (item.semanticCounts !== undefined) {
      const counts = record(item.semanticCounts);
      if (!counts)
        invalid(label, `case ${index} has malformed semanticCounts.`);
      for (const [key, count] of Object.entries(counts)) {
        if (typeof count !== 'number' || !Number.isFinite(count))
          invalid(label, `case ${index} has invalid semanticCounts.${key}.`);
      }
    }
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
