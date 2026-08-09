import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  definePlugin,
  defineRule,
  GeoLintCapabilityError,
  GeoLintConfigError,
  GeoLintPluginError,
  lintGeoJSON,
  lintGeoJSONText,
  optionSchema,
} from '../index.js';
import { resolveRuntimeConfig } from '../config/runtime.js';
import { mergeConfig } from '../config/merge.js';
import { resolveConfig } from '../config/resolve.js';
import { DiagnosticCollector } from '../engine/diagnostics.js';
import { compilePolicy } from '../engine/policy.js';
import { createExecutionRequirements } from '../engine/requirements.js';
import { scanGeoJSON, type ScanInstrumentation } from '../scanner/scan.js';
import externalPlugin, { namedPlugin } from './fixtures/external-plugin.js';
import { assertOrdinaryEquivalence } from './torture-harness.js';

const propertyAllowlist = defineRule({
  meta: {
    name: 'property-allowlist',
    schema: optionSchema.object({
      allow: optionSchema.array(optionSchema.string()),
    }),
  },
  create(context, options) {
    const allowed = new Set(options.allow);
    return {
      propertyValue(event) {
        if (!allowed.has(event.key)) {
          context.report({
            message: `Property "${event.key}" is not allowed.`,
            featureIndex: event.featureIndex,
            path: event.path,
          });
        }
      },
    };
  },
});

const minimumFeatures = defineRule({
  meta: {
    name: 'minimum-features',
    schema: optionSchema.object({ minimum: optionSchema.number() }),
    requires: ['featureCount'] as const,
  },
  create(context, options) {
    return {
      document(summary) {
        if (summary.featureCount < options.minimum) {
          context.report({ message: 'Too few Features.' });
        }
      },
    };
  },
});

const rawCoordinateFormat = defineRule({
  meta: { name: 'raw-coordinate-format', schema: null },
  create(context) {
    return {
      coordinateLexeme(event) {
        if (event.rawValues.some((value) => /[eE]/.test(value))) {
          context.report({
            message: 'Exponent notation is not allowed.',
            path: event.path,
            ...(event.byteOffset === undefined
              ? {}
              : { byteOffset: event.byteOffset }),
          });
        }
      },
    };
  },
});

const plugin = definePlugin({
  meta: { apiVersion: 1 },
  rules: {
    'property-allowlist': propertyAllowlist,
    'minimum-features': minimumFeatures,
    'raw-coordinate-format': rawCoordinateFormat,
  },
  configs: {
    recommended: {
      rules: { 'acme/property-allowlist': ['error', { allow: ['name'] }] },
    },
  },
});

const featureCollection = {
  type: 'FeatureCollection' as const,
  features: [
    {
      type: 'Feature' as const,
      properties: { name: 'one', secret: true },
      geometry: { type: 'Point' as const, coordinates: [1, 2] },
    },
  ],
};

test('namespaced plugin rules share options, hooks, aggregates, and diagnostics', async () => {
  const result = await lintGeoJSON(featureCollection, {
    config: {
      plugins: { acme: plugin },
      rules: {
        'acme/property-allowlist': ['warn', { allow: ['name'] }],
        'acme/minimum-features': ['error', { minimum: 2 }],
      },
    },
    filename: 'map.geojson',
  });

  assert.deepEqual(
    result.diagnostics.map(({ code, source, severity }) => ({
      code,
      source,
      severity,
    })),
    [
      {
        code: 'acme/property-allowlist',
        source: 'rule',
        severity: 'warning',
      },
      {
        code: 'acme/minimum-features',
        source: 'rule',
        severity: 'error',
      },
    ],
  );
});

test('plugin config fragments and reload metadata are preserved', async () => {
  const resolved = await resolveRuntimeConfig({
    config: { plugins: { acme: plugin, external: externalPlugin } },
  });
  assert.deepEqual(resolved.plugins.acme?.configs, plugin.configs);
  assert.equal(Object.isFrozen(resolved.plugins.acme?.configs), true);
  assert.equal(externalPlugin.meta.exportName, 'default');
  assert.equal(namedPlugin.meta.exportName, 'namedPlugin');
  assert.equal(externalPlugin.meta.moduleUrl, namedPlugin.meta.moduleUrl);
});

