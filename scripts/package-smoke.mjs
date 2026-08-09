import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repository = resolve(import.meta.dirname, '..');
const npm = process.env.npm_execpath;
assert.ok(npm, 'npm_execpath is required.');
const tsc = resolve(repository, 'node_modules', 'typescript', 'bin', 'tsc');

function run(command, args, cwd, expected = [0]) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  assert.ok(
    expected.includes(result.status ?? -1),
    `${command} ${args.join(' ')} exited ${result.status}\n${result.stdout}${result.stderr}`,
  );
  return result;
}

function runNpm(args, cwd, expected = [0]) {
  return run(process.execPath, [npm, ...args], cwd, expected);
}

function runCli(args, cwd, expected = [0]) {
  return runNpm(['exec', '--', 'geolint', ...args], cwd, expected);
}

const consumer = await mkdtemp(join(tmpdir(), 'geolint-consumer-'));
try {
  const packed = runNpm(
    ['pack', '--json', '--pack-destination', consumer],
    repository,
  );
  const starts = [...packed.stdout.matchAll(/\[\s*\{\s*"id"/g)];
  const start = starts.at(-1)?.index;
  assert.notEqual(
    start,
    undefined,
    `npm pack did not return JSON:\n${packed.stdout}`,
  );
  const details = JSON.parse(packed.stdout.slice(start))[0];
  const paths = details.files.map(({ path }) => path);
  for (const expected of [
    'README.md',
    'LICENSE',
    'CHANGELOG.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'docs/configuration.md',
    'docs/rules.md',
    'docs/budgets.md',
    'docs/node-api.md',
    'docs/plugins.md',
    'docs/regression.md',
    'docs/errors.md',
    'docs/performance.md',
    'docs/releasing.md',
  ]) {
    assert.ok(
      paths.includes(expected),
      `${expected} is missing from the tarball.`,
    );
  }
  assert.ok(paths.includes('dist/workers/worker-entry.js'));
  assert.ok(paths.every((path) => !path.startsWith('dist/test/')));
  assert.ok(paths.every((path) => !path.startsWith('dist/benchmark/')));
  assert.ok(paths.every((path) => !path.endsWith('.d.ts.map')));
  assert.ok(
    paths.every((path) =>
      [
        'dist/',
        'docs/',
        'README.md',
        'LICENSE',
        'CHANGELOG.md',
        'CONTRIBUTING.md',
        'SECURITY.md',
        'package.json',
      ].some((allowed) =>
        allowed.endsWith('/') ? path.startsWith(allowed) : path === allowed,
      ),
    ),
    'The tarball contains an unexpected path.',
  );
  const tarball = join(consumer, details.filename);

  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
  );
  runNpm(
    ['install', tarball, '--ignore-scripts', '--no-audit', '--no-fund'],
    consumer,
  );

  const valid = { type: 'Point', coordinates: [0, 0] };
  const quality = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', id: 'same', properties: {}, geometry: valid },
      { type: 'Feature', id: 'same', properties: {}, geometry: valid },
    ],
  };
  await writeFile(join(consumer, 'valid.geojson'), JSON.stringify(valid));
  await writeFile(join(consumer, 'quality.geojson'), JSON.stringify(quality));
  await writeFile(join(consumer, 'invalid.geojson'), '{"type":');
  runCli(['valid.geojson', '--no-color'], consumer);
  const qualityResult = runCli(
    ['quality.geojson', '--no-color'],
    consumer,
    [1],
  );
  assert.match(qualityResult.stdout, /unique-feature-id/);
  const invalidResult = runCli(
    ['invalid.geojson', '--no-color'],
    consumer,
    [1],
  );
  assert.match(invalidResult.stdout, /parse\/invalid-json/);
  assert.match(runCli(['--help'], consumer).stdout, /Usage: geolint/);
  assert.match(runCli(['--version'], consumer).stdout, /^geolint 0\.0\.0/m);
  assert.match(
    runCli(['--format', 'unsupported'], consumer, [2]).stderr,
    /GEOLINT_CLI_ERROR/,
  );

  await writeFile(
    join(consumer, 'node-api.mjs'),
    `import assert from 'node:assert/strict';
import { lintGeoJSONText } from 'geolint';
const result = await lintGeoJSONText('{"type":"Point","coordinates":[0,0]}');
assert.equal(result.summary?.totalVertices, 1);
`,
  );
  run(process.execPath, ['node-api.mjs'], consumer);

  await writeFile(
    join(consumer, 'plugin.mjs'),
    `import { definePlugin, defineRule } from 'geolint';
const nonEmpty = defineRule({
  meta: { name: 'non-empty', schema: null, requires: ['featureCount'] },
  create(context) {
    return { document(summary) {
      if (summary.featureCount > 0) context.report({ message: 'Document contains Features.' });
    } };
  },
});
export default definePlugin({
  meta: { apiVersion: 1, moduleUrl: import.meta.url, exportName: 'default' },
  rules: { 'non-empty': nonEmpty },
});
`,
  );
  await writeFile(
    join(consumer, 'geolint.config.mjs'),
    `import { defineConfig } from 'geolint';
import demo from './plugin.mjs';
export default defineConfig({
  plugins: { demo },
  rules: { 'demo/non-empty': 'warn' },
  regression: {
    baseline: '.geolint-baseline.json',
    thresholds: { totalVerticesIncrease: { minimumIncrease: 0 } },
  },
});
`,
  );
  const plugin = runCli(['quality.geojson', '--no-color'], consumer);
  assert.match(plugin.stdout, /demo\/non-empty/);
  const noConfig = runCli(
    ['valid.geojson', '--no-config', '--no-color'],
    consumer,
  );
  assert.doesNotMatch(noConfig.stdout, /demo\/non-empty/);
  const printed = runCli(['--print-config', 'valid.geojson'], consumer);
  assert.equal(JSON.parse(printed.stdout).filePath, 'valid.geojson');

  await writeFile(join(consumer, 'valid-copy.geojson'), JSON.stringify(valid));
  runCli(
    ['valid.geojson', 'valid-copy.geojson', '--workers', '2', '--no-color'],
    consumer,
  );
  runCli(['snapshot', 'valid.geojson', '--no-color'], consumer);
  runCli(['valid.geojson', '--no-color'], consumer);
  await writeFile(
    join(consumer, 'valid.geojson'),
    JSON.stringify({
      type: 'MultiPoint',
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    }),
  );
  const regression = runCli(['valid.geojson', '--no-color'], consumer, [1]);
  assert.match(regression.stdout, /regression\/vertex-count/);
  runCli(['snapshot', 'valid.geojson', '--no-color'], consumer);
  runCli(['valid.geojson', '--no-color'], consumer);
  assert.ok(
    (await readFile(join(consumer, '.geolint-baseline.json'), 'utf8')).includes(
      'valid.geojson',
    ),
  );

  await writeFile(
    join(consumer, 'consumer.ts'),
    `import { defineConfig, definePlugin, defineRule, lintFiles, lintGeoJSONText } from 'geolint';
import type { FileLintResult, GeoLintConfig, GeoLintPlugin, LintResult } from 'geolint';
const rule = defineRule({ meta: { name: 'typed', schema: null }, create: () => ({}) });
const plugin: GeoLintPlugin = definePlugin({ meta: { apiVersion: 1 }, rules: { typed: rule } });
const config: GeoLintConfig = defineConfig({ plugins: { demo: plugin } });
const file: Promise<FileLintResult> = lintGeoJSONText('{}');
const batch: Promise<LintResult> = lintFiles();
void config; void file; void batch;
`,
  );
  await writeFile(
    join(consumer, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2024',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        skipLibCheck: false,
      },
      include: ['consumer.ts'],
    }),
  );
  run(process.execPath, [tsc, '-p', 'tsconfig.json'], consumer);

  process.stdout.write(
    `Packed consumer smoke passed (${details.entryCount} files, ${details.size} packed bytes, ${details.unpackedSize} unpacked bytes).\n`,
  );
} finally {
  await rm(consumer, { recursive: true, force: true });
}
