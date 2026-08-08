import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { discoverConfig } from '../config/discover.js';
import { mergeConfig } from '../config/merge.js';
import {
  normalizeFilePath,
  resolveConfig,
  resolveFileConfig,
} from '../config/resolve.js';
import { resolveRuntimeConfig } from '../config/runtime.js';
import { validateConfig } from '../config/validate.js';
import { GeoLintConfigError } from '../engine/errors.js';

async function temporaryProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'geolint-config-'));
}

test('matching overrides accumulate in declaration order without leaking selectors', () => {
  const config = resolveConfig(
    {
      files: ['public/**/*.geojson'],
      ignores: ['vendor/**'],
      rules: { example: 'warn' },
      overrides: [
        { files: ['public/**'], rules: { example: 'error' } },
        {
          files: ['public/maps/**'],
          ignores: ['public/maps/vendor/**'],
          budgets: { totalVertices: { limit: 10 } },
        },
      ],
    },
    'C:/project',
  );

  const resolved = resolveFileConfig(config, 'public\\maps\\cities.geojson');

  assert.equal(resolved.filePath, 'public/maps/cities.geojson');
  assert.deepEqual(resolved.matchingOverrides, [0, 1]);
  assert.deepEqual(resolved.files, ['public/**/*.geojson']);
  assert.deepEqual(resolved.ignores, ['vendor/**']);
  assert.equal(resolved.rules.example, 'error');
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

test('non-matching overrides leave base policy unchanged', () => {
  const config = resolveConfig(
    {
      rules: { example: 'warn' },
      overrides: [{ files: ['other/**'], rules: { example: 'error' } }],
    },
    'C:/project',
  );

  const resolved = resolveFileConfig(config, 'public/map.geojson');

  assert.deepEqual(resolved.matchingOverrides, []);
  assert.equal(resolved.rules.example, 'warn');
});

test('discovery uses the nearest ancestor config as project root', async () => {
  const root = await temporaryProject();
  try {
    const nested = join(root, 'packages', 'app');
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, 'geolint.config.json'), '{}');
    await writeFile(
      join(root, 'packages', 'geolint.config.json'),
      JSON.stringify({ rules: { nearest: 'error' } }),
    );

    const config = await resolveRuntimeConfig({ cwd: nested });

    assert.equal(config.projectRoot, join(root, 'packages'));
    assert.equal(config.rules.nearest, 'error');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('discovery recognizes every supported config extension', async () => {
  const root = await temporaryProject();
  const extensions = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs', 'json'];
  try {
    for (const extension of extensions) {
      const directory = join(root, extension);
      await mkdir(directory);
      const path = join(directory, `geolint.config.${extension}`);
      await writeFile(path, '');
      assert.equal(await discoverConfig(directory), path);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('explicit config path wins over discovery', async () => {
  const root = await temporaryProject();
  try {
    await writeFile(
      join(root, 'geolint.config.json'),
      JSON.stringify({ rules: { discovered: 'error' } }),
    );
    await writeFile(
      join(root, 'explicit.json'),
      JSON.stringify({ rules: { explicit: 'error' } }),
    );

    const config = await resolveRuntimeConfig({
      cwd: root,
      config: 'explicit.json',
    });

    assert.equal(config.rules.explicit, 'error');
    assert.equal(config.rules.discovered, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('no-config bypasses discovered project configuration', async () => {
  const root = await temporaryProject();
  try {
    await writeFile(
      join(root, 'geolint.config.json'),
      JSON.stringify({ rules: { project: 'error' } }),
    );

    const config = await resolveRuntimeConfig({ cwd: root, noConfig: true });

    assert.equal(config.projectRoot, root);
    assert.equal(config.rules.project, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('inline config resolves preset and file references from cwd', async () => {
  const root = await temporaryProject();
  try {
    await writeFile(
      join(root, 'base.json'),
      JSON.stringify({ rules: { inherited: 'warn' } }),
    );

    const config = await resolveRuntimeConfig({
      cwd: root,
      config: {
        extends: ['geolint/recommended', './base.json'],
        rules: { inherited: 'error' },
      },
    });

    assert.equal(config.rules.inherited, 'error');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('file config extends merge left-to-right before local values', async () => {
  const root = await temporaryProject();
  try {
    await writeFile(
      join(root, 'first.json'),
      JSON.stringify({ rules: { order: 'warn', first: 'error' } }),
    );
    await writeFile(
      join(root, 'second.json'),
      JSON.stringify({ rules: { order: 'error', second: 'error' } }),
    );
    await writeFile(
      join(root, 'geolint.config.json'),
      JSON.stringify({
        extends: ['./first.json', './second.json'],
        rules: { order: 'off' },
      }),
    );

    const config = await resolveRuntimeConfig({ cwd: root });

    assert.deepEqual(config.rules, {
      order: 'off',
      first: 'error',
      second: 'error',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('every supported config extension loads through the real loader', async () => {
  const root = await temporaryProject();
  const sources: Readonly<Record<string, string>> = {
    ts: 'export default { rules: { ts: "error" } } as const;',
    mts: 'export default { rules: { mts: "error" } } as const;',
    cts: 'export default { rules: { cts: "error" } } as const;',
    js: 'export default { rules: { js: "error" } };',
    mjs: 'export default { rules: { mjs: "error" } };',
    cjs: 'module.exports = { rules: { cjs: "error" } };',
    json: JSON.stringify({ rules: { json: 'error' } }),
  };
  try {
    for (const [extension, source] of Object.entries(sources)) {
      const directory = join(root, extension);
      await mkdir(directory);
      await writeFile(join(directory, `geolint.config.${extension}`), source);

      const config = await resolveRuntimeConfig({ cwd: directory });

      assert.equal(config.rules[extension], 'error');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('package config references resolve through the shared extends pipeline', async () => {
  const root = await temporaryProject();
  try {
    const packageRoot = join(root, 'node_modules', 'example-config');
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: 'example-config',
        type: 'module',
        exports: './index.js',
      }),
    );
    await writeFile(
      join(packageRoot, 'index.js'),
      'export default { rules: { packaged: "error" } };',
    );

    const config = await resolveRuntimeConfig({
      cwd: root,
      config: { extends: ['example-config'] },
    });

    assert.equal(config.rules.packaged, 'error');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('circular extends fail with a stable config error', async () => {
  const root = await temporaryProject();
  try {
    await writeFile(
      join(root, 'a.json'),
      JSON.stringify({ extends: ['./b.json'] }),
    );
    await writeFile(
      join(root, 'b.json'),
      JSON.stringify({ extends: ['./a.json'] }),
    );

    await assert.rejects(
      resolveRuntimeConfig({ cwd: root, config: 'a.json' }),
      (error) =>
        error instanceof GeoLintConfigError &&
        error.code === 'GEOLINT_CIRCULAR_CONFIG',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('invalid extended configs fail at the config boundary', async () => {
  const root = await temporaryProject();
  try {
    await writeFile(join(root, 'invalid.json'), JSON.stringify({ files: 42 }));
    await writeFile(
      join(root, 'geolint.config.json'),
      JSON.stringify({ extends: ['./invalid.json'] }),
    );

    await assert.rejects(
      resolveRuntimeConfig({ cwd: root }),
      (error) =>
        error instanceof GeoLintConfigError &&
        error.code === 'GEOLINT_INVALID_CONFIG' &&
        /config\.files/.test(error.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('missing explicit config fails intentionally', async () => {
  const root = await temporaryProject();
  try {
    await assert.rejects(
      resolveRuntimeConfig({ cwd: root, config: 'missing.json' }),
      (error) =>
        error instanceof GeoLintConfigError &&
        error.code === 'GEOLINT_CONFIG_NOT_FOUND',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Phase 1 config validation rejects malformed known structures', () => {
  const malformed = [
    { files: 42 },
    { overrides: 'hello' },
    { diagnostics: [] },
    { overrides: [{ files: 123 }] },
    { overrides: [{ files: [] }] },
    { regression: { baseline: 42 } },
    { overrides: [{ files: ['**'], regression: { baseline: 'other.json' } }] },
    new Date(),
  ];

  for (const config of malformed) {
    assert.throws(
      () => validateConfig(config),
      (error) =>
        error instanceof GeoLintConfigError &&
        error.code === 'GEOLINT_INVALID_CONFIG',
    );
  }
});

test('all config glob fields are validated eagerly', () => {
  for (const config of [
    { files: ['!private/**'] },
    { ignores: ['@(vendor)/**'] },
    { overrides: [{ files: ['{a,{b,c}}/**'] }] },
    { overrides: [{ files: ['**'], ignores: ['+(tmp)/**'] }] },
  ]) {
    assert.throws(
      () => validateConfig(config),
      (error) =>
        error instanceof GeoLintConfigError &&
        error.code === 'GEOLINT_INVALID_GLOB',
    );
  }
});

test('merge semantics preserve each V5 field contract', () => {
  const merged = mergeConfig(
    {
      files: ['old/**'],
      ignores: ['old-ignore/**'],
      rules: { tuple: ['warn', { old: true }], sibling: 'warn' },
      budgets: {
        totalVertices: { limit: 10, severity: 'warn' },
        featureCount: { limit: 5 },
      },
      regression: {
        baseline: 'baseline.json',
        thresholds: {
          fileSizeIncrease: { percentage: 10, minimumIncrease: '1KB' },
        },
        checks: { propertyTypes: { widened: 'warn', narrowed: 'off' } },
      },
    },
    {
      files: ['new/**'],
      ignores: [],
      rules: { tuple: ['error', { replacement: true }] },
      budgets: {
        totalVertices: false,
        featureCount: { severity: 'error' },
      },
      regression: {
        thresholds: { fileSizeIncrease: { percentage: 20 } },
        checks: { propertyTypes: { widened: 'error' } },
      },
    },
  );

  assert.deepEqual(merged.files, ['new/**']);
  assert.deepEqual(merged.ignores, []);
  assert.deepEqual(merged.rules?.tuple, ['error', { replacement: true }]);
  assert.equal(merged.rules?.sibling, 'warn');
  assert.equal(merged.budgets?.totalVertices, false);
  assert.deepEqual(merged.budgets?.featureCount, {
    limit: 5,
    severity: 'error',
  });
  assert.deepEqual(
    (merged.regression?.thresholds as Record<string, unknown>).fileSizeIncrease,
    { percentage: 20 },
  );
  assert.deepEqual(merged.regression?.checks, {
    propertyTypes: { widened: 'error', narrowed: 'off' },
  });
  assert.equal(merged.regression?.baseline, 'baseline.json');
});

test('logical paths normalize separators and dot segments project-relatively', () => {
  const projectRoot = process.platform === 'win32' ? 'C:\\project' : '/project';
  const filePath =
    process.platform === 'win32'
      ? 'C:\\project\\public\\maps\\..\\map.geojson'
      : '/project/public/maps/../map.geojson';
  assert.equal(normalizeFilePath(projectRoot, filePath), 'public/map.geojson');
});

test('regression config is strict at every level', () => {
  const invalid = [
    { cheks: {} },
    { checks: { future: {} } },
    { checks: { propertyTypes: { widenend: 'error' } } },
    { checks: { properties: { added: 'fatal' } } },
    { checks: { geometryTypes: { typo: 'warn' } } },
    { checks: { duplicateIds: { increase: 'error' } } },
    { thresholds: { totalVertexIncrease: {} } },
    { thresholds: { totalVerticesIncrease: {} } },
    { thresholds: { totalVerticesIncrease: { percentage: -1 } } },
    {
      thresholds: {
        featureCountDecrease: { minimumDecrease: 1.5 },
      },
    },
    {
      thresholds: {
        fileSizeIncrease: { minimumIncrease: '1mb' },
      },
    },
  ];
  for (const regression of invalid) {
    assert.throws(
      () => validateConfig({ regression } as never),
      GeoLintConfigError,
    );
  }

  assert.doesNotThrow(() =>
    validateConfig({
      regression: {
        baseline: 'history/baseline.json',
        checks: { propertyTypes: { widened: 'warn', narrowed: 'off' } },
        thresholds: {
          fileSizeIncrease: { percentage: 0, minimumIncrease: '1KB' },
          totalVerticesIncrease: { minimumIncrease: 0 },
          featureCountDecrease: { percentage: 10 },
        },
      },
    }),
  );
});
