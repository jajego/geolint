import { GeoLintInternalError } from '../engine/errors.js';
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
  featureCount: number;
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
}

export interface ScanOptions {
  readonly filePath: string;
  readonly requirements: ExecutionRequirements;
  readonly listener?: SemanticListener;
  readonly sourceBytes?: number;
  readonly instrumentation?: ScanInstrumentation;
}

function fail(message: string): never {
  throw new GeoLintInternalError(message, 'GEOLINT_INVALID_SEMANTIC_INPUT');
}

function object(value: JsonValue, path: JsonPointer): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`Expected an object at ${path || '<root>'}.`);
  }
  return value;
}

function ownMember(object: JsonObject, key: string): JsonValue | undefined {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

function array(value: JsonValue | undefined, path: JsonPointer): JsonValue[] {
  if (!Array.isArray(value)) fail(`Expected an array at ${path}.`);
  return value;
}

function geometryType(
  value: JsonValue | undefined,
  path: JsonPointer,
): GeoJSONGeometryType {
  if (typeof value !== 'string' || !geometryTypes.has(value)) {
    fail(`Expected a supported geometry type at ${path}.`);
  }
  return value as GeoJSONGeometryType;
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

function visitPosition(
  value: JsonValue,
  parentPath: JsonPointer,
  positionIndex: number | undefined,
  featureIndex: number | undefined,
  metrics: GeometryMetrics,
  state: ScanState,
): void {
  if (!Array.isArray(value)) {
    fail(
      `Expected an array at ${positionPath(parentPath, positionIndex, state)}.`,
    );
  }
  const position = value;
  if (position.length < 2)
    fail(
      `Expected a position with at least two ordinates at ${positionPath(parentPath, positionIndex, state)}.`,
    );
  for (
    let ordinateIndex = 0;
    ordinateIndex < position.length;
    ordinateIndex += 1
  ) {
    const ordinate = position[ordinateIndex];
    if (typeof ordinate !== 'number' || !Number.isFinite(ordinate)) {
      fail(
        `Expected a finite coordinate ordinate at ${appendPointer(positionPath(parentPath, positionIndex, state), ordinateIndex)}.`,
      );
    }
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
    visitPositions(coordinates, coordinatesPath, featureIndex, metrics, state);
    return;
  }
  if (type === 'MultiLineString' || type === 'Polygon') {
    if (type === 'Polygon') metrics.ringCount += coordinates.length;
    for (let first = 0; first < coordinates.length; first += 1) {
      const partPath = appendPointer(coordinatesPath, first);
      visitPositions(
        array(coordinates[first], partPath),
        partPath,
        featureIndex,
        metrics,
        state,
      );
    }
    return;
  }
  if (type === 'MultiPolygon') {
    for (let polygon = 0; polygon < coordinates.length; polygon += 1) {
      const polygonPath = appendPointer(coordinatesPath, polygon);
      const rings = array(coordinates[polygon], polygonPath);
      metrics.ringCount += rings.length;
      for (let ring = 0; ring < rings.length; ring += 1) {
        const ringPath = appendPointer(polygonPath, ring);
        visitPositions(
          array(rings[ring], ringPath),
          ringPath,
          featureIndex,
          metrics,
          state,
        );
      }
    }
  }
}

function scanGeometry(
  value: JsonValue,
  path: JsonPointer,
  featureIndex: number | undefined,
  state: ScanState,
): GeometryMetrics {
  const geometry = object(value, path);
  const type = geometryType(
    ownMember(geometry, 'type'),
    appendPointer(path, 'type'),
  );
  const metrics: GeometryMetrics = {
    type,
    path,
    vertices: 0,
    ringCount: 0,
    geometryNodeCount: 1,
    dimensions: emptyDimensions(),
  };

  if (state.requirements.geometryNodeCounts)
    increment(state.geometryNodeTypes, type);
  if (type === 'GeometryCollection') {
    const geometriesPath = appendPointer(path, 'geometries');
    const geometries = array(ownMember(geometry, 'geometries'), geometriesPath);
    for (let index = 0; index < geometries.length; index += 1) {
      const child = scanGeometry(
        geometries[index] as JsonValue,
        appendPointer(geometriesPath, index),
        featureIndex,
        state,
      );
      metrics.vertices += child.vertices;
      metrics.ringCount += child.ringCount;
      metrics.geometryNodeCount += child.geometryNodeCount;
      addDimensions(metrics.dimensions, child.dimensions);
      const mergedBounds = mergeBounds(metrics.bounds, child.bounds);
      if (mergedBounds) metrics.bounds = mergedBounds;
    }
  } else if (state.requirements.positions || state.requirements.ringCounts) {
    const coordinatesPath = appendPointer(path, 'coordinates');
    const coordinates = array(
      ownMember(geometry, 'coordinates'),
      coordinatesPath,
    );
    if (state.requirements.positions) {
      scanCoordinateTree(
        type,
        coordinates,
        coordinatesPath,
        featureIndex,
        metrics,
        state,
      );
    } else if (type === 'Polygon') {
      metrics.ringCount = coordinates.length;
    } else if (type === 'MultiPolygon') {
      for (let index = 0; index < coordinates.length; index += 1) {
        metrics.ringCount += array(
          coordinates[index],
          appendPointer(coordinatesPath, index),
        ).length;
      }
    }
  }
  return metrics;
}

function scanProperties(
  value: JsonValue | undefined,
  path: JsonPointer,
  featureIndex: number,
  state: ScanState,
): { isNull: boolean; count: number } {
  if (value === null) {
    if (state.requirements.propertyStats) state.propertiesNullCount += 1;
    return { isNull: true, count: 0 };
  }
  if (value === undefined) fail(`Expected properties at ${path}.`);
  const properties = object(value, path);
  const keys = Object.keys(properties);
  if (state.requirements.propertyNames) keys.sort();

  for (const key of keys) {
    const propertyValue = properties[key] as JsonValue;
    const propertyPath = appendPointer(path, key);
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
    state.listener?.property?.({ featureIndex, key, path: propertyPath, type });
    state.listener?.propertyValue?.({
      featureIndex,
      key,
      path: propertyPath,
      type,
      value: propertyValue,
    });
  }
  return { isNull: false, count: keys.length };
}

function scanFeature(
  value: JsonValue,
  path: JsonPointer,
  index: number,
  state: ScanState,
): void {
  const feature = object(value, path);
  if (ownMember(feature, 'type') !== 'Feature')
    fail(`Expected Feature at ${appendPointer(path, 'type')}.`);
  state.featureCount += 1;
  state.listener?.featureStart?.({ index, path });
  const propertiesPath = appendPointer(path, 'properties');
  const needsProperties =
    state.requirements.propertyNames || Boolean(state.listener?.feature);
  const properties = needsProperties
    ? scanProperties(
        ownMember(feature, 'properties'),
        propertiesPath,
        index,
        state,
      )
    : { isNull: false, count: 0 };

  const id = ownMember(feature, 'id');
  const validId =
    typeof id === 'string' || typeof id === 'number' ? id : undefined;
  if (state.requirements.idStats) {
    if (validId === undefined) {
      state.idMissing += 1;
    } else {
      state.idPresent += 1;
      if (typeof validId === 'string') state.idStrings += 1;
      else state.idNumbers += 1;
      const identity = `${typeof validId}:${String(validId)}`;
      if (state.ids.has(identity)) state.idDuplicates += 1;
      else state.ids.add(identity);
    }
  }

  const geometryPath = appendPointer(path, 'geometry');
  const geometry = ownMember(feature, 'geometry');
  let metrics: GeometryMetrics | undefined;
  const needsGeometry =
    state.requirements.positions ||
    state.requirements.ringCounts ||
    state.requirements.geometryNodeCounts ||
    state.requirements.featureGeometryTypes ||
    state.requirements.geometrySummaries;
  if (!needsGeometry) {
    // Phase 3 structural validation will inspect skipped semantic subtrees.
  } else if (geometry === null) {
    if (state.requirements.featureGeometryTypes) {
      increment(state.featureGeometryTypes, 'null');
      state.nullGeometryCount += 1;
    }
  } else if (geometry === undefined) {
    fail(`Expected geometry at ${geometryPath}.`);
  } else {
    metrics = scanGeometry(geometry, geometryPath, index, state);
    if (state.requirements.featureGeometryTypes)
      increment(state.featureGeometryTypes, metrics.type);
  }
  if (state.requirements.vertexCounts) {
    state.largestFeatureVertices = Math.max(
      state.largestFeatureVertices,
      metrics?.vertices ?? 0,
    );
  }

  if (metrics && state.listener?.geometry) {
    state.listener.geometry(geometrySummary(metrics));
  }

  if (state.listener?.feature) {
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
      missing: state.featureCount - stats.present,
      types: stats.types,
    });
  }
  return completed;
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
    featureCount: 0,
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

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('Expected a supported GeoJSON root at /type.');
  }
  const root = object(value, jsonPointer());
  const rootType = ownMember(root, 'type');
  if (rootType === 'FeatureCollection') {
    const featuresPath = jsonPointer('features');
    const features = array(ownMember(root, 'features'), featuresPath);
    for (let index = 0; index < features.length; index += 1) {
      scanFeature(
        features[index] as JsonValue,
        appendPointer(featuresPath, index),
        index,
        state,
      );
    }
  } else if (rootType === 'Feature') {
    scanFeature(value, jsonPointer(), 0, state);
  } else if (typeof rootType === 'string' && geometryTypes.has(rootType)) {
    const needsGeometry =
      requirements.positions ||
      requirements.ringCounts ||
      requirements.geometryNodeCounts ||
      requirements.geometrySummaries;
    if (needsGeometry) {
      const metrics = scanGeometry(value, jsonPointer(), undefined, state);
      options.listener?.geometry?.(geometrySummary(metrics));
    }
  } else {
    fail('Expected a supported GeoJSON root at /type.');
  }

  const propertyStats = completePropertyStats(state);
  const derivedExtent = requirements.geographicExtents
    ? extent(state.bounds)
    : undefined;
  const summary: FileSummary = {
    filePath: options.filePath,
    completeness: {
      document: 'complete',
      facts: {
        fileBytes: requirements.exactFileBytes ? 'complete' : 'not-computed',
        featureCount: requirements.featureCount ? 'complete' : 'not-computed',
        vertexCount: requirements.vertexCounts ? 'complete' : 'not-computed',
        propertyStats: requirements.propertyStats ? 'complete' : 'not-computed',
        geometryStats: requirements.featureGeometryTypes
          ? 'complete'
          : 'not-computed',
        idStats: requirements.idStats ? 'complete' : 'not-computed',
        coordinateDimensionStats: requirements.coordinateDimensions
          ? 'complete'
          : 'not-computed',
        derivedExtent: requirements.geographicExtents
          ? 'complete'
          : 'not-computed',
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
