import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveRuntimeConfig } from '../config/runtime.js';
import {
  GeoLintCapabilityError,
  GeoLintConfigError,
  GeoLintInternalError,
} from '../engine/errors.js';
import { lintGeoJSON, lintGeoJSONText } from '../engine/lint-input.js';
import { parseByteSize } from '../engine/policy.js';
import { skipPolicyForIncompleteFacts } from '../engine/requirements.js';
import type { GeoLintConfig } from '../types/config.js';
import type {
  FileLintResult,
  JsonObject,
  JsonValue,
} from '../types/semantic.js';

function feature(
  id: string | number | undefined,
  properties: JsonValue,
  geometry: JsonValue = { type: 'Point', coordinates: [0, 0] },
): JsonObject {
  return {
    type: 'Feature',
    ...(id === undefined ? {} : { id }),
    properties,
    geometry,
  };
}

async function lint(
  value: JsonValue,
  config: GeoLintConfig,
): Promise<FileLintResult> {
  return lintGeoJSON(value, { config });
}

function codes(result: FileLintResult): string[] {
  return result.diagnostics.map(({ code }) => code);
}

function reverseMembers(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(reverseMembers);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, member]) => [key, reverseMembers(member)]),
  );
}

test('the no-config path runs exactly the recommended quality rules', async () => {
  const result = await lintGeoJSON({
    type: 'FeatureCollection',
    features: [
      feature('same', { value: 1 }),
      feature(
        'same',
        { value: 'one' },
        { type: 'Point', coordinates: [181, 0, 3] },
      ),
      feature(
        3,
        { value: 2 },
        {
          type: 'LineString',
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        },
      ),
      feature(undefined, {}, null),
    ],
  });
  assert.deepEqual(codes(result), [
    'valid-coordinate-range',
    'unique-feature-id',
    'consistent-feature-id-type',
    'consistent-property-types',
    'consistent-coordinate-dimensions',
  ]);
  assert.equal(
    result.diagnostics.every(({ severity }) => severity === 'error'),
    true,
  );
  assert.equal(codes(result).includes('require-feature-id'), false);
  assert.equal(codes(result).includes('no-null-geometry'), false);
  assert.equal(codes(result).includes('consistent-geometry-types'), false);
});

test('require-feature-id reports completed missing IDs but not invalid IDs', async () => {
  const result = await lint(
    {
      type: 'FeatureCollection',
      features: [
        feature(undefined, {}),
        feature('ok', {}),
        { ...feature(undefined, {}), id: null },
      ],
    },
    { rules: { 'require-feature-id': 'warn' } },
  );
  assert.deepEqual(codes(result), [
    'require-feature-id',
    'geojson/invalid-feature-id',
  ]);
  assert.equal(result.diagnostics[0]?.severity, 'warning');
});

test('unique-feature-id preserves ID type and reports every later duplicate', async () => {
  const result = await lint(
    {
      type: 'FeatureCollection',
      features: [
        feature('1', {}),
        feature(1, {}),
        feature('1', {}),
        feature('1', {}),
        feature(1, {}),
      ],
    },
    { rules: { 'unique-feature-id': 'error' } },
  );
  assert.deepEqual(codes(result), [
    'unique-feature-id',
    'unique-feature-id',
    'unique-feature-id',
  ]);
  assert.deepEqual(
    result.diagnostics.map(({ featureId }) => featureId),
    ['1', '1', 1],
  );
});

