import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const cli = fileURLToPath(new URL('../cli/index.js', import.meta.url));
const samples = 7;
const warmups = 2;

interface Result {
  readonly workload: string;
  readonly medianMs: number;
  readonly rangeMs: readonly [number, number];
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function run(cwd: string, args: readonly string[], expectedStatus = 0): number {
  const startedAt = performance.now();
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
  });
  const elapsed = performance.now() - startedAt;
  if (result.status !== expectedStatus || result.stderr !== '') {
    throw new Error(
      `${args.join(' ')} failed: ${result.status}\n${result.stderr}`,
    );
  }
  return elapsed;
}

function measure(
  workload: string,
  cwd: string,
  args: readonly string[],
): Result {
  for (let index = 0; index < warmups; index += 1) run(cwd, args);
  const values = Array.from({ length: samples }, () => run(cwd, args));
  return {
    workload,
    medianMs: Number(median(values).toFixed(2)),
    rangeMs: [
      Number(Math.min(...values).toFixed(2)),
      Number(Math.max(...values).toFixed(2)),
    ],
  };
}

const tiny = '{"type":"Point","coordinates":[0,0]}';
const small = JSON.stringify({
  type: 'FeatureCollection',
  features: Array.from({ length: 100 }, (_, index) => ({
    type: 'Feature',
    properties: { index },
    geometry: { type: 'Point', coordinates: [index / 10, 0] },
  })),
});
const large = JSON.stringify({
  type: 'LineString',
  coordinates: Array.from({ length: 100_000 }, (_, index) => [index % 180, 0]),
});

const root = await mkdtemp(join(tmpdir(), 'geolint-cli-cold-'));
const noConfigRoot = await mkdtemp(join(tmpdir(), 'geolint-cli-cold-absent-'));
try {
  const nested = join(root, 'nested', 'a', 'b', 'c');
  await mkdir(nested, { recursive: true });
  await writeFile(join(root, 'tiny.geojson'), tiny);
  await writeFile(join(root, 'small.geojson'), small);
  await writeFile(join(root, 'large.geojson'), large);
  const noConfig = join(noConfigRoot, 'a', 'b', 'c');
  await mkdir(noConfig, { recursive: true });
  await writeFile(join(noConfig, 'tiny.geojson'), tiny);
  await writeFile(
    join(root, 'geolint.config.ts'),
    "export default { rules: { 'valid-coordinate-range': 'error' } };\n",
  );

  const results = [
    measure('version', root, ['--version']),
    measure('help', root, ['--help']),
    measure('tiny-no-config-json', root, [
      '--no-config',
      '--format',
      'json',
      'tiny.geojson',
    ]),
    measure('tiny-no-config-pretty', root, [
      '--no-config',
      '--no-color',
      'tiny.geojson',
    ]),
    measure('tiny-discovery-absent', noConfig, [
      '--format',
      'json',
      'tiny.geojson',
    ]),
    measure('tiny-config-present', nested, [
      '--format',
      'json',
      '../../../../tiny.geojson',
    ]),
    measure('small-json', root, [
      '--no-config',
      '--format',
      'json',
      'small.geojson',
    ]),
    measure('large-json', root, [
      '--no-config',
      '--format',
      'json',
      'large.geojson',
    ]),
  ];
  process.stdout.write(`${JSON.stringify({ samples, results }, null, 2)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(noConfigRoot, { recursive: true, force: true });
}
