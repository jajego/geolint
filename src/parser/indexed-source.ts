import type { ExecutionRequirements } from '../engine/requirements.js';
import type { JsonObject, JsonPointer, JsonValue } from '../types/semantic.js';

type JsonTokenKind =
  'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

interface IndexedSpan {
  readonly start: number;
  readonly end: number;
  readonly startByte: number;
  readonly endByteExclusive: number;
  readonly kind: JsonTokenKind;
}

export interface SourceSpan {
  readonly startByte: number;
  readonly endByteExclusive: number;
}

export interface DuplicateJsonKey {
  readonly key: string;
  readonly path: JsonPointer;
  readonly byteOffset: number;
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

export class IndexedSyntaxError extends Error {
  constructor(readonly byteOffset: number) {
    super('Input is not valid JSON.');
  }
}

class Cursor {
  index: number;
  byte: number;

  constructor(
    readonly text: string,
    index = 0,
    byte = 0,
    readonly end = text.length,
  ) {
    this.index = index;
    this.byte = byte;
  }

  fail(): never {
    throw new IndexedSyntaxError(this.byte);
  }

  whitespace(): void {
    while (this.index < this.end) {
      const code = this.text.charCodeAt(this.index);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)
        return;
      this.index += 1;
      this.byte += 1;
    }
  }

  ascii(expected?: string): string {
    const value = this.text[this.index];
    if (value === undefined || (expected !== undefined && value !== expected))
      return this.fail();
    this.index += 1;
    this.byte += 1;
    return value;
  }