test('source hooks force indexed text execution and reject object input', async () => {
  const config = {
    plugins: { acme: plugin },
    rules: { 'acme/raw-coordinate-format': 'error' as const },
  };
  await assert.rejects(
    lintGeoJSON(featureCollection, { config }),
    (error) =>
      error instanceof GeoLintCapabilityError &&
      error.message.includes('acme/raw-coordinate-format'),
  );
  const result = await lintGeoJSONText(
    '{"type":"Point","coordinates":[1e0,2]}',
    { config },
  );
  assert.equal(result.diagnostics[0]?.code, 'acme/raw-coordinate-format');
});

test('semantic plugin output is equivalent for object, buffered, and indexed execution', async () => {
  await assertOrdinaryEquivalence({
    fixture: 'external-plugin',
    source: JSON.stringify(featureCollection),
    config: {
      plugins: { acme: plugin },
      rules: {
        'acme/property-allowlist': ['warn', { allow: ['name'] }],
        'acme/minimum-features': ['error', { minimum: 2 }],
      },
    },
  });
});

test('late indexed syntax failure invokes no plugin semantic hooks', async () => {
  let visits = 0;
  const observing = definePlugin({
    meta: { apiVersion: 1 },
    rules: {
      observing: defineRule({
        meta: { name: 'observing', schema: null },
        create() {
          return {
            coordinateLexeme() {
              visits += 1;
            },
          };
        },
      }),
    },
  });
  const result = await lintGeoJSONText(
    '{"type":"Point","coordinates":[1,2]} trailing',
    {
      config: {
        plugins: { acme: observing },
        rules: { 'acme/observing': 'error' },
      },
    },
  );
  assert.equal(result.diagnostics[0]?.code, 'parse/invalid-json');
  assert.equal(visits, 0);
});

test('plugin ordering is namespace then local rule ID, independent of config order', async () => {
  const makeRule = (name: string) =>
    defineRule({
      meta: { name, schema: null },
      create(context) {
        return {
          feature() {
            context.report({ message: name });
          },
        };
      },
    });
  const z = definePlugin({
    meta: { apiVersion: 1 },
    rules: { a: makeRule('a') },
  });
  const a = definePlugin({
    meta: { apiVersion: 1 },
    rules: { z: makeRule('z'), b: makeRule('b') },
  });
  const result = await lintGeoJSON(featureCollection, {
    config: {
      plugins: { z, a },
      rules: { 'z/a': 'error', 'a/z': 'error', 'a/b': 'error' },
    },
  });
  assert.deepEqual(
    result.diagnostics.map(({ code }) => code),
    ['a/b', 'a/z', 'z/a'],
  );
});

test('plugin failures preserve namespaced identity, file, type, and cause', async () => {
  const cause = new Error('boom');
  for (const rule of [
    defineRule({
      meta: { name: 'throwing', schema: null },
      create() {
        throw cause;
      },
    }),
    defineRule({
      meta: { name: 'throwing', schema: null },
      create() {
        return {
          feature: () => {
            throw cause;
          },
        };
      },
    }),
  ]) {
    const throwing = definePlugin({
      meta: { apiVersion: 1 },
      rules: { throwing: rule },
    });
    await assert.rejects(
      lintGeoJSON(featureCollection, {
        filename: 'failure.geojson',
        config: {
          plugins: { acme: throwing },
          rules: { 'acme/throwing': 'error' },
        },
      }),
      (error) =>
        error instanceof GeoLintPluginError &&
        error.code === 'GEOLINT_PLUGIN_ERROR' &&
        error.ruleId === 'acme/throwing' &&
        error.filePath === 'failure.geojson' &&
        error.cause === cause,
    );
  }
});

