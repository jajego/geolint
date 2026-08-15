import type { ExecutionRequirements } from '../engine/requirements.js';
import type { JsonObject, JsonValue } from '../types/semantic.js';
import {
  JsonSourceCursor,
  JsonSourceSyntaxError,
  type DuplicateJsonKey,
  type JsonSourceSpan,
} from './json-source.js';

type IndexedSpan = JsonSourceSpan;

export interface SourceSpan {
  readonly startByte: number;
  readonly endByteExclusive: number;
}

export interface IndexedInstrumentation {
  sourceBytes: number;
  syntaxValidationMs: number;
  initialIndexReplayMs: number;
  indexedObjects: number;
  winningSpans: number;
  coordinateSpans: number;
  sourceBytesReplayed: number;
}

interface IndexedSource {
  readonly text: string;
  readonly requirements: ExecutionRequirements;
  readonly instrumentation?: IndexedInstrumentation;
}

const sequenceBrand = Symbol('geolint.indexed-sequence');
const coordinateBrand = Symbol('geolint.indexed-coordinate');

export interface IndexedSequence {
  readonly [sequenceBrand]: true;
  readonly kind: 'features' | 'geometries';
  readonly source: IndexedSource;
  readonly span: IndexedSpan;
}

export interface IndexedCoordinateValue {
  readonly [coordinateBrand]: true;
  readonly source: IndexedSource;
  readonly span: IndexedSpan;
}

const featureSpans = new WeakMap<object, SourceSpan>();

export { JsonSourceSyntaxError as IndexedSyntaxError };

function decode(source: IndexedSource, span: IndexedSpan): JsonValue {
  return JSON.parse(source.text.slice(span.start, span.end)) as JsonValue;
}

function members(
  source: IndexedSource,
  span: IndexedSpan,
): ReadonlyMap<string, IndexedSpan> {
  const cursor = new JsonSourceCursor(
    source.text,
    span.start,
    span.startByte,
    span.end,
  );
  const result = new Map<string, IndexedSpan>();
  cursor.ascii('{');
  cursor.whitespace();
  if (source.text[cursor.index] !== '}') {
    while (true) {
      const keySpan = cursor.string()!;
      const key = JSON.parse(
        source.text.slice(keySpan.start, keySpan.end),
      ) as string;
      cursor.whitespace();
      cursor.ascii(':');
      const value = cursor.value()!;
      result.set(key, value);
      cursor.whitespace();
      if (source.text[cursor.index] !== ',') break;
      cursor.ascii(',');
      cursor.whitespace();
    }
  }
  cursor.ascii('}');
  if (source.instrumentation) {
    source.instrumentation.indexedObjects += 1;
    source.instrumentation.winningSpans += result.size;
    source.instrumentation.sourceBytesReplayed +=
      span.endByteExclusive - span.startByte;
  }
  return result;
}

function* elements(
  source: IndexedSource,
  span: IndexedSpan,
): Generator<IndexedSpan> {
  const cursor = new JsonSourceCursor(
    source.text,
    span.start,
    span.startByte,
    span.end,
  );
  cursor.ascii('[');
  cursor.whitespace();
  if (source.text[cursor.index] !== ']') {
    while (true) {
      yield cursor.value()!;
      cursor.whitespace();
      if (source.text[cursor.index] !== ',') break;
      cursor.ascii(',');
      cursor.whitespace();
    }
  }
  cursor.ascii(']');
}

function placeholder(span: IndexedSpan): JsonValue {
  if (span.kind === 'null') return null;
  if (span.kind === 'array') return [];
  if (span.kind === 'object') return Object.create(null) as JsonObject;
  if (span.kind === 'string') return '';
  if (span.kind === 'number') return 0;
  return false;
}

function memberValue(
  source: IndexedSource,
  values: ReadonlyMap<string, IndexedSpan>,
  key: string,
): JsonValue | undefined {
  const span = values.get(key);
  return span === undefined
    ? undefined
    : span.kind === 'string' ||
        span.kind === 'number' ||
        span.kind === 'boolean' ||
        span.kind === 'null'
      ? decode(source, span)
      : placeholder(span);
}

function sequence(
  source: IndexedSource,
  span: IndexedSpan,
  kind: IndexedSequence['kind'],
): IndexedSequence {
  return { [sequenceBrand]: true, source, span, kind };
}

function coordinate(
  source: IndexedSource,
  span: IndexedSpan,
): IndexedCoordinateValue {
  return { [coordinateBrand]: true, source, span };
}

function buildProperties(source: IndexedSource, span: IndexedSpan): JsonObject {
  const indexed = members(source, span);
  const result = Object.create(null) as Record<string, JsonValue>;
  for (const key of [...indexed.keys()].sort()) {
    const value = indexed.get(key)!;
    result[key] = source.requirements.propertyValues
      ? decode(source, value)
      : placeholder(value);
  }
  return result;
}

function buildGeometry(
  source: IndexedSource,
  span: IndexedSpan,
  indexed?: ReadonlyMap<string, IndexedSpan>,
): JsonValue {
  if (span.kind !== 'object') return placeholder(span);
  const values = indexed ?? members(source, span);
  const type = memberValue(source, values, 'type');
  const result = Object.create(null) as Record<string, JsonValue>;
  if (type !== undefined) result.type = type;
  const bbox = values.get('bbox');
  if (bbox) result.bbox = decode(source, bbox);
  if (type === 'GeometryCollection') {
    const geometries = values.get('geometries');
    if (geometries) {
      result.geometries = (geometries.kind === 'array'
        ? sequence(source, geometries, 'geometries')
        : placeholder(geometries)) as unknown as JsonValue;
    }
  } else {
    const coordinates = values.get('coordinates');
    if (coordinates) {
      result.coordinates = (coordinates.kind === 'array'
        ? coordinate(source, coordinates)
        : placeholder(coordinates)) as unknown as JsonValue;
      if (coordinates.kind === 'array' && source.instrumentation) {
        source.instrumentation.coordinateSpans += 1;
      }
    }
  }
  return result;
}

