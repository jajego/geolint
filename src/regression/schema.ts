import { createRequire } from 'node:module';
import { posix } from 'node:path';

import { GeoLintIOError } from '../engine/errors.js';
import type { GeoJSONGeometryType, JsonValueType } from '../types/semantic.js';

export const baselineSchemaVersion = 1 as const;
export const geometryTypeOrder = Object.freeze([
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
  'GeometryCollection',
] as const satisfies readonly GeoJSONGeometryType[]);
export const propertyTypeOrder = Object.freeze([
  'string',
  'number',
  'boolean',
  'null',
  'array',
  'object',
] as const satisfies readonly JsonValueType[]);

const packageVersion = (
  createRequire(import.meta.url)('../../package.json') as { version: string }
).version;

export interface BaselinePropertyEntry {
  readonly present: number;
  readonly missing: number;
  readonly types: Readonly<Partial<Record<JsonValueType, number>>>;
}

export interface BaselineFileEntry {
  readonly bytes: number;
  readonly featureCount: number;
  readonly totalVertices: number;
  readonly largestFeatureVertices: number;
  readonly featureGeometryTypes: Readonly<
    Partial<Record<GeoJSONGeometryType, number>>
  >;
  readonly properties: Readonly<Record<string, BaselinePropertyEntry>>;
  readonly ids: {
    readonly missing: number;
    readonly duplicates: number;
    readonly string: number;
    readonly number: number;
  };
  readonly nullGeometries: number;
}

export interface BaselineV1 {
  readonly schemaVersion: typeof baselineSchemaVersion;
  readonly geolintVersion: string;
  readonly files: Readonly<Record<string, BaselineFileEntry>>;
}

function invalid(path: string, expected: string): never {
  throw new GeoLintIOError(
    `Invalid GeoLint baseline at ${path}: expected ${expected}.`,
    'GEOLINT_INVALID_BASELINE',
  );
}

function dictionary<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return invalid(path, 'an object');
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown) invalid(`${path}.${unknown}`, 'a supported baseline field');
  const missing = keys.find((key) => !Object.hasOwn(value, key));
  if (missing) invalid(`${path}.${missing}`, 'a required baseline field');
}

function count(value: unknown, path: string, positive = false): number {
  if (!Number.isSafeInteger(value) || Number(value) < (positive ? 1 : 0)) {
    return invalid(
      path,
      positive ? 'a positive safe integer' : 'a non-negative safe integer',
    );
  }
  return Number(value);
}

function fileKey(value: string): string {
  const canonical = posix.normalize(value.replaceAll('\\', '/'));
  if (
    value.length === 0 ||
    value.endsWith('/') ||
    value !== canonical ||
    value.includes('\\') ||
    value === '.' ||
    value === '..' ||
    value.startsWith('../') ||
    value.startsWith('/') ||
    /^[A-Za-z]:\//.test(value)
  ) {
    invalid(`files.${JSON.stringify(value)}`, 'a normalized relative path');
  }
  return value;
}

function parseProperty(value: unknown, path: string): BaselinePropertyEntry {
  const entry = object(value, path);
  exactKeys(entry, ['present', 'missing', 'types'], path);
  const present = count(entry.present, `${path}.present`, true);
  const missing = count(entry.missing, `${path}.missing`);
  const rawTypes = object(entry.types, `${path}.types`);
  const types = {} as Partial<Record<JsonValueType, number>>;
  let observed = 0;
  for (const type of Object.keys(rawTypes)) {
    if (!propertyTypeOrder.includes(type as JsonValueType)) {
      invalid(`${path}.types.${type}`, 'a supported coarse property type');
    }
  }
  for (const type of propertyTypeOrder) {
    const valueCount = rawTypes[type];
    if (valueCount === undefined) continue;
    const parsed = count(valueCount, `${path}.types.${type}`, true);
    types[type as JsonValueType] = parsed;
    observed += parsed;
  }
  if (Object.keys(types).length === 0) invalid(`${path}.types`, 'non-empty');
  if (observed !== present) {
    invalid(`${path}.types`, 'counts summing to present');
  }
  return Object.freeze({ present, missing, types: Object.freeze(types) });
}

