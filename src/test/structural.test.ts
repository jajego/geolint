import assert from 'node:assert/strict';
import test from 'node:test';

import { DiagnosticCollector } from '../engine/diagnostics.js';
import { lintGeoJSON, lintGeoJSONText } from '../engine/lint-input.js';
import {
  createExecutionRequirements,
  skipPolicyForIncompleteFacts,
  type SemanticListener,
} from '../engine/requirements.js';
import { scanGeoJSON, type ScanInstrumentation } from '../scanner/scan.js';
import type {
  CoordinateEvent,
  FeatureSummary,
  FileSummary,
  GeometrySummary,
  JsonValue,
  PropertyEvent,
  SummaryFactName,
} from '../types/semantic.js';

const allFacts: readonly SummaryFactName[] = [
  'featureCount',
  'vertexCount',
  'propertyStats',
  'geometryStats',
  'idStats',
  'coordinateDimensionStats',
  'derivedExtent',
];

function inspect(
  value: JsonValue,
  facts: readonly SummaryFactName[] = allFacts,
  listener?: SemanticListener,
) {
  const diagnostics = new DiagnosticCollector('<structural>');
  const summary = scanGeoJSON(value, {
    filePath: '<structural>',
    diagnostics,
    ...(listener ? { listener } : {}),
    requirements: createExecutionRequirements({
      facts,
      ...(listener ? { listener } : {}),
    }),
  });
  return { summary, diagnostics };
}

test('malformed and truncated JSON are parser-fatal results', async () => {
  for (const source of ['{', '{"type":"Point","coordinates":[1,']) {
    const result = await lintGeoJSONText(source, { config: {} });
    assert.equal(result.summary, undefined);
    assert.equal(result.errorCount, 1);
    assert.deepEqual(result.diagnostics, [
      {
        code: 'parse/invalid-json',
        source: 'parser',
        severity: 'error',
        message: 'Input is not valid JSON.',
        filePath: '<memory>',
      },
    ]);
  }
});

test('uninterpretable roots are document-fatal with granular statuses', () => {
  for (const value of [null, 7, [], {}, { type: 'Unknown' }] as JsonValue[]) {
    const { summary, diagnostics } = inspect(value);
    assert.equal(diagnostics.diagnostics[0]?.code, 'geojson/invalid-root');
    assert.equal(summary.completeness.document, 'partial');
    for (const fact of allFacts) {
      assert.equal(summary.completeness.facts[fact], 'partial');
    }
  }
});

test('unusable FeatureCollection containers are document-fatal', () => {
  for (const features of [undefined, null, {}] as const) {
    const value: JsonValue =
      features === undefined
        ? { type: 'FeatureCollection' }
        : { type: 'FeatureCollection', features };
    const { summary, diagnostics } = inspect(value);
    assert.equal(
      diagnostics.diagnostics[0]?.code,
      'geojson/invalid-feature-collection',
    );
    assert.equal(diagnostics.diagnostics[0]?.path, '/features');
    assert.equal(summary.completeness.facts.featureCount, 'partial');
  }
});

test('every geometry family rejects an unusable coordinate body', () => {
  const geometries: readonly [JsonValue, string][] = [
    [{ type: 'Point', coordinates: null }, 'geojson/invalid-coordinates'],
    [{ type: 'MultiPoint', coordinates: null }, 'geojson/invalid-coordinates'],
    [{ type: 'LineString', coordinates: null }, 'geojson/invalid-coordinates'],
    [
      { type: 'MultiLineString', coordinates: null },
      'geojson/invalid-coordinates',
    ],
    [{ type: 'Polygon', coordinates: null }, 'geojson/invalid-coordinates'],
    [
      { type: 'MultiPolygon', coordinates: null },
      'geojson/invalid-coordinates',
    ],
    [
      { type: 'GeometryCollection', geometries: null },
      'geojson/invalid-geometry',
    ],
  ];
  for (const [geometry, code] of geometries) {
    const { summary, diagnostics } = inspect(geometry);
    assert.equal(diagnostics.diagnostics[0]?.code, code);
    assert.equal(summary.completeness.facts.vertexCount, 'partial');
    assert.equal(summary.completeness.facts.propertyStats, 'complete');
  }
});

test('LineString and linear-ring minimums are structural coordinate failures', () => {
  const cases: readonly [JsonValue, string][] = [
    [
      { type: 'LineString', coordinates: [[0, 1]] },
      'Expected a LineString containing at least two Positions.',
    ],
    [
      {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [0, 0],
          ],
        ],
      },
      'Expected a linear ring containing at least four Positions.',
    ],
    [
      {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [2, 2],
          ],
        ],
      },
      'Expected a linear ring whose first and last Positions are identical.',
    ],
  ];
  for (const [value, message] of cases) {
    const { diagnostics } = inspect(value);
    assert.equal(
      diagnostics.diagnostics[0]?.code,
      'geojson/invalid-coordinates',
    );
    assert.equal(diagnostics.diagnostics[0]?.message, message);
  }
});

