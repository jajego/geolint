import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('../cli/index.js', import.meta.url));

async function run(args: readonly string[], cwd?: string) {
  return execFileAsync(process.execPath, [cliPath, ...args], { cwd });
}

function runResult(
  args: readonly string[],
  options: { readonly cwd?: string; readonly input?: string | Buffer } = {},
) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: options.cwd,
    input: options.input,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

test('CLI help and version use the public command contract', async () => {
  const { stdout, stderr } = await run(['--help']);

  assert.equal(stderr, '');
  assert.match(stdout, /--print-config <file>/);
  assert.match(stdout, /snapshot \[targets\.\.\.\]/);
  assert.deepEqual(await run(['--version']), {
    stdout: 'geolint 0.0.0\n',
    stderr: '',
  });
});

test('snapshot command writes a baseline and prints its proposal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geolint-cli-snapshot-'));
  try {
    await writeFile(
      join(root, 'geolint.json'),
      JSON.stringify({ files: ['map.geojson'] }),
    );
    await writeFile(
      join(root, 'map.geojson'),
      JSON.stringify({ type: 'Point', coordinates: [0, 0] }),
    );
    const { stdout, stderr } = await run(
      ['--config', 'geolint.json', '--format', 'json', 'snapshot'],
      root,
    );
    assert.equal(stderr, '');
    assert.deepEqual(
      JSON.parse(stdout).added.map(
        ({ filePath }: { filePath: string }) => filePath,
      ),
      ['map.geojson'],
    );
    assert.equal(
      JSON.parse(await readFile(join(root, '.geolint-baseline.json'), 'utf8'))
        .schemaVersion,
      1,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('no-config pretty and JSON flows lint the actual built CLI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geolint-cli-product-'));
  try {
    await writeFile(
      join(root, 'map.geojson'),
      JSON.stringify({ type: 'Point', coordinates: [181, 0] }),
    );
    const pretty = runResult(['--no-config', '--no-color', 'map.geojson'], {
      cwd: root,
    });
    assert.equal(pretty.status, 1);
    assert.equal(pretty.stderr, '');
    assert.match(pretty.stdout, /valid-coordinate-range/);
    assert.match(pretty.stdout, /1 vertex/);

    const machine = runResult(
      ['--no-config', '--format', 'json', 'map.geojson'],
      { cwd: root },
    );
    assert.equal(machine.status, 1);
    assert.equal(machine.stderr, '');
    const result = JSON.parse(machine.stdout);
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.geolintVersion, '0.0.0');
    assert.equal(result.errorCount, 1);
    assert.equal(result.files[0].diagnostics[0].code, 'valid-coordinate-range');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI exit codes distinguish findings, warning thresholds, and operations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geolint-cli-exits-'));
  try {
    await writeFile(
      join(root, 'clean.geojson'),
      JSON.stringify({ type: 'Point', coordinates: [0, 0] }),
    );
    await writeFile(join(root, 'malformed.geojson'), '{');
    await writeFile(
      join(root, 'features.geojson'),
      JSON.stringify({
        type: 'FeatureCollection',
        features: Array.from({ length: 3 }, () => ({
          type: 'Feature',
          properties: {},
          geometry: { type: 'Point', coordinates: [0, 0] },
        })),
      }),
    );
    await writeFile(
      join(root, 'warnings.json'),
      JSON.stringify({
        rules: { 'require-feature-id': 'warn' },
        diagnostics: { maxPerCodePerFile: 1 },
      }),
    );
    assert.equal(
      runResult(['--no-config', 'clean.geojson'], { cwd: root }).status,
      0,
    );
    assert.equal(
      runResult(['--no-config', 'malformed.geojson'], { cwd: root }).status,
      1,
    );
    const warnings = runResult(
      [
        '--config',
        'warnings.json',
        '--max-warnings',
        '1',
        '--format',
        'json',
        'features.geojson',
      ],
      { cwd: root },
    );
    assert.equal(warnings.status, 1);
    assert.equal(JSON.parse(warnings.stdout).warningCount, 3);
    assert.equal(JSON.parse(warnings.stdout).files[0].diagnostics.length, 1);
    assert.equal(
      runResult(['--config', 'warnings.json', 'features.geojson'], {
        cwd: root,
      }).status,
      0,
    );
    const unmatched = runResult(['--no-config', 'missing.geojson'], {
      cwd: root,
    });
    assert.equal(unmatched.status, 2);
    assert.match(unmatched.stderr, /GEOLINT_UNMATCHED_TARGET/);
    assert.equal(
      runResult(['--format', 'xml', 'clean.geojson'], { cwd: root }).status,
      2,
    );
    await writeFile(join(root, 'invalid.json'), '{');
    assert.equal(
      runResult(['--config', 'invalid.json', 'clean.geojson'], { cwd: root })
        .status,
      2,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI stdin supports identity, malformed JSON, and invalid UTF-8', () => {
  const valid = runResult(
    [
      '--no-config',
      '--format',
      'json',
      '--stdin-filename',
      'public/generated.geojson',
      '-',
    ],
    { input: '{"type":"Point","coordinates":[0,0]}' },
  );
  assert.equal(valid.status, 0);
  assert.equal(
    JSON.parse(valid.stdout).files[0].filePath,
    'public/generated.geojson',
  );

  const malformed = runResult(['--no-config', '--format', 'json', '-'], {
    input: '{',
  });
  assert.equal(malformed.status, 1);
  assert.equal(
    JSON.parse(malformed.stdout).files[0].diagnostics[0].code,
    'parse/invalid-json',
  );

  const invalid = runResult(['--no-config', '--format', 'json', '-'], {
    input: Buffer.from([0xff]),
  });
  assert.equal(invalid.status, 1);
  assert.equal(
    JSON.parse(invalid.stdout).files[0].diagnostics[0].code,
    'parse/invalid-encoding',
  );
});

test('JSON debug output stays clean and parser capability errors are operational', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geolint-cli-parser-'));
  try {
    await writeFile(
      join(root, 'map.geojson'),
      '{"type":"Point","coordinates":[1.23456789,0]}',
    );
    await writeFile(
      join(root, 'precision.json'),
      JSON.stringify({ rules: { 'coordinate-precision': 'error' } }),
    );
    const debug = runResult(
      ['--no-config', '--format', 'json', '--debug', 'map.geojson'],
      { cwd: root },
    );
    assert.equal(debug.status, 0);
    assert.doesNotThrow(() => JSON.parse(debug.stdout));
    assert.doesNotMatch(debug.stdout, /GeoLint debug/);
    assert.match(debug.stderr, /GeoLint debug/);

    const stable = (stdout: string) => {
      const result = JSON.parse(stdout);
      delete result.durationMs;
      for (const file of result.files) delete file.durationMs;
      return result;
    };
    const strategies = ['auto', 'buffered', 'indexed'].map((parser) =>
      stable(
        runResult(
          [
            '--no-config',
            '--format',
            'json',
            '--parser',
            parser,
            'map.geojson',
          ],
          { cwd: root },
        ).stdout,
      ),
    );
    assert.deepEqual(strategies[1], strategies[0]);
    assert.deepEqual(strategies[2], strategies[0]);

    const buffered = runResult(
      ['--config', 'precision.json', '--parser', 'buffered', 'map.geojson'],
      { cwd: root },
    );
    assert.equal(buffered.status, 2);
    assert.match(buffered.stderr, /GEOLINT_CAPABILITY_NUMERIC_LEXEMES/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('directory, glob, config.files, ignores, and no-ignore use target resolution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geolint-cli-targets-'));
  try {
    await mkdir(join(root, 'maps'));
    for (const name of ['a.geojson', 'b.geojson']) {
      await writeFile(
        join(root, 'maps', name),
        JSON.stringify({ type: 'Point', coordinates: [0, 0] }),
      );
    }
    await writeFile(
      join(root, 'ignored.geojson'),
      JSON.stringify({ type: 'Point', coordinates: [181, 0] }),
    );
    await writeFile(
      join(root, 'geolint.json'),
      JSON.stringify({
        files: ['maps/*.geojson'],
        ignores: ['ignored.geojson'],
        rules: { 'valid-coordinate-range': 'error' },
      }),
    );
    for (const targets of [[], ['maps'], ['maps/*.geojson']]) {
      const result = runResult(
        ['--config', 'geolint.json', '--format', 'json', ...targets],
        { cwd: root },
      );
      assert.equal(result.status, 0);
      assert.equal(JSON.parse(result.stdout).files.length, 2);
    }
    assert.equal(
      JSON.parse(
        runResult(
          ['--config', 'geolint.json', '--format', 'json', 'ignored.geojson'],
          { cwd: root },
        ).stdout,
      ).files.length,
      0,
    );
    assert.equal(
      runResult(
        ['--config', 'geolint.json', '--no-ignore', 'ignored.geojson'],
        { cwd: root },
      ).status,
      1,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('configured project loads plugins, budgets, overrides, and print-config data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geolint-cli-project-'));
  const pluginUrl = new URL('./fixtures/external-plugin.js', import.meta.url)
    .href;
  try {
    await mkdir(join(root, 'public'));
    for (const name of ['a.geojson', 'b.geojson']) {
      await writeFile(
        join(root, 'public', name),
        JSON.stringify({
          type: 'Feature',
          properties: { name, secret: true },
          geometry: { type: 'Point', coordinates: [0, 0] },
        }),
      );
    }
    await writeFile(
      join(root, 'geolint.config.ts'),
      `import plugin from ${JSON.stringify(pluginUrl)};
export default {
  files: ['public/*.geojson'],
  plugins: { acme: plugin },
  rules: { 'acme/property-allowlist': ['error', { allow: ['name'] }] },
  budgets: { featureCount: 10 },
  overrides: [{
    files: ['public/b.geojson'],
    rules: { 'acme/property-allowlist': ['error', { allow: ['name', 'secret'] }] },
  }],
};\n`,
    );
    const lint = runResult(['--format', 'json'], { cwd: root });
    assert.equal(lint.status, 1);
    const result = JSON.parse(lint.stdout);
    assert.equal(result.files.length, 2);
    assert.equal(
      result.files[0].diagnostics[0].code,
      'acme/property-allowlist',
    );
    assert.equal(result.files[1].errorCount, 0);

    const printed = runResult(['--print-config', 'public/b.geojson'], {
      cwd: root,
    });
    const config = JSON.parse(printed.stdout);
    assert.deepEqual(config.matchingOverrides, [0]);
    assert.deepEqual(config.plugins.acme.rules, ['property-allowlist']);
    assert.equal(config.plugins.acme.apiVersion, 1);
    assert.equal(printed.stdout.includes('create'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('batch CLI reports partial JSON results and plugin operations separately', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geolint-cli-partial-'));
  const publicUrl = new URL('../index.js', import.meta.url).href;
  try {
    for (const name of ['bad.geojson', 'good.geojson']) {
      await writeFile(
        join(root, name),
        JSON.stringify({ type: 'Point', coordinates: [0, 0] }),
      );
    }
    await writeFile(join(root, 'malformed.geojson'), '{');
    await writeFile(
      join(root, 'geolint.config.ts'),
      `import { definePlugin, defineRule } from ${JSON.stringify(publicUrl)};
const plugin = definePlugin({
  meta: { apiVersion: 1 },
  rules: {
    throwing: defineRule({
      meta: { name: 'throwing', schema: null },
      create() { throw new Error('fixture plugin failed'); },
    }),
  },
});
export default {
  plugins: { acme: plugin },
  rules: { 'acme/throwing': 'off' },
  overrides: [{ files: ['bad.geojson'], rules: { 'acme/throwing': 'error' } }],
};\n`,
    );
    const printed = runResult(['--print-config', 'bad.geojson'], { cwd: root });
    assert.equal(printed.status, 0);
    assert.equal(printed.stderr, '');
    assert.doesNotThrow(() => JSON.parse(printed.stdout));

    const output = runResult(
      ['--format', 'json', 'bad.geojson', 'good.geojson', 'malformed.geojson'],
      { cwd: root },
    );
    assert.equal(output.status, 2);
    const result = JSON.parse(output.stdout);
    assert.deepEqual(
      result.files.map(({ filePath }: { filePath: string }) => filePath),
      ['good.geojson', 'malformed.geojson'],
    );
    assert.equal(result.files[1].diagnostics[0].code, 'parse/invalid-json');
    assert.match(output.stderr, /GEOLINT_PLUGIN_ERROR/);
    assert.equal(output.stderr.includes('fixture plugin failed'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('JSON CLI preserves hostile plugin diagnostic data keys', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geolint-cli-json-data-'));
  const publicUrl = new URL('../index.js', import.meta.url).href;
  try {
    await writeFile(
      join(root, 'map.geojson'),
      JSON.stringify({ type: 'Point', coordinates: [0, 0] }),
    );
    await writeFile(
      join(root, 'geolint.config.ts'),
      `import { definePlugin, defineRule } from ${JSON.stringify(publicUrl)};
const data = Object.create(null);
Object.defineProperty(data, '__proto__', { enumerable: true, value: { expected: true } });
data.constructor = 'constructor';
data.prototype = 'prototype';
const plugin = definePlugin({
  meta: { apiVersion: 1 },
  rules: {
    hostile: defineRule({
      meta: { name: 'hostile', schema: null },
      create(context) {
        return { document() { context.report({ message: 'hostile', data }); } };
      },
    }),
  },
});
export default { plugins: { acme: plugin }, rules: { 'acme/hostile': 'error' } };
`,
    );
    const output = runResult(['--format', 'json', 'map.geojson'], {
      cwd: root,
    });
    assert.equal(output.status, 1);
    assert.equal(output.stderr, '');
    const data = JSON.parse(output.stdout).files[0].diagnostics[0].data;
    assert.deepEqual(data.__proto__, { expected: true });
    assert.equal(data.constructor, 'constructor');
    assert.equal(data.prototype, 'prototype');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('source-aware stdin works and regression stdin requires a filename', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geolint-cli-stdin-'));
  try {
    await writeFile(
      join(root, 'precision.json'),
      JSON.stringify({
        rules: {
          'coordinate-precision': ['error', { maximumDecimals: 2 }],
        },
      }),
    );
    const source = runResult(
      ['--config', 'precision.json', '--format', 'json', '-'],
      { cwd: root, input: '{"type":"Point","coordinates":[1.234,0]}' },
    );
    assert.equal(source.status, 1);
    assert.equal(
      JSON.parse(source.stdout).files[0].diagnostics[0].code,
      'coordinate-precision',
    );

    await writeFile(
      join(root, 'regression.json'),
      JSON.stringify({
        regression: { checks: { properties: { added: 'error' } } },
      }),
    );
    const regression = runResult(['--config', 'regression.json', '-'], {
      cwd: root,
      input: '{"type":"Point","coordinates":[0,0]}',
    });
    assert.equal(regression.status, 2);
    assert.match(regression.stderr, /GEOLINT_UNSTABLE_REGRESSION_IDENTITY/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('snapshot pretty and JSON modes honor the invocation baseline override', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geolint-cli-baseline-'));
  try {
    await writeFile(
      join(root, 'map.geojson'),
      JSON.stringify({ type: 'Point', coordinates: [0, 0] }),
    );
    const pretty = runResult(
      [
        '--no-config',
        '--baseline',
        'alternate.json',
        '--no-color',
        'snapshot',
        'map.geojson',
      ],
      { cwd: root },
    );
    assert.equal(pretty.status, 0);
    assert.match(pretty.stdout, /GeoLint baseline update/);
    assert.equal(
      JSON.parse(await readFile(join(root, 'alternate.json'), 'utf8'))
        .schemaVersion,
      1,
    );
    const machine = runResult(
      [
        '--no-config',
        '--baseline',
        'alternate.json',
        '--format',
        'json',
        'snapshot',
        'map.geojson',
      ],
      { cwd: root },
    );
    assert.equal(machine.status, 0);
    assert.equal(JSON.parse(machine.stdout).mode, 'partial');
    await writeFile(
      join(root, 'map.geojson'),
      JSON.stringify({
        type: 'MultiPoint',
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      }),
    );
    await writeFile(
      join(root, 'regression.json'),
      JSON.stringify({
        regression: {
          thresholds: { totalVerticesIncrease: { minimumIncrease: 0 } },
        },
      }),
    );
    assert.equal(
      runResult(
        [
          '--config',
          'regression.json',
          '--baseline',
          'alternate.json',
          'map.geojson',
        ],
        { cwd: root },
      ).status,
      1,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('print-config uses an explicit config and applies overrides', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geolint-cli-'));
  try {
    await writeFile(
      join(root, 'custom.json'),
      JSON.stringify({
        rules: { base: 'warn' },
        overrides: [{ files: ['public/**'], rules: { scoped: 'error' } }],
      }),
    );

    const { stdout, stderr } = await run(
      ['--config', 'custom.json', '--print-config', 'public/map.geojson'],
      root,
    );
    const config = JSON.parse(stdout);

    assert.equal(stderr, '');
    assert.equal(config.filePath, 'public/map.geojson');
    assert.equal(config.rules.scoped, 'error');
    assert.deepEqual(config.matchingOverrides, [0]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('print-config discovers config and resolves file identity from nested cwd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geolint-cli-'));
  try {
    const cwd = join(root, 'packages', 'app');
    await mkdir(cwd, { recursive: true });
    await mkdir(join(root, 'public'));
    await writeFile(
      join(root, 'geolint.config.json'),
      JSON.stringify({
        overrides: [{ files: ['public/**'], rules: { nested: 'error' } }],
      }),
    );

    const { stdout } = await run(
      ['--print-config', '../../public/map.geojson'],
      cwd,
    );
    const config = JSON.parse(stdout);

    assert.equal(config.projectRoot, root);
    assert.equal(config.filePath, 'public/map.geojson');
    assert.equal(config.rules.nested, 'error');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('print-config supports no-config behavior', async () => {
  const { stdout, stderr } = await run([
    '--no-config',
    '--print-config',
    'public/map.geojson',
  ]);

  assert.equal(stderr, '');
  assert.equal(JSON.parse(stdout).filePath, 'public/map.geojson');
});

test('print-config supports stdin filename identity', async () => {
  const { stdout } = await run([
    '--no-config',
    '--stdin-filename',
    'public/generated.geojson',
    '--print-config',
    '-',
  ]);

  assert.equal(JSON.parse(stdout).filePath, 'public/generated.geojson');
});

test('print-config rejects a missing file argument cleanly', async () => {
  await assert.rejects(
    run(['--print-config']),
    (error: NodeJS.ErrnoException & { stderr?: string }) => {
      assert.match(error.stderr ?? '', /--print-config/);
      return true;
    },
  );
});
