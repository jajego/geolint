import assert from 'node:assert/strict';
import test from 'node:test';

import { createLintResult } from '../engine/lint-files.js';
import { lintGeoJSON, lintGeoJSONText } from '../engine/lint-input.js';
import { definePlugin, defineRule } from '../index.js';
import { formatJson, jsonProjection } from '../reporters/json.js';
import { formatPretty } from '../reporters/pretty.js';
import { formatSnapshot } from '../reporters/snapshot.js';
import { formatQuotedValue, formatTerminalText } from '../terminal-text.js';
import type { SnapshotProposal } from '../regression/snapshot.js';
import type { BaselineFileEntry } from '../regression/schema.js';
import { geolintVersion } from '../version.js';

function entry(overrides: Partial<BaselineFileEntry> = {}): BaselineFileEntry {
  return {
    bytes: 100,
    featureCount: 1,
    totalVertices: 1,
    largestFeatureVertices: 1,
    featureGeometryTypes: { Point: 1 },
    properties: {},
    ids: { missing: 0, duplicates: 0, string: 1, number: 0 },
    nullGeometries: 0,
    ...overrides,
  };
}

test('JSON reporter preserves Maps and versioned result data', async () => {
  const file = await lintGeoJSON(
    {
      type: 'Feature',
      properties: { name: 'x' },
      geometry: { type: 'Point', coordinates: [0, 0] },
    },
    {
      filename: 'map.geojson',
      config: {
        rules: {
          'consistent-property-types': 'error',
          'consistent-geometry-types': 'error',
        },
      },
    },
  );
  const parsed = JSON.parse(formatJson(createLintResult([file], 0)));
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.geolintVersion, geolintVersion);
  assert.equal(parsed.files[0].summary.propertyStats.name.present, 1);
  assert.equal(parsed.files[0].summary.featureGeometryTypes.Point, 1);
  assert.equal(JSON.stringify(parsed).includes('\u001b['), false);
});

test('pretty reporter shows codes, suppression, skips, and summary facts', async () => {
  const file = await lintGeoJSON(
    {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'Point', coordinates: [0, 0] },
        },
        {
          type: 'Feature',
          properties: [],
          geometry: { type: 'Point', coordinates: [0, 0] },
        },
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'Point', coordinates: [0, 0] },
        },
      ],
    },
    {
      filename: 'map.geojson',
      config: {
        rules: {
          'require-feature-id': 'warn',
          'consistent-property-types': 'error',
        },
        diagnostics: { maxPerCodePerFile: 1 },
      },
    },
  );
  const output = formatPretty(createLintResult([file], 0));
  assert.match(output, /require-feature-id/);
  assert.match(output, /additional occurrences suppressed/);
  assert.match(output, /consistent-property-types · incomplete propertyStats/);
  assert.match(output, /3 features/);
  assert.match(output, /3 vertices/);
  assert.equal(output.includes('\u001b['), false);
});

test('pretty reporter pluralizes vertices', async () => {
  const file = await lintGeoJSON(
    { type: 'Point', coordinates: [0, 0] },
    { filename: 'point.geojson' },
  );
  const output = formatPretty(createLintResult([file], 0));

  assert.match(output, /1 vertex/);
  assert.doesNotMatch(output, /vertexs/);
});

test('pretty reporter renders coordinate precision context from the rule message', async () => {
  const file = await lintGeoJSONText(
    '{"type":"Point","coordinates":[-116.5986666666667,34.1]}',
    {
      config: {
        rules: { 'coordinate-precision': ['warn', { maximumDecimals: 6 }] },
      },
    },
  );
  assert.match(
    formatPretty(createLintResult([file], 0)),
    /Coordinate precision is 13 decimals \(max 6\)\./,
  );
});

test('pretty reporter escapes hostile diagnostic paths', async () => {
  const file = await lintGeoJSONText(
    String.raw`{"type":"Feature","properties":{"a\"b":1,"a\"b":2,"line\nbreak":1,"line\nbreak":2,"\u001b":1,"\u001b":2},"geometry":null}`,
    { filename: 'hostile.geojson', config: {} },
  );
  const output = formatPretty(createLintResult([file], 0));
  assert.match(output, /\/properties\/a"b/);
  assert.match(output, /\/properties\/line\\nbreak/);
  assert.match(output, /\/properties\/\\u001b/);
  assert.equal(output.includes('\u001b'), false);
  assert.equal(output.split('\n').length, 10);
});

test('property diagnostics quote hostile names while JSON data stays semantic', async () => {
  const property = 'hello\nworld\t\u001b[31m東京🌋';
  const file = await lintGeoJSON(
    {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { [property]: 'first' },
          geometry: null,
        },
        { type: 'Feature', properties: { [property]: 2 }, geometry: null },
      ],
    },
    {
      filename: 'properties.geojson',
      config: { rules: { 'consistent-property-types': 'error' } },
    },
  );
  const pretty = formatPretty(createLintResult([file], 0));
  const json = JSON.parse(formatJson(createLintResult([file], 0))) as {
    files: { diagnostics: { data: { property: string } }[] }[];
  };

  assert.match(
    pretty,
    /Property "hello\\nworld\\t\\u001b\[31m東京🌋" uses inconsistent types\./,
  );
  assert.equal(pretty.includes('\u001b'), false);
  assert.equal(json.files[0]!.diagnostics[0]!.data.property, property);
});

