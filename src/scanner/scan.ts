import { DiagnosticCollector } from '../engine/diagnostics.js';
import type {
  ExecutionRequirements,
  SemanticListener,
} from '../engine/requirements.js';
import { appendPointer, jsonPointer } from './json-pointer.js';
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
  path: JsonPointer;
  vertices: number;
  ringCount: number;
  geometryNodeCount: number;
  dimensions: MutableDimensions;
  bounds?: MutableBounds;
  complete: boolean;
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
  readonly featureIdObservation?: FeatureIdObservation;
  readonly diagnostics: DiagnosticCollector;
  readonly partialFacts: Set<SummaryFactName>;
  documentPartial: boolean;
  featureCount: number;
  validPropertiesFeatureCount: number;
  totalVertices: number;
  largestFeatureVertices: number;
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
}

export interface ScanOptions {
  readonly filePath: string;
  readonly requirements: ExecutionRequirements;
  readonly listener?: SemanticListener;
  readonly sourceBytes?: number;
  readonly instrumentation?: ScanInstrumentation;
  readonly coordinateObservation?: CoordinateObservation;
  readonly featureIdObservation?: FeatureIdObservation;
  readonly diagnostics?: DiagnosticCollector;
}

export type CoordinateObservation = (
  values: readonly number[],
  featureIndex: number | undefined,
  parentPath: JsonPointer,
  positionIndex: number | undefined,
) => void;

