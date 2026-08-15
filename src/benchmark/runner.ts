import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DiagnosticCollector } from '../engine/diagnostics.js';
import { lintFiles } from '../engine/lint-files.js';
import { lintGeoJSONTextWithParser } from '../engine/lint-input.js';
import { compilePolicy } from '../engine/policy.js';
import { createExecutionRequirements } from '../engine/requirements.js';
import { parseBufferedJSON } from '../parser/buffered-json.js';
import { scanDuplicateKeysFromValidJSON } from '../parser/duplicate-keys.js';
import {
  parseIndexedSource,
  type IndexedInstrumentation,
} from '../parser/indexed-source.js';
import { createBaseline, serializeBaseline } from '../regression/schema.js';
import { baselineEntryFromSummary } from '../regression/snapshot.js';
import { definePlugin } from '../plugins/plugin.js';
import { defineRule } from '../rules/define-rule.js';
import { scanGeoJSON, type ScanInstrumentation } from '../scanner/scan.js';
import { resolveConfig } from '../config/resolve.js';
import { lintCases, type LintBenchmarkCase } from './cases.js';
import { createFixture, type FixtureId } from './fixtures.js';
import { median, round } from './metrics.js';
import type { BenchmarkCaseResult } from './types.js';

function result(
  definition: Omit<
    BenchmarkCaseResult,
    'sampleCount' | 'samplesMs' | 'medianMs' | 'minMs' | 'maxMs'
  >,
  samples: readonly number[],
): BenchmarkCaseResult {
  const values = samples.map((value) => round(value));
  return {
    ...definition,
    sampleCount: values.length,
    samplesMs: values,
    medianMs: round(median(values)),
    minMs: Math.min(...values),
    maxMs: Math.max(...values),
  };
}

function sampleCount(sourceBytes: number): number {
  return sourceBytes >= 5_000_000 ? 3 : 5;
}

async function measureLintCase(
  benchmark: LintBenchmarkCase,
): Promise<BenchmarkCaseResult> {
  const fixture = createFixture(benchmark.fixture);
  const sourceBytes = Buffer.byteLength(fixture.source);
  const execute = () =>
    lintGeoJSONTextWithParser(fixture.source, {
      parser: benchmark.strategy,
      filename: `${fixture.id}.geojson`,
      config: benchmark.config,
    });
  await execute();
  const samples: number[] = [];
  let last!: Awaited<ReturnType<typeof execute>>;
  for (let index = 0; index < sampleCount(sourceBytes); index += 1) {
    const startedAt = performance.now();
    last = await execute();
    samples.push(performance.now() - startedAt);
  }
  const expectedErrors = benchmark.expectedErrors ?? 0;
  if (
    last.summary?.featureCount !== fixture.expectedFeatures ||
    last.summary.totalVertices !== fixture.expectedVertices ||
    last.errorCount !== expectedErrors
  ) {
    throw new Error(`Benchmark invariant failed for ${benchmark.id}.`);
  }
  const elapsed = median(samples) / 1_000;
  const retainedDiagnostics = last.diagnostics.length;
  const suppressedDiagnostics = last.suppressedDiagnostics.reduce(
    (total, item) => total + item.suppressedCount,
    0,
  );
  return result(
    {
      id: benchmark.id,
      group: benchmark.group,
      fixture: fixture.id,
      profile: benchmark.profile,
      strategy: benchmark.strategy,
      sourceBytes,
      megabytesPerSecond: round(sourceBytes / 1_000_000 / elapsed),
      ...(fixture.expectedFeatures > 0
        ? { featuresPerSecond: round(fixture.expectedFeatures / elapsed) }
        : {}),
      ...(fixture.expectedVertices > 0
        ? { verticesPerSecond: round(fixture.expectedVertices / elapsed) }
        : {}),
      semanticCounts: {
        features: fixture.expectedFeatures,
        vertices: fixture.expectedVertices,
        errors: last.errorCount,
        warnings: last.warningCount,
        retainedDiagnostics,
        suppressedDiagnostics,
      },
    },
    samples,
  );
}

function indexedInstrumentation(): IndexedInstrumentation {
  return {
    sourceBytes: 0,
    syntaxValidationMs: 0,
    initialIndexReplayMs: 0,
    indexedObjects: 0,
    winningSpans: 0,
    coordinateSpans: 0,
    sourceBytesReplayed: 0,
  };
}

