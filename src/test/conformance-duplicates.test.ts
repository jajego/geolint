import assert from 'node:assert/strict';
import test from 'node:test';

import {
  lintGeoJSON,
  lintGeoJSONTextWithParser,
} from '../engine/lint-input.js';
import {
  createExecutionRequirements,
  type SemanticListener,
} from '../engine/requirements.js';
import {
  IndexedSyntaxError,
  parseIndexedSource,
  type IndexedInstrumentation,
} from '../parser/indexed-source.js';
import { scanGeoJSON, type ScanInstrumentation } from '../scanner/scan.js';
import type { GeoLintConfig } from '../types/config.js';
import {
  assertEquivalentSources,
  assertOrdinaryEquivalence,
} from './conformance-harness.js';

const feature = (members: string): string =>
  `{"type":"Feature",${members},"properties":{},"geometry":null}`;
const geometryFeature = (geometry: string): string =>
  `{"type":"Feature","id":"winner","properties":{"a":1},"geometry":${geometry}}`;

const duplicateCases: readonly [string, string][] = [
  ['root type bad/good', '{"type":"Bad","type":"Point","coordinates":[1,2]}'],
  ['root type good/bad', '{"type":"Point","type":"Bad","coordinates":[1,2]}'],
  [
    'FeatureCollection features bad/good',
    '{"type":"FeatureCollection","features":42,"features":[]}',
  ],
  [
    'FeatureCollection features good/bad',
    '{"type":"FeatureCollection","features":[],"features":42}',
  ],
  [
    'root bbox bad/good',
    '{"type":"Point","bbox":["bad"],"bbox":[0,0,1,1],"coordinates":[1,2]}',
  ],
  [
    'root bbox good/bad',
    '{"type":"Point","bbox":[0,0,1,1],"bbox":["bad"],"coordinates":[1,2]}',
  ],
  ['Feature type bad/good', feature('"type":"Bad","type":"Feature"')],
  ['Feature type good/bad', feature('"type":"Feature","type":"Bad"')],
  ['Feature id three-way', feature('"id":null,"id":"old","id":7')],
  [
    'Feature properties bad/good',
    '{"type":"Feature","properties":42,"properties":{"a":1},"geometry":null}',
  ],
  [
    'Feature properties good/bad',
    '{"type":"Feature","properties":{"a":1},"properties":42,"geometry":null}',
  ],
  [
    'Feature geometry bad/good',
    '{"type":"Feature","properties":{},"geometry":42,"geometry":{"type":"Point","coordinates":[1,2]}}',
  ],
  [
    'Feature geometry good/bad',
    '{"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[1,2]},"geometry":42}',
  ],
  [
    'Feature bbox three-way',
    '{"type":"Feature","bbox":["bad"],"bbox":[0,0],"bbox":[0,0,1,1],"properties":{},"geometry":null}',
  ],
  [
    'Feature bbox good/bad',
    '{"type":"Feature","bbox":[0,0,1,1],"bbox":["bad"],"properties":{},"geometry":null}',
  ],
  [
    'Feature bbox bad/good',
    '{"type":"Feature","bbox":["bad"],"bbox":[0,0,1,1],"properties":{},"geometry":null}',
  ],
  [
    'geometry type bad/good',
    '{"type":"Bad","type":"Point","coordinates":[1,2]}',
  ],
  [
    'geometry type good/bad',
    '{"type":"Point","type":"Bad","coordinates":[1,2]}',
  ],
  [
    'geometry coordinates bad/good',
    '{"type":"Point","coordinates":["bad"],"coordinates":[1,2]}',
  ],
  [
    'geometry coordinates good/bad',
    '{"type":"Point","coordinates":[1,2],"coordinates":["bad"]}',
  ],
  [
    'geometry coordinates three-way',
    '{"type":"Point","coordinates":null,"coordinates":[9],"coordinates":[1,2]}',
  ],
  [
    'GeometryCollection geometries bad/good',
    '{"type":"GeometryCollection","geometries":42,"geometries":[{"type":"Point","coordinates":[1,2]}]}',
  ],
  [
    'GeometryCollection geometries good/bad',
    '{"type":"GeometryCollection","geometries":[{"type":"Point","coordinates":[1,2]}],"geometries":42}',
  ],
  [
    'geometry bbox good/bad',
    '{"type":"Point","coordinates":[1,2],"bbox":[0,0,1,1],"bbox":["bad"]}',
  ],
  [
    'geometry bbox bad/good',
    '{"type":"Point","coordinates":[1,2],"bbox":["bad"],"bbox":[0,0,1,1]}',
  ],
  [
    'escaped semantic names',
    String.raw`{"type":"Bad","\u0074ype":"Point","coordinates":[9],"coord\u0069nates":[1,2]}`,
  ],
  [
    'escaped property names',
    String.raw`{"type":"Feature","properties":{"a":1,"\u0061":2,"a":3},"geometry":null}`,
  ],
];