test('Position-local recovery skips invalid events and preserves observations', () => {
  const events: CoordinateEvent[] = [];
  const geometries: GeometrySummary[] = [];
  const listener: SemanticListener = {
    coordinate: (event) => events.push(event),
    geometry: (summary) => geometries.push(summary),
  };
  const { summary, diagnostics } = inspect(
    {
      type: 'MultiPoint',
      coordinates: [
        [0, 1],
        [2],
        [3, 'x'],
        [4, null],
        [5, {}],
        [6, [7]],
        [8, 9, 10],
      ],
    },
    allFacts,
    listener,
  );
  assert.deepEqual(
    diagnostics.diagnostics.map(({ code, path }) => [code, path]),
    [
      ['geojson/invalid-position', '/coordinates/1'],
      ['geojson/invalid-position', '/coordinates/2'],
      ['geojson/invalid-position', '/coordinates/3'],
      ['geojson/invalid-position', '/coordinates/4'],
      ['geojson/invalid-position', '/coordinates/5'],
    ],
  );
  assert.deepEqual(
    events.map(({ values }) => values),
    [
      [0, 1],
      [8, 9, 10],
    ],
  );
  assert.equal(geometries.length, 0);
  assert.equal(summary.totalVertices, 2);
  assert.deepEqual(summary.coordinateDimensionStats, {
    two: 1,
    three: 1,
    fourOrMore: 0,
  });
  assert.equal(summary.completeness.facts.vertexCount, 'partial');
  assert.equal(summary.completeness.facts.coordinateDimensionStats, 'partial');
  assert.equal(summary.completeness.facts.derivedExtent, 'partial');
  assert.equal(summary.completeness.facts.geometryStats, 'complete');
});

test('GeometryCollection recovery continues siblings without a false summary', () => {
  const coordinates: CoordinateEvent[] = [];
  const geometries: GeometrySummary[] = [];
  const listener: SemanticListener = {
    coordinate: (event) => coordinates.push(event),
    geometry: (summary) => geometries.push(summary),
  };
  const { summary, diagnostics } = inspect(
    {
      type: 'GeometryCollection',
      geometries: [
        { type: 'Point', coordinates: [0, 1] },
        { type: 'Nope', coordinates: [2, 3] },
        {
          type: 'LineString',
          coordinates: [
            [4, 5],
            [6, 7],
          ],
        },
      ],
    },
    allFacts,
    listener,
  );
  assert.equal(diagnostics.diagnostics[0]?.path, '/geometries/1/type');
  assert.deepEqual(
    coordinates.map(({ values }) => values),
    [
      [0, 1],
      [4, 5],
      [6, 7],
    ],
  );
  assert.equal(geometries.length, 0);
  assert.equal(summary.totalVertices, 3);
  assert.equal(summary.completeness.facts.geometryStats, 'partial');
});

test('nested GeometryCollections recover after malformed grandchildren', () => {
  const events: CoordinateEvent[] = [];
  const { summary, diagnostics } = inspect(
    {
      type: 'GeometryCollection',
      geometries: [
        {
          type: 'GeometryCollection',
          geometries: [
            { type: 'Point', coordinates: [0, 1] },
            null,
            { type: 'Point', coordinates: [2, 3] },
          ],
        },
        { type: 'Point', coordinates: [4, 5] },
      ],
    },
    ['vertexCount'],
    { coordinate: (event) => events.push(event) },
  );
  assert.equal(diagnostics.diagnostics[0]?.path, '/geometries/0/geometries/1');
  assert.equal(summary.totalVertices, 3);
  assert.equal(summary.completeness.facts.vertexCount, 'partial');
  assert.equal(events.length, 3);
});

