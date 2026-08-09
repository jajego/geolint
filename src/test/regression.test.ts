import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DiagnosticCollector } from '../engine/diagnostics.js';
import {
  GeoLintCapabilityError,
  GeoLintInternalError,
  GeoLintTargetError,
} from '../engine/errors.js';
import { lintGeoJSON, lintGeoJSONText } from '../engine/lint-input.js';
import { compileRegression } from '../regression/compare.js';
import {
  createBaseline,
  serializeBaseline,
  type BaselineFileEntry,
} from '../regression/schema.js';
import type { RegressionConfig } from '../types/config.js';
import type {
  FileCompleteness,
  FileSummary,
  JsonValueType,
  PropertyStats,
} from '../types/semantic.js';

const completeFacts: FileCompleteness['facts'] = {
  fileBytes: 'complete',
  featureCount: 'complete',
  vertexCount: 'complete',
  propertyStats: 'complete',
  geometryStats: 'complete',
  idStats: 'complete',
  coordinateDimensionStats: 'not-computed',
  derivedExtent: 'not-computed',
  featureByteStats: 'not-computed',
};

function property(
  types: readonly JsonValueType[],
  present = 2,
  missing = 0,
): PropertyStats {
  return {
    present,
    missing,
    types: new Map(types.map((type) => [type, present / types.length])),
  };
}

function current(overrides: Partial<FileSummary> = {}): FileSummary {
  return {
    filePath: 'map.geojson',
    completeness: { document: 'complete', facts: completeFacts },
    bytes: 100,
    featureCount: 2,
    totalVertices: 100,
    largestFeatureVertices: 50,
    featureGeometryTypes: new Map([['Point', 2]]),
    geometryNodeTypes: new Map([['Point', 2]]),
    propertyStats: new Map([['a', property(['number'])]]),
    propertiesNullCount: 0,
    ids: {
      present: 2,
      missing: 0,
      duplicateCount: 0,
      stringCount: 2,
      numberCount: 0,
    },
    nullGeometryCount: 0,
    ...overrides,
  };
}

function baseline(
  overrides: Partial<BaselineFileEntry> = {},
): BaselineFileEntry {
  return {
    bytes: 100,
    featureCount: 2,
    totalVertices: 100,
    largestFeatureVertices: 50,
    featureGeometryTypes: { Point: 2 },
    properties: {
      a: { present: 2, missing: 0, types: { number: 2 } },
    },
    ids: { missing: 0, duplicates: 0, string: 2, number: 0 },
    nullGeometries: 0,
    ...overrides,
  };
}

function evaluate(
  config: RegressionConfig,
  summary: FileSummary,
  approved: BaselineFileEntry | false = baseline(),
) {
  const diagnostics = new DiagnosticCollector('map.geojson');
  const regression = compileRegression(
    config,
    'text',
    diagnostics,
    approved === false ? undefined : approved,
  );
  const skipped = regression.finish(summary);
  return { diagnostics, skipped };
}

test('numeric regression thresholds use strict AND boundaries and baseline-zero semantics', () => {
  const vertices = (percentage?: number, minimumIncrease?: number) =>
    ({
      thresholds: {
        totalVerticesIncrease: {
          ...(percentage === undefined ? {} : { percentage }),
          ...(minimumIncrease === undefined ? {} : { minimumIncrease }),
        },
      },
    }) satisfies RegressionConfig;

  assert.equal(
    evaluate(vertices(10), current({ totalVertices: 110 })).diagnostics
      .errorCount,
    0,
  );
  assert.equal(
    evaluate(vertices(10), current({ totalVertices: 111 })).diagnostics
      .errorCount,
    1,
  );
  assert.equal(
    evaluate(vertices(undefined, 10), current({ totalVertices: 110 }))
      .diagnostics.errorCount,
    0,
  );
  assert.equal(
    evaluate(vertices(undefined, 10), current({ totalVertices: 111 }))
      .diagnostics.errorCount,
    1,
  );
  assert.equal(
    evaluate(vertices(5, 20), current({ totalVertices: 110 })).diagnostics
      .errorCount,
    0,
  );
  assert.equal(
    evaluate(vertices(20, 5), current({ totalVertices: 110 })).diagnostics
      .errorCount,
    0,
  );
  assert.equal(
    evaluate(vertices(5, 5), current({ totalVertices: 110 })).diagnostics
      .errorCount,
    1,
  );
  assert.equal(
    evaluate(
      vertices(500),
      current({ totalVertices: 1 }),
      baseline({ totalVertices: 0 }),
    ).diagnostics.errorCount,
    1,
  );
  assert.equal(
    evaluate(
      vertices(500, 1),
      current({ totalVertices: 1 }),
      baseline({ totalVertices: 0 }),
    ).diagnostics.errorCount,
    0,
  );

  const decrease: RegressionConfig = {
    thresholds: {
      featureCountDecrease: { percentage: 50, minimumDecrease: 1 },
    },
  };
  assert.equal(
    evaluate(
      decrease,
      current({ featureCount: 0 }),
      baseline({ featureCount: 2 }),
    ).diagnostics.errorCount,
    1,
  );
  assert.equal(
    evaluate(
      decrease,
      current({ featureCount: 0 }),
      baseline({ featureCount: 0 }),
    ).diagnostics.errorCount,
    0,
  );

  const size: RegressionConfig = {
    thresholds: { fileSizeIncrease: { minimumIncrease: '1B' } },
  };
  const sizeResult = evaluate(size, current({ bytes: 102 }));
  assert.equal(
    sizeResult.diagnostics.diagnostics[0]?.code,
    'regression/file-size',
  );
  assert.equal(sizeResult.diagnostics.diagnostics[0]?.severity, 'error');
});