const richConfig: GeoLintConfig = {
  extends: ['geolint/recommended'],
  rules: {
    'require-feature-id': 'warn',
    'consistent-property-presence': 'warn',
  },
  budgets: {
    featureCount: 0,
    totalVertices: 0,
    feature: { vertices: 0 },
  },
  diagnostics: { maxPerCodePerFile: 2, maxPerFile: 20 },
};

test('source parsers report every decoded duplicate key in source order', async () => {
  const accented = String.fromCharCode(0x00e9);
  const source = `{"type":"Feature","properties":{"${accented}":0,"\\u00e9":1,"a/b":0,"a\\/b":1,"nested":{"a":0,"a":1},"__proto__":0,"__proto__":1},"geometry":null}`;
  const offset = (member: string) =>
    Buffer.byteLength(source.slice(0, source.indexOf(member)), 'utf8');
  const expected = (
    [
      [accented, `/properties/${accented}`, '"\\u00e9":1'],
      ['a/b', '/properties/a~1b', '"a\\/b":1'],
      ['a', '/properties/nested/a', '"a":1'],
      ['__proto__', '/properties/__proto__', '"__proto__":1'],
    ] as const
  ).map(([key, path, member]) => ({
    code: 'json/duplicate-key',
    source: 'parser',
    severity: 'error',
    message: `Duplicate JSON object key "${key}"; later value overrides an earlier value.`,
    filePath: 'map.geojson',
    path,
    byteOffset: offset(member),
    data: { key },
  }));
  const results = await Promise.all(
    (['buffered', 'indexed', 'auto'] as const).map((parser) =>
      lintGeoJSONTextWithParser(source, {
        filename: 'map.geojson',
        config: {},
        parser,
      }),
    ),
  );
  for (const result of results) {
    assert.deepEqual(result.diagnostics, expected);
    assert.equal(result.errorCount, expected.length);
  }
  for (const result of results.slice(1)) {
    const { durationMs: _duration, ...stable } = result;
    const { durationMs: _firstDuration, ...firstStable } = results[0]!;
    void _duration;
    void _firstDuration;
    assert.deepEqual(stable, firstStable);
  }
  const object = await lintGeoJSON(JSON.parse(source), {
    filename: 'map.geojson',
  });
  assert.equal(
    object.diagnostics.some(({ code }) => code === 'json/duplicate-key'),
    false,
  );
});

test('duplicate-key messages safely render hostile decoded names', async () => {
  const keys = ['a"b', 'line\nbreak', 'tab\tkey', 'slash\\key', '\u001b'];
  const source = String.raw`{"type":"Feature","properties":{"a\"b":1,"a\"b":2,"line\nbreak":1,"line\nbreak":2,"tab\tkey":1,"tab\tkey":2,"slash\\key":1,"slash\\key":2,"\u001b":1,"\u001b":2},"geometry":null}`;
  for (const parser of ['buffered', 'indexed'] as const) {
    const result = await lintGeoJSONTextWithParser(source, {
      filename: 'map.geojson',
      config: {},
      parser,
    });
    const diagnostics = result.diagnostics.filter(
      ({ code }) => code === 'json/duplicate-key',
    );
    assert.equal(diagnostics.length, keys.length);
    for (const [index, key] of keys.entries()) {
      const diagnostic = diagnostics[index]!;
      assert.equal(
        diagnostic.message,
        `Duplicate JSON object key ${JSON.stringify(key)}; later value overrides an earlier value.`,
      );
      assert.deepEqual(diagnostic.data, { key });
      assert.equal(diagnostic.message.includes('\n'), false);
      assert.equal(diagnostic.message.includes('\u001b'), false);
    }
  }
});

