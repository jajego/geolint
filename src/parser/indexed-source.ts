import type { PathLike } from 'node:fs';

import type { ExecutionRequirements } from '../engine/requirements.js';
import type { JsonObject, JsonPointer, JsonValue } from '../types/semantic.js';
import {
  ByteSourceMaterializationError,
  fileByteSource,
  memoryByteSource,
  type ByteSource,
} from './byte-source.js';

type IndexedKind =
  'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

interface IndexedSpan {
  readonly startByte: number;
  readonly endByteExclusive: number;
  readonly kind: IndexedKind;
}

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
  readonly bytes: ByteSource;
  readonly requirements: ExecutionRequirements;
  readonly instrumentation?: IndexedInstrumentation;
}

interface SourcePath {
  readonly parent?: SourcePath;
  readonly segment: string | number;
}

export interface DuplicateJsonKey {
  readonly key: string;
  readonly path: JsonPointer;
  readonly byteOffset: number;
}

export class JsonSourceSyntaxError extends Error {
  constructor(readonly byteOffset: number) {
    super('Input is not valid JSON.');
  }
}

export class JsonSourceEncodingError extends Error {
  constructor(readonly byteOffset: number) {
    super('Input is not valid UTF-8.');
  }
}

export {
  ByteSourceMaterializationError,
  JsonSourceSyntaxError as IndexedSyntaxError,
};

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

class ByteCursor {
  index: number;

  constructor(
    private readonly source: ByteSource,
    start = 0,
    private readonly end = source.length,
  ) {
    this.index = start;
  }

  private byte(): number | undefined {
    return this.source.byte(this.index);
  }

  fail(): never {
    throw new JsonSourceSyntaxError(this.index);
  }

  whitespace(): void {
    while (true) {
      const value = this.byte();
      if (value !== 0x20 && value !== 0x09 && value !== 0x0a && value !== 0x0d)
        return;
      this.index += 1;
    }
  }

  ascii(expected?: number): number {
    const value = this.byte();
    if (value === undefined || (expected !== undefined && value !== expected))
      return this.fail();
    this.index += 1;
    return value;
  }

  string(capture = true): IndexedSpan | undefined {
    const startByte = this.index;
    this.ascii(0x22);
    while (this.index < this.end) {
      const value = this.ascii();
      if (value === 0x22)
        return capture
          ? { startByte, endByteExclusive: this.index, kind: 'string' }
          : undefined;
      if (value < 0x20) this.fail();
      if (value === 0x5c) {
        const escape = this.ascii();
        if (escape === 0x75) {
          for (let index = 0; index < 4; index += 1)
            if (!isHex(this.ascii())) this.fail();
        } else if (!'"\\/bfnrt'.includes(String.fromCharCode(escape)))
          this.fail();
      } else if (value >= 0x80) this.index += utf8Width(value) - 1;
    }
    return this.fail();
  }

  number(capture = true): IndexedSpan | undefined {
    const startByte = this.index;
    if (this.byte() === 0x2d) this.ascii();
    if (this.byte() === 0x30) this.ascii();
    else {
      const first = this.byte();
      if (first === undefined || first < 0x31 || first > 0x39) this.fail();
      while (isDigit(this.byte())) this.ascii();
    }
    if (this.byte() === 0x2e) {
      this.ascii();
      if (!isDigit(this.byte())) this.fail();
      while (isDigit(this.byte())) this.ascii();
    }
    if (this.byte() === 0x65 || this.byte() === 0x45) {
      this.ascii();
      if (this.byte() === 0x2b || this.byte() === 0x2d) this.ascii();
      if (!isDigit(this.byte())) this.fail();
      while (isDigit(this.byte())) this.ascii();
    }
    return capture
      ? { startByte, endByteExclusive: this.index, kind: 'number' }
      : undefined;
  }

  literal(
    text: 'true' | 'false' | 'null',
    capture = true,
  ): IndexedSpan | undefined {
    const startByte = this.index;
    for (const character of text) this.ascii(character.charCodeAt(0));
    return capture
      ? {
          startByte,
          endByteExclusive: this.index,
          kind: text === 'null' ? 'null' : 'boolean',
        }
      : undefined;
  }

