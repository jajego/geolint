import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeFilePath } from '../config/resolve.js';
import { GeoLintCapabilityError, GeoLintIOError } from '../engine/errors.js';
import { regressionIdentity } from '../regression/baseline-io.js';
import {
  createBaseline,
  parseBaseline,
  serializeBaseline,
  type BaselineFileEntry,
} from '../regression/schema.js';

function entry(overrides: Partial<BaselineFileEntry> = {}): BaselineFileEntry {
  return {
    bytes: 100,
    featureCount: 2,
    totalVertices: 2,
    largestFeatureVertices: 1,
    featureGeometryTypes: { Point: 2 },
    properties: {
      name: { present: 2, missing: 0, types: { string: 2 } },
    },
    ids: { missing: 0, duplicates: 0, string: 2, number: 0 },
    nullGeometries: 0,
    ...overrides,
  };
}

test('baseline schema round-trips with deterministic canonical ordering', () => {
  const source = JSON.stringify({
    files: {
      'z.geojson': entry({
        properties: {
          z: { present: 1, missing: 1, types: { null: 1 } },
          a: { present: 2, missing: 0, types: { number: 1, string: 1 } },
        },
        featureGeometryTypes: { Polygon: 1, Point: 1 },
      }),
      'a.geojson': entry(),
    },
    geolintVersion: '99.1.2',
    schemaVersion: 1,
  });
  const parsed = parseBaseline(source);
  const serialized = serializeBaseline(parsed);
  assert.deepEqual(parseBaseline(serialized), parsed);
  assert.equal(serialized.endsWith('\n'), true);
  assert.equal(
    serialized.indexOf('a.geojson') < serialized.indexOf('z.geojson'),
    true,
  );
  assert.equal(
    serialized.indexOf('"Point"') < serialized.indexOf('"Polygon"'),
    true,
  );
  assert.equal(
    serialized.indexOf('"string"') < serialized.indexOf('"number"'),
    true,
  );
  assert.equal(parseBaseline(serialized).geolintVersion, '99.1.2');
});

test('baseline parser rejects corrupt and incompatible content', () => {
  const valid = createBaseline({ 'map.geojson': entry() });
  const cases: unknown[] = [
    '{',
    {},
    { schemaVersion: 2, geolintVersion: '1', files: {} },
    { schemaVersion: 1, geolintVersion: '1', files: [] },
    {
      ...valid,
      files: { 'map.geojson': { ...entry(), bytes: -1 } },
    },
    {
      ...valid,
      files: {
        'map.geojson': {
          ...entry(),
          featureGeometryTypes: { Unknown: 2 },
        },
      },
    },
    {
      ...valid,
      files: {
        'map.geojson': {
          ...entry(),
          properties: {
            name: { present: 2, missing: 0, types: { future: 2 } },
          },
        },
      },
    },
    {
      ...valid,
      files: {
        'map.geojson': { ...entry(), properties: { name: { present: 2 } } },
      },
    },
    {
      ...valid,
      files: { 'map.geojson': { ...entry(), ids: { missing: 0 } } },
    },
    { ...valid, files: { 'C:/absolute.geojson': entry() } },
  ];
  for (const candidate of cases) {
    assert.throws(
      () =>
        parseBaseline(
          typeof candidate === 'string' ? candidate : JSON.stringify(candidate),
        ),
      GeoLintIOError,
    );
  }
});

test('regression identities are stable project-relative paths', () => {
  assert.equal(
    normalizeFilePath('C:/repo', 'C:\\repo\\public\\map.geojson'),
    'public/map.geojson',
  );
  assert.equal(regressionIdentity('public/map.geojson'), 'public/map.geojson');
  assert.throws(
    () => regressionIdentity('../outside.geojson'),
    GeoLintCapabilityError,
  );
  assert.throws(() => regressionIdentity('<memory>'), GeoLintCapabilityError);
});
