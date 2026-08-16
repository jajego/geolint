import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { lintFileWithParser } from '../engine/lint-input.js';
import { median, round } from './metrics.js';
import { createArtifact, formatBenchmark } from './report.js';
import type { BenchmarkCaseResult, BenchmarkMemorySample } from './types.js';

type Strategy = 'buffered' | 'indexed';
type Shape = 'dense-coordinates' | 'many-features' | 'large-string';

interface GeneratedFixture {
  readonly id: string;
  readonly shape: Shape;
  readonly requestedMiB: number;
  readonly path: string;
  readonly sourceBytes: number;
  readonly expectedFeatures: number;
  readonly expectedVertices: number;
  readonly sampleCount: number;
}

interface ChildResult {
  readonly wallMs: number;
  readonly sourceBytes: number;
  readonly semanticCounts: NonNullable<BenchmarkCaseResult['semanticCounts']>;
  readonly memory: BenchmarkMemorySample;
}

const mib = 1024 * 1024;

async function writeFixture(
  path: string,
  body: (write: (text: string) => Promise<void>) => Promise<void>,
): Promise<number> {
  const stream = createWriteStream(path, { encoding: 'utf8' });
  let bytes = 0;
  const write = async (text: string) => {
    bytes += Buffer.byteLength(text);
    if (!stream.write(text)) await once(stream, 'drain');
  };
  try {
    await body(write);
    stream.end();
    await finished(stream);
    return bytes;
  } catch (error) {
    stream.destroy();
    throw error;
  }
}

async function denseFixture(directory: string, requestedMiB: number) {
  const path = join(directory, `dense-${requestedMiB}m.geojson`);
  const head = '{"type":"LineString","coordinates":[';
  const tail = ']}';
  const position = '[1,2]';
  const target = requestedMiB * mib;
  const count = Math.floor(
    (target - head.length - tail.length + 1) / (position.length + 1),
  );
  const sourceBytes = await writeFixture(path, async (write) => {
    await write(head);
    let remaining = count - 1;
    while (remaining > 0) {
      const entries = Math.min(remaining, 16_384);
      await write(`${`${position},`.repeat(entries)}`);
      remaining -= entries;
    }
    await write(`${position}${tail}`);
  });
  return {
    id: `dense-${requestedMiB}m`,
    shape: 'dense-coordinates' as const,
    requestedMiB,
    path,
    sourceBytes,
    expectedFeatures: 0,
    expectedVertices: count,
    sampleCount: requestedMiB === 10 ? 2 : 1,
  };
}

async function manyFeaturesFixture(directory: string) {
  const requestedMiB = 50;
  const path = join(directory, 'many-features-50m.geojson');
  const target = requestedMiB * mib;
  const head = '{"type":"FeatureCollection","features":[';
  const tail = ']}';
  let count = 0;
  const sourceBytes = await writeFixture(path, async (write) => {
    await write(head);
    let chunk = '';
    let chunkBytes = 0;
    let bodyBytes = head.length;
    while (true) {
      const feature = `${
        count === 0 ? '' : ','
      }{"type":"Feature","id":${count},"properties":{"kind":"large-memory"},"geometry":{"type":"Point","coordinates":[1,2]}}`;
      const featureBytes = Buffer.byteLength(feature);
      if (bodyBytes + featureBytes + tail.length > target) break;
      chunk += feature;
      chunkBytes += featureBytes;
      bodyBytes += featureBytes;
      count += 1;
      if (chunkBytes >= 64 * 1024) {
        await write(chunk);
        chunk = '';
        chunkBytes = 0;
      }
    }
    if (chunk) await write(chunk);
    await write(tail);
  });
  return {
    id: 'many-features-50m',
    shape: 'many-features' as const,
    requestedMiB,
    path,
    sourceBytes,
    expectedFeatures: count,
    expectedVertices: count,
    sampleCount: 1,
  };
}

async function largeStringFixture(directory: string) {
  const requestedMiB = 50;
  const path = join(directory, 'large-string-50m.geojson');
  const target = requestedMiB * mib;
  const head = '{"type":"Feature","id":1,"properties":{"payload":"';
  const tail = '"},"geometry":{"type":"Point","coordinates":[1,2]}}';
  const sourceBytes = await writeFixture(path, async (write) => {
    await write(head);
    let remaining = target - head.length - tail.length;
    while (remaining > 0) {
      const size = Math.min(remaining, 64 * 1024);
      await write('x'.repeat(size));
      remaining -= size;
    }
    await write(tail);
  });
  return {
    id: 'large-string-50m',
    shape: 'large-string' as const,
    requestedMiB,
    path,
    sourceBytes,
    expectedFeatures: 1,
    expectedVertices: 1,
    sampleCount: 1,
  };
}

async function fixtures(
  directory: string,
): Promise<readonly GeneratedFixture[]> {
  return [
    await denseFixture(directory, 10),
    await denseFixture(directory, 50),
    await denseFixture(directory, 100),
    await manyFeaturesFixture(directory),
    await largeStringFixture(directory),
  ];
}

