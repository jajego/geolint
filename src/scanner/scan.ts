import { DiagnosticCollector } from '../engine/diagnostics.js';
import type {
  ExecutionRequirements,
  SemanticListener,
} from '../engine/requirements.js';
import { appendPointer, jsonPointer } from './json-pointer.js';
import {
  indexedCoordinateElements,
  indexedCoordinateKind,
  indexedCoordinateNumber,
  indexedCoordinateSpan,
  indexedFeatureSpan,
  indexedSequenceElements,
  isIndexedCoordinateValue,
  isIndexedSequence,
  type IndexedCoordinateValue,
} from '../parser/indexed-source.js';
import type {
  CoordinateDimensions,
  FileSummary,
  GeographicExtent,
  GeoJSONGeometryType,
  GeometrySummary,
  JsonObject,
  JsonPointer,
  JsonValue,
  JsonValueType,
  PropertyStats,
  SummaryFactName,
} from '../types/semantic.js';

const geometryTypes = new Set<string>([
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
  'GeometryCollection',
]);

interface MutableDimensions {
  two: number;
  three: number;
  fourOrMore: number;
}

interface MutableBounds {
  minX: number;
  maxX: number;
  minShiftedX: number;
  maxShiftedX: number;
  minY: number;
  maxY: number;
}

interface GeometryMetrics {
  type: GeoJSONGeometryType;
  path: GeometryPath;
  vertices: number;
  ringCount: number;
  geometryNodeCount: number;
  dimensions: MutableDimensions;
  bounds?: MutableBounds;
  complete: boolean;
}

interface GeometryPathFrame {
  readonly parent: GeometryPath;
  readonly segment: string | number;
}

type GeometryPath = JsonPointer | GeometryPathFrame;

interface GeometryFrame {
  readonly kind: 'geometry';
  readonly value: JsonValue;
  readonly path: GeometryPath;
  readonly parent?: GeometryCollectionFrame;
}

interface GeometryCollectionFrame {
  readonly kind: 'collection';
  readonly metrics: GeometryMetrics;
  readonly geometries: Iterator<JsonValue>;
  readonly geometriesPath: GeometryPath;
  readonly parent?: GeometryCollectionFrame;
  index: number;
}

interface MutablePropertyStats {
  present: number;
  types: Map<JsonValueType, number>;
}

interface ScanState {
  readonly filePath: string;
  readonly requirements: ExecutionRequirements;
  readonly listener?: SemanticListener;
  readonly instrumentation?: ScanInstrumentation;
  readonly coordinateObservation?: CoordinateObservation;
  readonly coordinateLexemeObservation?: CoordinateLexemeObservation;
  readonly featureIdObservation?: FeatureIdObservation;
  readonly featureByteObservation?: FeatureByteObservation;
  readonly diagnostics: DiagnosticCollector;
  readonly partialFacts: Set<SummaryFactName>;
  documentPartial: boolean;
  featureCount: number;
  validPropertiesFeatureCount: number;
  totalVertices: number;
  largestFeatureVertices: number;
  largestFeatureBytes: number;
  featureByteStatsPartial: boolean;
  propertiesNullCount: number;
  nullGeometryCount: number;
  readonly dimensions: MutableDimensions;
  bounds?: MutableBounds;
  readonly propertyStats: Map<string, MutablePropertyStats>;
  readonly featureGeometryTypes: Map<GeoJSONGeometryType | 'null', number>;
  readonly geometryNodeTypes: Map<GeoJSONGeometryType, number>;
  idPresent: number;
  idMissing: number;
  idDuplicates: number;
  idStrings: number;
  idNumbers: number;
  readonly ids: Set<string>;
}

export interface ScanInstrumentation {
  coordinateTraversals: number;
  positionVisits: number;
  coordinatePathMaterializations: number;
  propertyPathMaterializations: number;
  rawLexemeCollections?: number;
  coordinateLexemeEvents?: number;
}

export interface ScanOptions {
  readonly filePath: string;
  readonly requirements: ExecutionRequirements;
  readonly listener?: SemanticListener;
  readonly sourceBytes?: number;
  readonly instrumentation?: ScanInstrumentation;
  readonly coordinateObservation?: CoordinateObservation;
  readonly coordinateLexemeObservation?: CoordinateLexemeObservation;
  readonly featureIdObservation?: FeatureIdObservation;
  readonly featureByteObservation?: FeatureByteObservation;
  readonly diagnostics?: DiagnosticCollector;
}

export type CoordinateObservation = (
  values: readonly number[],
  featureIndex: number | undefined,
  parentPath: JsonPointer,
  positionIndex: number | undefined,
) => void;

export type CoordinateLexemeObservation = (
  rawValues: readonly string[],
  featureIndex: number | undefined,
  parentPath: JsonPointer,
  positionIndex: number | undefined,
  byteOffset: number,
) => void;

