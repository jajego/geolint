import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  lintFile,
  lintFileWithParser,
  lintGeoJSONText,
  lintGeoJSONTextWithParser,
} from '../engine/lint-input.js';
import { GeoLintCapabilityError } from '../engine/errors.js';
import {
  createExecutionRequirements,
  type SemanticListener,
} from '../engine/requirements.js';
import {
  parseIndexedSource,
  type IndexedInstrumentation,
} from '../parser/indexed-source.js';
import { createBaseline, serializeBaseline } from '../regression/schema.js';
import { snapshotBaseline } from '../regression/snapshot.js';
import { scanGeoJSON, type ScanInstrumentation } from '../scanner/scan.js';
import type { GeoLintConfig } from '../types/config.js';
import type { FileLintResult, JsonValue } from '../types/semantic.js';

function stable(result: FileLintResult) {
  const { durationMs, ...value } = result;
  void durationMs;
  return value;
}

async function assertParity(
  source: string,
  config: GeoLintConfig | string = {},
) {
  const buffered = await lintGeoJSONTextWithParser(source, {
    config,
    parser: 'buffered',
  });
  const indexed = await lintGeoJSONTextWithParser(source, {
    config,
    parser: 'indexed',
  });
  assert.deepEqual(stable(indexed), stable(buffered));
}

function nestedArray(depth: number, value = '0'): string {
  return `${'['.repeat(depth)}${value}${']'.repeat(depth)}`;
}

function nestedObject(depth: number, value = '0'): string {
  return `${'{"x":'.repeat(depth)}${value}${'}'.repeat(depth)}`;
}

function mixedNesting(depth: number): string {
  const openings = Array.from({ length: depth }, (_, index) =>
    index % 2 === 0 ? '[' : '{"x":',
  );
  const closings = openings
    .toReversed()
    .map((opening) => (opening === '[' ? ']' : '}'));
  return `${openings.join('')}0${closings.join('')}`;
}

function internalScan(
  source: string,
  listener: SemanticListener,
  featureByteSpans = false,
) {
  const requirements = createExecutionRequirements({
    listener,
    featureByteSpans,
  });
  const indexed = parseIndexedSource(source, requirements);
  return scanGeoJSON(indexed.value, {
    filePath: 'map.geojson',
    requirements,
    listener,
    sourceBytes: indexed.sourceBytes,
  });
}

test('forced indexed and buffered strategies preserve ordinary semantics', async () => {
  const sources = [
    '{"type":"Point","coordinates":[1,2]}',
    '{"coordinates":[[0,0],[1,1]],"type":"LineString"}',
    '{"type":"Feature","properties":{"b":2,"a":1},"geometry":null}',
    '{"type":"FeatureCollection","features":[{"type":"Feature","id":1,"properties":{"a":1},"geometry":{"type":"Point","coordinates":[0,0]}}]}',
    '{"type":"FeatureCollection","features":[{"type":"Feature","properties":42,"geometry":null},{"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[0]}}]}',
    '{"type":"Point","coordinates":["loser"],"coordinates":[1,2]}',
    '{"type":"Point","coordinates":[1,2],"coordinates":["winner"]}',
    '{"type":"FeatureCollection","features":[],"features":[{"type":"Feature","properties":{},"geometry":null}]}',
  ];
  for (const source of sources) await assertParity(source);
});

test('bounded member-order permutations preserve cross-strategy results', async () => {
  let seed = 0x5eed;
  const random = () => {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
    return seed;
  };
  const original = [
    '"bbox":[0,0,1,1]',
    '"geometry":{"coordinates":[1,2],"type":"Point"}',
    '"properties":{"z":1,"a":2,"z":3}',
    '"id":1',
    '"type":"Feature"',
  ];
  for (let run = 0; run < 20; run += 1) {
    const members = [...original];
    for (let index = members.length - 1; index > 0; index -= 1) {
      const other = random() % (index + 1);
      [members[index], members[other]] = [members[other]!, members[index]!];
    }
    await assertParity(`{${members.join(',')}}`, {
      extends: ['geolint/recommended'],
    });
  }
});

