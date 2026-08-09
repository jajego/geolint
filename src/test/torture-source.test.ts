import assert from 'node:assert/strict';
import test from 'node:test';

import {
  lintGeoJSONText,
  lintGeoJSONTextWithParser,
} from '../engine/lint-input.js';
import {
  createExecutionRequirements,
  type SemanticListener,
} from '../engine/requirements.js';
import { parseIndexedSource } from '../parser/indexed-source.js';
import { scanGeoJSON, type ScanInstrumentation } from '../scanner/scan.js';
import type { FeatureSummary } from '../types/semantic.js';
import {
  assertEquivalentSources,
  assertOrdinaryEquivalence,
  ordinaryProjection,
  seededRandom,
} from './torture-harness.js';

test('numeric JSON grammar and exact coordinate lexemes match JSON.parse', async () => {
  const spellings = [
    '0',
    '-0',
    '1',
    '-1',
    '1.0',
    '1.000000',
    '0.1',
    '-0.1',
    '1e3',
    '1E3',
    '1e+3',
    '1E+04',
    '1e-7',
    '1.230000e2',
  ];
  const source = `{"type":"MultiPoint","coordinates":[${spellings
    .map((value) => `[${value},2]`)
    .join(',')}]}`;
  await assertOrdinaryEquivalence({ fixture: 'valid numeric grammar', source });

  const observed: string[][] = [];
  const values: number[][] = [];
  const listener: SemanticListener = {
    coordinateLexeme(event) {
      observed.push([...event.rawValues]);
      values.push([...event.values]);
    },
  };
  const requirements = createExecutionRequirements({ listener });
  const parsed = parseIndexedSource(source, requirements);
  scanGeoJSON(parsed.value, {
    filePath: 'map.geojson',
    requirements,
    listener,
  });
  assert.deepEqual(
    observed.map(([first]) => first),
    spellings,
  );
  assert.equal(Object.is(values[1]?.[0], -0), true);

  for (const invalid of [
    '+1',
    '01',
    '-01',
    '1.',
    '.5',
    '1e',
    '1e+',
    'NaN',
    'Infinity',
    '-Infinity',
  ]) {
    const invalidSource = `{"type":"Point","coordinates":[${invalid},2]}`;
    assert.throws(() => JSON.parse(invalidSource), SyntaxError);
    for (const parser of ['buffered', 'indexed'] as const) {
      const result = await lintGeoJSONTextWithParser(invalidSource, {
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

test('precision scale boundaries and exponent saturation remain exact', async () => {
  const source =
    '{"type":"MultiPoint","coordinates":[[1.12345,2],[1.123456,2],[1.1234567,2],[1e-7,2],[1.230000e2,2],[-0.000000,2],[1.2e3,2],[1.2E+300,2],[1e-999999999999999999,2]]}';
  const result = await lintGeoJSONText(source, {
    config: {
      rules: {
        'coordinate-precision': ['error', { maximumDecimals: 6 }],
      },
    },
  });
  assert.deepEqual(
    result.diagnostics
      .filter(({ code }) => code === 'coordinate-precision')
      .map(({ data }) => data),
    [
      {
        maximumDecimals: 6,
        maximumObserved: 7,
        offendingToken: '1.1234567',
      },
      {
        maximumDecimals: 6,
        maximumObserved: 7,
        offendingToken: '1e-7',
      },
      {
        maximumDecimals: 6,
        maximumObserved: Number.MAX_SAFE_INTEGER,
        offendingToken: '1e-999999999999999999',
      },
    ],
  );
});

test('Unicode, escapes, and RFC 6901 paths preserve decoded JSON semantics', async () => {
  const source = String.raw`{"type":"Feature","properties":{"/":"slash","~":"tilde",".":"dot","[":"left","]":"right","":"empty","é":"actual","\u00e9":"winner","escapes":"\"\\\/\b\f\n\r\t","emoji":"\ud83d\uddfa"},"geometry":null}`;
  await assertOrdinaryEquivalence({
    fixture: 'Unicode and escape values',
    source,
  });

  const paths: string[] = [];
  const values = new Map<string, unknown>();
  const listener: SemanticListener = {
    propertyValue(event) {
      paths.push(event.path);
      values.set(event.key, event.value);
    },
  };
  const requirements = createExecutionRequirements({ listener });
  const parsed = parseIndexedSource(source, requirements);
  scanGeoJSON(parsed.value, {
    filePath: 'map.geojson',
    requirements,
    listener,
  });
  assert.deepEqual(paths, [
    '/properties/',
    '/properties/.',
    '/properties/~1',
    '/properties/[',
    '/properties/]',
    '/properties/emoji',
    '/properties/escapes',
    '/properties/~0',
    '/properties/é',
  ]);
  assert.equal(values.get('é'), 'winner');
  assert.equal(values.get('emoji'), '🗺');
  assert.equal(values.get('escapes'), '"\\/\b\f\n\r\t');
});

test('UTF-8, CRLF, and Feature spans use independent raw-byte oracles', async () => {
  const first =
    '{\r\n  "type":"Feature",\r\n  "properties":{"actual":"é🗺️"},\r\n  "geometry":{"type":"Point","coordinates":[181.0000000,40]}\r\n}';
  const second = String.raw`{"type":"Feature","properties":{"escaped":"\u00e9"},"geometry":null}`;
  const source = ` \t\r\n{"type":"FeatureCollection","features":[ \r\n${first} ,\n\t${second}\r\n ]}\r\n `;
  const events: { start?: number; bytes?: number }[] = [];
  const lexemeOffsets: number[] = [];
  const listener: SemanticListener = {
    featureStart(event) {
      assert.notEqual(event.byteOffset, undefined);
      events.push({ start: event.byteOffset! });
    },
    coordinateLexeme(event) {
      assert.notEqual(event.byteOffset, undefined);
      lexemeOffsets.push(event.byteOffset!);
    },
    feature(summary: FeatureSummary) {
      assert.notEqual(summary.bytes, undefined);
      events[summary.index]!.bytes = summary.bytes!;
    },
  };
  const requirements = createExecutionRequirements({
    listener,
    featureByteSpans: true,
  });
  const parsed = parseIndexedSource(source, requirements);
  scanGeoJSON(parsed.value, {
    filePath: 'map.geojson',
    requirements,
    listener,
    sourceBytes: Buffer.byteLength(source),
  });
  const raw = Buffer.from(source, 'utf8');
  assert.deepEqual(events, [
    {
      start: raw.indexOf(Buffer.from(first, 'utf8')),
      bytes: Buffer.byteLength(first, 'utf8'),
    },
    {
      start: raw.indexOf(Buffer.from(second, 'utf8')),
      bytes: Buffer.byteLength(second, 'utf8'),
    },
  ]);
  assert.deepEqual(lexemeOffsets, [
    raw.indexOf(Buffer.from('[181.0000000', 'utf8')),
  ]);

  for (const [feature, expected] of [
    [first, Buffer.byteLength(first, 'utf8')],
    [second, Buffer.byteLength(second, 'utf8')],
  ] as const) {
    for (const [delta, failures] of [
      [1, 0],
      [0, 0],
      [-1, 1],
    ] as const) {
      const result = await lintGeoJSONText(feature, {
        config: { budgets: { feature: { bytes: `${expected + delta}B` } } },
      });
      assert.equal(result.errorCount, failures);
    }
  }
});

test('legal whitespace and line endings affect source bytes, not semantics', async () => {
  const compact =
    '{"type":"Feature","id":1,"properties":{"a":1},"geometry":{"type":"Point","coordinates":[1,2]}}';
  const variants = [
    ` \t${compact}\r\n`,
    '{\n"geometry" : { "coordinates" : [1,2] , "type" : "Point" },\n"properties" : { "a" : 1 },\n"id" : 1,\n"type" : "Feature"\n}',
    '{\r\n\t"properties"\t:\t{"a":1},\r\n\t"type":"Feature",\r\n\t"geometry":{"type":"Point","coordinates":[1,2]},\r\n\t"id":1\r\n}',
    `${' '.repeat(20_000)}${compact}${'\r\n'.repeat(1_000)}`,
  ];
  for (let index = 0; index < variants.length; index += 1) {
    await assertEquivalentSources(
      {
        fixture: `whitespace variant ${index}`,
        source: variants[index]!,
        config: { extends: ['geolint/recommended'] },
      },
      compact,
    );
  }
});

test('wide randomized properties remain canonical after duplicate collapse', async () => {
  const random = seededRandom(0x7a11ce);
  const entries = Array.from({ length: 1_000 }, (_, index) => {
    const key = `key-${String(index).padStart(4, '0')}`;
    const value =
      index % 5 === 0
        ? `{"nested":${index},"nested":${index + 1}}`
        : index % 5 === 1
          ? `[${index},null,"é"]`
          : index % 5 === 2
            ? 'null'
            : index % 5 === 3
              ? JSON.stringify(`value-${index}`)
              : String(index);
    return { key, value, order: random() };
  }).sort((left, right) => left.order - right.order);
  const properties = entries
    .flatMap(({ key, value }, index) =>
      index % 100 === 0
        ? [`${JSON.stringify(key)}:"loser"`, `${JSON.stringify(key)}:${value}`]
        : [`${JSON.stringify(key)}:${value}`],
    )
    .join(',');
  await assertOrdinaryEquivalence({
    fixture: '1k wide randomized properties',
    seed: 0x7a11ce,
    source: `{"type":"Feature","id":1,"properties":{${properties}},"geometry":null}`,
    config: {
      extends: ['geolint/recommended'],
      rules: { 'consistent-property-presence': 'warn' },
    },
  });
});

test('source-only capabilities add only their own observations in one traversal', async () => {
  const source =
    '{"type":"Feature","id":1,"properties":{"a":1},"geometry":{"type":"Point","coordinates":[1.0000000,2]}}';
  const ordinary = await lintGeoJSONText(source, {
    config: { extends: ['geolint/recommended'] },
  });
  for (const config of [
    {
      extends: ['geolint/recommended'],
      rules: { 'coordinate-precision': 'off' as const },
      budgets: { feature: { bytes: '1GiB' } },
    },
    {
      extends: ['geolint/recommended'],
      rules: {
        'coordinate-precision': ['error', { maximumDecimals: 7 }] as const,
      },
      budgets: { feature: { bytes: '1GiB' } },
    },
  ]) {
    const sourceAware = await lintGeoJSONText(source, { config });
    assert.deepEqual(
      ordinaryProjection(sourceAware),
      ordinaryProjection(ordinary),
    );
  }

  const requirements = createExecutionRequirements({
    facts: ['vertexCount'],
    listener: { coordinateLexeme() {} },
    numericLexemes: true,
    featureByteSpans: true,
  });
  const parsed = parseIndexedSource(source, requirements);
  const instrumentation: ScanInstrumentation = {
    coordinateTraversals: 0,
    positionVisits: 0,
    coordinatePathMaterializations: 0,
    propertyPathMaterializations: 0,
    rawLexemeCollections: 0,
    coordinateLexemeEvents: 0,
  };
  scanGeoJSON(parsed.value, {
    filePath: 'map.geojson',
    requirements,
    listener: { coordinateLexeme() {} },
    instrumentation,
  });
  assert.equal(instrumentation.positionVisits, 1);
  assert.equal(instrumentation.rawLexemeCollections, 1);
  assert.equal(instrumentation.coordinateLexemeEvents, 1);
});

test('combined source-only suppression preserves complete semantic facts', async () => {
  const source = `{"type":"FeatureCollection","features":[${Array.from(
    { length: 100 },
    (_, index) =>
      `{"type":"Feature","id":${index},"properties":{},"geometry":{"type":"Point","coordinates":[1.0000000,2]}}`,
  ).join(',')}]}`;
  const run = (cap: number) =>
    lintGeoJSONText(source, {
      config: {
        rules: {
          'coordinate-precision': ['error', { maximumDecimals: 0 }],
        },
        budgets: { feature: { bytes: '1B' } },
        diagnostics: { maxPerCodePerFile: cap, maxPerFile: cap },
      },
    });
  const low = await run(2);
  const high = await run(1_000);
  assert.equal(low.errorCount, 200);
  assert.equal(low.diagnostics.length, 2);
  assert.equal(
    low.suppressedDiagnostics.reduce(
      (total, { suppressedCount }) => total + suppressedCount,
      0,
    ),
    198,
  );
  assert.deepEqual(low.summary, high.summary);
  assert.equal(low.summary?.featureCount, 100);
  assert.equal(low.summary?.totalVertices, 100);
});

test('trailing content and malformed escapes are syntax-fatal', async () => {
  const root = '{"type":"Point","coordinates":[1,2]}';
  const invalid = [
    `${root}{}`,
    `${root}text`,
    `${root}//comment`,
    String.raw`{"type":"Feature","properties":{"x":"\u12G4"},"geometry":null}`,
    String.raw`{"type":"Feature","properties":{"x":"\x20"},"geometry":null}`,
  ];
  for (const source of invalid) {
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
  await assertOrdinaryEquivalence({
    fixture: 'trailing legal whitespace',
    source: `${root} \t\r\n`,
  });
});