export type FeatureIdObservation = (
  index: number,
  path: JsonPointer,
  status: 'missing' | 'valid' | 'invalid',
  id: string | number | undefined,
) => void;

export type FeatureByteObservation = (
  index: number,
  path: JsonPointer,
  bytes: number,
  byteOffset: number,
  id: string | number | undefined,
) => void;

function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const semanticFacts: readonly SummaryFactName[] = [
  'featureCount',
  'vertexCount',
  'propertyStats',
  'geometryStats',
  'idStats',
  'coordinateDimensionStats',
  'derivedExtent',
];

function damage(state: ScanState, ...facts: readonly SummaryFactName[]): void {
  state.documentPartial = true;
  for (const fact of facts) state.partialFacts.add(fact);
}

function report(
  state: ScanState,
  code: string,
  message: string,
  path: JsonPointer | (() => JsonPointer),
  featureIndex?: number,
): void {
  state.documentPartial = true;
  state.diagnostics.reportLazy({ code, source: 'geojson' }, () => ({
    message,
    path: typeof path === 'function' ? path() : path,
    ...(featureIndex === undefined ? {} : { featureIndex }),
  }));
}

function ownMember(object: JsonObject, key: string): JsonValue | undefined {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

function appendGeometryPath(
  path: GeometryPath,
  segment: string | number,
): GeometryPathFrame {
  return { parent: path, segment };
}

function materializeGeometryPath(path: GeometryPath): JsonPointer {
  if (typeof path === 'string') return path;
  const segments: (string | number)[] = [];
  let current: GeometryPath = path;
  while (typeof current !== 'string') {
    segments.push(current.segment);
    current = current.parent;
  }
  let pointer = current;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    pointer = appendPointer(pointer, segments[index]!);
  }
  return pointer;
}

function validateBbox(
  object: JsonObject,
  path: GeometryPath,
  state: ScanState,
  featureIndex?: number,
): void {
  const bbox = ownMember(object, 'bbox');
  if (bbox === undefined) return;
  const valid =
    Array.isArray(bbox) &&
    bbox.length >= 4 &&
    bbox.length % 2 === 0 &&
    bbox.every((value) => typeof value === 'number' && Number.isFinite(value));
  if (!valid) {
    report(
      state,
      'geojson/invalid-bbox',
      'Expected bbox to contain an even number of at least four finite numbers.',
      appendPointer(materializeGeometryPath(path), 'bbox'),
      featureIndex,
    );
  }
}

function valueType(value: JsonValue): JsonValueType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value as Exclude<JsonValueType, 'null' | 'array'>;
}

function increment<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function emptyDimensions(): MutableDimensions {
  return { two: 0, three: 0, fourOrMore: 0 };
}

function addDimensions(
  target: MutableDimensions,
  source: MutableDimensions,
): void {
  target.two += source.two;
  target.three += source.three;
  target.fourOrMore += source.fourOrMore;
}

function summarizeDimensions(value: MutableDimensions): CoordinateDimensions {
  const observed =
    Number(value.two > 0) +
    Number(value.three > 0) +
    Number(value.fourOrMore > 0);
  if (observed !== 1) return 'mixed';
  return value.two > 0 ? 2 : value.three > 0 ? 3 : '4+';
}

function updateBounds(
  bounds: MutableBounds | undefined,
  x: number,
  y: number,
): MutableBounds {
  const shiftedX = x < 0 ? x + 360 : x;
  if (!bounds) {
    return {
      minX: x,
      maxX: x,
      minShiftedX: shiftedX,
      maxShiftedX: shiftedX,
      minY: y,
      maxY: y,
    };
  }
  if (x < bounds.minX) bounds.minX = x;
  if (x > bounds.maxX) bounds.maxX = x;
  if (shiftedX < bounds.minShiftedX) bounds.minShiftedX = shiftedX;
  if (shiftedX > bounds.maxShiftedX) bounds.maxShiftedX = shiftedX;
  if (y < bounds.minY) bounds.minY = y;
  if (y > bounds.maxY) bounds.maxY = y;
  return bounds;
}

function mergeBounds(
  target: MutableBounds | undefined,
  source: MutableBounds | undefined,
): MutableBounds | undefined {
  if (!source) return target;
  if (!target) return { ...source };
  target.minX = Math.min(target.minX, source.minX);
  target.maxX = Math.max(target.maxX, source.maxX);
  target.minShiftedX = Math.min(target.minShiftedX, source.minShiftedX);
  target.maxShiftedX = Math.max(target.maxShiftedX, source.maxShiftedX);
  target.minY = Math.min(target.minY, source.minY);
  target.maxY = Math.max(target.maxY, source.maxY);
  return target;
}