test('runtime thenables and malformed listeners fail as plugin errors', async () => {
  for (const create of [
    () => Promise.resolve({}),
    () => ({ futureHook() {} }),
    () => ({ feature: 1 }),
    () => ({ feature: () => Promise.resolve() }),
  ]) {
    const unsafe = definePlugin({
      meta: { apiVersion: 1 },
      rules: {
        unsafe: defineRule({
          meta: { name: 'unsafe', schema: null },
          create: create as never,
        }),
      },
    });
    await assert.rejects(
      lintGeoJSON(featureCollection, {
        config: {
          plugins: { unsafe },
          rules: { 'unsafe/unsafe': 'error' },
        },
      }),
      GeoLintPluginError,
    );
  }
});

test('plugin validation rejects ambiguous or unsafe definitions', () => {
  const invalid: unknown[] = [
    null,
    [],
    {},
    { meta: { apiVersion: 2 }, rules: {} },
    { meta: { apiVersion: 1, moduleUrl: 'file:///plugin.js' }, rules: {} },
    { meta: { apiVersion: 1 }, rules: [] },
    {
      meta: { apiVersion: 1 },
      rules: { local: { meta: { name: 'other', schema: null }, create() {} } },
    },
  ];
  for (const value of invalid) {
    assert.throws(() => definePlugin(value as never), GeoLintConfigError);
  }
});

test('plugin identity uses reload metadata and inline reference identity', () => {
  const reloadable = () =>
    definePlugin({
      meta: {
        apiVersion: 1,
        moduleUrl: 'file:///plugin.js',
        exportName: 'default',
      },
      rules: {},
    });
  assert.doesNotThrow(() =>
    mergeConfig(
      { plugins: { acme: reloadable() } },
      { plugins: { acme: reloadable() } },
    ),
  );
  const inline = definePlugin({ meta: { apiVersion: 1 }, rules: {} });
  assert.doesNotThrow(() =>
    mergeConfig({ plugins: { acme: inline } }, { plugins: { acme: inline } }),
  );
  assert.throws(
    () =>
      mergeConfig(
        { plugins: { acme: inline } },
        {
          plugins: {
            acme: definePlugin({ meta: { apiVersion: 1 }, rules: {} }),
          },
        },
      ),
    (error) =>
      error instanceof GeoLintConfigError &&
      error.code === 'GEOLINT_PLUGIN_CONFLICT',
  );
});

test('plugin namespaces and local rule identities are unambiguous', async () => {
  for (const namespace of ['', 'acme/tools']) {
    await assert.rejects(
      lintGeoJSON(featureCollection, {
        config: { plugins: { [namespace]: plugin } },
      }),
      GeoLintConfigError,
    );
  }
  for (const name of ['', 'nested/rule']) {
    assert.throws(
      () =>
        definePlugin({
          meta: { apiVersion: 1 },
          rules: {
            [name]: defineRule({
              meta: { name, schema: null },
              create() {
                return {};
              },
            }),
          },
        }),
      GeoLintConfigError,
    );
  }
});

test('plugin diagnostics use shared logical counts and suppression', async () => {
  const noisy = definePlugin({
    meta: { apiVersion: 1 },
    rules: {
      noisy: defineRule({
        meta: { name: 'noisy', schema: null },
        create(context) {
          return {
            feature() {
              for (let index = 0; index < 10; index += 1) {
                context.report({ message: `Finding ${index}` });
              }
            },
          };
        },
      }),
    },
  });
  const result = await lintGeoJSON(featureCollection, {
    config: {
      plugins: { acme: noisy },
      rules: { 'acme/noisy': 'warn' },
      diagnostics: { maxPerCodePerFile: 2 },
    },
  });
  assert.equal(result.warningCount, 10);
  assert.equal(result.diagnostics.length, 2);
  assert.deepEqual(result.suppressedDiagnostics, [
    {
      code: 'acme/noisy',
      severity: 'warning',
      suppressedCount: 8,
    },
  ]);
});