test('all geometry families and nested collections have indexed parity', async () => {
  const geometries: JsonValue[] = [
    { type: 'Point', coordinates: [0, 0] },
    {
      type: 'MultiPoint',
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    },
    {
      type: 'LineString',
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    },
    {
      type: 'MultiLineString',
      coordinates: [
        [
          [0, 0],
          [1, 1],
        ],
      ],
    },
    {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    },
    {
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      ],
    },
    {
      type: 'GeometryCollection',
      geometries: [
        { type: 'Point', coordinates: [0, 0] },
        {
          type: 'GeometryCollection',
          geometries: [
            {
              type: 'LineString',
              coordinates: [
                [0, 0],
                [1, 1],
              ],
            },
          ],
        },
      ],
    },
  ];
  for (const geometry of geometries) {
    const source = JSON.stringify(geometry);
    await assertParity(source, {
      extends: ['geolint/recommended'],
    });
    await assertParity(source.replace('{', '{"type":"Bad",'));
    const malformed = {
      ...(geometry as Record<string, JsonValue>),
      bbox: ['bad'],
    };
    await assertParity(JSON.stringify(malformed));
    await assertParity(
      JSON.stringify(
        (geometry as Record<string, JsonValue>).type === 'GeometryCollection'
          ? { type: 'GeometryCollection', geometries: [null] }
          : {
              type: (geometry as Record<string, JsonValue>).type,
              coordinates: null,
            },
      ),
    );
  }
});

test('indexed property values retain JSON.parse semantics and pointer ordering', () => {
  const events: { key: string; path: string; value: JsonValue }[] = [];
  const source = String.raw`{"type":"Feature","properties":{"~":1,"/":2,".":3,"[x]":4,"é":5,"\u00e9":6,"meta":{"a":1,"a":2}},"geometry":null}`;
  internalScan(source, {
    propertyValue(event) {
      events.push({ key: event.key, path: event.path, value: event.value });
    },
  });
  assert.deepEqual(
    events.map(({ key, path }) => [key, path]),
    [
      ['.', '/properties/.'],
      ['/', '/properties/~1'],
      ['[x]', '/properties/[x]'],
      ['meta', '/properties/meta'],
      ['~', '/properties/~0'],
      ['é', '/properties/é'],
    ],
  );
  assert.deepEqual(events.find(({ key }) => key === 'meta')?.value, { a: 2 });
  assert.equal(events.find(({ key }) => key === 'é')?.value, 6);
});

test('indexed winners collapse decoded duplicate keys before any hooks', () => {
  const events: string[] = [];
  const source = String.raw`{
    "type":"FeatureCollection",
    "features":[{"type":"Feature","properties":{"losing":1},"geometry":{"type":"Point","coordinates":[9,9]}}],
    "features":[{
      "geometry":{"type":"Point","coordinates":["bad"],"coordinates":[1.0000000,2]},
      "properties":{"b":2,"a":1,"\u0061":3},
      "id":"old","id":"new","type":"Feature"
    }]
  }`;
  internalScan(source, {
    featureStart: () => events.push('start'),
    property: ({ key }) => events.push(`property:${key}`),
    propertyValue: ({ key, value }) => events.push(`value:${key}:${value}`),
    coordinate: ({ values }) => events.push(`coordinate:${values.join(',')}`),
    coordinateLexeme: ({ rawValues }) =>
      events.push(`lexeme:${rawValues.join(',')}`),
    geometry: () => events.push('geometry'),
    feature: ({ id }) => events.push(`feature:${id}`),
  });
  assert.deepEqual(events, [
    'start',
    'property:a',
    'value:a:3',
    'property:b',
    'value:b:2',
    'coordinate:1,2',
    'lexeme:1.0000000,2',
    'geometry',
    'feature:new',
  ]);
});

test('duplicate winner parity covers every relevant semantic member', async () => {
  const sources = [
    '{"type":"Bad","type":"Point","coordinates":[0,0]}',
    '{"type":"FeatureCollection","features":42,"features":[]}',
    '{"type":"FeatureCollection","bbox":["bad"],"bbox":[0,0,1,1],"features":[]}',
    '{"type":"FeatureCollection","features":[{"type":"Bad","type":"Feature","id":"old","id":"new","properties":42,"properties":{},"geometry":42,"geometry":null,"bbox":["bad"],"bbox":[0,0,1,1]}]}',
    '{"type":"FeatureCollection","features":[{"type":"Feature","properties":{},"geometry":{"type":"Bad","type":"Point","coordinates":["bad"],"coordinates":[0,0],"bbox":["bad"],"bbox":[0,0,1,1]}}]}',
    '{"type":"GeometryCollection","geometries":42,"geometries":[{"type":"Point","coordinates":[0,0]}]}',
    String.raw`{"type":"Feature","properties":{"a":1,"\u0061":2},"geometry":null}`,
  ];
  for (const source of sources) await assertParity(source);
});