function extent(
  bounds: MutableBounds | undefined,
): GeographicExtent | undefined {
  if (!bounds) return undefined;
  const ordinarySpan = bounds.maxX - bounds.minX;
  const shiftedSpan = bounds.maxShiftedX - bounds.minShiftedX;
  if (shiftedSpan < ordinarySpan) {
    const west =
      bounds.minShiftedX > 180 ? bounds.minShiftedX - 360 : bounds.minShiftedX;
    const east =
      bounds.maxShiftedX > 180 ? bounds.maxShiftedX - 360 : bounds.maxShiftedX;
    return {
      west,
      east,
      south: bounds.minY,
      north: bounds.maxY,
      crossesAntimeridian: west > east,
    };
  }
  return {
    west: bounds.minX,
    east: bounds.maxX,
    south: bounds.minY,
    north: bounds.maxY,
    crossesAntimeridian: false,
  };
}

function geometrySummary(metrics: GeometryMetrics): GeometrySummary {
  const geographicExtent = extent(metrics.bounds);
  return {
    type: metrics.type,
    path: materializeGeometryPath(metrics.path),
    vertices: metrics.vertices,
    ringCount: metrics.ringCount,
    geometryNodeCount: metrics.geometryNodeCount,
    coordinateDimensions: summarizeDimensions(metrics.dimensions),
    ...(geographicExtent ? { extent: geographicExtent } : {}),
  };
}

function positionPath(
  parentPath: JsonPointer,
  index: number | undefined,
  state: ScanState,
): JsonPointer {
  if (state.instrumentation) {
    state.instrumentation.coordinatePathMaterializations += 1;
  }
  return index === undefined ? parentPath : appendPointer(parentPath, index);
}

function invalidPosition(
  parentPath: JsonPointer,
  positionIndex: number | undefined,
  featureIndex: number | undefined,
  metrics: GeometryMetrics,
  state: ScanState,
): void {
  metrics.complete = false;
  damage(state, 'vertexCount', 'coordinateDimensionStats', 'derivedExtent');
  report(
    state,
    'geojson/invalid-position',
    'Expected a coordinate Position containing at least two finite numeric ordinates.',
    () => positionPath(parentPath, positionIndex, state),
    featureIndex,
  );
}

type CoordinateValue = JsonValue | IndexedCoordinateValue;

function isCoordinateArray(
  value: CoordinateValue | undefined,
): value is JsonValue[] | IndexedCoordinateValue {
  return (
    Array.isArray(value) ||
    (isIndexedCoordinateValue(value) &&
      indexedCoordinateKind(value) === 'array')
  );
}

function* coordinateElements(
  value: JsonValue[] | IndexedCoordinateValue,
): Generator<CoordinateValue> {
  if (Array.isArray(value)) {
    yield* value;
  } else {
    yield* indexedCoordinateElements(value);
  }
}

function positionValues(
  value: JsonValue[] | IndexedCoordinateValue,
  state: ScanState,
  collectRaw = state.requirements.numericLexemes,
):
  | {
      readonly values: readonly number[];
      readonly rawValues?: readonly string[];
      readonly byteOffset?: number;
    }
  | undefined {
  if (Array.isArray(value)) {
    if (
      value.length < 2 ||
      value.some(
        (ordinate) =>
          typeof ordinate !== 'number' || !Number.isFinite(ordinate),
      )
    ) {
      return undefined;
    }
    return { values: value as number[] };
  }
  const values: number[] = [];
  const rawValues: string[] | undefined = collectRaw ? [] : undefined;
  if (rawValues && state.instrumentation) {
    state.instrumentation.rawLexemeCollections =
      (state.instrumentation.rawLexemeCollections ?? 0) + 1;
  }
  for (const ordinate of indexedCoordinateElements(value)) {
    const number = indexedCoordinateNumber(ordinate, collectRaw);
    if (!number || !Number.isFinite(number.value)) return undefined;
    values.push(number.value);
    if (rawValues) rawValues.push(number.raw!);
  }
  if (values.length < 2) return undefined;
  return {
    values,
    ...(rawValues ? { rawValues } : {}),
    byteOffset: indexedCoordinateSpan(value).startByte,
  };
}

