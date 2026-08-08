import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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

test('CLI help documents print-config argument syntax', async () => {
  const { stdout, stderr } = await run(['--help']);

  assert.equal(stderr, '');
  assert.match(stdout, /--print-config <file>/);
  assert.match(stdout, /snapshot \[targets\.\.\.\]/);
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
      ['--config', 'geolint.json', 'snapshot'],
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