test('consistent-feature-id-type is aggregate and skips partial ID facts', async () => {
  const mixed = await lint(
    { type: 'FeatureCollection', features: [feature('1', {}), feature(1, {})] },
    { rules: { 'consistent-feature-id-type': 'warn' } },
  );
  assert.deepEqual(codes(mixed), ['consistent-feature-id-type']);
  assert.equal(mixed.diagnostics[0]?.severity, 'warning');

  const partial = await lint(
    {
      type: 'FeatureCollection',
      features: [feature('1', {}), { ...feature(1, {}), id: null }],
    },
    { rules: { 'consistent-feature-id-type': 'error' } },
  );
  assert.deepEqual(codes(partial), ['geojson/invalid-feature-id']);
  assert.deepEqual(partial.skippedPolicies, [
    {
      code: 'consistent-feature-id-type',
      source: 'rule',
      reason: 'incomplete-facts',
      requiredFacts: ['idStats'],
      incompleteFacts: ['idStats'],
      configuredSeverity: 'error',
    },
  ]);
});

test('consistent-property-types implements compatible and strict null policies', async () => {
  const document: JsonValue = {
    type: 'FeatureCollection',
    features: [feature(1, { a: 1, b: 1 }), feature(2, { a: null, b: 'x' })],
  };
  const compatible = await lint(document, {
    rules: { 'consistent-property-types': 'error' },
  });
  assert.deepEqual(codes(compatible), ['consistent-property-types']);
  assert.equal(compatible.diagnostics[0]?.data?.property, 'b');

  const strict = await lint(document, {
    rules: {
      'consistent-property-types': ['warn', { nullPolicy: 'strict' }],
    },
  });
  assert.deepEqual(codes(strict), [
    'consistent-property-types',
    'consistent-property-types',
  ]);
  assert.deepEqual(
    strict.diagnostics.map(({ data }) => data?.property),
    ['a', 'b'],
  );
});

test('consistent-property-presence uses stable aggregate presence ratios', async () => {
  const result = await lint(
    {
      type: 'FeatureCollection',
      features: [
        feature(1, { a: 1, b: 1 }),
        feature(2, { b: 2 }),
        feature(3, null),
      ],
    },
    {
      rules: {
        'consistent-property-presence': [
          'error',
          { minimumPresenceRatio: 0.5, minimumFeatureCount: 1 },
        ],
      },
    },
  );
  assert.deepEqual(codes(result), ['consistent-property-presence']);
  assert.deepEqual(result.diagnostics[0]?.data, {
    property: 'a',
    present: 1,
    missing: 2,
    ratio: 1 / 3,
    minimumPresenceRatio: 0.5,
  });
});

test('geometry rules use completed outer geometry semantics', async () => {
  const document: JsonValue = {
    type: 'FeatureCollection',
    features: [
      feature(1, {}, { type: 'Point', coordinates: [0, 0] }),
      feature(
        2,
        {},
        {
          type: 'LineString',
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        },
      ),
      feature(3, {}, null),
    ],
  };
  const result = await lint(document, {
    rules: {
      'allowed-geometry-types': ['error', { allow: ['Point'] }],
      'consistent-geometry-types': 'warn',
      'no-null-geometry': 'warn',
    },
  });
  assert.deepEqual(codes(result), [
    'allowed-geometry-types',
    'no-null-geometry',
    'consistent-geometry-types',
  ]);
  assert.equal(result.diagnostics[0]?.data?.observed, 'LineString');
});

test('allowed-geometry-types applies to bare root geometry', async () => {
  const result = await lint(
    { type: 'Point', coordinates: [0, 0] },
    { rules: { 'allowed-geometry-types': ['error', { allow: ['Polygon'] }] } },
  );
  assert.deepEqual(codes(result), ['allowed-geometry-types']);
  assert.equal(result.diagnostics[0]?.path, '');
});

test('coordinate rules receive only structurally valid Positions', async () => {
  const result = await lint(
    {
      type: 'MultiPoint',
      coordinates: [[181, 91], [0], [0, 0, 0]],
    },
    {
      rules: {
        'valid-coordinate-range': 'warn',
        'consistent-coordinate-dimensions': 'error',
      },
    },
  );
  assert.deepEqual(codes(result), [
    'valid-coordinate-range',
    'geojson/invalid-position',
  ]);
  assert.equal(result.diagnostics[0]?.severity, 'warning');
  assert.equal(
    result.skippedPolicies[0]?.code,
    'consistent-coordinate-dimensions',
  );
});