function visitPosition(
  value: CoordinateValue,
  parentPath: JsonPointer,
  positionIndex: number | undefined,
  featureIndex: number | undefined,
  metrics: GeometryMetrics,
  state: ScanState,
): void {
  if (!isCoordinateArray(value)) {
    if (state.instrumentation) state.instrumentation.positionVisits += 1;
    invalidPosition(parentPath, positionIndex, featureIndex, metrics, state);
    return;
  }
  const position = positionValues(value, state);
  if (!position) {
    if (state.instrumentation) state.instrumentation.positionVisits += 1;
    invalidPosition(parentPath, positionIndex, featureIndex, metrics, state);
    return;
  }

  if (state.instrumentation) state.instrumentation.positionVisits += 1;
  metrics.vertices += 1;
  if (state.requirements.vertexCounts) state.totalVertices += 1;
  const dimensionKey =
    position.values.length === 2
      ? 'two'
      : position.values.length === 3
        ? 'three'
        : 'fourOrMore';
  metrics.dimensions[dimensionKey] += 1;
  if (state.requirements.coordinateDimensions) {
    state.dimensions[dimensionKey] += 1;
  }
  if (state.requirements.geometrySummaries) {
    metrics.bounds = updateBounds(
      metrics.bounds,
      position.values[0]!,
      position.values[1]!,
    );
  }
  if (state.requirements.geographicExtents) {
    state.bounds = updateBounds(
      state.bounds,
      position.values[0]!,
      position.values[1]!,
    );
  }
  state.coordinateObservation?.(
    position.values,
    featureIndex,
    parentPath,
    positionIndex,
  );
  if (state.listener?.coordinate) {
    state.listener.coordinate({
      ...(featureIndex === undefined ? {} : { featureIndex }),
      values: position.values,
      path: positionPath(parentPath, positionIndex, state),
    });
  }
  if (position.rawValues && position.byteOffset !== undefined) {
    if (state.instrumentation) {
      state.instrumentation.coordinateLexemeEvents =
        (state.instrumentation.coordinateLexemeEvents ?? 0) + 1;
    }
    state.coordinateLexemeObservation?.(
      position.rawValues,
      featureIndex,
      parentPath,
      positionIndex,
      position.byteOffset,
    );
    state.listener?.coordinateLexeme?.({
      ...(featureIndex === undefined ? {} : { featureIndex }),
      values: position.values,
      rawValues: position.rawValues,
      path: positionPath(parentPath, positionIndex, state),
      byteOffset: position.byteOffset,
    });
  }
}

function visitPositions(
  values: JsonValue[] | IndexedCoordinateValue,
  path: JsonPointer,
  featureIndex: number | undefined,
  metrics: GeometryMetrics,
  state: ScanState,
): void {
  let index = 0;
  for (const value of coordinateElements(values)) {
    visitPosition(value, path, index, featureIndex, metrics, state);
    index += 1;
  }
}

function invalidCoordinates(
  path: JsonPointer,
  featureIndex: number | undefined,
  metrics: GeometryMetrics,
  state: ScanState,
  message = 'Expected coordinates with the required GeoJSON array structure.',
): void {
  metrics.complete = false;
  damage(state, 'vertexCount', 'coordinateDimensionStats', 'derivedExtent');
  report(state, 'geojson/invalid-coordinates', message, path, featureIndex);
}

function validPositionShape(
  value: CoordinateValue | undefined,
  state: ScanState,
): value is JsonValue[] | IndexedCoordinateValue {
  return (
    isCoordinateArray(value) &&
    positionValues(value, state, false) !== undefined
  );
}

function positionsEqual(
  left: JsonValue[] | IndexedCoordinateValue,
  right: JsonValue[] | IndexedCoordinateValue,
  state: ScanState,
): boolean {
  const leftValues = positionValues(left, state, false)!.values;
  const rightValues = positionValues(right, state, false)!.values;
  if (leftValues.length !== rightValues.length) return false;
  for (let index = 0; index < leftValues.length; index += 1) {
    if (leftValues[index] !== rightValues[index]) return false;
  }
  return true;
}

function scanLine(
  values: JsonValue[] | IndexedCoordinateValue,
  path: JsonPointer,
  featureIndex: number | undefined,
  metrics: GeometryMetrics,
  state: ScanState,
  ring: boolean,
): void {
  const minimum = ring ? 4 : 2;
  let length = 0;
  let first: CoordinateValue | undefined;
  let last: CoordinateValue | undefined;
  if (Array.isArray(values)) {
    length = values.length;
    first = values[0];
    last = values[values.length - 1];
  } else {
    for (const value of indexedCoordinateElements(values)) {
      if (length === 0) first = value;
      last = value;
      length += 1;
    }
  }
  if (length < minimum) {
    invalidCoordinates(
      path,
      featureIndex,
      metrics,
      state,
      ring
        ? 'Expected a linear ring containing at least four Positions.'
        : 'Expected a LineString containing at least two Positions.',
    );
  } else if (
    ring &&
    validPositionShape(first, state) &&
    validPositionShape(last, state) &&
    !positionsEqual(first, last, state)
  ) {
    invalidCoordinates(
      path,
      featureIndex,
      metrics,
      state,
      'Expected a linear ring whose first and last Positions are identical.',
    );
  }
  visitPositions(values, path, featureIndex, metrics, state);
}

