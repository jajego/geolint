import assert from 'node:assert/strict';
import test from 'node:test';

import { createExecutionRequirements } from '../engine/requirements.js';
import { lintGeoJSONText } from '../engine/lint-input.js';
import { parseBufferedJSON } from '../parser/buffered-json.js';
import { jsonPointer } from '../scanner/json-pointer.js';
import { scanGeoJSON, type ScanInstrumentation } from '../scanner/scan.js';
import type {
  CoordinateEvent,
  GeometrySummary,
  JsonValue,
  PropertyEvent,
  PropertyValueEvent,
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

function scan(value: JsonValue, facts = allFacts) {
  return scanGeoJSON(value, {
    filePath: '<test>',
    requirements: createExecutionRequirements({ facts }),
  });
}

function point(coordinates: readonly number[]): JsonValue {
  return { type: 'Point', coordinates: [...coordinates] };
}

test('jsonPointer implements RFC 6901 escaping without treating punctuation specially', () => {
  assert.equal(jsonPointer(), '');
  assert.equal(
    jsonPointer('features', 12, 'properties', 'a/b~c.[]', '雪😀'),
    '/features/12/properties/a~1b~0c.[]/雪😀',
  );
});

test('Feature events use canonical property order and semantic lifecycle order', () => {
  const events: string[] = [];
  const listener = {
    featureStart: ({ path }: { readonly path: string }) =>
      events.push(`start:${path}`),
    property: ({ key, path }: PropertyEvent) =>
      events.push(`property:${key}:${path}`),
    coordinate: ({ path }: CoordinateEvent) =>
      events.push(`coordinate:${path}`),
    geometry: ({ type }: GeometrySummary) => events.push(`geometry:${type}`),
    feature: ({ id }: { readonly id?: string | number }) =>
      events.push(`feature:${id}`),
    document: () => events.push('document'),
  };
  scanGeoJSON(
    {
      geometry: point([1, 2]),
      properties: { z: 1, 'a/b': 2, a: 3 },
      id: 'x',
      type: 'Feature',
    },
    {
      filePath: '<test>',
      listener,
      requirements: createExecutionRequirements({ listener }),
    },
  );

  assert.deepEqual(events, [
    'start:',
    'property:a:/properties/a',
    'property:a/b:/properties/a~1b',
    'property:z:/properties/z',
    'coordinate:/geometry/coordinates',
    'geometry:Point',
    'feature:x',
    'document',
  ]);
});

function shuffled(value: JsonValue, seed: number): JsonValue {
  let state = seed;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const visit = (current: JsonValue): JsonValue => {
    if (Array.isArray(current)) return current.map(visit);
    if (current === null || typeof current !== 'object') return current;
    const entries = Object.entries(current).map(
      ([key, item]) => [key, visit(item)] as const,
    );
    for (let index = entries.length - 1; index > 0; index -= 1) {
      const target = Math.floor(random() * (index + 1));
      [entries[index], entries[target]] = [entries[target]!, entries[index]!];
    }
    return Object.fromEntries(entries) as JsonValue;
  };
  return visit(value);
}

function semanticTrace(value: JsonValue): readonly unknown[] {
  const trace: unknown[] = [];
  const listener = {
    featureStart: (event: { readonly index: number; readonly path: string }) =>
      trace.push(['start', event]),
    property: (event: PropertyEvent) => trace.push(['property', event]),
    coordinate: (event: CoordinateEvent) => trace.push(['coordinate', event]),
    geometry: (event: GeometrySummary) => trace.push(['geometry', event]),
    feature: (event: unknown) => trace.push(['feature', event]),
  };
  const summary = scanGeoJSON(value, {
    filePath: '<test>',
    listener,
    requirements: createExecutionRequirements({ facts: allFacts, listener }),
  });
  return [trace, summary];
}

test('recursive object-member permutations preserve events and summaries', () => {
  const document: JsonValue = {
    type: 'FeatureCollection',
    extra: { z: true, a: false },
    features: [
      {
        type: 'Feature',
        id: 7,
        properties: { z: { nested: 1 }, a: ['x'], 'a/b': null },
        geometry: {
          type: 'GeometryCollection',
          geometries: [point([179, 10, 3]), point([-179, 12, 3, 4])],
        },
      },
    ],
  };
  const expected = semanticTrace(document);
  for (let seed = 1; seed <= 40; seed += 1) {
    assert.deepEqual(
      semanticTrace(shuffled(document, seed)),
      expected,
      `seed ${seed}`,
    );
  }
});

test('duplicate control and arbitrary members expose only their final winning values', async () => {
  const losing = Array.from(
    { length: 2_000 },
    (_, index) => `[${index},${index}]`,
  ).join(',');
  const source = `{
    "type":"FeatureCollection", "type":"FeatureCollection",
    "bbox":[0,0,99,99], "bbox":[0,0,1,1],
    "features":[{"type":"Feature","properties":null,"geometry":null}],
    "features":[{
      "type":"Other", "type":"Feature",
      "id":"loser", "id":"winner",
      "properties":{"a":1,"a":"final"},
      "geometry":{"type":"Point","coordinates":[${losing}],"coordinates":[1,2]},
      "geometry":{"type":"GeometryCollection","geometries":[{"type":"Point","coordinates":[8,9]}],"geometries":[{"type":"Point","coordinates":[3,4]}]}
    }]
  }`;
  const result = await lintGeoJSONText(source, { config: {} });

  assert.equal(result.errorCount, 0);
  assert.equal(result.summary?.featureCount, 1);
  assert.equal(result.summary?.totalVertices, 1);

  const parsed = parseBufferedJSON(source);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const properties: PropertyValueEvent[] = [];
  const coordinates: readonly number[][] = [];
  const ids: (string | number | undefined)[] = [];
  const listener = {
    propertyValue: (event: PropertyValueEvent) => properties.push(event),
    coordinate: ({ values }: CoordinateEvent) =>
      (coordinates as number[][]).push([...values]),
    feature: ({ id }: { readonly id?: string | number }) => ids.push(id),
  };
  const summary = scanGeoJSON(parsed.value, {
    filePath: '<test>',
    listener,
    requirements: createExecutionRequirements({ facts: allFacts, listener }),
  });
  assert.deepEqual(
    properties.map(({ key, value }) => [key, value]),
    [['a', 'final']],
  );
  assert.deepEqual(ids, ['winner']);
  assert.deepEqual(coordinates, [[3, 4]]);
  assert.equal(summary.geometryNodeTypes?.get('Point'), 1);
});

test('all geometry families count vertices, rings, and nested nodes', () => {
  const cases: readonly [JsonValue, number, number, number][] = [
    [point([0, 1]), 1, 0, 1],
    [
      {
        type: 'MultiPoint',
        coordinates: [
          [0, 1],
          [2, 3],
        ],
      },
      2,
      0,
      1,
    ],
    [
      {
        type: 'LineString',
        coordinates: [
          [0, 1],
          [2, 3],
          [4, 5],
        ],
      },
      3,
      0,
      1,
    ],
    [
      {
        type: 'MultiLineString',
        coordinates: [
          [
            [0, 1],
            [2, 3],
          ],
          [[4, 5]],
        ],
      },
      3,
      0,
      1,
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
          [
            [2, 2],
            [2, 2],
          ],
        ],
      },
      5,
      2,
      1,
    ],
    [
      {
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [0, 0],
              [1, 0],
              [0, 0],
            ],
          ],
          [
            [
              [2, 2],
              [3, 2],
              [2, 2],
            ],
          ],
        ],
      },
      6,
      2,
      1,
    ],
    [
      {
        type: 'GeometryCollection',
        geometries: [
          point([0, 1]),
          { type: 'GeometryCollection', geometries: [point([2, 3])] },
        ],
      },
      2,
      0,
      4,
    ],
  ];

  for (const [geometry, vertices, rings, nodes] of cases) {
    const observed: GeometrySummary[] = [];
    const listener = {
      geometry: (summary: GeometrySummary) => {
        observed.push(summary);
      },
    };
    const summary = scanGeoJSON(geometry, {
      filePath: '<test>',
      listener,
      requirements: createExecutionRequirements({ facts: allFacts, listener }),
    });
    const outer = observed[0];
    assert.equal(observed.length, 1);
    assert.equal(summary.totalVertices, vertices);
    assert.equal(outer?.vertices, vertices);
    assert.equal(outer?.ringCount, rings);
    assert.equal(outer?.geometryNodeCount, nodes);
  }
});

