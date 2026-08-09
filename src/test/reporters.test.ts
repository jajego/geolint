import assert from 'node:assert/strict';
import test from 'node:test';

import { createLintResult } from '../engine/lint-files.js';
import { lintGeoJSON } from '../engine/lint-input.js';
import { formatJson, jsonProjection } from '../reporters/json.js';
import { formatPretty } from '../reporters/pretty.js';
import { formatSnapshot } from '../reporters/snapshot.js';
import type { SnapshotProposal } from '../regression/snapshot.js';
import type { BaselineFileEntry } from '../regression/schema.js';
import { geolintVersion } from '../version.js';

function entry(overrides: Partial<BaselineFileEntry> = {}): BaselineFileEntry {
  return {
    bytes: 100,
    featureCount: 1,
    totalVertices: 1,
    largestFeatureVertices: 1,
    featureGeometryTypes: { Point: 1 },
    properties: {},
    ids: { missing: 0, duplicates: 0, string: 1, number: 0 },
    nullGeometries: 0,
    ...overrides,
  };
}

test('JSON reporter preserves Maps and versioned result data', async () => {
  const file = await lintGeoJSON(
    {
      type: 'Feature',
      properties: { name: 'x' },
      geometry: { type: 'Point', coordinates: [0, 0] },
    },
    {
      filename: 'map.geojson',
      config: {
        rules: {
          'consistent-property-types': 'error',
          'consistent-geometry-types': 'error',
        },
      },
    },
  );
  const parsed = JSON.parse(formatJson(createLintResult([file], 0)));
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.geolintVersion, geolintVersion);
  assert.equal(parsed.files[0].summary.propertyStats.name.present, 1);
  assert.equal(parsed.files[0].summary.featureGeometryTypes.Point, 1);
  assert.equal(JSON.stringify(parsed).includes('\u001b['), false);
});

test('pretty reporter shows codes, suppression, skips, and summary facts', async () => {
  const file = await lintGeoJSON(
    {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'Point', coordinates: [0, 0] },
        },
        {
          type: 'Feature',
          properties: [],
          geometry: { type: 'Point', coordinates: [0, 0] },
        },
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'Point', coordinates: [0, 0] },
        },
      ],
    },
    {
      filename: 'map.geojson',
      config: {
        rules: {
          'require-feature-id': 'warn',
          'consistent-property-types': 'error',
        },
        diagnostics: { maxPerCodePerFile: 1 },
      },
    },
  );
  const output = formatPretty(createLintResult([file], 0));
  assert.match(output, /require-feature-id/);
  assert.match(output, /additional occurrences suppressed/);
  assert.match(output, /consistent-property-types · incomplete propertyStats/);
  assert.match(output, /3 features/);
  assert.match(output, /3 vertices/);
  assert.equal(output.includes('\u001b['), false);
});

test('pretty reporter pluralizes vertices', async () => {
  const file = await lintGeoJSON(
    { type: 'Point', coordinates: [0, 0] },
    { filename: 'point.geojson' },
  );
  const output = formatPretty(createLintResult([file], 0));

  assert.match(output, /1 vertex/);
  assert.doesNotMatch(output, /vertexs/);
});

test('JSON reporter preserves hostile own keys without mutating prototypes', () => {
  const nested = Object.create(null) as Record<string, unknown>;
  nested['constructor'] = 'nested constructor';
  nested['prototype'] = 'nested prototype';
  nested['__proto__'] = 'nested proto';
  const data: Record<string, unknown> = {
    constructor: 'constructor',
    prototype: 'prototype',
    nested,
  };
  Object.defineProperty(data, '__proto__', {
    enumerable: true,
    value: { expected: true },
  });
  const projected = jsonProjection({
    data,
    map: new Map([
      ['prototype', 1],
      ['__proto__', 2],
      ['constructor', 3],
    ]),
  }) as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(projected), null);
  const parsed = JSON.parse(formatJson({ data, map: projected.map })) as {
    data: Record<string, unknown>;
    map: Record<string, unknown>;
  };
  assert.deepEqual(parsed.data.__proto__, { expected: true });
  assert.equal(parsed.data.constructor, 'constructor');
  assert.equal(parsed.data.prototype, 'prototype');
  assert.equal(
    (parsed.data.nested as Record<string, unknown>).__proto__,
    'nested proto',
  );
  assert.equal(parsed.map.__proto__, 2);
  assert.equal(parsed.map.constructor, 3);
  assert.equal(parsed.map.prototype, 1);
});

test('pretty snapshot reports stable useful diffs without unchanged noise', () => {
  const before = entry({
    bytes: 1_000,
    featureCount: 2,
    totalVertices: 3,
    largestFeatureVertices: 2,
    featureGeometryTypes: { Point: 2, Polygon: 3 },
  });
  const after = entry({
    bytes: 2_000,
    featureCount: 4,
    totalVertices: 6,
    largestFeatureVertices: 5,
    featureGeometryTypes: { Point: 1, MultiPolygon: 3 },
  });
  const proposal: SnapshotProposal = {
    mode: 'full',
    baselinePath: 'baseline.json',
    added: [{ filePath: 'added.geojson', after }],
    updated: [{ filePath: 'updated.geojson', before, after }],
    removed: [{ filePath: 'removed.geojson', before }],
    unchanged: ['unchanged.geojson'],
  };
  const output = formatSnapshot(proposal);
  assert.match(output, /bytes {2}1\.0 KB → 2\.0 KB/);
  assert.match(output, /featureCount {2}2 → 4/);
  assert.match(output, /totalVertices {2}3 → 6/);
  assert.match(output, /largestFeatureVertices {2}2 → 5/);
  assert.match(output, /\+ MultiPolygon/);
  assert.match(output, /- Polygon/);
  assert.match(output, /Point {2}2 → 1/);
  assert.match(
    output,
    /added\.geojson\n {2}added\n {2}4 features · 6 vertices · 2\.0 KB/,
  );
  assert.match(output, /removed\.geojson\n {2}removed/);
  assert.doesNotMatch(output, /unchanged\.geojson/);
  assert.equal(
    output,
    formatSnapshot({
      ...proposal,
      updated: [
        {
          filePath: 'updated.geojson',
          before: { ...before, featureGeometryTypes: { Polygon: 3, Point: 2 } },
          after: {
            ...after,
            featureGeometryTypes: { MultiPolygon: 3, Point: 1 },
          },
        },
      ],
    }),
  );
});

test('JSON reporter retains defensive rejection of invalid runtime values', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => formatJson({ value: NaN }), /non-finite/);
  assert.throws(() => formatJson(cyclic), /cyclic/);
  assert.throws(
    () =>
      formatJson(
        Object.defineProperty({}, 'value', { enumerable: true, get: () => 1 }),
      ),
    /accessors/,
  );
});