test('combined recovery has deterministic diagnostics, hooks, and fact damage', () => {
  const featureStarts: number[] = [];
  const properties: PropertyEvent[] = [];
  const coordinates: CoordinateEvent[] = [];
  const geometries: GeometrySummary[] = [];
  const features: FeatureSummary[] = [];
  const listener: SemanticListener = {
    featureStart: ({ index }) => featureStarts.push(index),
    property: (event) => properties.push(event),
    coordinate: (event) => coordinates.push(event),
    geometry: (summary) => geometries.push(summary),
    feature: (summary) => features.push(summary),
  };
  const document: JsonValue = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'good-id',
        properties: [],
        geometry: { type: 'Point', coordinates: [0, 1] },
      },
      12,
      {
        type: 'Feature',
        id: null,
        properties: { b: true },
        geometry: { type: 'MultiPoint', coordinates: [[2, 3], [4]] },
      },
      {
        type: 'Feature',
        properties: { c: 1 },
        geometry: { type: 'Point', coordinates: [5, 6] },
      },
    ],
  };
  const { summary, diagnostics } = inspect(document, allFacts, listener);
  assert.deepEqual(
    diagnostics.diagnostics.map(({ code, path, featureIndex }) => [
      code,
      path,
      featureIndex,
    ]),
    [
      ['geojson/invalid-properties', '/features/0/properties', 0],
      ['geojson/invalid-feature', '/features/1', 1],
      ['geojson/invalid-feature-id', '/features/2/id', 2],
      ['geojson/invalid-position', '/features/2/geometry/coordinates/1', 2],
    ],
  );
  assert.deepEqual(featureStarts, [0, 2, 3]);
  assert.deepEqual(
    properties.map(({ featureIndex, key }) => [featureIndex, key]),
    [
      [2, 'b'],
      [3, 'c'],
    ],
  );
  assert.deepEqual(
    coordinates.map(({ featureIndex }) => featureIndex),
    [0, 2, 3],
  );
  assert.deepEqual(
    geometries.map(({ type }) => type),
    ['Point', 'Point'],
  );
  assert.deepEqual(
    features.map(({ index }) => index),
    [3],
  );
  assert.equal(summary.featureCount, 3);
  assert.equal(summary.totalVertices, 3);
  assert.equal(summary.ids?.present, 1);
  assert.equal(summary.ids?.missing, 1);
  assert.equal(summary.completeness.document, 'partial');
  for (const fact of allFacts) {
    assert.equal(summary.completeness.facts[fact], 'partial');
  }
});

test('fact damage remains independent across malformed Feature fields', () => {
  const invalidProperties = inspect({
    type: 'Feature',
    properties: [],
    geometry: { type: 'Point', coordinates: [1, 2] },
  }).summary.completeness.facts;
  assert.equal(invalidProperties.propertyStats, 'partial');
  assert.equal(invalidProperties.vertexCount, 'complete');
  assert.equal(invalidProperties.idStats, 'complete');

  const invalidGeometry = inspect({
    type: 'Feature',
    id: 'a',
    properties: { x: 1 },
    geometry: { type: 'Point', coordinates: null },
  }).summary.completeness.facts;
  assert.equal(invalidGeometry.vertexCount, 'partial');
  assert.equal(invalidGeometry.propertyStats, 'complete');
  assert.equal(invalidGeometry.idStats, 'complete');

  const invalidId = inspect({
    type: 'Feature',
    id: null,
    properties: { x: 1 },
    geometry: { type: 'Point', coordinates: [1, 2] },
  }).summary.completeness.facts;
  assert.equal(invalidId.idStats, 'partial');
  assert.equal(invalidId.propertyStats, 'complete');
  assert.equal(invalidId.vertexCount, 'complete');
});

test('malformed bbox affects document validity but not derived facts', () => {
  const cases: JsonValue[] = [
    { type: 'Point', coordinates: [1, 2], bbox: null },
    { type: 'Point', coordinates: [1, 2], bbox: [0, 1] },
    { type: 'Point', coordinates: [1, 2], bbox: [0, 1, 2, '3'] },
    { type: 'Point', coordinates: [1, 2], bbox: [0, 1, 2, 3, 4] },
  ];
  for (const value of cases) {
    const { summary, diagnostics } = inspect(value);
    assert.equal(diagnostics.diagnostics[0]?.code, 'geojson/invalid-bbox');
    assert.equal(summary.completeness.document, 'partial');
    for (const fact of allFacts) {
      assert.equal(summary.completeness.facts[fact], 'complete');
    }
  }
  for (const bbox of [
    [0, 1, 2, 3],
    [0, 1, 2, 3, 4, 5],
  ]) {
    assert.equal(
      inspect({ type: 'Point', coordinates: [1, 2], bbox }).diagnostics
        .errorCount,
      0,
    );
  }
});

test('requirements keep unrequested damaged facts not-computed', () => {
  const document: JsonValue = {
    type: 'Feature',
    properties: [],
    geometry: { type: 'Point', coordinates: [1, 2] },
  };
  const vertexOnly = inspect(document, ['vertexCount']).summary.completeness
    .facts;
  assert.equal(vertexOnly.vertexCount, 'complete');
  assert.equal(vertexOnly.propertyStats, 'not-computed');

  const propertyOnly = inspect(
    {
      type: 'Feature',
      properties: { x: 1 },
      geometry: { type: 'Point', coordinates: [1] },
    },
    ['propertyStats'],
  ).summary.completeness.facts;
  assert.equal(propertyOnly.propertyStats, 'complete');
  assert.equal(propertyOnly.vertexCount, 'not-computed');
  assert.equal(propertyOnly.derivedExtent, 'not-computed');
});