function scanCoordinateTree(
  type: GeoJSONGeometryType,
  coordinates: JsonValue[] | IndexedCoordinateValue,
  coordinatesPath: JsonPointer,
  featureIndex: number | undefined,
  metrics: GeometryMetrics,
  state: ScanState,
): void {
  if (state.instrumentation) state.instrumentation.coordinateTraversals += 1;
  if (type === 'Point') {
    visitPosition(
      coordinates,
      coordinatesPath,
      undefined,
      featureIndex,
      metrics,
      state,
    );
    return;
  }
  if (type === 'MultiPoint' || type === 'LineString') {
    if (type === 'LineString') {
      scanLine(
        coordinates,
        coordinatesPath,
        featureIndex,
        metrics,
        state,
        false,
      );
    } else {
      visitPositions(
        coordinates,
        coordinatesPath,
        featureIndex,
        metrics,
        state,
      );
    }
    return;
  }
  if (type === 'MultiLineString' || type === 'Polygon') {
    let first = 0;
    for (const part of coordinateElements(coordinates)) {
      if (type === 'Polygon') metrics.ringCount += 1;
      const partPath = appendPointer(coordinatesPath, first);
      if (!isCoordinateArray(part)) {
        invalidCoordinates(partPath, featureIndex, metrics, state);
        first += 1;
        continue;
      }
      scanLine(
        part,
        partPath,
        featureIndex,
        metrics,
        state,
        type === 'Polygon',
      );
      first += 1;
    }
    return;
  }
  if (type === 'MultiPolygon') {
    let polygon = 0;
    for (const polygonValue of coordinateElements(coordinates)) {
      const polygonPath = appendPointer(coordinatesPath, polygon);
      if (!isCoordinateArray(polygonValue)) {
        invalidCoordinates(polygonPath, featureIndex, metrics, state);
        polygon += 1;
        continue;
      }
      let ring = 0;
      for (const ringValue of coordinateElements(polygonValue)) {
        metrics.ringCount += 1;
        const ringPath = appendPointer(polygonPath, ring);
        if (!isCoordinateArray(ringValue)) {
          invalidCoordinates(ringPath, featureIndex, metrics, state);
          ring += 1;
          continue;
        }
        scanLine(ringValue, ringPath, featureIndex, metrics, state, true);
        ring += 1;
      }
      polygon += 1;
    }
  }
}

function scanGeometry(
  value: JsonValue,
  path: JsonPointer,
  featureIndex: number | undefined,
  state: ScanState,
): GeometryMetrics | undefined {
  let result: GeometryMetrics | undefined;
  const work: (GeometryFrame | GeometryCollectionFrame)[] = [
    { kind: 'geometry', value, path },
  ];
  const finish = (
    metrics: GeometryMetrics | undefined,
    parent: GeometryCollectionFrame | undefined,
  ): void => {
    if (!parent) {
      result = metrics;
      return;
    }
    if (!metrics) {
      parent.metrics.complete = false;
      return;
    }
    parent.metrics.vertices += metrics.vertices;
    parent.metrics.ringCount += metrics.ringCount;
    parent.metrics.geometryNodeCount += metrics.geometryNodeCount;
    addDimensions(parent.metrics.dimensions, metrics.dimensions);
    const mergedBounds = mergeBounds(parent.metrics.bounds, metrics.bounds);
    if (mergedBounds) parent.metrics.bounds = mergedBounds;
    if (!metrics.complete) parent.metrics.complete = false;
    parent.index += 1;
  };

  // GeometryCollections can nest arbitrarily deeply, so do not use the JS call stack.
  while (work.length > 0) {
    const frame = work.pop()!;
    if (frame.kind === 'collection') {
      const next = frame.geometries.next();
      if (next.done) {
        finish(frame.metrics, frame.parent);
        continue;
      }
      work.push(frame);
      work.push({
        kind: 'geometry',
        value: next.value,
        path: appendGeometryPath(frame.geometriesPath, frame.index),
        parent: frame,
      });
      continue;
    }

    if (!isObject(frame.value)) {
      damage(
        state,
        'geometryStats',
        'vertexCount',
        'coordinateDimensionStats',
        'derivedExtent',
      );
      report(
        state,
        'geojson/invalid-geometry',
        'Expected a GeoJSON geometry object.',
        materializeGeometryPath(frame.path),
        featureIndex,
      );
      finish(undefined, frame.parent);
      continue;
    }
    const geometry = frame.value;
    const typeValue = ownMember(geometry, 'type');
    if (typeof typeValue !== 'string' || !geometryTypes.has(typeValue)) {
      damage(
        state,
        'geometryStats',
        'vertexCount',
        'coordinateDimensionStats',
        'derivedExtent',
      );
      report(
        state,
        'geojson/invalid-geometry',
        'Expected a supported GeoJSON geometry type.',
        appendPointer(materializeGeometryPath(frame.path), 'type'),
        featureIndex,
      );
      finish(undefined, frame.parent);
      continue;
    }
    const type = typeValue as GeoJSONGeometryType;
    const metrics: GeometryMetrics = {
      type,
      path: frame.path,
      vertices: 0,
      ringCount: 0,
      geometryNodeCount: 1,
      dimensions: emptyDimensions(),
      complete: true,
    };
    validateBbox(geometry, frame.path, state, featureIndex);
    if (state.requirements.geometryNodeCounts)
      increment(state.geometryNodeTypes, type);

    if (type === 'GeometryCollection') {
      const geometriesPath = appendGeometryPath(frame.path, 'geometries');
      const geometries = ownMember(geometry, 'geometries');
      if (
        !Array.isArray(geometries) &&
        !isIndexedSequence(geometries, 'geometries')
      ) {
        metrics.complete = false;
        damage(
          state,
          'geometryStats',
          'vertexCount',
          'coordinateDimensionStats',
          'derivedExtent',
        );
        report(
          state,
          'geojson/invalid-geometry',
          'Expected GeometryCollection.geometries to be an array.',
          materializeGeometryPath(geometriesPath),
          featureIndex,
        );
        finish(metrics, frame.parent);
        continue;
      }
      work.push({
        kind: 'collection',
        metrics,
        geometries: Array.isArray(geometries)
          ? geometries.values()
          : indexedSequenceElements(geometries),
        geometriesPath,
        ...(frame.parent ? { parent: frame.parent } : {}),
        index: 0,
      });
      continue;
    }

    const coordinatesPath = appendPointer(
      materializeGeometryPath(frame.path),
      'coordinates',
    );
    const coordinates = ownMember(geometry, 'coordinates');
    if (!isCoordinateArray(coordinates)) {
      invalidCoordinates(coordinatesPath, featureIndex, metrics, state);
      finish(metrics, frame.parent);
      continue;
    }
    scanCoordinateTree(
      type,
      coordinates,
      coordinatesPath,
      featureIndex,
      metrics,
      state,
    );
    finish(metrics, frame.parent);
  }
  return result;
}

