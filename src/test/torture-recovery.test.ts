import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createBaseline, serializeBaseline } from '../regression/schema.js';
import type { GeoLintConfig } from '../types/config.js';
import { assertOrdinaryEquivalence } from './torture-harness.js';

const recoveryConfig: GeoLintConfig = {
  extends: ['geolint/recommended'],
  rules: {
    'require-feature-id': 'warn',
    'consistent-property-presence': 'warn',
    'consistent-geometry-types': 'warn',
    'no-null-geometry': 'warn',
  },
  budgets: {
    featureCount: 1,
    totalVertices: 1,
    feature: { vertices: 0 },
  },
  diagnostics: { maxPerCodePerFile: 2, maxPerFile: 30 },
};

const recoveryCases: readonly [string, string][] = [
  ['document invalid root', '{}'],
  ['document invalid features', '{"type":"FeatureCollection","features":null}'],
  [
    'Feature-local recovery',
    '{"type":"FeatureCollection","features":[42,{"type":"Feature","id":"later","properties":{},"geometry":{"type":"Point","coordinates":[1,2]}}]}',
  ],
  [
    'combined Feature geometry Position and property recovery',
    '{"type":"FeatureCollection","features":[{"type":"Feature","id":"a","properties":{},"geometry":{"type":"Point","coordinates":[0,0]}},{"type":"Feature","id":"b","properties":42,"geometry":null},{"type":"Feature","id":null,"properties":{"mixed":1},"geometry":{"type":"MultiPoint","coordinates":[[1,2],[3]]}},{"type":"Feature","properties":{"mixed":"x"},"geometry":{"type":"Nope","coordinates":[4,5]}},{"type":"Feature","id":"e","properties":null,"geometry":{"type":"LineString","coordinates":[[6,7],[8,9]]}}]}',
  ],
  [
    'nested GeometryCollection recovery',
    '{"type":"GeometryCollection","geometries":[{"type":"Point","coordinates":[0,0]},{"type":"GeometryCollection","geometries":[null,{"type":"MultiPoint","coordinates":[[1,2],[3,4,5]]}]},{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}]}',
  ],
  [
    'bbox damage with valid semantics',
    '{"type":"Feature","id":1,"bbox":[0,1,2],"properties":{"a":1},"geometry":{"bbox":[0,0,0,1,1,1],"type":"Point","coordinates":[1,2,3]}}',
  ],
  [
    'valid losing invalid winning properties',
    '{"type":"Feature","id":1,"properties":{"a":1},"properties":42,"geometry":null}',
  ],
  [
    'invalid losing valid winning properties',
    '{"type":"Feature","id":1,"properties":42,"properties":{"a":1},"geometry":null}',
  ],
  [
    'valid losing invalid winning geometry',
    '{"type":"Feature","id":1,"properties":{},"geometry":{"type":"Point","coordinates":[1,2]},"geometry":{"type":"Point","coordinates":[1]}}',
  ],
  [
    'invalid losing valid winning geometry',
    '{"type":"Feature","id":1,"properties":{},"geometry":{"type":"Point","coordinates":[1]},"geometry":{"type":"Point","coordinates":[1,2]}}',
  ],
  ['empty FeatureCollection', '{"type":"FeatureCollection","features":[]}'],
  ['empty GeometryCollection', '{"type":"GeometryCollection","geometries":[]}'],
  [
    'minimal null Feature',
    '{"type":"Feature","properties":null,"geometry":null}',
  ],
  [
    'mixed coordinate dimensions',
    '{"type":"GeometryCollection","geometries":[{"type":"Point","coordinates":[-180,-90]},{"type":"MultiPoint","coordinates":[[180,90,3],[0,0,1,2],[1,1,2,3,4]]}]}',
  ],
  [
    'range boundaries and just outside',
    '{"type":"MultiPoint","coordinates":[[-180,-90],[180,90],[-180.000001,0],[0,90.000001],[1,2,999]]}',
  ],
  [
    'bbox lengths and duplicate winner',
    '{"type":"FeatureCollection","bbox":[0,0,1,1,2,2,3,3],"bbox":[0,0,1,1],"features":[{"type":"Feature","bbox":[0,0,0,1,1,1],"id":1,"properties":{},"geometry":null}]}',
  ],
];