function scanInstrumentation(): ScanInstrumentation {
  return {
    coordinateTraversals: 0,
    positionVisits: 0,
    coordinatePathMaterializations: 0,
    propertyPathMaterializations: 0,
    rawLexemeCollections: 0,
    coordinateLexemeEvents: 0,
  };
}

function measureIndexedDetail(fixtureId: FixtureId): BenchmarkCaseResult {
  const fixture = createFixture(fixtureId);
  const sourceBytes = Buffer.byteLength(fixture.source);
  const requirements = createExecutionRequirements({ facts: ['vertexCount'] });
  const execute = () => {
    const index = indexedInstrumentation();
    const startedAt = performance.now();
    const parsed = parseIndexedSource(fixture.source, requirements, index);
    const scan = scanInstrumentation();
    const semanticStarted = performance.now();
    const summary = scanGeoJSON(parsed.value, {
      filePath: '<benchmark>',
      requirements,
      instrumentation: scan,
    });
    const semanticMs = performance.now() - semanticStarted;
    if (
      summary.totalVertices !== fixture.expectedVertices ||
      scan.positionVisits !== fixture.expectedVertices ||
      scan.coordinateTraversals !== 1
    ) {
      throw new Error(`Indexed invariant failed for ${fixture.id}.`);
    }
    return {
      elapsedMs: performance.now() - startedAt,
      index,
      scan,
      semanticMs,
    };
  };
  execute();
  const samples: number[] = [];
  const syntax: number[] = [];
  const replay: number[] = [];
  const semantic: number[] = [];
  let finalIndex = indexedInstrumentation();
  let finalScan = scanInstrumentation();
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const measured = execute();
    samples.push(measured.elapsedMs);
    syntax.push(measured.index.syntaxValidationMs);
    replay.push(measured.index.initialIndexReplayMs);
    semantic.push(measured.semanticMs);
    finalIndex = measured.index;
    finalScan = measured.scan;
  }
  return result(
    {
      id: `indexed-detail/${fixture.id}`,
      group: 'instrumentation',
      fixture: fixture.id,
      profile: 'indexed-detail',
      strategy: 'indexed',
      sourceBytes,
      semanticCounts: { vertices: fixture.expectedVertices },
      instrumentation: {
        syntaxValidationMs: round(median(syntax)),
        initialIndexReplayMs: round(median(replay)),
        semanticReplayMs: round(median(semantic)),
        indexedObjects: finalIndex.indexedObjects,
        winningSpans: finalIndex.winningSpans,
        coordinateSpans: finalIndex.coordinateSpans,
        sourceBytesReplayed: finalIndex.sourceBytesReplayed,
        coordinateTraversals: finalScan.coordinateTraversals,
        positionVisits: finalScan.positionVisits,
        coordinatePathMaterializations:
          finalScan.coordinatePathMaterializations,
      },
    },
    samples,
  );
}

function measureBufferedDetail(fixtureId: FixtureId): BenchmarkCaseResult {
  const fixture = createFixture(fixtureId);
  const sourceBytes = Buffer.byteLength(fixture.source);
  const requirements = createExecutionRequirements({
    facts: ['featureCount', 'vertexCount'],
  });
  const execute = () => {
    const startedAt = performance.now();
    const parsed = parseBufferedJSON(fixture.source);
    const parsedAt = performance.now();
    if (!parsed.ok) throw new Error('Buffered benchmark fixture was invalid.');
    const duplicates = scanDuplicateKeysFromValidJSON(fixture.source);
    const duplicatesAt = performance.now();
    const summary = scanGeoJSON(parsed.value, {
      filePath: '<benchmark>',
      requirements,
    });
    const finishedAt = performance.now();
    if (
      duplicates.length !== 0 ||
      summary.featureCount !== fixture.expectedFeatures ||
      summary.totalVertices !== fixture.expectedVertices
    ) {
      throw new Error('Buffered benchmark invariant failed.');
    }
    return {
      elapsedMs: finishedAt - startedAt,
      parseMs: parsedAt - startedAt,
      duplicateMs: duplicatesAt - parsedAt,
      semanticMs: finishedAt - duplicatesAt,
    };
  };
  execute();
  const samples: number[] = [];
  const parseSamples: number[] = [];
  const duplicateSamples: number[] = [];
  const semanticSamples: number[] = [];
  for (
    let iteration = 0;
    iteration < sampleCount(sourceBytes);
    iteration += 1
  ) {
    const measured = execute();
    samples.push(measured.elapsedMs);
    parseSamples.push(measured.parseMs);
    duplicateSamples.push(measured.duplicateMs);
    semanticSamples.push(measured.semanticMs);
  }
  return result(
    {
      id: `buffered-detail/${fixture.id}`,
      group: 'instrumentation',
      fixture: fixture.id,
      profile: 'buffered-detail-v2',
      strategy: 'buffered',
      sourceBytes,
      semanticCounts: {
        ...(fixture.expectedFeatures > 0
          ? { features: fixture.expectedFeatures }
          : {}),
        vertices: fixture.expectedVertices,
      },
      instrumentation: {
        jsonParseMs: round(median(parseSamples)),
        duplicateKeyScanMs: round(median(duplicateSamples)),
        semanticScanMs: round(median(semanticSamples)),
      },
    },
    samples,
  );
}