test('terminal text keeps ordinary Unicode readable and makes controls visible', () => {
  const value =
    'a"b\\c\nhello\tworld\r\u001b[31m\u2028\u2029\u061c\u200f\u202e\u2066\u2069東京🌋';
  const display = formatTerminalText(value);
  const quoted = formatQuotedValue(value);

  assert.equal(display.includes('東京🌋'), true);
  assert.equal(quoted.includes('東京🌋'), true);
  for (const control of [
    '\n',
    '\r',
    '\t',
    '\u001b',
    '\u2028',
    '\u2029',
    '\u061c',
    '\u200f',
    '\u202e',
    '\u2066',
    '\u2069',
  ]) {
    assert.equal(display.includes(control), false);
    assert.equal(quoted.includes(control), false);
  }
  assert.match(
    display,
    /a"b\\c\\nhello\\tworld\\r\\u001b\[31m\\u2028\\u2029\\u061c\\u200f\\u202e\\u2066\\u2069/,
  );
  assert.match(
    quoted,
    /^"a\\"b\\\\c\\nhello\\tworld\\r\\u001b\[31m\\u2028\\u2029\\u061c\\u200f\\u202e\\u2066\\u2069東京🌋"$/,
  );
});

test('pretty reporter keeps hostile plugin codes semantic but terminal-safe', async () => {
  const namespace = 'evil\n\u001b[31m\u202e';
  const localName = 'finding\t\u2066';
  const code = `${namespace}/${localName}`;
  const plugin = definePlugin({
    meta: { apiVersion: 1 },
    rules: {
      [localName]: defineRule({
        meta: { name: localName, schema: null },
        create(context) {
          return {
            document: () => (
              context.report({ message: 'Plugin result.' }),
              undefined
            ),
          };
        },
      }),
    },
  });
  const file = await lintGeoJSON(
    { type: 'Point', coordinates: [0, 0] },
    {
      config: { plugins: { [namespace]: plugin }, rules: { [code]: 'error' } },
    },
  );
  const pretty = formatPretty(createLintResult([file], 0));
  const json = JSON.parse(formatJson(createLintResult([file], 0))) as {
    files: { diagnostics: { code: string }[] }[];
  };

  assert.match(pretty, /evil\\n\\u001b\[31m\\u202e\/finding\\t\\u2066/);
  for (const control of ['\t', '\u001b', '\u202e', '\u2066'])
    assert.equal(pretty.includes(control), false);
  assert.equal(json.files[0]!.diagnostics[0]!.code, code);
});

test('pretty reporter escapes hostile diagnostic, suppressed, and skipped codes', async () => {
  const file = await lintGeoJSON(
    { type: 'Feature', id: null, properties: {}, geometry: null },
    { config: {} },
  );
  const hostile = 'evil\n\u001b[31m\u202e';
  const output = formatPretty(
    createLintResult(
      [
        {
          ...file,
          diagnostics: [{ ...file.diagnostics[0]!, code: hostile }],
          suppressedDiagnostics: [
            { code: hostile, severity: 'error', suppressedCount: 1 },
          ],
          skippedPolicies: [
            { code: hostile, source: 'regression', reason: 'no-baseline' },
          ],
        },
      ],
      0,
    ),
  );

  assert.equal(output.includes(hostile), false);
  assert.match(output, /evil\\n\\u001b\[31m\\u202e/);
  assert.equal(output.split('\n').length, 12);
});

test('pretty reporter safely renders hostile paths, messages, and feature IDs', async () => {
  const file = await lintGeoJSON(
    {
      type: 'Feature',
      id: null,
      properties: {},
      geometry: null,
    },
    { filename: 'foo/bar.geojson' },
  );
  const diagnostic = {
    ...file.diagnostics[0]!,
    featureId: 'id\n\u001b[31m',
    message: 'Plugin finding\n\u001b[31m with 東京🌋.',
  };
  const output = formatPretty(
    createLintResult(
      [
        {
          ...file,
          filePath: 'C:\\foo\\bar\n\u001b.geojson',
          diagnostics: [diagnostic],
        },
      ],
      0,
    ),
  );

  assert.match(output, /C:\\foo\\bar\\n\\u001b\.geojson/);
  assert.match(output, /id "id\\n\\u001b\[31m"/);
  assert.match(output, /Plugin finding\\n\\u001b\[31m with 東京🌋\./);
  assert.equal(output.includes('\u001b'), false);
  assert.equal(output.split('\n').length, 11);
});

test('JSON reporter preserves hostile own keys without mutating prototypes', () => {
  const nested = Object.create(null) as Record<string, unknown>;
  nested['constructor'] = 'nested constructor';
  nested['prototype'] = 'nested prototype';
  nested['__proto__'] = 'nested proto';
  const data: Record<string, unknown> = {
    constructor: 'constructor',
    prototype: 'prototype',
    nested,
  };
  Object.defineProperty(data, '__proto__', {
    enumerable: true,
    value: { expected: true },
  });
  const projected = jsonProjection({
    data,
    map: new Map([
      ['prototype', 1],
      ['__proto__', 2],
      ['constructor', 3],
    ]),
  }) as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(projected), null);
  const parsed = JSON.parse(formatJson({ data, map: projected.map })) as {
    data: Record<string, unknown>;
    map: Record<string, unknown>;
  };
  assert.deepEqual(parsed.data.__proto__, { expected: true });
  assert.equal(parsed.data.constructor, 'constructor');
  assert.equal(parsed.data.prototype, 'prototype');
  assert.equal(
    (parsed.data.nested as Record<string, unknown>).__proto__,
    'nested proto',
  );
  assert.equal(parsed.map.__proto__, 2);
  assert.equal(parsed.map.constructor, 3);
  assert.equal(parsed.map.prototype, 1);
});

test('pretty snapshot reports stable useful diffs without unchanged noise', () => {
  const before = entry({
    bytes: 1_000,
    featureCount: 2,
    totalVertices: 3,
    largestFeatureVertices: 2,
    featureGeometryTypes: { Point: 2, Polygon: 3 },
  });
  const after = entry({
    bytes: 2_000,
    featureCount: 4,
    totalVertices: 6,
    largestFeatureVertices: 5,
    featureGeometryTypes: { Point: 1, MultiPolygon: 3 },
  });
  const proposal: SnapshotProposal = {
    mode: 'full',
    baselinePath: 'baseline.json',
    added: [{ filePath: 'added.geojson', after }],
    updated: [{ filePath: 'updated.geojson', before, after }],
    removed: [{ filePath: 'removed.geojson', before }],
    unchanged: ['unchanged.geojson'],
  };
  const output = formatSnapshot(proposal);
  assert.match(output, /bytes {2}1\.0 KB → 2\.0 KB/);
  assert.match(output, /featureCount {2}2 → 4/);
  assert.match(output, /totalVertices {2}3 → 6/);
  assert.match(output, /largestFeatureVertices {2}2 → 5/);
  assert.match(output, /\+ MultiPolygon/);
  assert.match(output, /- Polygon/);
  assert.match(output, /Point {2}2 → 1/);
  assert.match(
    output,
    /added\.geojson\n {2}added\n {2}4 features · 6 vertices · 2\.0 KB/,
  );
  assert.match(output, /removed\.geojson\n {2}removed/);
  assert.doesNotMatch(output, /unchanged\.geojson/);
  assert.equal(
    output,
    formatSnapshot({
      ...proposal,
      updated: [
        {
          filePath: 'updated.geojson',
          before: { ...before, featureGeometryTypes: { Polygon: 3, Point: 2 } },
          after: {
            ...after,
            featureGeometryTypes: { MultiPolygon: 3, Point: 1 },
          },
        },
      ],
    }),
  );
});

test('pretty snapshot safely renders hostile filenames without changing normal paths', () => {
  const proposal: SnapshotProposal = {
    mode: 'full',
    baselinePath: 'baseline.json',
    added: [{ filePath: 'foo/bar.geojson', after: entry() }],
    updated: [],
    removed: [{ filePath: 'C:\\foo\\bar\n\u001b.geojson', before: entry() }],
    unchanged: [],
  };
  const output = formatSnapshot(proposal);

  assert.match(output, /^GeoLint baseline update\n\nfoo\/bar\.geojson/m);
  assert.match(output, /C:\\foo\\bar\\n\\u001b\.geojson/);
  assert.equal(output.includes('\u001b'), false);
});

test('JSON reporter retains defensive rejection of invalid runtime values', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => formatJson({ value: NaN }), /non-finite/);
  assert.throws(() => formatJson(cyclic), /cyclic/);
  assert.throws(
    () =>
      formatJson(
        Object.defineProperty({}, 'value', { enumerable: true, get: () => 1 }),
      ),
    /accessors/,
  );
});