test('indexed syntax validation is fatal before semantic execution', async () => {
  for (const source of [
    '{"type":"Point","coordinates":[0,0],"losing":}',
    '{"type":"Point","coordinates":[0,0],}',
    '[01]',
    '[NaN]',
    '[Infinity]',
    '[+1]',
    '[1.]',
    '[.5]',
    "['x']",
    '/* comment */ []',
  ]) {
    const result = await lintGeoJSONTextWithParser(source, {
      parser: 'indexed',
      config: {},
    });
    assert.deepEqual(
      result.diagnostics.map(({ code }) => code),
      ['parse/invalid-json'],
    );
    assert.equal(result.summary, undefined);
  }
});

test('indexed syntax traversal is stack-safe for deeply nested valid JSON', async () => {
  const values = [
    nestedArray(20_000),
    nestedObject(10_000),
    mixedNesting(12_000),
  ];
  for (const value of values) {
    const source = `{"type":"Feature","properties":{"deep":${value}},"geometry":null}`;
    await assertParity(source);
  }

  const losing = `{"type":"Feature","properties":{"deep":${nestedArray(10_000)},"deep":0},"geometry":null}`;
  const winning = `{"type":"Feature","properties":{"deep":0,"deep":${nestedObject(10_000)}},"geometry":null}`;
  await assertParity(losing);
  await assertParity(winning);

  let losingValue: JsonValue | undefined;
  internalScan(losing, {
    propertyValue(event) {
      losingValue = event.value;
    },
  });
  assert.equal(losingValue, 0);
  let winningValue: JsonValue | undefined;
  internalScan(winning, {
    propertyValue(event) {
      winningValue = event.value;
    },
  });
  assert.equal(typeof winningValue, 'object');
});

test('deep malformed JSON reports parse/invalid-json without stack errors', async () => {
  const malformed = [
    nestedArray(12_000).slice(0, -1),
    nestedObject(12_000).slice(0, -1),
    nestedArray(12_000, '?'),
    `{"type":"Feature","properties":{"deep":${nestedArray(10_000, '?')},"deep":0},"geometry":null}`,
    `{"type":"Feature","properties":{"deep":0,"deep":${nestedObject(10_000, '?')}},"geometry":null}`,
  ];
  for (const source of malformed) {
    const result = await lintGeoJSONTextWithParser(source, {
      parser: 'indexed',
      config: {},
    });
    assert.deepEqual(
      result.diagnostics.map(({ code }) => code),
      ['parse/invalid-json'],
    );
    assert.equal(result.summary, undefined);
  }
});

test('coordinate precision uses exact lexemes, all ordinates, and lazy diagnostics', async () => {
  const source =
    '{"type":"MultiPoint","coordinates":[[1e-7,1.230000e2],[-0.000000,1.2e3],[1,1.0,1.0000000],[1.20e-2,-2]]}';
  const result = await lintGeoJSONText(source, {
    config: {
      rules: { 'coordinate-precision': ['error', { maximumDecimals: 6 }] },
      diagnostics: { maxPerCodePerFile: 2, maxPerFile: 2 },
    },
  });
  assert.equal(result.errorCount, 2);
  assert.equal(result.diagnostics.length, 2);
  assert.deepEqual(result.suppressedDiagnostics, []);
  assert.deepEqual(result.diagnostics[0]?.data, {
    maximumDecimals: 6,
    maximumObserved: 7,
    offendingToken: '1e-7',
  });
  assert.deepEqual(result.diagnostics[1]?.data, {
    maximumDecimals: 6,
    maximumObserved: 7,
    offendingToken: '1.0000000',
  });

  const huge = await lintGeoJSONText(
    '{"type":"Point","coordinates":[1e-999999999999999999999,0]}',
    { config: { rules: { 'coordinate-precision': 'error' } } },
  );
  assert.equal(
    huge.diagnostics[0]?.data?.maximumObserved,
    Number.MAX_SAFE_INTEGER,
  );

  const many = await lintGeoJSONText(
    `{"type":"MultiPoint","coordinates":[${Array.from({ length: 1_000 }, () => '[1.1,2]').join(',')}]}`,
    {
      config: {
        rules: {
          'coordinate-precision': ['error', { maximumDecimals: 0 }],
        },
        diagnostics: { maxPerCodePerFile: 2, maxPerFile: 2 },
      },
    },
  );
  assert.equal(many.errorCount, 1_000);
  assert.equal(many.diagnostics.length, 2);
  assert.equal(many.suppressedDiagnostics[0]?.suppressedCount, 998);
});