  unicode(): void {
    const first = this.text.charCodeAt(this.index);
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = this.text.charCodeAt(this.index + 1);
      if (second >= 0xdc00 && second <= 0xdfff) {
        this.index += 2;
        this.byte += 4;
        return;
      }
    }
    this.index += 1;
    this.byte += first <= 0x7f ? 1 : first <= 0x7ff ? 2 : 3;
  }

  string(capture = true): IndexedSpan | undefined {
    const start = this.index;
    const startByte = this.byte;
    this.ascii('"');
    while (this.index < this.end) {
      const code = this.text.charCodeAt(this.index);
      if (code === 0x22) {
        this.ascii('"');
        return capture
          ? {
              start,
              end: this.index,
              startByte,
              endByteExclusive: this.byte,
              kind: 'string',
            }
          : undefined;
      }
      if (code < 0x20) this.fail();
      if (code === 0x5c) {
        this.ascii('\\');
        const escape = this.ascii();
        if ('"\\/bfnrt'.includes(escape)) continue;
        if (escape !== 'u') this.fail();
        for (let index = 0; index < 4; index += 1) {
          const hex = this.ascii();
          if (!/[0-9a-fA-F]/.test(hex)) this.fail();
        }
        continue;
      }
      this.unicode();
    }
    return this.fail();
  }

  number(capture = true): IndexedSpan | undefined {
    const start = this.index;
    const startByte = this.byte;
    if (this.text[this.index] === '-') this.ascii('-');
    if (this.text[this.index] === '0') this.ascii('0');
    else {
      const first = this.text.charCodeAt(this.index);
      if (first < 0x31 || first > 0x39) this.fail();
      while (isDigit(this.text.charCodeAt(this.index))) this.ascii();
    }
    if (this.text[this.index] === '.') {
      this.ascii('.');
      if (!isDigit(this.text.charCodeAt(this.index))) this.fail();
      while (isDigit(this.text.charCodeAt(this.index))) this.ascii();
    }
    if (this.text[this.index] === 'e' || this.text[this.index] === 'E') {
      this.ascii();
      if (this.text[this.index] === '+' || this.text[this.index] === '-')
        this.ascii();
      if (!isDigit(this.text.charCodeAt(this.index))) this.fail();
      while (isDigit(this.text.charCodeAt(this.index))) this.ascii();
    }
    return capture
      ? {
          start,
          end: this.index,
          startByte,
          endByteExclusive: this.byte,
          kind: 'number',
        }
      : undefined;
  }

  literal(
    text: 'true' | 'false' | 'null',
    capture = true,
  ): IndexedSpan | undefined {
    const start = this.index;
    const startByte = this.byte;
    for (const character of text) this.ascii(character);
    return capture
      ? {
          start,
          end: this.index,
          startByte,
          endByteExclusive: this.byte,
          kind: text === 'null' ? 'null' : 'boolean',
        }
      : undefined;
  }

  value(
    capture = true,
    duplicate?: (occurrence: DuplicateJsonKey) => void,
  ): IndexedSpan | undefined {
    this.whitespace();
    const start = this.index;
    const startByte = this.byte;
    const character = this.text[this.index];
    if (character === '"') return this.string(capture);
    if (character === '-' || isDigit(this.text.charCodeAt(this.index)))
      return this.number(capture);
    if (character === 't') return this.literal('true', capture);
    if (character === 'f') return this.literal('false', capture);
    if (character === 'n') return this.literal('null', capture);
    if (character !== '[' && character !== '{') return this.fail();

    const arrayFirst = 0;
    const arrayValue = 1;
    const arrayAfter = 2;
    const objectFirst = 3;
    const objectKey = 4;
    const objectColon = 5;
    const objectValue = 6;
    const objectAfter = 7;
    const kind = character === '[' ? 'array' : 'object';
    const stack: {
      state: number;
      path: JsonPointer;
      arrayIndex?: number;
      key?: string;
      keys?: Set<string>;
    }[] = [
      {
        state: character === '[' ? arrayFirst : objectFirst,
        path: '' as JsonPointer,
        ...(duplicate && character === '[' ? { arrayIndex: 0 } : {}),
        ...(duplicate && character === '{' ? { keys: new Set() } : {}),
      },
    ];
    this.ascii(character);

    const appendPath = (path: JsonPointer, segment: string | number) =>
      `${path}/${
        typeof segment === 'number'
          ? segment
          : segment.includes('~') || segment.includes('/')
            ? segment.replaceAll('~', '~0').replaceAll('/', '~1')
            : segment
      }` as JsonPointer;

    const consumeValue = (path: JsonPointer): void => {
      this.whitespace();
      const next = this.text[this.index];
      if (next === '"') this.string(false);
      else if (next === '-' || isDigit(this.text.charCodeAt(this.index)))
        this.number(false);
      else if (next === 't') this.literal('true', false);
      else if (next === 'f') this.literal('false', false);
      else if (next === 'n') this.literal('null', false);
      else if (next === '[' || next === '{') {
        this.ascii(next);
        stack.push({
          state: next === '[' ? arrayFirst : objectFirst,
          path,
          ...(duplicate && next === '[' ? { arrayIndex: 0 } : {}),
          ...(duplicate && next === '{' ? { keys: new Set() } : {}),
        });
      } else this.fail();
    };

    while (stack.length > 0) {
      const last = stack.length - 1;
      const frame = stack[last]!;
      const state = frame.state;
      this.whitespace();
      if (state <= arrayAfter) {
        if (state === arrayFirst && this.text[this.index] === ']') {
          this.ascii(']');
          stack.pop();
        } else if (state === arrayFirst || state === arrayValue) {
          frame.state = arrayAfter;
          if (duplicate) {
            const index = frame.arrayIndex!;
            frame.arrayIndex = index + 1;
            consumeValue(appendPath(frame.path, index));
          } else consumeValue(frame.path);
        } else if (this.text[this.index] === ',') {
          this.ascii(',');
          frame.state = arrayValue;
        } else if (this.text[this.index] === ']') {
          this.ascii(']');
          stack.pop();
        } else this.fail();
      } else if (state === objectFirst && this.text[this.index] === '}') {
        this.ascii('}');
        stack.pop();
      } else if (state === objectFirst || state === objectKey) {
        if (this.text[this.index] !== '"') this.fail();
        if (duplicate) {
          const keySpan = this.string()!;
          const key = JSON.parse(
            this.text.slice(keySpan.start, keySpan.end),
          ) as string;
          if (frame.keys!.has(key)) {
            duplicate({
              key,
              path: appendPath(frame.path, key),
              byteOffset: keySpan.startByte,
            });
          } else frame.keys!.add(key);
          frame.key = key;
        } else this.string(false);
        frame.state = objectColon;
      } else if (state === objectColon) {
        this.ascii(':');
        frame.state = objectValue;
      } else if (state === objectValue) {
        frame.state = objectAfter;
        consumeValue(
          duplicate ? appendPath(frame.path, frame.key!) : frame.path,
        );
      } else if (this.text[this.index] === ',') {
        this.ascii(',');
        frame.state = objectKey;
      } else if (this.text[this.index] === '}') {
        this.ascii('}');
        stack.pop();
      } else this.fail();
    }

    return capture
      ? {
          start,
          end: this.index,
          startByte,
          endByteExclusive: this.byte,
          kind,
        }
      : undefined;
  }
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function decode(source: IndexedSource, span: IndexedSpan): JsonValue {
  return JSON.parse(source.text.slice(span.start, span.end)) as JsonValue;
}

function members(
  source: IndexedSource,
  span: IndexedSpan,
): ReadonlyMap<string, IndexedSpan> {
  const cursor = new Cursor(source.text, span.start, span.startByte, span.end);
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
  const cursor = new Cursor(source.text, span.start, span.startByte, span.end);
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
  const cursor = new Cursor(text);
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

/** Finds duplicate object keys without retaining an indexed source tree. */
export function findDuplicateJSONKeys(
  text: string,
): readonly DuplicateJsonKey[] {
  const cursor = new Cursor(text);
  const duplicateKeys: DuplicateJsonKey[] = [];
  cursor.value(false, (occurrence) => duplicateKeys.push(occurrence));
  cursor.whitespace();
  if (cursor.index !== text.length) cursor.fail();
  return duplicateKeys;
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