function scanProperties(
  value: JsonObject | null,
  path: JsonPointer,
  featureIndex: number,
  state: ScanState,
): { isNull: boolean; count: number } {
  if (value === null) {
    if (state.requirements.propertyStats) state.propertiesNullCount += 1;
    return { isNull: true, count: 0 };
  }
  const properties = value;
  const keys = Object.keys(properties);
  if (state.requirements.propertyNames) keys.sort();

  for (const key of keys) {
    const propertyValue = properties[key] as JsonValue;
    const type = valueType(propertyValue);
    if (state.requirements.propertyStats) {
      let stats = state.propertyStats.get(key);
      if (!stats) {
        stats = { present: 0, types: new Map() };
        state.propertyStats.set(key, stats);
      }
      stats.present += 1;
      increment(stats.types, type);
    }
    if (state.listener?.property || state.listener?.propertyValue) {
      if (state.instrumentation) {
        state.instrumentation.propertyPathMaterializations += 1;
      }
      const propertyPath = appendPointer(path, key);
      state.listener.property?.({
        featureIndex,
        key,
        path: propertyPath,
        type,
      });
      state.listener.propertyValue?.({
        featureIndex,
        key,
        path: propertyPath,
        type,
        value: propertyValue,
      });
    }
  }
  return { isNull: false, count: keys.length };
}