test('indexed UTF-8 offsets and raw numeric spelling are exact', () => {
  const source =
    '{\r\n"type":"Feature","properties":{"café":"🗺️","escaped":"\\u00e9"},"geometry":{"type":"Point","coordinates":[181,-0.000000,1E+04]}}';
  let observed:
    | { readonly rawValues: readonly string[]; readonly byteOffset?: number }
    | undefined;
  internalScan(source, {
    coordinateLexeme(event) {
      observed = event;
    },
  });
  const characterOffset = source.indexOf('[181');
  assert.deepEqual(observed?.rawValues, ['181', '-0.000000', '1E+04']);
  assert.equal(
    observed?.byteOffset,
    Buffer.byteLength(source.slice(0, characterOffset), 'utf8'),
  );
});

test('indexed numeric values match JSON.parse including negative zero', () => {
  let values: readonly number[] = [];
  let rawValues: readonly string[] = [];
  internalScan('{"type":"Point","coordinates":[-0,1e3,1E-3,1.230000e2]}', {
    coordinateLexeme(event) {
      values = event.values;
      rawValues = event.rawValues;
    },
  });
  assert.equal(Object.is(values[0], -0), true);
  assert.deepEqual(values.slice(1), [1_000, 0.001, 123]);
  assert.deepEqual(rawValues, ['-0', '1e3', '1E-3', '1.230000e2']);
});

test('Feature byte spans exclude surrounding whitespace and enforce exact boundaries', async () => {
  const feature =
    '{ "type":"Feature", "properties":{"label":"é"}, "geometry":null }';
  const source = ` \n[${feature},\r\n${feature}] `;
  const root = `{"type":"FeatureCollection","features":${source.trim()}}`;
  const exact = Buffer.byteLength(feature, 'utf8');
  const atLimit = await lintGeoJSONText(root, {
    config: { budgets: { feature: { bytes: `${exact}B` } } },
  });
  assert.equal(atLimit.errorCount, 0);
  assert.equal(atLimit.summary?.largestFeatureBytes, exact);
  assert.equal(
    atLimit.summary?.completeness.facts.featureByteStats,
    'complete',
  );
  const compactFeature =
    '{"type":"Feature","properties":{"label":"é"},"geometry":null}';
  const compact = await lintGeoJSONText(compactFeature, {
    config: { budgets: { feature: { bytes: '1KB' } } },
  });
  assert.equal(
    compact.summary?.largestFeatureBytes,
    Buffer.byteLength(compactFeature, 'utf8'),
  );
  assert.notEqual(compact.summary?.largestFeatureBytes, exact);

  const over = await lintGeoJSONText(root, {
    config: { budgets: { feature: { bytes: `${exact - 1}B` } } },
  });
  assert.equal(over.errorCount, 2);
  assert.deepEqual(over.diagnostics[0]?.data, {
    actual: exact,
    limit: exact - 1,
  });

  const bare = ` \r\n${feature}\n `;
  const bareResult = await lintGeoJSONText(bare, {
    config: { budgets: { feature: { bytes: `${exact}B` } } },
  });
  assert.equal(bareResult.summary?.largestFeatureBytes, exact);

  let startByte: number | undefined;
  let summaryBytes: number | undefined;
  internalScan(
    root,
    {
      featureStart(event) {
        if (startByte === undefined) startByte = event.byteOffset;
      },
      feature(summary) {
        summaryBytes = summary.bytes;
      },
    },
    true,
  );
  const firstFeature = root.indexOf(feature);
  assert.equal(
    startByte,
    Buffer.byteLength(root.slice(0, firstFeature), 'utf8'),
  );
  assert.equal(summaryBytes, exact);

  const manyFeatures = `{"type":"FeatureCollection","features":[${Array.from(
    { length: 1_000 },
    () => '{"type":"Feature","properties":{},"geometry":null}',
  ).join(',')}]}`;
  const bounded = await lintGeoJSONText(manyFeatures, {
    config: {
      budgets: { feature: { bytes: '1B' } },
      diagnostics: { maxPerCodePerFile: 2, maxPerFile: 2 },
    },
  });
  assert.equal(bounded.errorCount, 1_000);
  assert.equal(bounded.diagnostics.length, 2);
  assert.equal(bounded.suppressedDiagnostics[0]?.suppressedCount, 998);
});