test('diagnostic caps retain bounded details without changing recovery', async () => {
  const coordinates: JsonValue[] = [];
  for (let index = 0; index < 12; index += 1) coordinates.push([index]);
  coordinates.push([20, 21]);
  const result = await lintGeoJSON(
    { type: 'MultiPoint', coordinates },
    {
      config: {
        diagnostics: { maxPerCodePerFile: 2, maxPerFile: 2 },
      },
    },
  );
  assert.equal(result.diagnostics.length, 2);
  assert.equal(result.errorCount, 12);
  assert.deepEqual(result.suppressedDiagnostics, [
    {
      code: 'geojson/invalid-position',
      severity: 'error',
      suppressedCount: 10,
    },
  ]);
  assert.equal(result.summary?.totalVertices, 1);
  assert.equal(result.summary?.completeness.facts.vertexCount, 'partial');
});

test('diagnostic limits do not change traversal or lazy valid-position paths', () => {
  const instrumentation: ScanInstrumentation = {
    coordinateTraversals: 0,
    positionVisits: 0,
    coordinatePathMaterializations: 0,
  };
  const diagnostics = new DiagnosticCollector('<structural>', {
    maxPerCodePerFile: 1,
    maxPerFile: 1,
  });
  const summary = scanGeoJSON(
    {
      type: 'MultiPoint',
      coordinates: [[0], [1], [2], [3, 4]],
    },
    {
      filePath: '<structural>',
      diagnostics,
      instrumentation,
      requirements: createExecutionRequirements({ facts: ['vertexCount'] }),
    },
  );
  assert.equal(summary.totalVertices, 1);
  assert.equal(diagnostics.errorCount, 3);
  assert.equal(instrumentation.coordinateTraversals, 1);
  assert.equal(instrumentation.positionVisits, 1);
  assert.equal(instrumentation.coordinatePathMaterializations, 3);
});

test('skipped-policy records distinguish incomplete facts from a pass', () => {
  const completeness: FileSummary['completeness'] = inspect(
    { type: 'Point', coordinates: [1] },
    ['vertexCount', 'derivedExtent'],
  ).summary.completeness;
  assert.deepEqual(
    skipPolicyForIncompleteFacts({
      code: 'budget/max-vertices',
      source: 'budget',
      requiredFacts: ['vertexCount', 'derivedExtent'],
      completeness,
      configuredSeverity: 'error',
    }),
    {
      code: 'budget/max-vertices',
      source: 'budget',
      reason: 'incomplete-facts',
      requiredFacts: ['vertexCount', 'derivedExtent'],
      incompleteFacts: ['vertexCount', 'derivedExtent'],
      configuredSeverity: 'error',
    },
  );
  assert.equal(
    skipPolicyForIncompleteFacts({
      code: 'rule/example',
      source: 'rule',
      requiredFacts: ['propertyStats'],
      completeness: inspect(
        {
          type: 'Feature',
          properties: { x: 1 },
          geometry: null,
        },
        ['propertyStats'],
      ).summary.completeness,
    }),
    undefined,
  );
});

test('structural diagnostics are stable under object-member reordering', () => {
  const variants: JsonValue[] = [
    {
      type: 'Feature',
      bbox: [],
      id: null,
      properties: [],
      geometry: { coordinates: null, type: 'Point' },
    },
    {
      geometry: { type: 'Point', coordinates: null },
      properties: [],
      id: null,
      bbox: [],
      type: 'Feature',
    },
  ];
  const traces = variants.map((value) => {
    const { summary, diagnostics } = inspect(value);
    return {
      diagnostics: diagnostics.diagnostics.map(({ code, path }) => [
        code,
        path,
      ]),
      completeness: summary.completeness,
    };
  });
  assert.deepEqual(traces[0], traces[1]);
  assert.deepEqual(
    traces[0]?.diagnostics.map(([code]) => code),
    [
      'geojson/invalid-bbox',
      'geojson/invalid-feature-id',
      'geojson/invalid-properties',
      'geojson/invalid-coordinates',
    ],
  );
});

test('new structural members retain own-member semantics', () => {
  const point = JSON.parse('{"type":"Point","coordinates":[1,2]}') as JsonValue;
  Object.setPrototypeOf(point as object, { bbox: [] });
  assert.equal(inspect(point).diagnostics.errorCount, 0);

  const collection = JSON.parse('{"type":"GeometryCollection"}') as JsonValue;
  Object.setPrototypeOf(collection as object, {
    geometries: [{ type: 'Point', coordinates: [1, 2] }],
  });
  const { diagnostics } = inspect(collection);
  assert.equal(diagnostics.diagnostics[0]?.code, 'geojson/invalid-geometry');
  assert.equal(diagnostics.diagnostics[0]?.path, '/geometries');
});
