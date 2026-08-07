import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('../cli/index.js', import.meta.url));

test('CLI help resolves', async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    cliPath,
    '--help',
  ]);

  assert.equal(stderr, '');
  assert.match(stdout, /^Usage: geolint <targets/);
});

test('CLI prints the resolved no-config policy', async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    cliPath,
    '--no-config',
    '--print-config',
    'public/map.geojson',
  ]);

  assert.equal(stderr, '');
  assert.equal(JSON.parse(stdout).filePath, 'public/map.geojson');
});