function buildFeature(
  source: IndexedSource,
  span: IndexedSpan,
  indexed?: ReadonlyMap<string, IndexedSpan>,
): JsonValue {
  if (span.kind !== 'object') return placeholder(span);
  const values = indexed ?? members(source, span);
  const type = memberValue(source, values, 'type');
  const result = Object.create(null) as Record<string, JsonValue>;
  if (type !== undefined) result.type = type;
  if (type !== 'Feature') return result;
  const id = values.get('id');
  if (id) {
    result.id =
      id.kind === 'string' || id.kind === 'number'
        ? decode(source, id)
        : placeholder(id);
  }
  const bbox = values.get('bbox');
  if (bbox) result.bbox = decode(source, bbox);
  const properties = values.get('properties');
  if (properties) {
    result.properties =
      properties.kind === 'object'
        ? buildProperties(source, properties)
        : properties.kind === 'null'
          ? null
          : placeholder(properties);
  }
  const geometry = values.get('geometry');
  if (geometry) {
    result.geometry =
      geometry.kind === 'null' ? null : buildGeometry(source, geometry);
  }
  featureSpans.set(result, {
    startByte: span.startByte,
    endByteExclusive: span.endByteExclusive,
  });
  return result;
}

function buildRoot(source: IndexedSource, span: IndexedSpan): JsonValue {
  if (span.kind !== 'object') return placeholder(span);
  const indexed = members(source, span);
  const type = memberValue(source, indexed, 'type');
  if (type === 'Feature') return buildFeature(source, span, indexed);
  if (
    typeof type === 'string' &&
    [
      'Point',
      'MultiPoint',
      'LineString',
      'MultiLineString',
      'Polygon',
      'MultiPolygon',
      'GeometryCollection',
    ].includes(type)
  ) {
    return buildGeometry(source, span, indexed);
  }
  const result = Object.create(null) as Record<string, JsonValue>;
  if (type !== undefined) result.type = type;
  if (type === 'FeatureCollection') {
    const bbox = indexed.get('bbox');
    if (bbox) result.bbox = decode(source, bbox);
    const features = indexed.get('features');
    if (features) {
      result.features = (features.kind === 'array'
        ? sequence(source, features, 'features')
        : placeholder(features)) as unknown as JsonValue;
    }
  }
  return result;
}

export function parseIndexedSource(
  text: string,
  requirements: ExecutionRequirements,
  instrumentation?: IndexedInstrumentation,
): {
  readonly value: JsonValue;
  readonly sourceBytes: number;
  readonly duplicateKeys: readonly DuplicateJsonKey[];
} {
  const startedAt = performance.now();
  const cursor = new JsonSourceCursor(text);
  const duplicateKeys: DuplicateJsonKey[] = [];
  const root = cursor.value(true, (occurrence) =>
    duplicateKeys.push(occurrence),
  )!;
  cursor.whitespace();
  if (cursor.index !== text.length) cursor.fail();
  const validatedAt = performance.now();
  if (instrumentation) {
    instrumentation.sourceBytes = cursor.byte;
    instrumentation.syntaxValidationMs = validatedAt - startedAt;
  }
  const source: IndexedSource = {
    text,
    requirements,
    ...(instrumentation ? { instrumentation } : {}),
  };
  const value = buildRoot(source, root);
  if (instrumentation) {
    instrumentation.initialIndexReplayMs = performance.now() - validatedAt;
  }
  return { value, sourceBytes: cursor.byte, duplicateKeys };
}

export function isIndexedSequence(
  value: unknown,
  kind: IndexedSequence['kind'],
): value is IndexedSequence {
  return (
    typeof value === 'object' &&
    value !== null &&
    sequenceBrand in value &&
    (value as IndexedSequence).kind === kind
  );
}

export function* indexedSequenceElements(
  value: IndexedSequence,
): Generator<JsonValue> {
  for (const span of elements(value.source, value.span)) {
    yield value.kind === 'features'
      ? buildFeature(value.source, span)
      : buildGeometry(value.source, span);
  }
}

export function isIndexedCoordinateValue(
  value: unknown,
): value is IndexedCoordinateValue {
  return (
    typeof value === 'object' && value !== null && coordinateBrand in value
  );
}

export function* indexedCoordinateElements(
  value: IndexedCoordinateValue,
): Generator<IndexedCoordinateValue> {
  if (value.span.kind !== 'array') return;
  for (const span of elements(value.source, value.span)) {
    yield coordinate(value.source, span);
  }
}

export function indexedCoordinateKind(
  value: IndexedCoordinateValue,
): 'array' | 'number' | 'other' {
  return value.span.kind === 'array'
    ? 'array'
    : value.span.kind === 'number'
      ? 'number'
      : 'other';
}

export function indexedCoordinateNumber(
  value: IndexedCoordinateValue,
  includeRaw = false,
): { readonly value: number; readonly raw?: string } | undefined {
  if (value.span.kind !== 'number') return undefined;
  const raw = value.source.text.slice(value.span.start, value.span.end);
  return { value: Number(raw), ...(includeRaw ? { raw } : {}) };
}

export function indexedCoordinateSpan(
  value: IndexedCoordinateValue,
): SourceSpan {
  return {
    startByte: value.span.startByte,
    endByteExclusive: value.span.endByteExclusive,
  };
}

export function indexedFeatureSpan(value: object): SourceSpan | undefined {
  return featureSpans.get(value);
}