test('duplicate equality is exact and object-local', async () => {
  const composed = String.fromCharCode(0x00e9);
  const decomposed = `e${String.fromCharCode(0x0301)}`;
  const source = `{"type":"Feature","properties":{"Name":1,"name":2,"${composed}":3,"${decomposed}":4,"constructor":1,"constructor":2,"items":[{"x":1,"x":2},{"x":3}]},"geometry":null}`;
  for (const parser of ['buffered', 'indexed'] as const) {
    const result = await lintGeoJSONTextWithParser(source, {
      filename: 'map.geojson',
      config: {},
      parser,
    });
    assert.deepEqual(
      result.diagnostics.map(({ code, path, data }) => ({ code, path, data })),
      [
        {
          code: 'json/duplicate-key',
          path: '/properties/constructor',
          data: { key: 'constructor' },
        },
        {
          code: 'json/duplicate-key',
          path: '/properties/items/0/x',
          data: { key: 'x' },
        },
      ],
    );
  }
});

test('deep duplicate walking is stack-safe and uses normal suppression', async () => {
  const nested = `${'['.repeat(2_000)}{"x":1,"x":2}${']'.repeat(2_000)}`;
  const deepSource = `{"type":"Feature","properties":{"deep":${nested}},"geometry":null}`;
  const paths: string[] = [];
  for (const parser of ['buffered', 'indexed'] as const) {
    const result = await lintGeoJSONTextWithParser(deepSource, {
      filename: 'map.geojson',
      config: {},
      parser,
    });
    assert.equal(result.errorCount, 1);
    paths.push(result.diagnostics[0]!.path!);
  }
  assert.equal(paths[0], paths[1]);
  assert.equal(paths[0]?.endsWith('/x'), true);

  const repeated = `{"type":"Feature","properties":{${Array.from(
    { length: 10 },
    (_, index) => `"x":${index}`,
  ).join(',')}},"geometry":null}`;
  const limited = await lintGeoJSONTextWithParser(repeated, {
    parser: 'buffered',
    config: { diagnostics: { maxPerCodePerFile: 2, maxPerFile: 2 } },
  });
  assert.equal(limited.errorCount, 9);
  assert.equal(limited.diagnostics.length, 2);
  assert.deepEqual(limited.suppressedDiagnostics, [
    {
      code: 'json/duplicate-key',
      severity: 'error',
      suppressedCount: 7,
    },
  ]);
});

test('duplicate winner matrix matches JSON.parse across all semantic levels', async () => {
  for (let index = 0; index < duplicateCases.length; index += 1) {
    const [fixture, source] = duplicateCases[index]!;
    await assertOrdinaryEquivalence({
      source,
      fixture,
      permutation: index,
      config: richConfig,
    });
  }
});

test('losing duplicate subtrees are semantically invisible', async () => {
  const positions = Array.from(
    { length: 1_000 },
    (_, index) => `[${index % 180},${index % 90}]`,
  ).join(',');
  const cases: readonly [string, string, string][] = [
    [
      'invalid losing properties',
      '{"type":"Feature","id":1,"properties":42,"properties":{"a":1},"geometry":null}',
      '{"type":"Feature","id":1,"properties":{"a":1},"geometry":null}',
    ],
    [
      'invalid losing geometry',
      '{"type":"Feature","id":1,"properties":{"a":1},"geometry":{"type":"Point","coordinates":["bad"]},"geometry":null}',
      '{"type":"Feature","id":1,"properties":{"a":1},"geometry":null}',
    ],
    [
      'huge losing coordinates',
      geometryFeature(
        `{"type":"MultiPoint","coordinates":[${positions}],"coordinates":[[1,2]]}`,
      ),
      geometryFeature('{"type":"MultiPoint","coordinates":[[1,2]]}'),
    ],
    [
      'huge A and B with small C winner',
      geometryFeature(
        `{"type":"MultiPoint","coordinates":[${positions}],"coordinates":[${positions}],"coordinates":[[1,2]]}`,
      ),
      geometryFeature('{"type":"MultiPoint","coordinates":[[1,2]]}'),
    ],
  ];
  for (const [fixture, source, winner] of cases) {
    await assertEquivalentSources(
      { source, fixture, config: richConfig },
      winner,
    );
  }
});