export type FeatureIdObservation = (
  index: number,
  path: JsonPointer,
  status: 'missing' | 'valid' | 'invalid',
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

function validateBbox(
  object: JsonObject,
  path: JsonPointer,
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
      appendPointer(path, 'bbox'),
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
    path: metrics.path,
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

function visitPosition(
  value: JsonValue,
  parentPath: JsonPointer,
  positionIndex: number | undefined,
  featureIndex: number | undefined,
  metrics: GeometryMetrics,
  state: ScanState,
): void {
  if (!Array.isArray(value)) {
    if (state.instrumentation) state.instrumentation.positionVisits += 1;
    invalidPosition(parentPath, positionIndex, featureIndex, metrics, state);
    return;
  }
  const position = value;
  let valid = position.length >= 2;
  for (
    let ordinateIndex = 0;
    valid && ordinateIndex < position.length;
    ordinateIndex += 1
  ) {
    const ordinate = position[ordinateIndex];
    if (typeof ordinate !== 'number' || !Number.isFinite(ordinate)) {
      valid = false;
    }
  }
  if (!valid) {
    if (state.instrumentation) state.instrumentation.positionVisits += 1;
    invalidPosition(parentPath, positionIndex, featureIndex, metrics, state);
    return;
  }

  if (state.instrumentation) state.instrumentation.positionVisits += 1;
  metrics.vertices += 1;
  if (state.requirements.vertexCounts) state.totalVertices += 1;
  const dimensionKey =
    position.length === 2
      ? 'two'
      : position.length === 3
        ? 'three'
        : 'fourOrMore';
  metrics.dimensions[dimensionKey] += 1;
  if (state.requirements.coordinateDimensions) {
    state.dimensions[dimensionKey] += 1;
  }
  if (state.requirements.geometrySummaries) {
    metrics.bounds = updateBounds(
      metrics.bounds,
      position[0] as number,
      position[1] as number,
    );
  }
  if (state.requirements.geographicExtents) {
    state.bounds = updateBounds(
      state.bounds,
      position[0] as number,
      position[1] as number,
    );
  }
  state.coordinateObservation?.(
    position as number[],
    featureIndex,
    parentPath,
    positionIndex,
  );
  if (state.listener?.coordinate) {
    state.listener.coordinate({
      ...(featureIndex === undefined ? {} : { featureIndex }),
      values: position as number[],
      path: positionPath(parentPath, positionIndex, state),
    });
  }
}

function visitPositions(
  values: JsonValue[],
  path: JsonPointer,
  featureIndex: number | undefined,
  metrics: GeometryMetrics,
  state: ScanState,
): void {
  for (let index = 0; index < values.length; index += 1) {
    visitPosition(
      values[index] as JsonValue,
      path,
      index,
      featureIndex,
      metrics,
      state,
    );
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
  value: JsonValue | undefined,
): value is JsonValue[] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value.every(
      (ordinate) => typeof ordinate === 'number' && Number.isFinite(ordinate),
    )
  );
}

function positionsEqual(left: JsonValue[], right: JsonValue[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function scanLine(
  values: JsonValue[],
  path: JsonPointer,
  featureIndex: number | undefined,
  metrics: GeometryMetrics,
  state: ScanState,
  ring: boolean,
): void {
  const minimum = ring ? 4 : 2;
  const first = values[0];
  const last = values[values.length - 1];
  if (values.length < minimum) {
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
    validPositionShape(first) &&
    validPositionShape(last) &&
    !positionsEqual(first, last)
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
  coordinates: JsonValue[],
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
    if (type === 'Polygon') metrics.ringCount += coordinates.length;
    for (let first = 0; first < coordinates.length; first += 1) {
      const partPath = appendPointer(coordinatesPath, first);
      const part = coordinates[first];
      if (!Array.isArray(part)) {
        invalidCoordinates(partPath, featureIndex, metrics, state);
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
    }
    return;
  }
  if (type === 'MultiPolygon') {
    for (let polygon = 0; polygon < coordinates.length; polygon += 1) {
      const polygonPath = appendPointer(coordinatesPath, polygon);
      const polygonValue = coordinates[polygon];
      if (!Array.isArray(polygonValue)) {
        invalidCoordinates(polygonPath, featureIndex, metrics, state);
        continue;
      }
      const rings = polygonValue;
      metrics.ringCount += rings.length;
      for (let ring = 0; ring < rings.length; ring += 1) {
        const ringPath = appendPointer(polygonPath, ring);
        const ringValue = rings[ring];
        if (!Array.isArray(ringValue)) {
          invalidCoordinates(ringPath, featureIndex, metrics, state);
          continue;
        }
        scanLine(ringValue, ringPath, featureIndex, metrics, state, true);
      }
    }
  }
}

function scanGeometry(
  value: JsonValue,
  path: JsonPointer,
  featureIndex: number | undefined,
  state: ScanState,
): GeometryMetrics | undefined {
  if (!isObject(value)) {
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
      path,
      featureIndex,
    );
    return undefined;
  }
  const geometry = value;
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
      appendPointer(path, 'type'),
      featureIndex,
    );
    return undefined;
  }
  const type = typeValue as GeoJSONGeometryType;
  const metrics: GeometryMetrics = {
    type,
    path,
    vertices: 0,
    ringCount: 0,
    geometryNodeCount: 1,
    dimensions: emptyDimensions(),
    complete: true,
  };
  validateBbox(geometry, path, state, featureIndex);

  if (state.requirements.geometryNodeCounts)
    increment(state.geometryNodeTypes, type);
  if (type === 'GeometryCollection') {
    const geometriesPath = appendPointer(path, 'geometries');
    const geometries = ownMember(geometry, 'geometries');
    if (!Array.isArray(geometries)) {
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
        geometriesPath,
        featureIndex,
      );
      return metrics;
    }
    for (let index = 0; index < geometries.length; index += 1) {
      const child = scanGeometry(
        geometries[index] as JsonValue,
        appendPointer(geometriesPath, index),
        featureIndex,
        state,
      );
      if (!child) {
        metrics.complete = false;
        continue;
      }
      metrics.vertices += child.vertices;
      metrics.ringCount += child.ringCount;
      metrics.geometryNodeCount += child.geometryNodeCount;
      addDimensions(metrics.dimensions, child.dimensions);
      const mergedBounds = mergeBounds(metrics.bounds, child.bounds);
      if (mergedBounds) metrics.bounds = mergedBounds;
      if (!child.complete) metrics.complete = false;
    }
  } else {
    const coordinatesPath = appendPointer(path, 'coordinates');
    const coordinates = ownMember(geometry, 'coordinates');
    if (!Array.isArray(coordinates)) {
      invalidCoordinates(coordinatesPath, featureIndex, metrics, state);
      return metrics;
    }
    scanCoordinateTree(
      type,
      coordinates,
      coordinatesPath,
      featureIndex,
      metrics,
      state,
    );
  }
  return metrics;
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
  state.featureCount += 1;
  state.listener?.featureStart?.({ index, path });
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
    ...(options.featureIdObservation
      ? { featureIdObservation: options.featureIdObservation }
      : {}),
    diagnostics:
      options.diagnostics ?? new DiagnosticCollector(options.filePath),
    partialFacts: new Set(),
    documentPartial: false,
    featureCount: 0,
    validPropertiesFeatureCount: 0,
    totalVertices: 0,
    largestFeatureVertices: 0,
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
      if (!Array.isArray(features)) {
        damage(state, ...semanticFacts);
        report(
          state,
          'geojson/invalid-feature-collection',
          'Expected FeatureCollection.features to be an array.',
          featuresPath,
        );
      } else {
        for (let index = 0; index < features.length; index += 1) {
          scanFeature(
            features[index] as JsonValue,
            appendPointer(featuresPath, index),
            index,
            state,
          );
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
        featureByteStats: 'not-computed',
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