test('geometry hook dispatches only the completed outer tree while node facts include children', () => {
  const document: JsonValue = {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'GeometryCollection',
      geometries: [
        point([0, 0]),
        {
          type: 'GeometryCollection',
          geometries: [
            {
              type: 'LineString',
              coordinates: [
                [1, 1],
                [2, 2],
                [3, 3],
              ],
            },
          ],
        },
      ],
    },
  };
  const observed: GeometrySummary[] = [];
  const listener = {
    geometry: (summary: GeometrySummary) => observed.push(summary),
  };
  const summary = scanGeoJSON(document, {
    filePath: '<test>',
    listener,
    requirements: createExecutionRequirements({
      facts: ['geometryStats'],
      listener,
    }),
  });

  assert.equal(observed.length, 1);
  assert.deepEqual(observed[0], {
    type: 'GeometryCollection',
    path: '/geometry',
    vertices: 4,
    ringCount: 0,
    geometryNodeCount: 4,
    coordinateDimensions: 2,
    extent: {
      west: 0,
      east: 3,
      south: 0,
      north: 3,
      crossesAntimeridian: false,
    },
  });
  assert.deepEqual(
    summary.geometryNodeTypes,
    new Map([
      ['GeometryCollection', 2],
      ['Point', 1],
      ['LineString', 1],
    ]),
  );
});