test('unclassifiable Feature elements make requested Feature byte stats partial', async () => {
  const result = await lintGeoJSONText(
    '{"type":"FeatureCollection","features":[42,{"type":"Feature","properties":{},"geometry":null}]}',
    { config: { budgets: { feature: { bytes: '1KB' } } } },
  );
  assert.equal(result.summary?.completeness.facts.featureByteStats, 'partial');
  assert.equal(result.summary?.largestFeatureBytes, 50);

  const losing = await lintGeoJSONText(
    '{"type":"FeatureCollection","features":[{"type":"Feature","properties":{},"geometry":null}],"features":[]}',
    { config: { budgets: { feature: { bytes: '1B' } } } },
  );
  assert.equal(losing.errorCount, 0);
  assert.equal(losing.summary?.largestFeatureBytes, 0);
  assert.equal(losing.summary?.featureCount, 0);

  const malformed = await lintGeoJSONText(
    '{"type":"Feature","properties":42,"geometry":null}',
    { config: { budgets: { feature: { bytes: '1B' } } } },
  );
  assert.deepEqual(
    malformed.diagnostics.map(({ code }) => code),
    ['geojson/invalid-properties', 'budget/feature-bytes'],
  );
  assert.equal(
    malformed.summary?.completeness.facts.featureByteStats,
    'complete',
  );
});

test('source policies compose, forced buffered rejects, and object input remains source-less', async () => {
  const source =
    '{"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[1.0000000,2]}}';
  const result = await lintGeoJSONText(source, {
    config: {
      rules: { 'coordinate-precision': 'warn' },
      budgets: { feature: { bytes: '1B' } },
    },
  });
  assert.deepEqual(
    result.diagnostics.map(({ code }) => code),
    ['coordinate-precision', 'budget/feature-bytes'],
  );
  for (const config of [
    { rules: { 'coordinate-precision': 'error' as const } },
    { budgets: { feature: { bytes: '1KB' } } },
  ]) {
    await assert.rejects(
      lintGeoJSONTextWithParser(source, { parser: 'buffered', config }),
      GeoLintCapabilityError,
    );
  }
});

test('web preset runs source-backed with precision, ordinary findings, and overrides', async () => {
  const source =
    '{"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[181.0000000,2]}}';
  const result = await lintGeoJSONText(source, {
    filename: 'public/map.geojson',
    config: { extends: ['geolint/web'] },
  });
  assert.deepEqual(
    result.diagnostics.map(({ code }) => code),
    ['valid-coordinate-range', 'coordinate-precision', 'require-feature-id'],
  );

  const overridden = await lintGeoJSONText(source, {
    filename: 'public/map.geojson',
    config: {
      extends: ['geolint/web'],
      overrides: [
        {
          files: ['public/**'],
          rules: {
            'coordinate-precision': ['warn', { maximumDecimals: 7 }],
          },
        },
      ],
    },
  });
  assert.equal(
    overridden.diagnostics.some(({ code }) => code === 'coordinate-precision'),
    false,
  );
});

test('a passing source-only policy does not perturb ordinary policy output', async () => {
  const source = JSON.stringify({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 1,
        properties: { a: 1 },
        geometry: { type: 'Point', coordinates: [0, 0] },
      },
    ],
  });
  const ordinary = await lintGeoJSONText(source, {
    config: { extends: ['geolint/recommended'] },
  });
  const sourceAware = await lintGeoJSONText(source, {
    config: {
      extends: ['geolint/recommended'],
      rules: { 'coordinate-precision': 'error' },
    },
  });
  assert.deepEqual(stable(sourceAware), stable(ordinary));
});