test('disabled rules do not validate options or contribute diagnostics', async () => {
  const result = await lint(feature(undefined, {}), {
    rules: {
      'require-feature-id': 'off',
      'allowed-geometry-types': ['error', { allow: ['Point'] }],
      future: 'off',
    },
  });
  assert.equal(result.errorCount, 0);
});

test('rule options reject unknown, out-of-range, and meaningless values', async () => {
  const cases: GeoLintConfig[] = [
    { rules: { 'require-feature-id': ['error', {}] } },
    {
      rules: {
        'consistent-property-types': ['error', { nullPolicy: 'other' }],
      },
    },
    {
      rules: {
        'consistent-property-presence': ['error', { minimumPresenceRatio: 0 }],
      },
    },
    {
      rules: {
        'consistent-property-presence': ['error', { minimumPresenceRatio: 2 }],
      },
    },
    {
      rules: {
        'consistent-property-presence': ['error', { minimumFeatureCount: -1 }],
      },
    },
    {
      rules: {
        'consistent-property-presence': ['error', { minimumFeatureCount: 1.5 }],
      },
    },
    { rules: { 'allowed-geometry-types': ['error', { allow: [] }] } },
    { rules: { 'allowed-geometry-types': ['error', { allow: ['Unknown'] }] } },
    { rules: { 'coordinate-precision': ['error', { maximumDecimals: -1 }] } },
  ];
  for (const config of cases) {
    await assert.rejects(
      lint(feature(1, {}), config),
      (error) => error instanceof GeoLintConfigError,
    );
  }
});

test('source-aware policies fail capability preflight for both input APIs', async () => {
  for (const options of [
    { config: { rules: { 'coordinate-precision': 'error' as const } } },
    { config: { budgets: { feature: { bytes: '5KB' } } } },
  ]) {
    await assert.rejects(
      lintGeoJSON(feature(1, {}), options),
      (error) => error instanceof GeoLintCapabilityError,
    );
    await assert.rejects(
      lintGeoJSONText(JSON.stringify(feature(1, {})), options),
      (error) => error instanceof GeoLintCapabilityError,
    );
  }
});

test('file-size budget requires source bytes and uses exact UTF-8 size', async () => {
  const source = JSON.stringify(feature(1, { label: 'é' }));
  await assert.rejects(
    lintGeoJSON(feature(1, {}), { config: { budgets: { fileSize: '1KB' } } }),
    (error) => error instanceof GeoLintCapabilityError,
  );
  const exact = Buffer.byteLength(source, 'utf8');
  const atLimit = await lintGeoJSONText(source, {
    config: { budgets: { fileSize: `${exact}B` } },
  });
  assert.equal(codes(atLimit).includes('budget/file-size'), false);
  const over = await lintGeoJSONText(source, {
    config: {
      budgets: { fileSize: { limit: `${exact - 1}B`, severity: 'warn' } },
    },
  });
  assert.equal(over.diagnostics.at(-1)?.code, 'budget/file-size');
  assert.equal(over.diagnostics.at(-1)?.severity, 'warning');
  assert.deepEqual(over.diagnostics.at(-1)?.data, {
    actual: exact,
    limit: exact - 1,
  });
});

test('aggregate count budgets enforce > boundaries and skip partial facts', async () => {
  const valid: JsonValue = {
    type: 'FeatureCollection',
    features: [feature(1, {}), feature(2, {})],
  };
  const atLimit = await lint(valid, {
    budgets: { featureCount: 2, totalVertices: 2 },
  });
  assert.equal(atLimit.errorCount, 0);
  const over = await lint(valid, {
    budgets: {
      featureCount: { limit: 1, severity: 'warn' },
      totalVertices: 1,
    },
  });
  assert.deepEqual(codes(over), [
    'budget/feature-count',
    'budget/total-vertices',
  ]);
  assert.deepEqual(
    over.diagnostics.map(({ severity }) => severity),
    ['warning', 'error'],
  );

  const partial = await lint(
    { type: 'FeatureCollection', features: [feature(1, {}), null] },
    { budgets: { featureCount: 0, totalVertices: 0 } },
  );
  assert.deepEqual(codes(partial), ['geojson/invalid-feature']);
  assert.deepEqual(
    partial.skippedPolicies.map(({ code }) => code),
    ['budget/feature-count', 'budget/total-vertices'],
  );
});