test('local geometry and Feature summaries do not expose document coordinate facts', () => {
  const document: JsonValue = {
    type: 'Feature',
    properties: {},
    geometry: point([1, 2, 3]),
  };
  const geometryEvents: GeometrySummary[] = [];
  const geometryListener = {
    geometry: (summary: GeometrySummary) => geometryEvents.push(summary),
  };
  const geometryFileSummary = scanGeoJSON(document, {
    filePath: '<test>',
    listener: geometryListener,
    requirements: createExecutionRequirements({ listener: geometryListener }),
  });
  const featureEvents: unknown[] = [];
  const featureListener = {
    feature: (summary: unknown) => featureEvents.push(summary),
  };
  const featureFileSummary = scanGeoJSON(document, {
    filePath: '<test>',
    listener: featureListener,
    requirements: createExecutionRequirements({ listener: featureListener }),
  });

  assert.equal(geometryEvents.length, 1);
  assert.equal(geometryEvents[0]?.vertices, 1);
  assert.equal(geometryEvents[0]?.coordinateDimensions, 3);
  assert.equal(featureEvents.length, 1);
  for (const summary of [geometryFileSummary, featureFileSummary]) {
    assert.equal(summary.featureCount, 0);
    assert.equal(summary.totalVertices, 0);
    assert.equal(summary.derivedExtent, undefined);
    assert.equal(summary.coordinateDimensionStats, undefined);
    assert.equal(summary.completeness.facts.featureCount, 'not-computed');
    assert.equal(summary.completeness.facts.vertexCount, 'not-computed');
    assert.equal(
      summary.completeness.facts.coordinateDimensionStats,
      'not-computed',
    );
    assert.equal(summary.completeness.facts.derivedExtent, 'not-computed');
  }
});

test('nested GeometryCollections preserve coordinate array order and exact pointers', () => {
  const paths: string[] = [];
  const document: JsonValue = {
    type: 'GeometryCollection',
    geometries: [
      point([0, 0]),
      {
        type: 'GeometryCollection',
        geometries: [point([1, 1]), point([2, 2])],
      },
    ],
  };
  const listener = {
    coordinate: ({ path }: CoordinateEvent) => paths.push(path),
  };
  scanGeoJSON(document, {
    filePath: '<test>',
    listener,
    requirements: createExecutionRequirements({ listener }),
  });
  assert.deepEqual(paths, [
    '/geometries/0/coordinates',
    '/geometries/1/geometries/0/coordinates',
    '/geometries/1/geometries/1/coordinates',
  ]);
});