  value(
    capture = true,
    duplicate?: (occurrence: DuplicateJsonKey) => void,
  ): IndexedSpan | undefined {
    this.whitespace();
    const startByte = this.index;
    const first = this.byte();
    if (first === 0x22) return this.string(capture);
    if (first === 0x2d || isDigit(first)) return this.number(capture);
    if (first === 0x74) return this.literal('true', capture);
    if (first === 0x66) return this.literal('false', capture);
    if (first === 0x6e) return this.literal('null', capture);
    if (first !== 0x5b && first !== 0x7b) return this.fail();
    const arrayFirst = 0,
      arrayValue = 1,
      arrayAfter = 2;
    const objectFirst = 3,
      objectKey = 4,
      objectColon = 5,
      objectValue = 6,
      objectAfter = 7;
    const kind: IndexedKind = first === 0x5b ? 'array' : 'object';
    const stack: {
      state: number;
      path?: SourcePath;
      arrayIndex?: number;
      key?: string;
      keys?: Set<string>;
    }[] = [
      {
        state: first === 0x5b ? arrayFirst : objectFirst,
        ...(duplicate && first === 0x5b ? { arrayIndex: 0 } : {}),
        ...(duplicate && first === 0x7b ? { keys: new Set() } : {}),
      },
    ];
    this.ascii(first);
    const appendPath = (
      parent: SourcePath | undefined,
      segment: string | number,
    ): SourcePath => ({ ...(parent ? { parent } : {}), segment });
    const consumeValue = (path?: SourcePath): void => {
      this.whitespace();
      const next = this.byte();
      if (next === 0x22) this.string(false);
      else if (next === 0x2d || isDigit(next)) this.number(false);
      else if (next === 0x74) this.literal('true', false);
      else if (next === 0x66) this.literal('false', false);
      else if (next === 0x6e) this.literal('null', false);
      else if (next === 0x5b || next === 0x7b) {
        this.ascii(next);
        stack.push({
          state: next === 0x5b ? arrayFirst : objectFirst,
          ...(path ? { path } : {}),
          ...(duplicate && next === 0x5b ? { arrayIndex: 0 } : {}),
          ...(duplicate && next === 0x7b ? { keys: new Set() } : {}),
        });
      } else this.fail();
    };
    while (stack.length > 0) {
      const frame = stack.at(-1)!;
      this.whitespace();
      if (frame.state <= arrayAfter) {
        if (frame.state === arrayFirst && this.byte() === 0x5d) {
          this.ascii();
          stack.pop();
        } else if (frame.state === arrayFirst || frame.state === arrayValue) {
          frame.state = arrayAfter;
          if (duplicate) {
            const index = frame.arrayIndex!;
            frame.arrayIndex = index + 1;
            consumeValue(appendPath(frame.path, index));
          } else consumeValue();
        } else if (this.byte() === 0x2c) {
          this.ascii();
          frame.state = arrayValue;
        } else if (this.byte() === 0x5d) {
          this.ascii();
          stack.pop();
        } else this.fail();
      } else if (frame.state === objectFirst && this.byte() === 0x7d) {
        this.ascii();
        stack.pop();
      } else if (frame.state === objectFirst || frame.state === objectKey) {
        if (this.byte() !== 0x22) this.fail();
        if (duplicate) {
          const keySpan = this.string()!;
          const key = JSON.parse(
            this.source.text(keySpan.startByte, keySpan.endByteExclusive),
          ) as string;
          if (frame.keys!.has(key))
            duplicate({
              key,
              path: renderPath(appendPath(frame.path, key)),
              byteOffset: keySpan.startByte,
            });
          else frame.keys!.add(key);
          frame.key = key;
        } else this.string(false);
        frame.state = objectColon;
      } else if (frame.state === objectColon) {
        this.ascii(0x3a);
        frame.state = objectValue;
      } else if (frame.state === objectValue) {
        frame.state = objectAfter;
        consumeValue(
          duplicate ? appendPath(frame.path, frame.key!) : undefined,
        );
      } else if (this.byte() === 0x2c) {
        this.ascii();
        frame.state = objectKey;
      } else if (this.byte() === 0x7d) {
        this.ascii();
        stack.pop();
      } else this.fail();
    }
    return capture
      ? { startByte, endByteExclusive: this.index, kind }
      : undefined;
  }
}

function validateUtf8(source: ByteSource): void {
  for (let offset = 0; offset < source.length;) {
    const first = source.byte(offset)!;
    if (first <= 0x7f) {
      offset += 1;
      continue;
    }
    const width = utf8Width(first);
    const second = source.byte(offset + 1);
    const third = source.byte(offset + 2);
    const fourth = source.byte(offset + 3);
    const continuation = (value: number | undefined) =>
      value !== undefined && value >= 0x80 && value <= 0xbf;
    const valid =
      (width === 2 && continuation(second)) ||
      (width === 3 &&
        continuation(second) &&
        continuation(third) &&
        (first !== 0xe0 || second! >= 0xa0) &&
        (first !== 0xed || second! <= 0x9f)) ||
      (width === 4 &&
        continuation(second) &&
        continuation(third) &&
        continuation(fourth) &&
        (first !== 0xf0 || second! >= 0x90) &&
        (first !== 0xf4 || second! <= 0x8f));
    if (!valid) throw new JsonSourceEncodingError(offset);
    offset += width;
  }
}

