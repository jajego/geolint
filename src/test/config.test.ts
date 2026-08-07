import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveConfig, resolveFileConfig } from '../config/resolve.js';
import { resolveRuntimeConfig } from '../config/runtime.js';

test('matching overrides accumulate in declaration order', () => {
  const config = resolveConfig(
    {
      rules: { 'example/rule': 'warn' },
      budgets: { totalVertices: { limit: 100 } },
      overrides: [
        { files: ['public/**/*.geojson'], rules: { 'example/rule': 'error' } },
        {
          files: ['public/maps/**'],
          budgets: { totalVertices: { severity: 'error' } },
        },
      ],
    },
    'C:/project',
  );

  const resolved = resolveFileConfig(config, 'public\\maps\\cities.geojson');

  assert.equal(resolved.filePath, 'public/maps/cities.geojson');
  assert.deepEqual(resolved.matchingOverrides, [0, 1]);
  assert.equal(resolved.rules['example/rule'], 'error');
  assert.deepEqual(resolved.budgets.totalVertices, {
    limit: 100,
    severity: 'error',
  });
});

test('override-local ignores affect only that override', () => {
  const config = resolveConfig(
    {
      rules: { first: 'warn', second: 'warn' },
      overrides: [
        {
          files: ['public/**'],
          ignores: ['public/vendor/**'],
          rules: { first: 'off' },
        },
        { files: ['public/**'], rules: { second: 'error' } },
      ],
    },
    'C:/project',
  );

  const resolved = resolveFileConfig(config, 'public/vendor/source.geojson');

  assert.deepEqual(resolved.matchingOverrides, [1]);
  assert.equal(resolved.rules.first, 'warn');
  assert.equal(resolved.rules.second, 'error');
});

test('runtime discovery sets the config directory as project root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geolint-config-'));
  try {
    await mkdir(join(root, 'nested'), { recursive: true });
    await writeFile(
      join(root, 'geolint.config.json'),
      JSON.stringify({
        files: ['public/**/*.geojson'],
        rules: { example: 'error' },
      }),
    );

    const config = await resolveRuntimeConfig({ cwd: join(root, 'nested') });

    assert.equal(config.projectRoot, root);
    assert.deepEqual(config.files, ['public/**/*.geojson']);
    assert.equal(config.rules.example, 'error');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('file configs merge extensions from left to right', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geolint-extends-'));
  try {
    await writeFile(
      join(root, 'base.json'),
      JSON.stringify({
        rules: { example: 'warn' },
        budgets: { totalVertices: { limit: 10 } },
      }),
    );
    await writeFile(
      join(root, 'geolint.config.json'),
      JSON.stringify({
        extends: ['./base.json'],
        rules: { example: 'error' },
        budgets: { totalVertices: { severity: 'error' } },
      }),
    );

    const config = await resolveRuntimeConfig({ cwd: root });

    assert.equal(config.rules.example, 'error');
    assert.deepEqual(config.budgets.totalVertices, {
      limit: 10,
      severity: 'error',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