test('categorical regression emits stable independent changes with null distinct', () => {
  const approved = baseline({
    featureGeometryTypes: { Point: 1, Polygon: 1 },
    properties: {
      a: { present: 2, missing: 0, types: { number: 2 } },
      b: { present: 2, missing: 0, types: { number: 1, string: 1 } },
      c: { present: 2, missing: 0, types: { number: 1, string: 1 } },
      e: { present: 2, missing: 0, types: { boolean: 2 } },
    },
    ids: { missing: 0, duplicates: 0, string: 2, number: 0 },
  });
  const summary = current({
    featureGeometryTypes: new Map([
      ['Point', 1],
      ['MultiPolygon', 1],
    ]),
    propertyStats: new Map([
      ['a', property(['number', 'null'])],
      ['b', property(['number'])],
      ['c', property(['string', 'boolean'])],
      ['d', property(['object'])],
    ]),
    ids: {
      present: 1,
      missing: 1,
      duplicateCount: 1,
      stringCount: 1,
      numberCount: 0,
    },
    nullGeometryCount: 1,
  });
  const config: RegressionConfig = {
    checks: {
      propertyTypes: { widened: 'warn', narrowed: 'error', changed: 'error' },
      properties: { added: 'warn', removed: 'error' },
      geometryTypes: { added: 'warn', removed: 'error' },
      duplicateIds: { increased: 'error' },
      missingIds: { increased: 'warn' },
      nullGeometries: { increased: 'warn' },
    },
  };
  const result = evaluate(config, summary, approved);
  assert.deepEqual(
    result.diagnostics.diagnostics.map(({ code }) => code),
    [
      'regression/property-types-widened',
      'regression/property-types-narrowed',
      'regression/property-types-changed',
      'regression/property-added',
      'regression/property-removed',
      'regression/geometry-type-added',
      'regression/geometry-type-removed',
      'regression/duplicate-ids-increased',
      'regression/missing-ids-increased',
      'regression/null-geometries-increased',
    ],
  );
  assert.deepEqual(result.diagnostics.diagnostics[0]?.data, {
    property: 'a',
    baselineTypes: ['number'],
    currentTypes: ['number', 'null'],
  });
});

test('high-cardinality regression findings use shared diagnostic limits', () => {
  const diagnostics = new DiagnosticCollector('map.geojson', {
    maxPerCodePerFile: 2,
    maxPerFile: 2,
  });
  const properties = new Map<string, PropertyStats>();
  for (let index = 0; index < 1_000; index += 1) {
    properties.set(`p${index}`, property(['number']));
  }
  const regression = compileRegression(
    { checks: { properties: { added: 'error' } } },
    'text',
    diagnostics,
    baseline({ properties: {} }),
  );
  regression.finish(current({ propertyStats: properties }));
  assert.equal(diagnostics.errorCount, 1_000);
  assert.equal(diagnostics.diagnostics.length, 2);
  assert.equal(diagnostics.suppressedDiagnostics[0]?.suppressedCount, 998);
  assert.equal(diagnostics.lazyDetailCount, 2);
});

test('regression exposes no-baseline and incomplete-fact skips', () => {
  const config: RegressionConfig = {
    checks: {
      propertyTypes: { widened: 'warn', narrowed: 'off' },
      duplicateIds: { increased: 'error' },
    },
    thresholds: { totalVerticesIncrease: { percentage: 10 } },
  };
  const missing = evaluate(config, current(), false);
  assert.equal(missing.diagnostics.errorCount, 0);
  assert.deepEqual(
    missing.skipped.map(({ reason }) => reason),
    ['no-baseline', 'no-baseline', 'no-baseline'],
  );

  const facts = { ...completeFacts, propertyStats: 'partial' as const };
  const partial = evaluate(
    config,
    current({ completeness: { document: 'partial', facts } }),
  );
  assert.deepEqual(
    partial.skipped.map(({ code }) => code),
    ['regression/property-types-widened'],
  );

  const broken = { ...completeFacts, propertyStats: 'not-computed' as const };
  assert.throws(
    () =>
      evaluate(
        config,
        current({ completeness: { document: 'complete', facts: broken } }),
      ),
    GeoLintInternalError,
  );
});

