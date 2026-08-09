import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { definePlugin } from '../plugins/plugin.js';
import { defineRule } from '../rules/define-rule.js';
import { GeoLintBatchError } from '../engine/errors.js';
import { executeLintFiles, lintFiles } from '../engine/lint-files.js';
import { geolintVersion } from '../version.js';

test('lintFiles resolves a deterministic batch and aggregates logical counts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geolint-batch-'));
  try {
    await writeFile(
      join(root, 'b.geojson'),
      JSON.stringify({ type: 'Point', coordinates: [181, 0] }),
    );
    await writeFile(
      join(root, 'a.geojson'),
      JSON.stringify({ type: 'Point', coordinates: [0, 0] }),
    );
    const result = await lintFiles({
      cwd: root,
      targets: ['b.geojson', 'a.geojson'],
      config: { rules: { 'valid-coordinate-range': 'warn' } },
    });
    assert.deepEqual(
      result.files.map(({ filePath }) => filePath),
      ['a.geojson', 'b.geojson'],
    );
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.geolintVersion, geolintVersion);
    assert.equal(result.errorCount, 0);
    assert.equal(result.warningCount, 1);
    assert.equal(result.suppressedDiagnosticCount, 0);
    assert.equal(result.skippedPolicyCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('batch operational failures preserve successful target results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geolint-batch-'));
  const cause = new Error('plugin failed');
  const plugin = definePlugin({
    meta: { apiVersion: 1 },
    rules: {
      throwing: defineRule({
        meta: { name: 'throwing', schema: null },
        create() {
          throw cause;
        },
      }),
    },
  });
  try {
    await writeFile(
      join(root, 'good.geojson'),
      JSON.stringify({ type: 'Point', coordinates: [0, 0] }),
    );
    await writeFile(
      join(root, 'bad.geojson'),
      JSON.stringify({ type: 'Point', coordinates: [0, 0] }),
    );
    await writeFile(join(root, 'malformed.geojson'), '{');
    await assert.rejects(
      lintFiles({
        cwd: root,
        targets: ['good.geojson', 'bad.geojson', 'malformed.geojson'],
        config: {
          plugins: { acme: plugin },
          rules: { 'acme/throwing': 'off' },
          overrides: [
            {
              files: ['bad.geojson'],
              rules: { 'acme/throwing': 'error' },
            },
          ],
        },
      }),
      (error) => {
        assert.ok(error instanceof GeoLintBatchError);
        assert.equal(error.code, 'GEOLINT_BATCH_ERROR');
        assert.equal(error.errors.length, 1);
        assert.equal(error.errors[0]?.cause, cause);
        assert.deepEqual(
          error.partialResult.files.map(({ filePath }) => filePath),
          ['good.geojson', 'malformed.geojson'],
        );
        assert.equal(error.partialResult.errorCount, 1);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stdin bytes use normal text execution and invalid UTF-8 is a finding', async () => {
  const valid = await executeLintFiles({
    targets: ['-'],
    noConfig: true,
    stdinFilename: 'public/generated.geojson',
    stdinBytes: Buffer.from('{"type":"Point","coordinates":[0,0]}'),
  });
  assert.equal(valid.files[0]?.filePath, 'public/generated.geojson');
  assert.ok(valid.files[0]?.summary);

  const invalid = await executeLintFiles({
    targets: ['-'],
    noConfig: true,
    stdinBytes: Buffer.from([0xff]),
  });
  assert.equal(
    invalid.files[0]?.diagnostics[0]?.code,
    'parse/invalid-encoding',
  );
  assert.equal(invalid.errorCount, 1);
});