test('2D, 3D, 4D+ and mixed dimensions preserve every ordinate', () => {
  const observed: readonly number[][] = [];
  const listener = {
    coordinate: ({ values }: CoordinateEvent) =>
      (observed as number[][]).push([...values]),
  };
  const summary = scanGeoJSON(
    {
      type: 'MultiPoint',
      coordinates: [
        [1, 2],
        [3, 4, 5],
        [6, 7, 8, 9, 10],
      ],
    },
    {
      filePath: '<test>',
      listener,
      requirements: createExecutionRequirements({
        facts: ['coordinateDimensionStats'],
        listener,
      }),
    },
  );
  assert.deepEqual(observed, [
    [1, 2],
    [3, 4, 5],
    [6, 7, 8, 9, 10],
  ]);
  assert.deepEqual(summary.coordinateDimensionStats, {
    two: 1,
    three: 1,
    fourOrMore: 1,
  });
});

test('facts remain absent and not-computed unless requested', () => {
  const document: JsonValue = {
    type: 'Feature',
    id: 'a',
    properties: { x: 1 },
    geometry: point([1, 2]),
  };
  const none = scan(document, []);
  assert.equal(none.completeness.facts.vertexCount, 'not-computed');
  assert.equal(none.totalVertices, 0);
  assert.equal(none.propertyStats, undefined);
  assert.equal(none.derivedExtent, undefined);

  const vertices = scan(document, ['vertexCount']);
  assert.equal(vertices.totalVertices, 1);
  assert.equal(vertices.propertyStats, undefined);
  assert.equal(vertices.derivedExtent, undefined);
  assert.equal(
    vertices.completeness.facts.coordinateDimensionStats,
    'not-computed',
  );

  const properties = scan(document, ['propertyStats']);
  assert.equal(properties.completeness.facts.vertexCount, 'not-computed');
  assert.equal(properties.propertyStats?.get('x')?.present, 1);

  const extent = scan(document, ['derivedExtent']);
  assert.equal(extent.completeness.facts.vertexCount, 'not-computed');
  assert.equal(
    extent.completeness.facts.coordinateDimensionStats,
    'not-computed',
  );
  assert.deepEqual(extent.derivedExtent, {
    west: 1,
    east: 1,
    south: 2,
    north: 2,
    crossesAntimeridian: false,
  });
});

test('multiple coordinate facts share one traversal of each winning coordinate tree', () => {
  const document: JsonValue = {
    type: 'MultiPolygon',
    coordinates: [
      [
        [
          [0, 0],
          [1, 0],
          [0, 0],
        ],
      ],
    ],
  };
  const one: ScanInstrumentation = {
    coordinateTraversals: 0,
    positionVisits: 0,
    coordinatePathMaterializations: 0,
  };
  const many: ScanInstrumentation = {
    coordinateTraversals: 0,
    positionVisits: 0,
    coordinatePathMaterializations: 0,
  };
  const geometryEvents: GeometrySummary[] = [];
  const coordinatePaths: string[] = [];
  const listener = {
    geometry: (summary: GeometrySummary) => geometryEvents.push(summary),
    coordinate: ({ path }: CoordinateEvent) => coordinatePaths.push(path),
  };
  scanGeoJSON(document, {
    filePath: '<test>',
    instrumentation: one,
    requirements: createExecutionRequirements({ facts: ['vertexCount'] }),
  });
  scanGeoJSON(document, {
    filePath: '<test>',
    instrumentation: many,
    listener,
    requirements: createExecutionRequirements({
      facts: ['vertexCount', 'coordinateDimensionStats', 'derivedExtent'],
      listener,
    }),
  });
  assert.deepEqual(one, {
    coordinateTraversals: 1,
    positionVisits: 3,
    coordinatePathMaterializations: 0,
  });
  assert.deepEqual(many, {
    coordinateTraversals: 1,
    positionVisits: 3,
    coordinatePathMaterializations: 3,
  });
  assert.equal(geometryEvents.length, 1);
  assert.equal(geometryEvents[0]?.vertices, 3);
  assert.deepEqual(coordinatePaths, [
    '/coordinates/0/0/0',
    '/coordinates/0/0/1',
    '/coordinates/0/0/2',
  ]);
});