function parseEntry(value: unknown, path: string): BaselineFileEntry {
  const entry = object(value, path);
  exactKeys(
    entry,
    [
      'bytes',
      'featureCount',
      'totalVertices',
      'largestFeatureVertices',
      'featureGeometryTypes',
      'properties',
      'ids',
      'nullGeometries',
    ],
    path,
  );
  const bytes = count(entry.bytes, `${path}.bytes`);
  const featureCount = count(entry.featureCount, `${path}.featureCount`);
  const totalVertices = count(entry.totalVertices, `${path}.totalVertices`);
  const largestFeatureVertices = count(
    entry.largestFeatureVertices,
    `${path}.largestFeatureVertices`,
  );
  if (largestFeatureVertices > totalVertices) {
    invalid(`${path}.largestFeatureVertices`, 'at most totalVertices');
  }

  const geometry = object(
    entry.featureGeometryTypes,
    `${path}.featureGeometryTypes`,
  );
  const featureGeometryTypes = {} as Partial<
    Record<GeoJSONGeometryType, number>
  >;
  let geometryCount = 0;
  for (const type of Object.keys(geometry)) {
    if (!geometryTypeOrder.includes(type as GeoJSONGeometryType)) {
      invalid(
        `${path}.featureGeometryTypes.${type}`,
        'a GeoJSON geometry type',
      );
    }
  }
  for (const type of geometryTypeOrder) {
    const valueCount = geometry[type];
    if (valueCount === undefined) continue;
    const parsed = count(
      valueCount,
      `${path}.featureGeometryTypes.${type}`,
      true,
    );
    featureGeometryTypes[type] = parsed;
    geometryCount += parsed;
  }

  const rawProperties = object(entry.properties, `${path}.properties`);
  const properties = dictionary<BaselinePropertyEntry>();
  for (const key of Object.keys(rawProperties).sort()) {
    const property = parseProperty(
      rawProperties[key],
      `${path}.properties.${JSON.stringify(key)}`,
    );
    if (property.present + property.missing !== featureCount) {
      invalid(
        `${path}.properties.${JSON.stringify(key)}`,
        'present and missing counts summing to featureCount',
      );
    }
    properties[key] = property;
  }

  const rawIds = object(entry.ids, `${path}.ids`);
  exactKeys(
    rawIds,
    ['missing', 'duplicates', 'string', 'number'],
    `${path}.ids`,
  );
  const ids = {
    missing: count(rawIds.missing, `${path}.ids.missing`),
    duplicates: count(rawIds.duplicates, `${path}.ids.duplicates`),
    string: count(rawIds.string, `${path}.ids.string`),
    number: count(rawIds.number, `${path}.ids.number`),
  };
  if (ids.missing + ids.string + ids.number !== featureCount) {
    invalid(`${path}.ids`, 'ID counts summing to featureCount');
  }
  if (ids.duplicates > Math.max(0, ids.string + ids.number - 1)) {
    invalid(`${path}.ids.duplicates`, 'at most present ID count minus one');
  }
  const nullGeometries = count(entry.nullGeometries, `${path}.nullGeometries`);
  if (geometryCount + nullGeometries !== featureCount) {
    invalid(
      `${path}.featureGeometryTypes`,
      'geometry and null counts summing to featureCount',
    );
  }
  return Object.freeze({
    bytes,
    featureCount,
    totalVertices,
    largestFeatureVertices,
    featureGeometryTypes: Object.freeze(featureGeometryTypes),
    properties: Object.freeze(properties),
    ids: Object.freeze(ids),
    nullGeometries,
  });
}

export function parseBaseline(text: string): BaselineV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new GeoLintIOError(
      'GeoLint baseline is not valid JSON.',
      'GEOLINT_INVALID_BASELINE',
      { cause },
    );
  }
  const root = object(parsed, 'baseline');
  exactKeys(root, ['schemaVersion', 'geolintVersion', 'files'], 'baseline');
  if (root.schemaVersion !== baselineSchemaVersion) {
    throw new GeoLintIOError(
      `Unsupported GeoLint baseline schema version ${String(root.schemaVersion)}.`,
      'GEOLINT_UNSUPPORTED_BASELINE_SCHEMA',
    );
  }
  if (
    typeof root.geolintVersion !== 'string' ||
    root.geolintVersion.length === 0
  ) {
    invalid('baseline.geolintVersion', 'a non-empty string');
  }
  const rawFiles = object(root.files, 'baseline.files');
  const files = dictionary<BaselineFileEntry>();
  for (const key of Object.keys(rawFiles).sort()) {
    files[fileKey(key)] = parseEntry(
      rawFiles[key],
      `baseline.files.${JSON.stringify(key)}`,
    );
  }
  return Object.freeze({
    schemaVersion: baselineSchemaVersion,
    geolintVersion: root.geolintVersion,
    files: Object.freeze(files),
  });
}

function orderedEntry(entry: BaselineFileEntry): BaselineFileEntry {
  const featureGeometryTypes: Partial<Record<GeoJSONGeometryType, number>> = {};
  for (const type of geometryTypeOrder) {
    const value = entry.featureGeometryTypes[type];
    if (value !== undefined) featureGeometryTypes[type] = value;
  }
  const properties = dictionary<BaselinePropertyEntry>();
  for (const key of Object.keys(entry.properties).sort()) {
    const source = entry.properties[key]!;
    const types: Partial<Record<JsonValueType, number>> = {};
    for (const type of propertyTypeOrder) {
      const value = source.types[type];
      if (value !== undefined) types[type] = value;
    }
    properties[key] = {
      present: source.present,
      missing: source.missing,
      types,
    };
  }
  return {
    bytes: entry.bytes,
    featureCount: entry.featureCount,
    totalVertices: entry.totalVertices,
    largestFeatureVertices: entry.largestFeatureVertices,
    featureGeometryTypes,
    properties,
    ids: {
      missing: entry.ids.missing,
      duplicates: entry.ids.duplicates,
      string: entry.ids.string,
      number: entry.ids.number,
    },
    nullGeometries: entry.nullGeometries,
  };
}

export function createBaseline(
  files: Readonly<Record<string, BaselineFileEntry>>,
): BaselineV1 {
  return Object.freeze({
    schemaVersion: baselineSchemaVersion,
    geolintVersion: packageVersion,
    files: Object.freeze({ ...files }),
  });
}

export function serializeBaseline(baseline: BaselineV1): string {
  const files = dictionary<BaselineFileEntry>();
  for (const key of Object.keys(baseline.files).sort()) {
    files[fileKey(key)] = orderedEntry(baseline.files[key]!);
  }
  return `${JSON.stringify(
    {
      schemaVersion: baselineSchemaVersion,
      geolintVersion: baseline.geolintVersion,
      files,
    },
    null,
    2,
  )}\n`;
}