function utf8Width(first: number): number {
  if (first >= 0xc2 && first <= 0xdf) return 2;
  if (first >= 0xe0 && first <= 0xef) return 3;
  if (first >= 0xf0 && first <= 0xf4) return 4;
  return 0;
}

function isDigit(value: number | undefined): boolean {
  return value !== undefined && value >= 0x30 && value <= 0x39;
}

function isHex(value: number): boolean {
  return (
    (value >= 0x30 && value <= 0x39) ||
    (value >= 0x41 && value <= 0x46) ||
    (value >= 0x61 && value <= 0x66)
  );
}

function escapePathSegment(segment: string | number): string | number {
  if (typeof segment === 'number') return segment;
  return segment.includes('~') || segment.includes('/')
    ? segment.replaceAll('~', '~0').replaceAll('/', '~1')
    : segment;
}

function renderPath(path: SourcePath): JsonPointer {
  const segments: (string | number)[] = [];
  for (
    let current: SourcePath | undefined = path;
    current;
    current = current.parent
  )
    segments.push(current.segment);
  return `/${segments.toReversed().map(escapePathSegment).join('/')}` as JsonPointer;
}

function decode(source: IndexedSource, span: IndexedSpan): JsonValue {
  return JSON.parse(
    source.bytes.text(span.startByte, span.endByteExclusive),
  ) as JsonValue;
}

function members(
  source: IndexedSource,
  span: IndexedSpan,
): ReadonlyMap<string, IndexedSpan> {
  const cursor = new ByteCursor(
    source.bytes,
    span.startByte,
    span.endByteExclusive,
  );
  const result = new Map<string, IndexedSpan>();
  cursor.ascii(0x7b);
  cursor.whitespace();
  if (source.bytes.byte(cursor.index) !== 0x7d) {
    while (true) {
      const keySpan = cursor.string()!;
      const key = JSON.parse(
        source.bytes.text(keySpan.startByte, keySpan.endByteExclusive),
      ) as string;
      cursor.whitespace();
      cursor.ascii(0x3a);
      result.set(key, cursor.value()!);
      cursor.whitespace();
      if (source.bytes.byte(cursor.index) !== 0x2c) break;
      cursor.ascii();
      cursor.whitespace();
    }
  }
  cursor.ascii(0x7d);
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
  const cursor = new ByteCursor(
    source.bytes,
    span.startByte,
    span.endByteExclusive,
  );
  cursor.ascii(0x5b);
  cursor.whitespace();
  if (source.bytes.byte(cursor.index) !== 0x5d) {
    while (true) {
      yield cursor.value()!;
      cursor.whitespace();
      if (source.bytes.byte(cursor.index) !== 0x2c) break;
      cursor.ascii();
      cursor.whitespace();
    }
  }
  cursor.ascii(0x5d);
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
  if (!span) return undefined;
  return span.kind === 'string' ||
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
    if (geometries)
      result.geometries = (geometries.kind === 'array'
        ? sequence(source, geometries, 'geometries')
        : placeholder(geometries)) as unknown as JsonValue;
  } else {
    const coordinates = values.get('coordinates');
    if (coordinates) {
      result.coordinates = (coordinates.kind === 'array'
        ? coordinate(source, coordinates)
        : placeholder(coordinates)) as unknown as JsonValue;
      if (coordinates.kind === 'array' && source.instrumentation)
        source.instrumentation.coordinateSpans += 1;
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
  if (id)
    result.id =
      id.kind === 'string' || id.kind === 'number'
        ? decode(source, id)
        : placeholder(id);
  const bbox = values.get('bbox');
  if (bbox) result.bbox = decode(source, bbox);
  const properties = values.get('properties');
  if (properties)
    result.properties =
      properties.kind === 'object'
        ? buildProperties(source, properties)
        : properties.kind === 'null'
          ? null
          : placeholder(properties);
  const geometry = values.get('geometry');
  if (geometry)
    result.geometry =
      geometry.kind === 'null' ? null : buildGeometry(source, geometry);
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
  )
    return buildGeometry(source, span, indexed);
  const result = Object.create(null) as Record<string, JsonValue>;
  if (type !== undefined) result.type = type;
  if (type === 'FeatureCollection') {
    const bbox = indexed.get('bbox');
    if (bbox) result.bbox = decode(source, bbox);
    const features = indexed.get('features');
    if (features)
      result.features = (features.kind === 'array'
        ? sequence(source, features, 'features')
        : placeholder(features)) as unknown as JsonValue;
  }
  return result;
}