test('duplicate cardinality retains one decoded property winner', () => {
  const occurrences = Array.from(
    { length: 10_000 },
    (_, index) => `"same":${index}`,
  ).join(',');
  const source = `{"type":"Feature","properties":{${occurrences}},"geometry":null}`;
  const values: unknown[] = [];
  const listener: SemanticListener = {
    propertyValue: ({ value }) => values.push(value),
  };
  const requirements = createExecutionRequirements({ listener });
  const instrumentation: IndexedInstrumentation = {
    sourceBytes: 0,
    syntaxValidationMs: 0,
    initialIndexReplayMs: 0,
    indexedObjects: 0,
    winningSpans: 0,
    coordinateSpans: 0,
    sourceBytesReplayed: 0,
  };
  const parsed = parseIndexedSource(source, requirements, instrumentation);
  scanGeoJSON(parsed.value, {
    filePath: 'map.geojson',
    requirements,
    listener,
  });
  assert.deepEqual(values, [9_999]);
  assert.equal(instrumentation.indexedObjects, 2);
  assert.equal(instrumentation.winningSpans, 4);
});

test('huge coordinate duplicates visit only winning Positions', async () => {
  const count = 2_000;
  const huge = Array.from(
    { length: count },
    (_, index) => `[${index % 180},${index % 90}]`,
  ).join(',');
  const cases: readonly [string, number][] = [
    [`"coordinates":[${huge}],"coordinates":[[1,2]]`, 1],
    [`"coordinates":[[1,2]],"coordinates":[${huge}]`, count],
    [
      `"coordinates":[${huge}],"coordinates":[${huge}],"coordinates":[[1,2]]`,
      1,
    ],
  ];
  for (const [members, expected] of cases) {
    let coordinateEvents = 0;
    let lexemeEvents = 0;
    const listener: SemanticListener = {
      coordinate: () => {
        coordinateEvents += 1;
      },
      coordinateLexeme: () => {
        lexemeEvents += 1;
      },
    };
    const requirements = createExecutionRequirements({
      facts: ['vertexCount', 'coordinateDimensionStats', 'derivedExtent'],
      listener,
    });
    const source = geometryFeature(`{"type":"MultiPoint",${members}}`);
    const parsed = parseIndexedSource(source, requirements);
    const instrumentation: ScanInstrumentation = {
      coordinateTraversals: 0,
      positionVisits: 0,
      coordinatePathMaterializations: 0,
      propertyPathMaterializations: 0,
      rawLexemeCollections: 0,
      coordinateLexemeEvents: 0,
    };
    const summary = scanGeoJSON(parsed.value, {
      filePath: 'map.geojson',
      requirements,
      listener,
      instrumentation,
    });
    assert.equal(instrumentation.positionVisits, expected);
    assert.equal(instrumentation.rawLexemeCollections, expected);
    assert.equal(instrumentation.coordinateLexemeEvents, expected);
    assert.equal(coordinateEvents, expected);
    assert.equal(lexemeEvents, expected);
    assert.equal(summary.totalVertices, expected);
    await assertOrdinaryEquivalence({
      fixture: `huge coordinate winner count ${expected}`,
      source,
      config: richConfig,
    });
  }
});

test('syntax errors in would-be losing values prevent all semantics', async () => {
  const validFeature =
    '{"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[1,2]}}';
  const manyFeatures = Array.from({ length: 100 }, () => validFeature).join(
    ',',
  );
  const malformed = [
    '?',
    '{"type":?',
    '{"type":"Point","coordinates":?,"coordinates":[1,2]}',
    '{"type":"Feature","properties":{"nested":?},"properties":{},"geometry":null}',
    `{"type":"FeatureCollection","features":[${manyFeatures},?]}`,
    `${validFeature}?`,
    `${validFeature}{}`,
    `${validFeature}/*comment*/`,
  ];
  for (const source of malformed) {
    let events = 0;
    const listener: SemanticListener = {
      featureStart: () => {
        events += 1;
      },
      coordinate: () => {
        events += 1;
      },
      document: () => {
        events += 1;
      },
    };
    const requirements = createExecutionRequirements({ listener });
    assert.throws(() => {
      const parsed = parseIndexedSource(source, requirements);
      scanGeoJSON(parsed.value, {
        filePath: 'map.geojson',
        requirements,
        listener,
      });
    }, IndexedSyntaxError);
    assert.equal(events, 0);
    for (const parser of ['buffered', 'indexed'] as const) {
      const result = await lintGeoJSONTextWithParser(source, {
        parser,
        config: {},
      });
      assert.deepEqual(
        result.diagnostics.map(({ code }) => code),
        ['parse/invalid-json'],
      );
      assert.equal(result.summary, undefined);
    }
  }
});