function measureMultiRuleTraversal(): BenchmarkCaseResult {
  const fixture = createFixture('points-100k');
  let callbacks = 0;
  const noopRule = (name: string) =>
    defineRule({
      meta: { name, schema: null },
      create() {
        return {
          coordinate() {
            callbacks += 1;
          },
        };
      },
    });
  const plugin = definePlugin({
    meta: { apiVersion: 1 },
    rules: {
      first: noopRule('first'),
      second: noopRule('second'),
      third: noopRule('third'),
    },
  });
  const config = resolveConfig(
    {
      plugins: { benchmark: plugin },
      rules: {
        'benchmark/first': 'error',
        'benchmark/second': 'error',
        'benchmark/third': 'error',
      },
    },
    process.cwd(),
  );
  const diagnostics = new DiagnosticCollector('<benchmark>');
  const policy = compilePolicy(config, '<benchmark>', 'object', diagnostics);
  const requirements = createExecutionRequirements({
    facts: policy.facts,
    ...(policy.listener ? { listener: policy.listener } : {}),
    exactFileBytes: policy.exactFileBytes,
    numericLexemes: policy.numericLexemes,
    featureByteSpans: policy.featureByteSpans,
  });
  const value = JSON.parse(fixture.source);
  const execute = () => {
    callbacks = 0;
    const instrumentation = scanInstrumentation();
    const startedAt = performance.now();
    scanGeoJSON(value, {
      filePath: '<benchmark>',
      requirements,
      instrumentation,
      ...(policy.listener ? { listener: policy.listener } : {}),
      ...(policy.coordinateObservation
        ? { coordinateObservation: policy.coordinateObservation }
        : {}),
    });
    if (
      callbacks !== fixture.expectedVertices * 3 ||
      instrumentation.coordinateTraversals !== 1 ||
      instrumentation.positionVisits !== fixture.expectedVertices
    ) {
      throw new Error('Multi-rule traversal invariant failed.');
    }
    return {
      elapsedMs: performance.now() - startedAt,
      instrumentation,
      callbacks,
    };
  };
  execute();
  const samples: number[] = [];
  let finalInstrumentation = scanInstrumentation();
  for (let iteration = 0; iteration < 5; iteration += 1) {
    const measured = execute();
    samples.push(measured.elapsedMs);
    finalInstrumentation = measured.instrumentation;
  }
  return result(
    {
      id: 'rule-dispatch/three-coordinate-hooks-100k',
      group: 'instrumentation',
      fixture: fixture.id,
      profile: 'three-plugin-coordinate-hooks',
      strategy: 'semantic-only',
      sourceBytes: Buffer.byteLength(fixture.source),
      semanticCounts: { vertices: fixture.expectedVertices },
      instrumentation: {
        coordinateTraversals: finalInstrumentation.coordinateTraversals,
        positionVisits: finalInstrumentation.positionVisits,
        callbacks,
      },
    },
    samples,
  );
}