export interface IndexedParseResult {
  readonly value: JsonValue;
  readonly sourceBytes: number;
  readonly duplicateKeys: readonly DuplicateJsonKey[];
  close(): void;
}

function parse(
  sourceBytes: ByteSource,
  requirements: ExecutionRequirements,
  instrumentation?: IndexedInstrumentation,
): IndexedParseResult {
  const startedAt = performance.now();
  validateUtf8(sourceBytes);
  const cursor = new ByteCursor(sourceBytes);
  const duplicateKeys: DuplicateJsonKey[] = [];
  const root = cursor.value(true, (occurrence) =>
    duplicateKeys.push(occurrence),
  )!;
  cursor.whitespace();
  if (cursor.index !== sourceBytes.length) cursor.fail();
  const validatedAt = performance.now();
  if (instrumentation) {
    instrumentation.sourceBytes = sourceBytes.length;
    instrumentation.syntaxValidationMs = validatedAt - startedAt;
  }
  const source: IndexedSource = {
    bytes: sourceBytes,
    requirements,
    ...(instrumentation ? { instrumentation } : {}),
  };
  const value = buildRoot(source, root);
  if (instrumentation)
    instrumentation.initialIndexReplayMs = performance.now() - validatedAt;
  return {
    value,
    sourceBytes: sourceBytes.length,
    duplicateKeys,
    close: () => sourceBytes.close(),
  };
}

export function parseIndexedSource(
  text: string,
  requirements: ExecutionRequirements,
  instrumentation?: IndexedInstrumentation,
): IndexedParseResult {
  return parse(memoryByteSource(text), requirements, instrumentation);
}

export function parseIndexedFileSource(
  path: PathLike,
  requirements: ExecutionRequirements,
  instrumentation?: IndexedInstrumentation,
  windowBytes?: number,
): IndexedParseResult {
  const source = fileByteSource(path, windowBytes);
  try {
    return parse(source, requirements, instrumentation);
  } catch (error) {
    source.close();
    throw error;
  }
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
  for (const span of elements(value.source, value.span))
    yield value.kind === 'features'
      ? buildFeature(value.source, span)
      : buildGeometry(value.source, span);
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
  for (const span of elements(value.source, value.span))
    yield coordinate(value.source, span);
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
  return value.source.bytes.number(
    value.span.startByte,
    value.span.endByteExclusive,
    includeRaw,
  );
}

export function indexedCoordinateDirectPosition(
  value: IndexedCoordinateValue,
): readonly number[] | undefined {
  if (value.span.kind !== 'array') return undefined;
  const values: number[] = [];
  for (const span of elements(value.source, value.span)) {
    if (span.kind !== 'number') return undefined;
    const number = value.source.bytes.number(
      span.startByte,
      span.endByteExclusive,
      false,
    );
    if (!Number.isFinite(number.value)) return undefined;
    values.push(number.value);
  }
  return values.length < 2 ? undefined : values;
}

export function indexedCoordinateUsesByteDirect(
  value: IndexedCoordinateValue,
): boolean {
  return !value.source.bytes.directText;
}

export function indexedCoordinateSpan(
  value: IndexedCoordinateValue,
): SourceSpan {
  return {
    startByte: value.span.startByte,
    endByteExclusive: value.span.endByteExclusive,
  };
}

export function indexedCoordinateTextSpan(
  value: IndexedCoordinateValue,
):
  | { readonly text: string; readonly start: number; readonly end: number }
  | undefined {
  if (!value.source.bytes.directText) return undefined;
  const text = value.source.bytes.text(
    value.span.startByte,
    value.span.endByteExclusive,
  );
  return { text, start: 0, end: text.length };
}

export function indexedCoordinateByteSpan(value: IndexedCoordinateValue):
  | {
      readonly source: ByteSource;
      readonly start: number;
      readonly end: number;
    }
  | undefined {
  if (value.source.bytes.directText) return undefined;
  return {
    source: value.source.bytes,
    start: value.span.startByte,
    end: value.span.endByteExclusive,
  };
}

export function indexedCoordinateSupportsDirect(
  value: IndexedCoordinateValue,
): boolean {
  void value;
  return true;
}

export function indexedFeatureSpan(value: object): SourceSpan | undefined {
  return featureSpans.get(value);
}