test('each regression family skips only its own incomplete fact', () => {
  const config: RegressionConfig = {
    checks: {
      properties: { added: 'error' },
      geometryTypes: { added: 'error' },
      duplicateIds: { increased: 'error' },
      nullGeometries: { increased: 'error' },
    },
    thresholds: { totalVerticesIncrease: { percentage: 1 } },
  };
  const facts: FileCompleteness['facts'] = {
    ...completeFacts,
    vertexCount: 'partial',
    propertyStats: 'partial',
    geometryStats: 'partial',
    idStats: 'partial',
  };
  const result = evaluate(
    config,
    current({ completeness: { document: 'partial', facts } }),
  );
  assert.deepEqual(
    result.skipped.map(({ code }) => code),
    [
      'regression/vertex-count',
      'regression/property-added',
      'regression/geometry-type-added',
      'regression/duplicate-ids-increased',
      'regression/null-geometries-increased',
    ],
  );
});

test('ordinary lint requires stable identity and loads baseline by filename', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'geolint-regression-'));
  try {
    const config: RegressionConfig = {
      baseline: 'baseline.json',
      checks: { missingIds: { increased: 'warn' } },
    };
    await assert.rejects(
      lintGeoJSONText('{"type":"FeatureCollection","features":[]}', {
        cwd: directory,
        config: { regression: config },
      }),
      (error) =>
        error instanceof GeoLintTargetError &&
        error.code === 'GEOLINT_UNSTABLE_REGRESSION_IDENTITY',
    );

    const absent = await lintGeoJSON(
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'Point', coordinates: [0, 0] },
      },
      {
        cwd: directory,
        filename: 'new.geojson',
        config: {
          rules: { 'require-feature-id': 'error' },
          budgets: { featureCount: 0 },
          regression: config,
        },
      },
    );
    assert.equal(absent.skippedPolicies[0]?.reason, 'no-baseline');
    assert.deepEqual(
      absent.diagnostics.map(({ code }) => code),
      ['require-feature-id', 'budget/feature-count'],
    );

    const approved = createBaseline({
      'map.geojson': baseline({
        bytes: 0,
        featureCount: 1,
        totalVertices: 1,
        largestFeatureVertices: 1,
        featureGeometryTypes: { Point: 1 },
        properties: {},
        ids: { missing: 0, duplicates: 0, string: 1, number: 0 },
      }),
    });
    await writeFile(
      join(directory, 'baseline.json'),
      serializeBaseline(approved),
    );
    const result = await lintGeoJSON(
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'Point', coordinates: [0, 0] },
      },
      {
        cwd: directory,
        filename: 'map.geojson',
        config: { regression: config },
      },
    );
    assert.equal(
      result.diagnostics.at(-1)?.code,
      'regression/missing-ids-increased',
    );

    const newFile = await lintGeoJSON(
      { type: 'FeatureCollection', features: [] },
      {
        cwd: directory,
        filename: 'new.geojson',
        config: { regression: config },
      },
    );
    assert.deepEqual(newFile.skippedPolicies, [
      {
        code: 'regression/missing-ids-increased',
        source: 'regression',
        reason: 'no-baseline',
        configuredSeverity: 'warning',
      },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('text input evaluates exact file-size regression bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'geolint-regression-bytes-'));
  try {
    await writeFile(
      join(directory, 'baseline.json'),
      serializeBaseline(
        createBaseline({
          'map.geojson': baseline({
            bytes: 1,
            featureCount: 0,
            totalVertices: 0,
            largestFeatureVertices: 0,
            featureGeometryTypes: {},
            properties: {},
            ids: { missing: 0, duplicates: 0, string: 0, number: 0 },
          }),
        }),
      ),
    );
    const result = await lintGeoJSONText(
      '{"type":"Point","coordinates":[0,0]}',
      {
        cwd: directory,
        filename: 'map.geojson',
        config: {
          regression: {
            baseline: 'baseline.json',
            thresholds: { fileSizeIncrease: { minimumIncrease: '1B' } },
          },
        },
      },
    );
    assert.equal(result.diagnostics.at(-1)?.code, 'regression/file-size');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('object input rejects file-size regression before scanning', async () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  await assert.rejects(
    lintGeoJSON(cyclic, {
      filename: 'map.geojson',
      config: {
        regression: { thresholds: { fileSizeIncrease: { percentage: 1 } } },
      },
    }),
    GeoLintCapabilityError,
  );
});

test('off regression checks require no identity, facts, or comparison', async () => {
  const result = await lintGeoJSON(
    { type: 'FeatureCollection', features: [] },
    {
      config: {
        regression: {
          checks: {
            propertyTypes: {
              widened: 'off',
              narrowed: 'off',
              changed: 'off',
            },
          },
        },
      },
    },
  );
  assert.deepEqual(result.skippedPolicies, []);
  assert.equal(result.errorCount, 0);
});