async function child(
  path: string,
  strategy: Strategy,
  expectedFeatures: number,
  expectedVertices: number,
): Promise<void> {
  const sourceBytes = (await stat(path)).size;
  const startedAt = performance.now();
  const result = await lintFileWithParser(path, {
    parser: strategy,
    config: { extends: ['geolint/recommended'] },
  });
  const wallMs = performance.now() - startedAt;
  if (
    result.summary?.featureCount !== expectedFeatures ||
    result.summary.totalVertices !== expectedVertices ||
    result.summary.bytes !== sourceBytes ||
    result.errorCount !== 0 ||
    result.warningCount !== 0
  ) {
    throw new Error(`Large-memory semantic invariant failed for ${path}.`);
  }
  const memory = process.memoryUsage();
  const peakRssBytes = Math.max(
    memory.rss,
    process.resourceUsage().maxRSS * 1024,
  );
  const output: ChildResult = {
    wallMs: round(wallMs),
    sourceBytes,
    semanticCounts: {
      features: result.summary.featureCount,
      vertices: result.summary.totalVertices,
      errors: result.errorCount,
      warnings: result.warningCount,
      retainedDiagnostics: result.diagnostics.length,
      suppressedDiagnostics: result.suppressedDiagnostics.reduce(
        (total, item) => total + item.suppressedCount,
        0,
      ),
    },
    memory: {
      peakRssBytes,
      finalRssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
    },
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

function sample(
  entry: string,
  fixture: GeneratedFixture,
  strategy: Strategy,
): ChildResult {
  const childProcess = spawnSync(
    process.execPath,
    [
      entry,
      '--child',
      fixture.path,
      strategy,
      String(fixture.expectedFeatures),
      String(fixture.expectedVertices),
    ],
    { encoding: 'utf8', maxBuffer: 1_000_000 },
  );
  if (childProcess.status !== 0)
    throw new Error(childProcess.stderr || 'Large-memory child failed.');
  return JSON.parse(childProcess.stdout) as ChildResult;
}

function result(
  fixture: GeneratedFixture,
  strategy: Strategy,
  samples: readonly ChildResult[],
): BenchmarkCaseResult {
  const timings = samples.map((item) => round(item.wallMs));
  const memory = samples.map((item) => item.memory);
  const elapsed = median(timings) / 1_000;
  const metric = (key: keyof BenchmarkMemorySample) =>
    round(median(memory.map((item) => item[key])));
  const final = samples.at(-1)!;
  if (
    samples.some(
      (item) =>
        item.sourceBytes !== fixture.sourceBytes ||
        item.semanticCounts.features !== fixture.expectedFeatures ||
        item.semanticCounts.vertices !== fixture.expectedVertices,
    )
  ) {
    throw new Error(`Large-memory result invariant failed for ${fixture.id}.`);
  }
  return {
    id: `large-memory/${fixture.id}/${strategy}`,
    group: 'memory',
    fixture: fixture.id,
    shape: fixture.shape,
    requestedMiB: fixture.requestedMiB,
    profile: 'large-memory',
    strategy,
    coordinateConsumer: strategy === 'indexed' ? 'direct' : 'not-applicable',
    sourceBytes: fixture.sourceBytes,
    fileBytes: fixture.sourceBytes,
    sampleCount: timings.length,
    samplesMs: timings,
    medianMs: median(timings),
    minMs: Math.min(...timings),
    maxMs: Math.max(...timings),
    megabytesPerSecond: round(fixture.sourceBytes / 1_000_000 / elapsed),
    ...(fixture.expectedFeatures > 0
      ? { featuresPerSecond: round(fixture.expectedFeatures / elapsed) }
      : {}),
    ...(fixture.expectedVertices > 0
      ? { verticesPerSecond: round(fixture.expectedVertices / elapsed) }
      : {}),
    peakRssBytes: metric('peakRssBytes'),
    finalRssBytes: metric('finalRssBytes'),
    heapUsedBytes: metric('heapUsedBytes'),
    externalBytes: metric('externalBytes'),
    arrayBuffersBytes: metric('arrayBuffersBytes'),
    memorySamples: memory,
    semanticCounts: final.semanticCounts,
  };
}

function output(
  cases: readonly BenchmarkCaseResult[],
  fixtureBytes: number,
  runtimeMs: number,
  artifactBytes?: number,
): string {
  const artifact = createArtifact(cases, 'large-memory');
  const peak = Math.max(...cases.map((item) => item.peakRssBytes ?? 0));
  return `${formatBenchmark(artifact)}\nlarge-memory suite: ${(runtimeMs / 1_000).toFixed(1)} s wall - ${(fixtureBytes / mib).toFixed(1)} MiB temporary fixtures - ${(peak / mib).toFixed(1)} MiB highest child RSS${artifactBytes === undefined ? '' : ` - ${artifactBytes} B artifact`}\n`;
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv[0] === '--child') {
    const [, path, strategy, features, vertices] = argv;
    if (
      !path ||
      (strategy !== 'buffered' && strategy !== 'indexed') ||
      !features ||
      !vertices
    )
      throw new TypeError('Invalid large-memory child arguments.');
    await child(path, strategy, Number(features), Number(vertices));
    return;
  }
  const outputIndex = argv.indexOf('--output');
  const outputPath = outputIndex < 0 ? undefined : argv[outputIndex + 1];
  if (outputIndex >= 0 && !outputPath)
    throw new TypeError('--output requires a JSON file path.');
  const startedAt = performance.now();
  const directory = await mkdtemp(join(tmpdir(), 'geolint-large-memory-'));
  try {
    const generated = await fixtures(directory);
    const entry = fileURLToPath(import.meta.url);
    const cases: BenchmarkCaseResult[] = [];
    for (const fixture of generated) {
      for (const strategy of ['buffered', 'indexed'] as const) {
        const samples = Array.from({ length: fixture.sampleCount }, () =>
          sample(entry, fixture, strategy),
        );
        cases.push(result(fixture, strategy, samples));
      }
    }
    const artifact = createArtifact(cases, 'large-memory');
    let artifactBytes: number | undefined;
    if (outputPath) {
      const path = resolve(outputPath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`);
      artifactBytes = (await stat(path)).size;
    }
    if (argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
    } else {
      process.stdout.write(
        output(
          cases,
          generated.reduce((total, item) => total + item.sourceBytes, 0),
          performance.now() - startedAt,
          artifactBytes,
        ),
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2));
