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
  platform: NodeJS.Platform,
  result: BenchmarkCaseResult,
): BenchmarkArtifact {
  return {
    schemaVersion: 1,
    geolintVersion: '0.0.0',
    suite: 'extended',
    environment: {
      node: 'v22.1.0',
      platform,
      arch: 'x64',
      cpuModel: 'fixture',
      logicalCpuCount: 1,
      totalMemoryBytes: 1,
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
  };
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

test('benchmark comparison is advisory and warns on unlike environments', () => {
  const comparison = compareArtifacts(
    artifact('win32', benchmark(100, 10, 100)),
    artifact('linux', benchmark(125, 7, 130)),
    20,
  );
  assert.equal(comparison.compatibleEnvironment, false);
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