test('feature vertex budgets use completed Feature summaries and honor false', async () => {
  const document: JsonValue = {
    type: 'FeatureCollection',
    features: [
      feature(
        1,
        {},
        {
          type: 'MultiPoint',
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        },
      ),
      feature(2, {}, null),
    ],
  };
  const result = await lint(document, {
    budgets: { feature: { vertices: { limit: 1, severity: 'warn' } } },
  });
  assert.deepEqual(codes(result), ['budget/feature-vertices']);
  assert.equal(result.diagnostics[0]?.featureId, 1);
  const disabled = await lint(document, {
    budgets: { feature: { vertices: false } },
  });
  assert.equal(disabled.errorCount, 0);
});

test('byte units are owned, exact, and case-sensitive', () => {
  assert.equal(parseByteSize('1KB', 'test'), 1_000);
  assert.equal(parseByteSize('1KiB', 'test'), 1_024);
  assert.equal(parseByteSize('1.5MB', 'test'), 1_500_000);
  for (const value of ['1mb', '1', 'wat', '999999999999999999GB']) {
    assert.throws(() => parseByteSize(value, 'test'), GeoLintConfigError);
  }
});

test('recommended and web presets resolve exact V5 membership', async () => {
  const recommended = await resolveRuntimeConfig({ config: {} });
  assert.deepEqual(recommended.rules, {});

  const defaults = await resolveRuntimeConfig();
  assert.deepEqual(defaults.rules, {
    'unique-feature-id': 'error',
    'consistent-feature-id-type': 'error',
    'consistent-property-types': 'error',
    'valid-coordinate-range': 'error',
    'consistent-coordinate-dimensions': 'error',
  });

  const web = await resolveRuntimeConfig({
    config: { extends: ['geolint/web'] },
  });
  assert.deepEqual(web.rules, {
    ...defaults.rules,
    'require-feature-id': 'warn',
    'consistent-geometry-types': 'warn',
    'no-null-geometry': 'warn',
    'coordinate-precision': ['warn', { maximumDecimals: 6 }],
  });
  await assert.rejects(
    lintGeoJSONText(JSON.stringify(feature(1, {})), {
      config: { extends: ['geolint/web'] },
    }),
    GeoLintCapabilityError,
  );
});

test('resolved file overrides disable and change recommended rules', async () => {
  const value: JsonValue = {
    type: 'FeatureCollection',
    features: [feature('x', {}), feature('x', {})],
  };
  const config: GeoLintConfig = {
    extends: ['geolint/recommended'],
    overrides: [
      {
        files: ['fixtures/**'],
        rules: { 'unique-feature-id': 'off' },
      },
      {
        files: ['warnings/**'],
        rules: { 'unique-feature-id': 'warn' },
      },
    ],
  };
  const disabled = await lintGeoJSON(value, {
    config,
    filename: 'fixtures/a.geojson',
  });
  assert.equal(codes(disabled).includes('unique-feature-id'), false);
  const warning = await lintGeoJSON(value, {
    config,
    filename: 'warnings/a.geojson',
  });
  assert.equal(
    warning.diagnostics.find(({ code }) => code === 'unique-feature-id')
      ?.severity,
    'warning',
  );
});