test('structural recovery and aggregate damage are strategy-equivalent', async () => {
  for (let index = 0; index < recoveryCases.length; index += 1) {
    const [fixture, source] = recoveryCases[index]!;
    await assertOrdinaryEquivalence({
      fixture,
      source,
      permutation: index,
      config: recoveryConfig,
    });
  }
});

test('diagnostic retention changes representation but not semantic facts', async () => {
  const source = `{"type":"FeatureCollection","features":[${Array.from(
    { length: 100 },
    (_, index) =>
      `{"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[${181 + index},91]}}`,
  ).join(',')}]}`;
  for (const cap of [1, 1_000]) {
    await assertOrdinaryEquivalence({
      fixture: `suppression cap ${cap}`,
      source,
      config: {
        extends: ['geolint/recommended'],
        rules: { 'require-feature-id': 'error' },
        budgets: { featureCount: 0, totalVertices: 0 },
        diagnostics: { maxPerCodePerFile: cap, maxPerFile: cap },
      },
    });
  }
});

test('numeric, categorical, no-baseline, and incomplete regression remain equivalent', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'geolint-torture-regression-'),
  );
  try {
    await writeFile(
      join(directory, 'baseline.json'),
      serializeBaseline(
        createBaseline({
          'map.geojson': {
            bytes: 1,
            featureCount: 3,
            totalVertices: 1,
            largestFeatureVertices: 1,
            featureGeometryTypes: { Point: 3 },
            properties: {
              old: { present: 3, missing: 0, types: { string: 3 } },
            },
            ids: { missing: 0, duplicates: 0, string: 3, number: 0 },
            nullGeometries: 0,
          },
        }),
      ),
    );
    const config: GeoLintConfig = {
      regression: {
        baseline: 'baseline.json',
        thresholds: {
          featureCountDecrease: { minimumDecrease: 0 },
          totalVerticesIncrease: { minimumIncrease: 0 },
        },
        checks: {
          geometryTypes: { removed: 'warn', added: 'error' },
          properties: { removed: 'warn', added: 'error' },
          propertyTypes: { changed: 'error' },
          duplicateIds: { increased: 'error' },
          missingIds: { increased: 'warn' },
          nullGeometries: { increased: 'error' },
        },
      },
    };
    await assertOrdinaryEquivalence({
      fixture: 'complete regression families',
      source:
        '{"type":"FeatureCollection","features":[{"type":"Feature","id":1,"properties":{"new":1},"geometry":{"type":"LineString","coordinates":[[0,0],[1,1]]}},{"type":"Feature","id":1,"properties":{"new":"x"},"geometry":null}]}',
      cwd: directory,
      config,
    });
    await assertOrdinaryEquivalence({
      fixture: 'incomplete regression facts',
      source:
        '{"type":"FeatureCollection","features":[{"type":"Feature","id":1,"properties":42,"geometry":{"type":"Point","coordinates":[0]}},42]}',
      cwd: directory,
      config,
    });
    await assertOrdinaryEquivalence({
      fixture: 'no baseline behavior',
      source: '{"type":"FeatureCollection","features":[]}',
      cwd: directory,
      config: {
        regression: { ...config.regression, baseline: 'missing.json' },
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('repeated hostile execution is deeply deterministic', async () => {
  const source = recoveryCases[3]![1];
  const runs = await Promise.all(
    Array.from({ length: 5 }, async () => {
      await assertOrdinaryEquivalence({
        fixture: 'repeatability',
        source,
        config: recoveryConfig,
      });
      return JSON.parse(source);
    }),
  );
  for (const run of runs.slice(1)) assert.deepEqual(run, runs[0]);
});
