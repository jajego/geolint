import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GeoLintConfigError,
  GeoLintInputError,
  GeoLintPluginError,
} from '../engine/errors.js';
import { lintGeoJSON, lintGeoJSONText } from '../engine/lint-input.js';

const valid = {
  type: 'Feature',
  properties: {},
  geometry: { type: 'Point', coordinates: [1, 2] },
};

test('lintGeoJSON accepts the strict JSON data model', async () => {
  const nullPrototype = Object.assign(
    Object.create(null) as Record<string, unknown>,
    valid,
  );
  const shared = { value: 1 };
  const result = await lintGeoJSON(
    {
      ...valid,
      properties: {
        nullPrototype,
        sharedA: shared,
        sharedB: shared,
        negativeZero: -0,
      },
    },
    { config: {} },
  );
  assert.equal(result.errorCount, 0);
  assert.equal(result.summary?.totalVertices, 1);
  assert.equal(result.summary?.bytes, undefined);
});

test('lintGeoJSON rejects a non-finite bbox before structural validation', async () => {
  await assert.rejects(
    lintGeoJSON(
      {
        type: 'Point',
        coordinates: [1, 2],
        bbox: [0, 0, Infinity, 2],
      },
      { config: {} },
    ),
    (error) =>
      error instanceof GeoLintInputError &&
      error.code === 'GEOLINT_INVALID_JSON_VALUE',
  );
});

test('lintGeoJSON rejects JavaScript-only values with a stable error', async (context) => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const sparse = Array(2);
  const accessor = Object.defineProperty({}, 'x', {
    enumerable: true,
    get: () => 1,
  });
  const symbolState = { [Symbol('x')]: 1 };
  class Custom {
    value = 1;
  }
  const cases: readonly unknown[] = [
    undefined,
    1n,
    Symbol('x'),
    () => undefined,
    Number.NaN,
    Infinity,
    -Infinity,
    cyclic,
    sparse,
    accessor,
    symbolState,
    new Date(),
    new Map(),
    new Custom(),
    new Proxy({}, {}),
  ];
  for (const value of cases) {
    await context.test(String(value), async () => {
      await assert.rejects(
        lintGeoJSON(value, { config: {} }),
        (error) =>
          error instanceof GeoLintInputError &&
          error.code === 'GEOLINT_INVALID_JSON_VALUE',
      );
    });
  }
});

test('lintGeoJSONText reports malformed JSON without leaking SyntaxError', async () => {
  const result = await lintGeoJSONText('{"type":', { config: {} });
  assert.equal(result.errorCount, 1);
  assert.equal(result.diagnostics[0]?.code, 'parse/invalid-json');
  assert.equal(result.summary, undefined);
});

test('lintGeoJSONText counts UTF-8 source bytes', async () => {
  const text = JSON.stringify({ ...valid, properties: { label: 'é😀' } });
  const result = await lintGeoJSONText(text, {
    filename: 'data/cities.geojson',
    cwd: process.cwd(),
    config: {},
  });
  assert.equal(result.filePath, 'data/cities.geojson');
  assert.equal(result.summary?.bytes, Buffer.byteLength(text, 'utf8'));
  assert.equal(result.summary?.completeness.facts.fileBytes, 'complete');
});

test('valid JSON with an unsupported root remains an artifact diagnostic', async () => {
  const result = await lintGeoJSON(42, { config: {} });
  assert.equal(result.errorCount, 1);
  assert.equal(result.diagnostics[0]?.code, 'geojson/invalid-root');
});

test('unknown enabled rules fail clearly', async () => {
  await assert.rejects(
    lintGeoJSON(valid, { config: { rules: { future: 'error' } } }),
    (error) =>
      error instanceof GeoLintConfigError &&
      error.code === 'GEOLINT_UNKNOWN_RULE',
  );
});

test('config incompatibility is found before a large object validation walk', async () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  await assert.rejects(
    lintGeoJSON(cyclic, { config: { regression: { future: 1 } } }),
    (error) =>
      error instanceof GeoLintConfigError &&
      error.code === 'GEOLINT_UNIMPLEMENTED_REGRESSION',
  );
});

test('external plugin execution fails explicitly', async () => {
  await assert.rejects(
    lintGeoJSON(valid, { config: { plugins: { example: {} } } }),
    (error) =>
      error instanceof GeoLintPluginError &&
      error.code === 'GEOLINT_PLUGIN_LOADING_UNAVAILABLE',
  );
});
