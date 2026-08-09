import assert from 'node:assert/strict';
import test from 'node:test';

import { compareArtifacts } from '../benchmark/compare.js';
import { createFixture } from '../benchmark/fixtures.js';
import { median } from '../benchmark/metrics.js';
import type {
  BenchmarkArtifact,
  BenchmarkCaseResult,
} from '../benchmark/types.js';

function artifact(
  result: BenchmarkCaseResult = benchmark(100, 10, 100),
): BenchmarkArtifact {
  return {
    schemaVersion: 1,
    geolintVersion: '0.0.0',
    suite: 'extended',
    environment: {
      node: 'v22.1.0',
      platform: 'linux',
      arch: 'x64',
      cpuModel: 'AMD  Ryzen  9',
      logicalCpuCount: 8,
      totalMemoryBytes: 32_000,
    },
    cases: [result],
  };
}

function benchmark(
  medianMs: number,
  megabytesPerSecond: number,
  peakRssBytes: number,
): BenchmarkCaseResult {
  return {
    id: 'fixture/case',
    group: 'memory',
    fixture: 'fixture',
    profile: 'test',
    strategy: 'buffered',
    sourceBytes: 1,
    sampleCount: 1,
    samplesMs: [medianMs],
    medianMs,
    minMs: medianMs,
    maxMs: medianMs,
    megabytesPerSecond,
    peakRssBytes,
    semanticCounts: { features: 1, vertices: 2 },
  };
}

function changed(
  source: BenchmarkArtifact,
  change: Partial<BenchmarkArtifact['environment']>,
): BenchmarkArtifact {
  return { ...source, environment: { ...source.environment, ...change } };
}

test('benchmark metrics and deterministic fixtures are reproducible', () => {
  assert.equal(median([9, 1, 5]), 5);
  assert.equal(median([8, 2, 4, 6]), 5);
  const first = createFixture('random-order-10k');
  const second = createFixture('random-order-10k');
  assert.equal(first.source, second.source);
  assert.deepEqual(
    JSON.parse(first.source),
    JSON.parse(createFixture('canonical-order-10k').source),
  );
});

test('benchmark comparison validates schema and basic artifact structure', () => {
  const valid = artifact();
  assert.equal(compareArtifacts(valid, valid).comparisons.length, 3);
  for (const [value, message] of [
    [{ ...valid, schemaVersion: undefined }, 'schemaVersion'],
    [{ ...valid, schemaVersion: 2 }, 'schemaVersion'],
    [{ ...valid, environment: undefined }, 'environment'],
    [{ ...valid, cases: [{}] }, 'missing id'],
  ] as const) {
    assert.throws(
      () => compareArtifacts(value as unknown as BenchmarkArtifact, valid),
      new RegExp(message),
    );
  }
});

test('benchmark environment compatibility uses CPU and Node major', () => {
  const baseline = artifact();
  const compatible = changed(baseline, {
    node: 'v22.14.1',
    cpuModel: ' AMD Ryzen 9 ',
  });
  assert.equal(
    compareArtifacts(baseline, compatible).compatibleEnvironment,
    true,
  );
  for (const change of [
    { platform: 'win32' as const },
    { arch: 'arm64' },
    { node: 'v24.1.0' },
    { cpuModel: 'Intel Xeon' },
  ]) {
    const comparison = compareArtifacts(baseline, changed(baseline, change));
    assert.equal(comparison.compatibleEnvironment, false);
    assert.equal(comparison.comparisons.length, 0);
  }
  const warning = compareArtifacts(
    baseline,
    changed(baseline, { logicalCpuCount: 4, totalMemoryBytes: 8_000 }),
  );
  assert.equal(warning.compatibleEnvironment, true);
  assert.deepEqual(warning.environmentWarnings, [
    'logical CPU count differs',
    'total system memory differs materially',
  ]);
});

test('benchmark comparison skips changed workloads and reports unmatched cases', () => {
  const baseline = artifact();
  const currentCase = {
    ...benchmark(125, 7, 130),
    fixture: 'changed',
    profile: 'changed',
    strategy: 'indexed',
    sourceBytes: 2,
    workerCount: 4,
    semanticCounts: { features: 2, vertices: 3 },
  };
  const current = {
    ...artifact(currentCase),
    cases: [currentCase, { ...benchmark(1, 1, 1), id: 'added' }],
  };
  const comparison = compareArtifacts(baseline, current, 20);
  assert.equal(comparison.comparisons.length, 0);
  assert.deepEqual(comparison.addedCases, ['added']);
  assert.deepEqual(comparison.incompatibleCases, [
    {
      id: 'fixture/case',
      reasons: [
        'fixture differs',
        'profile differs',
        'strategy differs',
        'sourceBytes differs',
        'workerCount differs',
        'semanticCounts.features differs',
        'semanticCounts.vertices differs',
      ],
    },
  ]);
  assert.deepEqual(
    compareArtifacts(baseline, { ...artifact(), cases: [] }).removedCases,
    ['fixture/case'],
  );
});

test('benchmark comparison remains advisory for compatible workloads', () => {
  const comparison = compareArtifacts(
    artifact(benchmark(100, 10, 100)),
    artifact(benchmark(125, 7, 130)),
    20,
  );
  assert.deepEqual(
    comparison.comparisons.map(({ metric, advisoryRegression }) => [
      metric,
      advisoryRegression,
    ]),
    [
      ['wallClockMs', true],
      ['megabytesPerSecond', true],
      ['peakRssBytes', true],
    ],
  );
});