test('plugin aggregate skips retain the full namespaced rule ID', async () => {
  const result = await lintGeoJSON(
    {
      type: 'FeatureCollection',
      features: [featureCollection.features[0], null],
    },
    {
      config: {
        plugins: { acme: plugin },
        rules: { 'acme/minimum-features': ['error', { minimum: 2 }] },
      },
    },
  );
  const skipped = result.skippedPolicies[0];
  assert.equal(skipped?.code, 'acme/minimum-features');
  assert.equal(skipped?.reason, 'incomplete-facts');
  if (skipped?.reason === 'incomplete-facts') {
    assert.deepEqual(skipped.incompleteFacts, ['featureCount']);
  }
});

test('multiple plugin coordinate subscribers share one Position traversal', () => {
  const visits = [0, 0];
  const coordinatePlugin = definePlugin({
    meta: { apiVersion: 1 },
    rules: Object.fromEntries(
      visits.map((_count, index) => {
        const name = `observer-${index}`;
        return [
          name,
          defineRule({
            meta: { name, schema: null },
            create() {
              return {
                coordinate() {
                  visits[index]! += 1;
                },
              };
            },
          }),
        ];
      }),
    ),
  });
  const config = resolveConfig(
    {
      plugins: { acme: coordinatePlugin },
      rules: {
        'acme/observer-0': 'error',
        'acme/observer-1': 'error',
      },
    },
    process.cwd(),
  );
  const diagnostics = new DiagnosticCollector('map.geojson');
  const policy = compilePolicy(config, 'map.geojson', 'object', diagnostics);
  const requirements = createExecutionRequirements({
    facts: policy.facts,
    ...(policy.listener ? { listener: policy.listener } : {}),
  });
  const instrumentation: ScanInstrumentation = {
    positionVisits: 0,
    coordinateTraversals: 0,
    coordinatePathMaterializations: 0,
    propertyPathMaterializations: 0,
  };
  scanGeoJSON(
    {
      type: 'MultiPoint',
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    },
    {
      filePath: 'map.geojson',
      diagnostics,
      ...(policy.listener ? { listener: policy.listener } : {}),
      requirements,
      instrumentation,
    },
  );
  assert.deepEqual(visits, [2, 2]);
  assert.equal(instrumentation.positionVisits, 2);
  assert.equal(instrumentation.coordinateTraversals, 1);
});

test('disabled unknown rules and disabled plugin hooks remain inert', async () => {
  const result = await lintGeoJSON(featureCollection, {
    config: {
      plugins: { acme: plugin },
      rules: {
        'optional/missing': 'off',
        'acme/raw-coordinate-format': 'off',
      },
    },
  });
  assert.equal(result.errorCount, 0);
});

test('jiti loads a public-entry plugin through extends and applies overrides', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'geolint-plugin-'));
  const moduleUrl = new URL('./fixtures/external-plugin.js', import.meta.url)
    .href;
  const basePath = join(directory, 'base.ts');
  const configPath = join(directory, 'geolint.config.ts');
  try {
    await writeFile(
      basePath,
      `import plugin from ${JSON.stringify(moduleUrl)};
export default {
  plugins: { acme: plugin },
  rules: { 'acme/property-allowlist': ['error', { allow: ['name'] }] },
};\n`,
    );
    await writeFile(
      configPath,
      `export default {
  extends: ['./base.ts'],
  overrides: [{
    files: ['special/**'],
    rules: { 'acme/property-allowlist': ['warn', { allow: ['name', 'secret'] }] },
  }],
};\n`,
    );
    const resolved = await resolveRuntimeConfig({ config: configPath });
    assert.equal(resolved.plugins.acme?.meta.moduleUrl, moduleUrl);
    assert.equal(resolved.plugins.acme?.meta.exportName, 'default');

    const ordinary = await lintGeoJSON(featureCollection, {
      config: configPath,
      filename: 'ordinary/map.geojson',
    });
    assert.equal(ordinary.diagnostics[0]?.severity, 'error');
    const overridden = await lintGeoJSON(featureCollection, {
      config: configPath,
      filename: 'special/map.geojson',
    });
    assert.equal(overridden.errorCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
