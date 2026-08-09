import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeFilePath } from '../config/resolve.js';
import { GeoLintIOError, GeoLintTargetError } from '../engine/errors.js';
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
  const projectRoot = process.platform === 'win32' ? 'C:\\repo' : '/repo';
  const filePath =
    process.platform === 'win32'
      ? 'C:\\repo\\public\\map.geojson'
      : '/repo/public/map.geojson';
  assert.equal(normalizeFilePath(projectRoot, filePath), 'public/map.geojson');
  assert.equal(regressionIdentity('public/map.geojson'), 'public/map.geojson');
  assert.throws(
    () => regressionIdentity('../outside.geojson'),
    (error) =>
      error instanceof GeoLintTargetError &&
      error.code === 'GEOLINT_UNSTABLE_REGRESSION_IDENTITY',
  );
  assert.throws(
    () => regressionIdentity('<memory>'),
    (error) =>
      error instanceof GeoLintTargetError &&
      error.code === 'GEOLINT_UNSTABLE_REGRESSION_IDENTITY',
  );
});

test('baseline parser rejects noncanonical persisted file keys', () => {
  const valid = createBaseline({ 'public/map.geojson': entry() });
  for (const key of [
    'public\\map.geojson',
    'public//map.geojson',
    'public/./map.geojson',
    'public/foo/../map.geojson',
    '../public/map.geojson',
    'a/../../outside.geojson',
    '/public/map.geojson',
    'C:/repo/public/map.geojson',
    'foo/',
    'public/map.geojson/',
    '',
  ]) {
    assert.throws(
      () =>
        parseBaseline(JSON.stringify({ ...valid, files: { [key]: entry() } })),
      GeoLintIOError,
    );
  }
  assert.deepEqual(
    Object.keys(
      parseBaseline(
        serializeBaseline(
          createBaseline({
            'foo.geojson': entry(),
            'public/map.geojson': entry(),
            'public/maps/cities.geojson': entry(),
            'fixtures/a.geojson': entry(),
          }),
        ),
      ).files,
    ),
    [
      'fixtures/a.geojson',
      'foo.geojson',
      'public/map.geojson',
      'public/maps/cities.geojson',
    ],
  );
});

test('baseline parser canonicalizes unordered maps and rejects impossible duplicates', () => {
  const parsed = parseBaseline(
    JSON.stringify({
      schemaVersion: 1,
      geolintVersion: '1',
      files: {
        'z.geojson': entry({
          featureGeometryTypes: { Polygon: 1, Point: 1 },
          properties: {
            z: { present: 2, missing: 0, types: { number: 1, string: 1 } },
            a: { present: 2, missing: 0, types: { null: 1, boolean: 1 } },
          },
        }),
        'a.geojson': entry(),
      },
    }),
  );
  assert.deepEqual(Object.keys(parsed.files), ['a.geojson', 'z.geojson']);
  assert.deepEqual(Object.keys(parsed.files['z.geojson']!.properties), [
    'a',
    'z',
  ]);
  assert.deepEqual(
    Object.keys(parsed.files['z.geojson']!.featureGeometryTypes),
    ['Point', 'Polygon'],
  );
  assert.deepEqual(
    Object.keys(parsed.files['z.geojson']!.properties.a!.types),
    ['boolean', 'null'],
  );

  for (const [string, number, duplicates, valid] of [
    [0, 0, 0, true],
    [1, 0, 0, true],
    [1, 1, 1, true],
    [1, 1, 2, false],
    [5, 5, 9, true],
    [5, 5, 10, false],
  ] as const) {
    const present = string + number;
    const candidate = createBaseline({
      'map.geojson': entry({
        featureCount: present,
        totalVertices: present,
        largestFeatureVertices: present === 0 ? 0 : 1,
        featureGeometryTypes: present === 0 ? {} : { Point: present },
        properties: {},
        ids: { missing: 0, string, number, duplicates },
      }),
    });
    if (valid)
      assert.doesNotThrow(() => parseBaseline(JSON.stringify(candidate)));
    else
      assert.throws(
        () => parseBaseline(JSON.stringify(candidate)),
        GeoLintIOError,
      );
  }
});