function baselineEntry(source: string, filePath: string) {
  const summary = scanGeoJSON(JSON.parse(source), {
    filePath,
    sourceBytes: Buffer.byteLength(source),
    diagnostics: new DiagnosticCollector(filePath),
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
  return baselineEntryFromSummary(summary);
}

async function measureRegression(): Promise<readonly BenchmarkCaseResult[]> {
  const fixture = createFixture('points-100k');
  const directory = await mkdtemp(
    join(tmpdir(), 'geolint-benchmark-regression-'),
  );
  try {
    await writeFile(
      join(directory, 'baseline.json'),
      serializeBaseline(
        createBaseline({
          'points-100k.geojson': baselineEntry(
            fixture.source,
            'points-100k.geojson',
          ),
        }),
      ),
    );
    const execute = () =>
      lintGeoJSONTextWithParser(fixture.source, {
        parser: 'auto',
        cwd: directory,
        filename: 'points-100k.geojson',
        config: {
          extends: ['geolint/recommended'],
          regression: {
            baseline: 'baseline.json',
            thresholds: { totalVerticesIncrease: { percentage: 0 } },
          },
        },
      });
    await execute();
    const regressionSamples: number[] = [];
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const startedAt = performance.now();
      const lint = await execute();
      regressionSamples.push(performance.now() - startedAt);
      if (lint.errorCount !== 0 || lint.skippedPolicies.length !== 0) {
        throw new Error('Regression benchmark invariant failed.');
      }
    }
    const snapshotSamples: number[] = [];
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const startedAt = performance.now();
      baselineEntry(fixture.source, 'points-100k.geojson');
      snapshotSamples.push(performance.now() - startedAt);
    }
    const common = {
      group: 'product-lint' as const,
      fixture: fixture.id,
      strategy: 'auto',
      sourceBytes: Buffer.byteLength(fixture.source),
      semanticCounts: { vertices: fixture.expectedVertices },
    };
    return [
      result(
        { ...common, id: 'regression/points-100k', profile: 'regression' },
        regressionSamples,
      ),
      result(
        {
          ...common,
          id: 'snapshot-facts/points-100k',
          profile: 'snapshot-facts',
          strategy: 'buffered',
        },
        snapshotSamples,
      ),
    ];
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function measureBatch(
  id: string,
  fileCount: number,
  verticesPerFile: number,
): Promise<BenchmarkCaseResult> {
  const directory = await mkdtemp(join(tmpdir(), 'geolint-benchmark-batch-'));
  try {
    const source = JSON.stringify({
      type: 'MultiPoint',
      coordinates: Array.from({ length: verticesPerFile }, (_, index) => [
        index % 180,
        index % 90,
      ]),
    });
    const files: Record<string, ReturnType<typeof baselineEntry>> = {};
    const targets: string[] = [];
    for (let index = 0; index < fileCount; index += 1) {
      const filePath = `map-${index}.geojson`;
      targets.push(filePath);
      files[filePath] = baselineEntry(source, filePath);
      await writeFile(join(directory, filePath), source);
    }
    await writeFile(
      join(directory, 'baseline.json'),
      serializeBaseline(createBaseline(files)),
    );
    const config = {
      regression: {
        baseline: 'baseline.json',
        thresholds: { totalVerticesIncrease: { percentage: 0 } },
      },
    } as const;
    const execute = () => lintFiles({ cwd: directory, targets, config });
    await execute();
    const samples: number[] = [];
    let last!: Awaited<ReturnType<typeof execute>>;
    for (let index = 0; index < 3; index += 1) {
      const startedAt = performance.now();
      last = await execute();
      samples.push(performance.now() - startedAt);
    }
    const vertices = fileCount * verticesPerFile;
    if (last.files.length !== fileCount || last.errorCount !== 0) {
      throw new Error(`Batch invariant failed for ${id}.`);
    }
    const elapsed = median(samples) / 1_000;
    return result(
      {
        id,
        group: 'batch',
        fixture: `${fileCount}x${verticesPerFile}`,
        profile: 'regression',
        strategy: 'auto',
        sourceBytes: Buffer.byteLength(source) * fileCount,
        filesPerSecond: round(fileCount / elapsed),
        verticesPerSecond: round(vertices / elapsed),
        semanticCounts: { files: fileCount, vertices, errors: 0, warnings: 0 },
      },
      samples,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function measureColdStart(): Promise<readonly BenchmarkCaseResult[]> {
  const directory = await mkdtemp(join(tmpdir(), 'geolint-benchmark-startup-'));
  const cli = fileURLToPath(new URL('../cli/index.js', import.meta.url));
  try {
    const source = '{"type":"Point","coordinates":[0,0]}';
    await writeFile(join(directory, 'small.geojson'), source);
    const definitions = [
      ['cold-start/version', ['--version'], 0],
      ['cold-start/help', ['--help'], 0],
      [
        'cold-start/small-lint',
        ['small.geojson', '--no-config', '--format', 'json'],
        Buffer.byteLength(source),
      ],
    ] as const;
    return definitions.map(([id, args, sourceBytes]) => {
      const samples: number[] = [];
      for (let index = 0; index < 5; index += 1) {
        const startedAt = performance.now();
        const child = spawnSync(process.execPath, [cli, ...args], {
          cwd: directory,
          encoding: 'utf8',
        });
        samples.push(performance.now() - startedAt);
        if (child.status !== 0 || child.stderr !== '') {
          throw new Error(`Cold-start invariant failed for ${id}.`);
        }
      }
      return result(
        {
          id,
          group: 'cold-start',
          fixture: sourceBytes === 0 ? 'none' : 'small-clean',
          profile: 'cli',
          strategy: 'process',
          sourceBytes,
        },
        samples,
      );
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function runMemoryCase(
  fixtureId: FixtureId,
  strategy: 'buffered' | 'indexed',
  profile: 'recommended' | 'source-precision' = 'recommended',
): Promise<BenchmarkCaseResult> {
  const fixture = createFixture(fixtureId);
  const startedAt = performance.now();
  const lint = await lintGeoJSONTextWithParser(fixture.source, {
    parser: strategy,
    filename: `${fixture.id}.geojson`,
    config: {
      extends: ['geolint/recommended'],
      ...(profile === 'source-precision'
        ? { rules: { 'coordinate-precision': 'error' as const } }
        : {}),
    },
  });
  const elapsed = performance.now() - startedAt;
  if (lint.summary?.totalVertices !== fixture.expectedVertices) {
    throw new Error(`Memory invariant failed for ${fixture.id}.`);
  }
  const resourcePeak = process.resourceUsage().maxRSS * 1024;
  return result(
    {
      id: `memory/${fixture.id}/${profile}/${strategy}`,
      group: 'memory',
      fixture: fixture.id,
      profile,
      strategy,
      sourceBytes: Buffer.byteLength(fixture.source),
      peakRssBytes: Math.max(process.memoryUsage().rss, resourcePeak),
      semanticCounts: {
        features: fixture.expectedFeatures,
        vertices: fixture.expectedVertices,
      },
    },
    [elapsed],
  );
}

async function measureMemoryCases(): Promise<readonly BenchmarkCaseResult[]> {
  const entry = fileURLToPath(new URL('./index.js', import.meta.url));
  const definitions = [
    ['points-10k', 'buffered', 'recommended'],
    ['points-100k', 'buffered', 'recommended'],
    ['points-1m', 'buffered', 'recommended'],
    ['points-1m', 'indexed', 'recommended'],
    ['points-1m', 'indexed', 'source-precision'],
    ['huge-feature-100k', 'buffered', 'recommended'],
    ['tiny-features-100k', 'buffered', 'recommended'],
    ['duplicate-losing-100k', 'indexed', 'recommended'],
  ] as const satisfies readonly (readonly [
    FixtureId,
    'buffered' | 'indexed',
    'recommended' | 'source-precision',
  ])[];
  return definitions.map(([fixture, strategy, profile]) => {
    const child = spawnSync(
      process.execPath,
      [entry, '--memory-case', fixture, strategy, profile],
      { encoding: 'utf8' },
    );
    if (child.status !== 0) {
      throw new Error(`Memory child failed for ${fixture}: ${child.stderr}`);
    }
    return JSON.parse(child.stdout) as BenchmarkCaseResult;
  });
}

export async function runBenchmarks(
  extended: boolean,
): Promise<readonly BenchmarkCaseResult[]> {
  const cases: BenchmarkCaseResult[] = [];
  for (const benchmark of lintCases)
    cases.push(await measureLintCase(benchmark));
  cases.push(
    measureIndexedDetail('duplicate-losing-100k'),
    measureIndexedDetail('duplicate-winning-100k'),
    measureIndexedDetail('points-100k'),
    measureBufferedDetail('points-100k'),
    measureBufferedDetail('tiny-features-100k'),
    measureMultiRuleTraversal(),
  );
  cases.push(
    ...(await measureRegression()),
    await measureBatch('batch/10-medium', 10, 10_000),
    await measureBatch('batch/100-small', 100, 100),
    ...(await measureColdStart()),
  );
  if (extended) cases.push(...(await measureMemoryCases()));
  return cases;
}

export async function runProfileCase(id: string): Promise<BenchmarkCaseResult> {
  if (id === 'buffered-detail/points-100k')
    return measureBufferedDetail('points-100k');
  if (id === 'buffered-detail/tiny-features-100k')
    return measureBufferedDetail('tiny-features-100k');
  if (id === 'indexed-detail/duplicate-losing-100k') {
    return measureIndexedDetail('duplicate-losing-100k');
  }
  const benchmark = lintCases.find((candidate) => candidate.id === id);
  if (!benchmark)
    throw new TypeError(`Unknown benchmark case ${JSON.stringify(id)}.`);
  return measureLintCase(benchmark);
}
