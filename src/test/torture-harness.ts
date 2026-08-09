import assert from 'node:assert/strict';

import {
  lintGeoJSON,
  lintGeoJSONTextWithParser,
} from '../engine/lint-input.js';
import {
  createExecutionRequirements,
  type SemanticListener,
} from '../engine/requirements.js';
import { parseIndexedSource } from '../parser/indexed-source.js';
import { scanGeoJSON } from '../scanner/scan.js';
import type { GeoLintConfig } from '../types/config.js';
import type {
  FileLintResult,
  FileSummary,
  JsonValue,
  SummaryFactName,
} from '../types/semantic.js';

export const tortureFacts = [
  'featureCount',
  'vertexCount',
  'propertyStats',
  'geometryStats',
  'idStats',
  'coordinateDimensionStats',
  'derivedExtent',
] as const satisfies readonly SummaryFactName[];

export interface TortureCase {
  readonly source: string;
  readonly fixture: string;
  readonly seed?: number;
  readonly permutation?: number;
  readonly config?: GeoLintConfig;
  readonly cwd?: string;
}

function context(test: TortureCase, strategies: string): string {
  const reproduction =
    test.source.length <= 500
      ? test.source
      : `${test.source.slice(0, 240)}…<${test.source.length} chars>`;
  return [
    `fixture=${test.fixture}`,
    ...(test.seed === undefined ? [] : [`seed=${test.seed}`]),
    ...(test.permutation === undefined
      ? []
      : [`permutation=${test.permutation}`]),
    `strategies=${strategies}`,
    `source=${reproduction}`,
  ].join(' ');
}

function semanticSummary(summary: FileSummary | undefined): unknown {
  if (!summary) return undefined;
  const {
    bytes: _bytes,
    largestFeatureBytes: _featureBytes,
    ...ordinary
  } = summary;
  void _bytes;
  void _featureBytes;
  return {
    ...ordinary,
    completeness: {
      ...ordinary.completeness,
      facts: {
        ...ordinary.completeness.facts,
        fileBytes: 'not-computed',
        featureByteStats: 'not-computed',
      },
    },
  };
}

export function ordinaryProjection(result: FileLintResult): unknown {
  const { durationMs: _duration, summary, diagnostics, ...ordinary } = result;
  void _duration;
  return {
    ...ordinary,
    diagnostics: diagnostics.map(({ byteOffset: _byteOffset, ...item }) => {
      void _byteOffset;
      return item;
    }),
    summary: semanticSummary(summary),
  };
}

function sourceProjection(result: FileLintResult): unknown {
  const { durationMs: _duration, ...stable } = result;
  void _duration;
  return stable;
}

function trace(source: string, indexed: boolean): readonly unknown[] {
  const events: unknown[] = [];
  const listener: SemanticListener = {
    featureStart({ byteOffset: _byteOffset, ...event }) {
      void _byteOffset;
      events.push(['featureStart', event]);
    },
    property: (event) => events.push(['property', event]),
    propertyValue: (event) => events.push(['propertyValue', event]),
    coordinate: (event) => events.push(['coordinate', event]),
    geometry: (event) => events.push(['geometry', event]),
    feature: (event) => events.push(['feature', event]),
  };
  const requirements = createExecutionRequirements({
    facts: tortureFacts,
    listener,
  });
  const value = indexed
    ? parseIndexedSource(source, requirements).value
    : (JSON.parse(source) as JsonValue);
  const summary = scanGeoJSON(value, {
    filePath: 'map.geojson',
    requirements,
    listener,
  });
  return [events, semanticSummary(summary)];
}

export async function assertOrdinaryEquivalence(
  test: TortureCase,
): Promise<void> {
  const options = {
    filename: 'map.geojson',
    ...(test.cwd ? { cwd: test.cwd } : {}),
    config: test.config ?? {},
  };
  const object = await lintGeoJSON(JSON.parse(test.source), options);
  const buffered = await lintGeoJSONTextWithParser(test.source, {
    ...options,
    parser: 'buffered',
  });
  const indexed = await lintGeoJSONTextWithParser(test.source, {
    ...options,
    parser: 'indexed',
  });
  const details = context(test, 'object/buffered/indexed');
  assert.deepEqual(
    ordinaryProjection(buffered),
    ordinaryProjection(object),
    details,
  );
  assert.deepEqual(
    ordinaryProjection(indexed),
    ordinaryProjection(object),
    details,
  );
  assert.deepEqual(
    sourceProjection(indexed),
    sourceProjection(buffered),
    context(test, 'buffered/indexed source-backed'),
  );
  assert.deepEqual(
    trace(test.source, true),
    trace(test.source, false),
    details,
  );
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

export function permuteObjects(value: JsonValue, seed: number): JsonValue {
  const random = seededRandom(seed);
  const visit = (current: JsonValue): JsonValue => {
    if (Array.isArray(current)) return current.map(visit);
    if (current === null || typeof current !== 'object') return current;
    const entries = Object.entries(current).map(
      ([key, item]) => [key, visit(item)] as const,
    );
    for (let index = entries.length - 1; index > 0; index -= 1) {
      const other = Math.floor(random() * (index + 1));
      [entries[index], entries[other]] = [entries[other]!, entries[index]!];
    }
    return Object.fromEntries(entries) as JsonValue;
  };
  return visit(value);
}

export async function assertEquivalentSources(
  actual: TortureCase,
  expectedSource: string,
): Promise<void> {
  const expected = { ...actual, source: expectedSource };
  for (const parser of ['buffered', 'indexed'] as const) {
    const options = {
      filename: 'map.geojson',
      config: actual.config ?? {},
      parser,
    };
    const observed = await lintGeoJSONTextWithParser(actual.source, options);
    const wanted = await lintGeoJSONTextWithParser(expected.source, options);
    assert.deepEqual(
      ordinaryProjection(observed),
      ordinaryProjection(wanted),
      context(actual, `${parser}/canonical-winner`),
    );
  }
  assert.deepEqual(
    trace(actual.source, true),
    trace(expected.source, true),
    context(actual, 'indexed hooks/canonical-winner'),
  );
}