test('partial aggregate rules skip while unrelated local rules continue', async () => {
  const result = await lint(
    {
      type: 'FeatureCollection',
      features: [
        feature(1, []),
        feature(2, {}, { type: 'Point', coordinates: [181, 0] }),
        feature(3, {}),
      ],
    },
    {
      rules: {
        'consistent-property-types': 'error',
        'valid-coordinate-range': 'error',
      },
    },
  );
  assert.deepEqual(codes(result), [
    'geojson/invalid-properties',
    'valid-coordinate-range',
  ]);
  assert.equal(result.skippedPolicies[0]?.code, 'consistent-property-types');
});

test('valid ID rules survive unrelated malformed properties', async () => {
  const result = await lint(
    {
      type: 'FeatureCollection',
      features: [feature('same', {}), feature('same', [])],
    },
    {
      rules: {
        'unique-feature-id': 'error',
        'require-feature-id': 'error',
      },
    },
  );
  assert.deepEqual(codes(result), [
    'geojson/invalid-properties',
    'unique-feature-id',
  ]);
});

test('policy diagnostics are invariant to member and rule configuration order', async () => {
  const first: JsonValue = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'same',
        properties: { z: 1, a: 'x' },
        geometry: { type: 'Point', coordinates: [0, 0] },
      },
      {
        geometry: { coordinates: [181, 0, 3], type: 'Point' },
        properties: { a: 2, z: 'x' },
        id: 'same',
        type: 'Feature',
      },
    ],
  };
  const second = reverseMembers(first);
  const rulesA = {
    'unique-feature-id': 'error' as const,
    'consistent-property-types': 'error' as const,
    'valid-coordinate-range': 'warn' as const,
    'consistent-coordinate-dimensions': 'error' as const,
  };
  const rulesB = Object.fromEntries(Object.entries(rulesA).reverse());
  const left = await lint(first, { rules: rulesA });
  const right = await lint(second, { rules: rulesB });
  const trace = (result: FileLintResult) => ({
    diagnostics: result.diagnostics,
    skippedPolicies: result.skippedPolicies,
    errorCount: result.errorCount,
    warningCount: result.warningCount,
  });
  assert.deepEqual(trace(left), trace(right));
});

test('rules, budgets, and structural findings share global diagnostic limits', async () => {
  const features = Array.from({ length: 5 }, () =>
    feature(undefined, {}, { type: 'Point', coordinates: [181, 0] }),
  );
  const result = await lint(
    { type: 'FeatureCollection', features },
    {
      rules: {
        'require-feature-id': 'error',
        'valid-coordinate-range': 'error',
      },
      budgets: { feature: { vertices: 0 } },
      diagnostics: { maxPerCodePerFile: 2, maxPerFile: 3 },
    },
  );
  assert.deepEqual(codes(result), [
    'valid-coordinate-range',
    'require-feature-id',
    'budget/feature-vertices',
  ]);
  assert.equal(result.errorCount, 15);
  assert.deepEqual(result.suppressedDiagnostics, [
    { code: 'valid-coordinate-range', severity: 'error', suppressedCount: 4 },
    { code: 'require-feature-id', severity: 'error', suppressedCount: 4 },
    { code: 'budget/feature-vertices', severity: 'error', suppressedCount: 4 },
  ]);
});

test('not-computed required facts are policy planner invariants', () => {
  const completeness = {
    document: 'complete' as const,
    facts: {
      fileBytes: 'not-computed' as const,
      featureCount: 'not-computed' as const,
      vertexCount: 'not-computed' as const,
      propertyStats: 'not-computed' as const,
      geometryStats: 'not-computed' as const,
      idStats: 'not-computed' as const,
      coordinateDimensionStats: 'not-computed' as const,
      derivedExtent: 'not-computed' as const,
      featureByteStats: 'not-computed' as const,
    },
  };
  assert.throws(
    () =>
      skipPolicyForIncompleteFacts({
        code: 'broken-plan',
        source: 'rule',
        requiredFacts: ['propertyStats'],
        completeness,
      }),
    (error) =>
      error instanceof GeoLintInternalError &&
      error.code === 'GEOLINT_POLICY_PLAN_INVARIANT',
  );
});