test('semantic budgets and regression remain identical across strategies', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'geolint-indexed-regression-'),
  );
  try {
    const baselinePath = join(directory, 'baseline.json');
    await writeFile(
      baselinePath,
      serializeBaseline(
        createBaseline({
          'map.geojson': {
            bytes: 1,
            featureCount: 2,
            totalVertices: 2,
            largestFeatureVertices: 1,
            featureGeometryTypes: { Point: 2 },
            properties: {
              a: { present: 2, missing: 0, types: { number: 2 } },
            },
            ids: { missing: 0, duplicates: 0, string: 0, number: 2 },
            nullGeometries: 0,
          },
        }),
      ),
    );
    const source = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 1,
          properties: { a: 1 },
          geometry: { type: 'Point', coordinates: [0, 0] },
        },
      ],
    });
    const config: GeoLintConfig = {
      budgets: { featureCount: 0, totalVertices: 0, fileSize: '1B' },
      regression: {
        baseline: 'baseline.json',
        checks: { properties: { added: 'error', removed: 'warn' } },
        thresholds: {
          featureCountDecrease: { minimumDecrease: 0 },
          totalVerticesIncrease: { minimumIncrease: 0 },
        },
      },
    };
    const buffered = await lintGeoJSONTextWithParser(source, {
      cwd: directory,
      filename: 'map.geojson',
      config,
      parser: 'buffered',
    });
    const indexed = await lintGeoJSONTextWithParser(source, {
      cwd: directory,
      filename: 'map.geojson',
      config,
      parser: 'indexed',
    });
    assert.deepEqual(stable(indexed), stable(buffered));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('lintFile matches text source semantics and rejects invalid UTF-8 before scanning', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'geolint-indexed-'));
  try {
    const source = '{"type":"Point","coordinates":[1.0000000,2],"label":"é"}';
    const path = join(directory, 'map.geojson');
    await writeFile(path, source);
    const config = { rules: { 'coordinate-precision': 'error' as const } };
    const text = await lintGeoJSONText(source, {
      filename: path,
      cwd: directory,
      config,
    });
    const file = await lintFile(path, { cwd: directory, config });
    assert.deepEqual(stable(file), stable(text));

    const invalidPath = join(directory, 'bad.geojson');
    await writeFile(invalidPath, Uint8Array.of(0xff));
    const invalid = await lintFile(invalidPath, { cwd: directory, config: {} });
    assert.deepEqual(
      invalid.diagnostics.map(({ code }) => code),
      ['parse/invalid-encoding'],
    );
    assert.equal(invalid.summary, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('source decoding preserves BOM for consistent JSON rejection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'geolint-bom-'));
  try {
    const source = '\uFEFF{"type":"Point","coordinates":[1,2]}';
    const path = join(directory, 'map.geojson');
    await writeFile(path, source);
    for (const parser of ['buffered', 'indexed'] as const) {
      const text = await lintGeoJSONTextWithParser(source, {
        parser,
        filename: path,
        cwd: directory,
        config: {},
      });
      const file = await lintFileWithParser(path, {
        parser,
        cwd: directory,
        config: {},
      });
      assert.deepEqual(
        text.diagnostics.map(({ code }) => code),
        ['parse/invalid-json'],
      );
      assert.deepEqual(stable(file), stable(text));
    }
    await assert.rejects(
      snapshotBaseline({
        cwd: directory,
        targets: ['map.geojson'],
        config: { regression: { baseline: 'baseline.json' } },
      }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'GEOLINT_SNAPSHOT_INVALID_JSON',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('raw source bytes, offsets, Feature spans, snapshot, and regression agree', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'geolint-source-truth-'));
  try {
    const feature =
      '{"type":"Feature","properties":{"label":"🗺️"},"geometry":{"type":"Point","coordinates":[1.0000000,2]}}';
    const source = ` \r\n${feature}\n`;
    const path = join(directory, 'map.geojson');
    const bytes = Buffer.byteLength(source, 'utf8');
    const featureBytes = Buffer.byteLength(feature, 'utf8');
    await writeFile(path, source);
    const snapshot = await snapshotBaseline({
      cwd: directory,
      targets: ['map.geojson'],
      config: { regression: { baseline: 'baseline.json' } },
    });
    assert.equal(snapshot.baseline.files['map.geojson']?.bytes, bytes);

    const result = await lintFile(path, {
      cwd: directory,
      config: {
        rules: {
          'coordinate-precision': ['error', { maximumDecimals: 6 }],
        },
        budgets: { feature: { bytes: `${featureBytes}B` } },
        regression: {
          baseline: 'baseline.json',
          thresholds: { fileSizeIncrease: { minimumIncrease: '0B' } },
        },
      },
    });
    assert.equal(result.summary?.bytes, bytes);
    assert.equal(result.summary?.largestFeatureBytes, featureBytes);
    assert.equal(
      result.diagnostics.find(({ code }) => code === 'coordinate-precision')
        ?.byteOffset,
      Buffer.byteLength(source.slice(0, source.indexOf('[1.0000000')), 'utf8'),
    );
    assert.equal(
      result.diagnostics.some(({ code }) => code === 'regression/file-size'),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('indexed Feature spans do not allocate unrequested numeric lexemes', () => {
  const source =
    '{"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[1.0000000,2]}}';
  const featureOnly = createExecutionRequirements({
    facts: ['vertexCount'],
    featureByteSpans: true,
  });
  const parsed = parseIndexedSource(source, featureOnly);
  const noLexemes: ScanInstrumentation = {
    coordinateTraversals: 0,
    positionVisits: 0,
    coordinatePathMaterializations: 0,
    propertyPathMaterializations: 0,
    rawLexemeCollections: 0,
    coordinateLexemeEvents: 0,
  };
  scanGeoJSON(parsed.value, {
    filePath: 'map.geojson',
    requirements: featureOnly,
    instrumentation: noLexemes,
  });
  assert.equal(noLexemes.positionVisits, 1);
  assert.equal(noLexemes.rawLexemeCollections, 0);
  assert.equal(noLexemes.coordinateLexemeEvents, 0);

  let observed: readonly string[] = [];
  const listener: SemanticListener = {
    coordinateLexeme(event) {
      observed = event.rawValues;
    },
  };
  const withLexemes = createExecutionRequirements({ listener });
  const lexemeParsed = parseIndexedSource(source, withLexemes);
  const lexemes: ScanInstrumentation = {
    coordinateTraversals: 0,
    positionVisits: 0,
    coordinatePathMaterializations: 0,
    propertyPathMaterializations: 0,
    rawLexemeCollections: 0,
    coordinateLexemeEvents: 0,
  };
  scanGeoJSON(lexemeParsed.value, {
    filePath: 'map.geojson',
    requirements: withLexemes,
    listener,
    instrumentation: lexemes,
  });
  assert.deepEqual(observed, ['1.0000000', '2']);
  assert.equal(lexemes.rawLexemeCollections, 1);
  assert.equal(lexemes.coordinateLexemeEvents, 1);
});

test('hostile losing coordinates retain one span and visit only winning positions', () => {
  const losing = Array.from(
    { length: 10_000 },
    (_, index) => `[${index},0]`,
  ).join(',');
  const source = `{"type":"MultiPoint","coordinates":[${losing}],"coordinates":[[1,2]]}`;
  const index: IndexedInstrumentation = {
    sourceBytes: 0,
    syntaxValidationMs: 0,
    initialIndexReplayMs: 0,
    indexedObjects: 0,
    winningSpans: 0,
    coordinateSpans: 0,
    sourceBytesReplayed: 0,
  };
  const requirements = createExecutionRequirements({ facts: ['vertexCount'] });
  const parsed = parseIndexedSource(source, requirements, index);
  const scan: ScanInstrumentation = {
    coordinateTraversals: 0,
    positionVisits: 0,
    coordinatePathMaterializations: 0,
    propertyPathMaterializations: 0,
  };
  const summary = scanGeoJSON(parsed.value, {
    filePath: 'map.geojson',
    requirements,
    instrumentation: scan,
  });
  assert.equal(index.coordinateSpans, 1);
  assert.equal(index.indexedObjects, 1);
  assert.equal(scan.positionVisits, 1);
  assert.equal(summary.totalVertices, 1);
});