function scanFeature(
  value: JsonValue,
  path: JsonPointer,
  index: number,
  state: ScanState,
): void {
  if (!isObject(value) || ownMember(value, 'type') !== 'Feature') {
    if (state.requirements.featureByteSpans) {
      state.featureByteStatsPartial = true;
    }
    damage(state, ...semanticFacts);
    report(
      state,
      'geojson/invalid-feature',
      'Expected a GeoJSON Feature object.',
      path,
      index,
    );
    return;
  }
  const feature = value;
  const sourceSpan = indexedFeatureSpan(feature);
  const featureBytes =
    state.requirements.featureByteSpans && sourceSpan
      ? sourceSpan.endByteExclusive - sourceSpan.startByte
      : undefined;
  if (state.requirements.featureByteSpans) {
    if (featureBytes === undefined) state.featureByteStatsPartial = true;
    else
      state.largestFeatureBytes = Math.max(
        state.largestFeatureBytes,
        featureBytes,
      );
  }
  state.featureCount += 1;
  state.listener?.featureStart?.({
    index,
    path,
    ...(sourceSpan ? { byteOffset: sourceSpan.startByte } : {}),
  });
  validateBbox(feature, path, state, index);

  const id = ownMember(feature, 'id');
  const hasId = Object.hasOwn(feature, 'id');
  const idValid = !hasId || typeof id === 'string' || typeof id === 'number';
  const validId =
    typeof id === 'string' || typeof id === 'number' ? id : undefined;
  if (!idValid) {
    damage(state, 'idStats');
    report(
      state,
      'geojson/invalid-feature-id',
      'Expected Feature.id to be a string or number.',
      appendPointer(path, 'id'),
      index,
    );
  }
  if (state.requirements.idStats) {
    if (!hasId) {
      state.idMissing += 1;
    } else if (validId !== undefined) {
      state.idPresent += 1;
      if (typeof validId === 'string') state.idStrings += 1;
      else state.idNumbers += 1;
      const identity = `${typeof validId}:${String(validId)}`;
      if (state.ids.has(identity)) state.idDuplicates += 1;
      else state.ids.add(identity);
    }
  }
  const propertiesPath = appendPointer(path, 'properties');
  const propertiesValue = ownMember(feature, 'properties');
  const propertiesValid = propertiesValue === null || isObject(propertiesValue);
  if (!propertiesValid) {
    damage(state, 'propertyStats');
    report(
      state,
      'geojson/invalid-properties',
      'Expected Feature.properties to be an object or null.',
      propertiesPath,
      index,
    );
  }
  if (propertiesValid && state.requirements.propertyStats) {
    state.validPropertiesFeatureCount += 1;
  }
  const needsProperties =
    state.requirements.propertyNames || Boolean(state.listener?.feature);
  const properties =
    propertiesValid && needsProperties
      ? scanProperties(propertiesValue, propertiesPath, index, state)
      : { isNull: false, count: 0 };

  const geometryPath = appendPointer(path, 'geometry');
  const geometry = ownMember(feature, 'geometry');
  let metrics: GeometryMetrics | undefined;
  let geometryValid = true;
  if (geometry === null) {
    if (state.requirements.featureGeometryTypes) {
      increment(state.featureGeometryTypes, 'null');
      state.nullGeometryCount += 1;
    }
  } else if (geometry === undefined) {
    geometryValid = false;
    damage(
      state,
      'geometryStats',
      'vertexCount',
      'coordinateDimensionStats',
      'derivedExtent',
    );
    report(
      state,
      'geojson/invalid-geometry',
      'Expected Feature.geometry to be a geometry object or null.',
      geometryPath,
      index,
    );
  } else {
    metrics = scanGeometry(geometry, geometryPath, index, state);
    geometryValid = Boolean(metrics?.complete);
    if (state.requirements.featureGeometryTypes)
      if (metrics) increment(state.featureGeometryTypes, metrics.type);
  }
  if (state.requirements.vertexCounts) {
    state.largestFeatureVertices = Math.max(
      state.largestFeatureVertices,
      metrics?.vertices ?? 0,
    );
  }
  if (featureBytes !== undefined && sourceSpan) {
    state.featureByteObservation?.(
      index,
      path,
      featureBytes,
      sourceSpan.startByte,
      validId,
    );
  }

  if (metrics?.complete && state.listener?.geometry) {
    state.listener.geometry(geometrySummary(metrics));
  }

  state.featureIdObservation?.(
    index,
    path,
    idValid ? (hasId ? 'valid' : 'missing') : 'invalid',
    validId,
  );

  if (idValid && propertiesValid && geometryValid && state.listener?.feature) {
    state.listener.feature({
      index,
      path,
      ...(validId === undefined ? {} : { id: validId }),
      properties,
      geometry: metrics ? geometrySummary(metrics) : null,
      ...(featureBytes === undefined ? {} : { bytes: featureBytes }),
    });
  }
}

function completePropertyStats(
  state: ScanState,
): ReadonlyMap<string, PropertyStats> | undefined {
  if (!state.requirements.propertyStats) return undefined;
  const completed = new Map<string, PropertyStats>();
  for (const [key, stats] of state.propertyStats) {
    completed.set(key, {
      present: stats.present,
      // Invalid properties are unknown, not observed missing.
      missing: state.validPropertiesFeatureCount - stats.present,
      types: stats.types,
    });
  }
  return completed;
}

function factStatus(
  state: ScanState,
  computed: boolean,
  fact: SummaryFactName,
): 'complete' | 'partial' | 'not-computed' {
  return !computed
    ? 'not-computed'
    : state.partialFacts.has(fact)
      ? 'partial'
      : 'complete';
}

