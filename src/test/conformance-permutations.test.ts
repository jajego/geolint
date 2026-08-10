import assert from 'node:assert/strict';
import test from 'node:test';

import { createExecutionRequirements } from '../engine/requirements.js';
import { parseIndexedSource } from '../parser/indexed-source.js';
import { scanGeoJSON } from '../scanner/scan.js';
import type { GeoLintConfig } from '../types/config.js';
import type { JsonValue } from '../types/semantic.js';
import {
  assertOrdinaryEquivalence,
  permuteObjects,
} from './conformance-harness.js';

const point = (coordinates: readonly number[]): JsonValue => ({
  type: 'Point',
  bbox: [-180, -90, 180, 90],
  coordinates: [...coordinates],
});

const ring = [
  [0, 0],
  [2, 0],
  [2, 2],
  [0, 0],
];

const fixtures: readonly [string, JsonValue][] = [
  ['Point', point([-180, -90, 3, 4, 5])],
  [
    'MultiPoint',
    {
      type: 'MultiPoint',
      coordinates: [
        [0, 0],
        [180, 90, 3],
      ],
    },
  ],
  [
    'LineString',
    {
      type: 'LineString',
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    },
  ],
  [
    'MultiLineString',
    {
      type: 'MultiLineString',
      coordinates: [
        [
          [0, 0],
          [1, 1],
        ],
        [
          [2, 2],
          [3, 3],
        ],
      ],
    },
  ],
  ['Polygon', { type: 'Polygon', bbox: [0, 0, 2, 2], coordinates: [ring] }],
  [
    'MultiPolygon',
    { type: 'MultiPolygon', coordinates: [[ring], [[...ring].reverse()]] },
  ],
  [
    'GeometryCollection',
    {
      type: 'GeometryCollection',
      geometries: [point([0, 0]), { type: 'LineString', coordinates: ring }],
    },
  ],
  [
    'nested GeometryCollection',
    {
      type: 'GeometryCollection',
      geometries: [
        {
          type: 'GeometryCollection',
          geometries: [point([1, 2, 3, 4])],
        },
        {
          type: 'MultiPoint',
          coordinates: [
            [3, 4],
            [5, 6],
          ],
        },
      ],
    },
  ],
  [
    'Feature',
    {
      type: 'Feature',
      bbox: [-1, -1, 1, 1],
      id: 'feature-a',
      properties: {
        z: 1,
        A: null,
        a: ['nested', { value: true }],
        é: 'actual',
        中: 3,
        '🗺️': false,
        '/': 4,
        '~': 5,
        '.': 6,
        '[': 7,
        ']': 8,
      },
      geometry: point([1, 2]),
    },
  ],
  [
    'FeatureCollection',
    {
      type: 'FeatureCollection',
      bbox: [-180, -90, 180, 90],
      features: [
        {
          type: 'Feature',
          id: 1,
          properties: { a: 1, nullable: null },
          geometry: point([0, 0]),
        },
        {
          type: 'Feature',
          id: 2,
          properties: { a: 2 },
          geometry: null,
        },
      ],
    },
  ],
];

const config: GeoLintConfig = {
  extends: ['geolint/recommended'],
  rules: {
    'consistent-property-presence': ['warn', { minimumPresenceRatio: 0.75 }],
    'allowed-geometry-types': ['warn', { allow: ['Point', 'LineString'] }],
  },
  budgets: {
    featureCount: 1,
    totalVertices: 2,
    feature: { vertices: 1 },
  },
  diagnostics: { maxPerCodePerFile: 3, maxPerFile: 20 },
};

test('seeded recursive member permutations preserve every root family', async () => {
  const seeds = [1, 7, 42, 0x5eed, 0xdeadbeef, 0xffffffff, 123_456, 987_654];
  for (const [fixture, value] of fixtures) {
    for (let permutation = 0; permutation < seeds.length; permutation += 1) {
      const seed = seeds[permutation]!;
      const source = JSON.stringify(permuteObjects(value, seed));
      await assertOrdinaryEquivalence({
        source,
        fixture,
        seed,
        permutation,
        config,
      });
    }
  }
});

test('seeded permutations are reproducible and preserve array order', () => {
  const value = fixtures.find(([name]) => name === 'FeatureCollection')![1];
  const first = JSON.stringify(permuteObjects(value, 0x12345678));
  const second = JSON.stringify(permuteObjects(value, 0x12345678));
  assert.equal(first, second);
  assert.deepEqual(
    (JSON.parse(first) as { features: { id: number }[] }).features.map(
      ({ id }) => id,
    ),
    [1, 2],
  );
});

test('randomized property source order emits canonical JS code-unit order', () => {
  const keys = ['a', 'A', 'z', 'é', '中', '🗺️', '/', '~', '.', '[', ']'];
  const properties = Object.fromEntries(keys.map((key, index) => [key, index]));
  const feature = permuteObjects(
    { type: 'Feature', properties, geometry: null },
    0xc0ffee,
  );
  const source = JSON.stringify(feature);
  const observed: string[] = [];
  const listener = {
    property: ({ key }: { readonly key: string }) => observed.push(key),
  };
  const requirements = createExecutionRequirements({ listener });
  const parsed = parseIndexedSource(source, requirements);
  scanGeoJSON(parsed.value, {
    filePath: 'map.geojson',
    requirements,
    listener,
  });
  assert.deepEqual(observed, [...keys].sort());
});