test('large vertex-only traversal does not materialize position pointers', () => {
  const coordinates = Array.from({ length: 10_000 }, (_, index) => [
    index,
    index,
  ]);
  const instrumentation: ScanInstrumentation = {
    coordinateTraversals: 0,
    positionVisits: 0,
    coordinatePathMaterializations: 0,
  };
  const summary = scanGeoJSON(
    { type: 'MultiPoint', coordinates },
    {
      filePath: '<test>',
      instrumentation,
      requirements: createExecutionRequirements({ facts: ['vertexCount'] }),
    },
  );
  assert.equal(summary.totalVertices, 10_000);
  assert.deepEqual(instrumentation, {
    coordinateTraversals: 1,
    positionVisits: 10_000,
    coordinatePathMaterializations: 0,
  });
});

test('property, geometry, id, null, dimension, and extent facts are reusable', () => {
  const summary = scan({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 1,
        properties: { a: 1 },
        geometry: point([179, -5]),
      },
      { type: 'Feature', id: 1, properties: null, geometry: point([-179, 7]) },
      { type: 'Feature', properties: { a: 'x', b: true }, geometry: null },
    ],
  });
  assert.deepEqual(summary.ids, {
    present: 2,
    missing: 1,
    duplicateCount: 1,
    stringCount: 0,
    numberCount: 2,
  });
  assert.deepEqual(summary.propertyStats?.get('a'), {
    present: 2,
    missing: 1,
    types: new Map([
      ['number', 1],
      ['string', 1],
    ]),
  });
  assert.deepEqual(summary.propertyStats?.get('b'), {
    present: 1,
    missing: 2,
    types: new Map([['boolean', 1]]),
  });
  assert.equal(summary.nullGeometryCount, 1);
  assert.deepEqual(summary.derivedExtent, {
    west: 179,
    east: -179,
    south: -5,
    north: 7,
    crossesAntimeridian: true,
  });
});

test('repeated semantic executions are deeply deterministic', () => {
  const document: JsonValue = {
    type: 'Feature',
    properties: { b: 2, a: 1 },
    geometry: point([1, 2, 3]),
  };
  const expected = semanticTrace(document);
  for (let run = 0; run < 20; run += 1)
    assert.deepEqual(semanticTrace(document), expected);
});

test('buffered semantic scanning observes only own root geometry members', () => {
  const value = JSON.parse('{}') as JsonValue;
  Object.setPrototypeOf(value as object, {
    type: 'Point',
    coordinates: [1, 2],
  });
  const coordinates: CoordinateEvent[] = [];
  const geometries: GeometrySummary[] = [];
  const listener = {
    coordinate: (event: CoordinateEvent) => coordinates.push(event),
    geometry: (summary: GeometrySummary) => geometries.push(summary),
  };

  assert.throws(() =>
    scanGeoJSON(value, {
      filePath: '<test>',
      listener,
      requirements: createExecutionRequirements({
        facts: ['vertexCount'],
        listener,
      }),
    }),
  );
  assert.deepEqual(coordinates, []);
  assert.deepEqual(geometries, []);
});