export function scanGeoJSON(
  value: JsonValue,
  options: ScanOptions,
): FileSummary {
  const requirements = options.requirements;
  const state: ScanState = {
    filePath: options.filePath,
    requirements,
    ...(options.listener ? { listener: options.listener } : {}),
    ...(options.instrumentation
      ? { instrumentation: options.instrumentation }
      : {}),
    ...(options.coordinateObservation
      ? { coordinateObservation: options.coordinateObservation }
      : {}),
    ...(options.coordinateLexemeObservation
      ? { coordinateLexemeObservation: options.coordinateLexemeObservation }
      : {}),
    ...(options.featureIdObservation
      ? { featureIdObservation: options.featureIdObservation }
      : {}),
    ...(options.featureByteObservation
      ? { featureByteObservation: options.featureByteObservation }
      : {}),
    diagnostics:
      options.diagnostics ?? new DiagnosticCollector(options.filePath),
    partialFacts: new Set(),
    documentPartial: false,
    featureCount: 0,
    validPropertiesFeatureCount: 0,
    totalVertices: 0,
    largestFeatureVertices: 0,
    largestFeatureBytes: 0,
    featureByteStatsPartial: false,
    propertiesNullCount: 0,
    nullGeometryCount: 0,
    dimensions: emptyDimensions(),
    propertyStats: new Map(),
    featureGeometryTypes: new Map(),
    geometryNodeTypes: new Map(),
    idPresent: 0,
    idMissing: 0,
    idDuplicates: 0,
    idStrings: 0,
    idNumbers: 0,
    ids: new Set(),
  };

  const rootPath = jsonPointer();
  if (!isObject(value)) {
    if (requirements.featureByteSpans) state.featureByteStatsPartial = true;
    damage(state, ...semanticFacts);
    report(
      state,
      'geojson/invalid-root',
      'Expected a GeoJSON object at the document root.',
      rootPath,
    );
  } else {
    const rootType = ownMember(value, 'type');
    if (rootType === 'FeatureCollection') {
      validateBbox(value, rootPath, state);
      const featuresPath = jsonPointer('features');
      const features = ownMember(value, 'features');
      if (
        !Array.isArray(features) &&
        !isIndexedSequence(features, 'features')
      ) {
        if (requirements.featureByteSpans) state.featureByteStatsPartial = true;
        damage(state, ...semanticFacts);
        report(
          state,
          'geojson/invalid-feature-collection',
          'Expected FeatureCollection.features to be an array.',
          featuresPath,
        );
      } else {
        const featureValues = Array.isArray(features)
          ? features
          : indexedSequenceElements(features);
        let index = 0;
        for (const feature of featureValues) {
          scanFeature(
            feature as JsonValue,
            appendPointer(featuresPath, index),
            index,
            state,
          );
          index += 1;
        }
      }
    } else if (rootType === 'Feature') {
      scanFeature(value, rootPath, 0, state);
    } else if (typeof rootType === 'string' && geometryTypes.has(rootType)) {
      const metrics = scanGeometry(value, rootPath, undefined, state);
      if (metrics?.complete) {
        options.listener?.geometry?.(geometrySummary(metrics));
      }
    } else {
      if (requirements.featureByteSpans) state.featureByteStatsPartial = true;
      damage(state, ...semanticFacts);
      report(
        state,
        'geojson/invalid-root',
        'Expected a supported GeoJSON type at the document root.',
        appendPointer(rootPath, 'type'),
      );
    }
  }

  const propertyStats = completePropertyStats(state);
  const derivedExtent = requirements.geographicExtents
    ? extent(state.bounds)
    : undefined;
  const summary: FileSummary = {
    filePath: options.filePath,
    completeness: {
      document: state.documentPartial ? 'partial' : 'complete',
      facts: {
        fileBytes: requirements.exactFileBytes ? 'complete' : 'not-computed',
        featureCount: factStatus(
          state,
          requirements.featureCount,
          'featureCount',
        ),
        vertexCount: factStatus(
          state,
          requirements.vertexCounts,
          'vertexCount',
        ),
        propertyStats: factStatus(
          state,
          requirements.propertyStats,
          'propertyStats',
        ),
        geometryStats: factStatus(
          state,
          requirements.featureGeometryTypes,
          'geometryStats',
        ),
        idStats: factStatus(state, requirements.idStats, 'idStats'),
        coordinateDimensionStats: factStatus(
          state,
          requirements.coordinateDimensions,
          'coordinateDimensionStats',
        ),
        derivedExtent: factStatus(
          state,
          requirements.geographicExtents,
          'derivedExtent',
        ),
        featureByteStats: !requirements.featureByteSpans
          ? 'not-computed'
          : state.featureByteStatsPartial
            ? 'partial'
            : 'complete',
      },
    },
    ...(requirements.exactFileBytes && options.sourceBytes !== undefined
      ? { bytes: options.sourceBytes }
      : {}),
    featureCount: requirements.featureCount ? state.featureCount : 0,
    totalVertices: requirements.vertexCounts ? state.totalVertices : 0,
    ...(requirements.vertexCounts
      ? { largestFeatureVertices: state.largestFeatureVertices }
      : {}),
    ...(requirements.featureByteSpans
      ? { largestFeatureBytes: state.largestFeatureBytes }
      : {}),
    ...(requirements.featureGeometryTypes
      ? {
          featureGeometryTypes: state.featureGeometryTypes,
          geometryNodeTypes: state.geometryNodeTypes,
          nullGeometryCount: state.nullGeometryCount,
        }
      : {}),
    ...(propertyStats
      ? { propertyStats, propertiesNullCount: state.propertiesNullCount }
      : {}),
    ...(requirements.idStats
      ? {
          ids: {
            present: state.idPresent,
            missing: state.idMissing,
            duplicateCount: state.idDuplicates,
            stringCount: state.idStrings,
            numberCount: state.idNumbers,
          },
        }
      : {}),
    ...(requirements.coordinateDimensions
      ? { coordinateDimensionStats: state.dimensions }
      : {}),
    ...(derivedExtent ? { derivedExtent } : {}),
  };
  options.listener?.document?.(summary);
  return summary;
}
