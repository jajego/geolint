import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repository = resolve(import.meta.dirname, '..');
const npm = process.env.npm_execpath;
assert.ok(npm, 'npm_execpath is required.');
const tsc = resolve(repository, 'node_modules', 'typescript', 'bin', 'tsc');
const packageVersion = JSON.parse(
  await readFile(join(repository, 'package.json'), 'utf8'),
).version;

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
  assert.equal(details.name, '@jajego/geolint');
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
  const installedPackage = JSON.parse(
    await readFile(
      join(consumer, 'node_modules', '@jajego', 'geolint', 'package.json'),
    ),
  );
  assert.equal(installedPackage.name, '@jajego/geolint');
  assert.equal(installedPackage.version, packageVersion);

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
  assert.equal(
    runCli(['--version'], consumer).stdout,
    `geolint ${packageVersion}\n`,
  );
  assert.match(
    runCli(['--format', 'unsupported'], consumer, [2]).stderr,
    /GEOLINT_CLI_ERROR/,
  );

  await writeFile(
    join(consumer, 'node-api.mjs'),
    `import assert from 'node:assert/strict';
import { lintGeoJSONText } from '@jajego/geolint';
const result = await lintGeoJSONText('{"type":"Point","coordinates":[0,0]}');
assert.equal(result.summary?.totalVertices, 1);
`,
  );
  run(process.execPath, ['node-api.mjs'], consumer);

  await writeFile(
    join(consumer, 'plugin.mjs'),
    `import { definePlugin, defineRule } from '@jajego/geolint';
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
    `import { defineConfig } from '@jajego/geolint';
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
    `import { defineConfig, definePlugin, defineRule, lintFiles, lintGeoJSONText } from '@jajego/geolint';
import type { FileLintResult, GeoLintConfig, GeoLintPlugin, LintResult } from '@jajego/geolint';
const rule = defineRule({ meta: { name: 'typed', schema: null }, create: () => ({}) });
const plugin: GeoLintPlugin = definePlugin({ meta: { apiVersion: 1 }, rules: { typed: rule } });
const config: GeoLintConfig = defineConfig({ plugins: { demo: plugin } });
const file: Promise<FileLintResult> = lintGeoJSONText('{}');
const batch: Promise<LintResult> = lintFiles({ workers: 1 });
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

  const fixture = join(repository, 'fixtures', 'external-plugin');
  const fixtureConsumer = join(repository, 'fixtures', 'external-consumer');
  const fixturePluginDirectory = join(consumer, 'plugin');
  await mkdir(fixturePluginDirectory);
  await cp(join(fixture, 'src'), join(fixturePluginDirectory, 'src'), {
    recursive: true,
  });
  await cp(
    join(fixture, 'tsconfig.json'),
    join(fixturePluginDirectory, 'tsconfig.json'),
  );
  await cp(
    join(fixture, 'package.json'),
    join(fixturePluginDirectory, 'package.json'),
  );
  run(process.execPath, [tsc, '-p', 'tsconfig.json'], fixturePluginDirectory);
  const pluginDetails = JSON.parse(
    runNpm(
      ['pack', '--json', '--pack-destination', consumer],
      fixturePluginDirectory,
    ).stdout,
  )[0];
  assert.equal(pluginDetails.name, '@fixture/geolint-plugin-quality');
  assert.ok(pluginDetails.files.some(({ path }) => path === 'dist/index.d.ts'));
  const pluginTarball = join(consumer, pluginDetails.filename);
  runNpm(
    ['install', pluginTarball, '--ignore-scripts', '--no-audit', '--no-fund'],
    consumer,
  );
  await cp(
    join(fixtureConsumer, 'geolint.config.mjs'),
    join(consumer, 'geolint.config.mjs'),
  );
  await cp(join(fixtureConsumer, 'maps'), join(consumer, 'maps'), {
    recursive: true,
  });
  const sequentialPlugin = runCli(
    ['maps', '--workers', '1', '--no-color'],
    consumer,
    [1],
  );
  const parallelPlugin = runCli(
    ['maps', '--workers', '2', '--no-color'],
    consumer,
    [1],
  );
  const stableOutput = (value) => value.replace(/· \d+ ms/g, '· <ms>');
  assert.equal(
    stableOutput(parallelPlugin.stdout),
    stableOutput(sequentialPlugin.stdout),
  );
  for (const rule of [
    'quality/require-feature-id',
    'quality/allowed-property-values',
    'quality/unique-property-value',
    'quality/coordinate-precision',
  ]) {
    assert.match(parallelPlugin.stdout, new RegExp(rule));
  }

  process.stdout.write(
    `Packed consumer smoke passed (${details.entryCount} files, ${details.size} packed bytes, ${details.unpackedSize} unpacked bytes).\n`,
  );
} finally {
  await rm(consumer, { recursive: true, force: true });
}