test('inherited FeatureCollection, Feature ID, properties, and geometry members stay absent', () => {
  const collection = JSON.parse('{"type":"FeatureCollection"}') as JsonValue;
  Object.setPrototypeOf(collection as object, {
    features: [{ type: 'Feature', properties: {}, geometry: point([1, 2]) }],
  });
  const starts: number[] = [];
  const collectionListener = {
    featureStart: ({ index }: { readonly index: number }) => starts.push(index),
  };
  assert.throws(() =>
    scanGeoJSON(collection, {
      filePath: '<test>',
      listener: collectionListener,
      requirements: createExecutionRequirements({
        listener: collectionListener,
      }),
    }),
  );
  assert.deepEqual(starts, []);

  const feature = JSON.parse(
    '{"type":"Feature","properties":{},"geometry":null}',
  ) as JsonValue;
  Object.setPrototypeOf(feature as object, { id: 'inherited-id' });
  let observedId: string | number | undefined;
  const featureListener = {
    feature: ({ id }: { readonly id?: string | number }) => {
      observedId = id;
    },
  };
  const featureSummary = scanGeoJSON(feature, {
    filePath: '<test>',
    listener: featureListener,
    requirements: createExecutionRequirements({
      facts: ['idStats'],
      listener: featureListener,
    }),
  });
  assert.equal(observedId, undefined);
  assert.deepEqual(featureSummary.ids, {
    present: 0,
    missing: 1,
    duplicateCount: 0,
    stringCount: 0,
    numberCount: 0,
  });

  const missingProperties = JSON.parse(
    '{"type":"Feature","geometry":null}',
  ) as JsonValue;
  Object.setPrototypeOf(missingProperties as object, {
    properties: { inherited: true },
  });
  const properties: PropertyEvent[] = [];
  const propertyListener = {
    property: (event: PropertyEvent) => properties.push(event),
  };
  assert.throws(() =>
    scanGeoJSON(missingProperties, {
      filePath: '<test>',
      listener: propertyListener,
      requirements: createExecutionRequirements({ listener: propertyListener }),
    }),
  );
  assert.deepEqual(properties, []);

  const missingGeometry = JSON.parse(
    '{"type":"Feature","properties":{}}',
  ) as JsonValue;
  Object.setPrototypeOf(missingGeometry as object, { geometry: point([1, 2]) });
  const coordinates: CoordinateEvent[] = [];
  const geometryListener = {
    coordinate: (event: CoordinateEvent) => coordinates.push(event),
  };
  assert.throws(() =>
    scanGeoJSON(missingGeometry, {
      filePath: '<test>',
      listener: geometryListener,
      requirements: createExecutionRequirements({
        facts: ['vertexCount'],
        listener: geometryListener,
      }),
    }),
  );
  assert.deepEqual(coordinates, []);
});

test('inherited control getters are never invoked and own members still win', () => {
  let invoked = false;
  const inheritedGetter = Object.defineProperty({}, 'type', {
    get: () => {
      invoked = true;
      throw new Error('inherited getter must not run');
    },
  });
  const absent = JSON.parse('{}') as JsonValue;
  Object.setPrototypeOf(absent as object, inheritedGetter);
  assert.throws(() =>
    scanGeoJSON(absent, {
      filePath: '<test>',
      requirements: createExecutionRequirements(),
    }),
  );
  assert.equal(invoked, false);

  const pointValue = JSON.parse(
    '{"type":"Point","coordinates":[10,20]}',
  ) as JsonValue;
  Object.setPrototypeOf(pointValue as object, {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [1, 0],
        [0, 0],
      ],
    ],
  });
  const geometries: GeometrySummary[] = [];
  const listener = {
    geometry: (summary: GeometrySummary) => geometries.push(summary),
  };
  const summary = scanGeoJSON(pointValue, {
    filePath: '<test>',
    listener,
    requirements: createExecutionRequirements({
      facts: ['vertexCount'],
      listener,
    }),
  });
  assert.equal(summary.totalVertices, 1);
  assert.equal(geometries[0]?.type, 'Point');
  assert.deepEqual(geometries[0]?.path, '');
});

test('JSON.parse values ignore Object.prototype control members without invoking getters', () => {
  const previousType = Object.getOwnPropertyDescriptor(
    Object.prototype,
    'type',
  );
  const previousCoordinates = Object.getOwnPropertyDescriptor(
    Object.prototype,
    'coordinates',
  );
  let invoked = false;
  try {
    Object.defineProperty(Object.prototype, 'type', {
      configurable: true,
      get: () => {
        invoked = true;
        throw new Error('inherited getter must not run');
      },
    });
    Object.defineProperty(Object.prototype, 'coordinates', {
      configurable: true,
      value: [1, 2],
    });

    const events: CoordinateEvent[] = [];
    const listener = {
      coordinate: (event: CoordinateEvent) => events.push(event),
    };
    assert.throws(() =>
      scanGeoJSON(JSON.parse('{}') as JsonValue, {
        filePath: '<test>',
        listener,
        requirements: createExecutionRequirements({
          facts: ['vertexCount'],
          listener,
        }),
      }),
    );
    assert.equal(invoked, false);
    assert.deepEqual(events, []);
  } finally {
    if (previousType)
      Object.defineProperty(Object.prototype, 'type', previousType);
    else delete (Object.prototype as { type?: unknown }).type;
    if (previousCoordinates) {
      Object.defineProperty(
        Object.prototype,
        'coordinates',
        previousCoordinates,
      );
    } else {
      delete (Object.prototype as { coordinates?: unknown }).coordinates;
    }
  }
});
