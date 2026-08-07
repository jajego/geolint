export type JsonPrimitive = null | boolean | string | number;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

declare const jsonPointerBrand: unique symbol;
export type JsonPointer = string & {
  readonly [jsonPointerBrand]: true;
};

export type JsonValueType =
  'string' | 'number' | 'boolean' | 'null' | 'array' | 'object';

export type GeoJSONGeometryType =
  | 'Point'
  | 'MultiPoint'
  | 'LineString'
  | 'MultiLineString'
  | 'Polygon'
  | 'MultiPolygon'
  | 'GeometryCollection';

export interface GeographicExtent {
  readonly west: number;
  readonly east: number;
  readonly south: number;
  readonly north: number;
  readonly crossesAntimeridian: boolean;
}

export interface FeatureStartEvent {
  readonly index: number;
  readonly path: JsonPointer;
  readonly byteOffset?: number;
}

export interface PropertyEvent {
  readonly featureIndex: number;
  readonly key: string;
  readonly path: JsonPointer;
  readonly type: JsonValueType;
}

export interface PropertyValueEvent extends PropertyEvent {
  readonly value: JsonValue;
}

export interface CoordinateEvent {
  readonly featureIndex?: number;
  readonly values: readonly number[];
  readonly path: JsonPointer;
}

export interface CoordinateLexemeEvent extends CoordinateEvent {
  readonly rawValues: readonly string[];
  readonly byteOffset?: number;
}

export type CoordinateDimensions = 2 | 3 | '4+' | 'mixed';

export interface GeometrySummary {
  readonly type: GeoJSONGeometryType;
  readonly path: JsonPointer;
  readonly vertices: number;
  readonly ringCount: number;
  readonly geometryNodeCount: number;
  readonly coordinateDimensions: CoordinateDimensions;
  readonly extent?: GeographicExtent;
}

export interface FeatureSummary {
  readonly index: number;
  readonly path: JsonPointer;
  readonly id?: string | number;
  readonly properties: {
    readonly isNull: boolean;
    readonly count: number;
  };
  readonly geometry: GeometrySummary | null;
  readonly bytes?: number;
}

export type SummaryFactName =
  | 'featureCount'
  | 'vertexCount'
  | 'propertyStats'
  | 'geometryStats'
  | 'idStats'
  | 'coordinateDimensionStats'
  | 'derivedExtent';

export type FactStatus = 'complete' | 'partial' | 'not-computed';

export interface FileCompleteness {
  readonly document: 'complete' | 'partial';
  readonly facts: {
    readonly fileBytes: FactStatus;
    readonly featureCount: FactStatus;
    readonly vertexCount: FactStatus;
    readonly propertyStats: FactStatus;
    readonly geometryStats: FactStatus;
    readonly idStats: FactStatus;
    readonly coordinateDimensionStats: FactStatus;
    readonly derivedExtent: FactStatus;
    readonly featureByteStats: FactStatus;
  };
}

export interface PropertyStats {
  readonly present: number;
  readonly missing: number;
  readonly types: ReadonlyMap<JsonValueType, number>;
}

export interface FileSummary {
  readonly filePath: string;
  readonly completeness: FileCompleteness;
  readonly bytes?: number;
  readonly featureCount: number;
  readonly totalVertices: number;
  readonly largestFeatureBytes?: number;
  readonly largestFeatureVertices?: number;
  readonly featureGeometryTypes?: ReadonlyMap<
    GeoJSONGeometryType | 'null',
    number
  >;
  readonly geometryNodeTypes?: ReadonlyMap<GeoJSONGeometryType, number>;
  readonly propertyStats?: ReadonlyMap<string, PropertyStats>;
  readonly ids?: {
    readonly present: number;
    readonly missing: number;
    readonly duplicateCount: number;
    readonly stringCount: number;
    readonly numberCount: number;
  };
  readonly propertiesNullCount?: number;
  readonly nullGeometryCount?: number;
  readonly coordinateDimensionStats?: {
    readonly two: number;
    readonly three: number;
    readonly fourOrMore: number;
  };
  readonly derivedExtent?: GeographicExtent;
}

export interface Diagnostic {
  readonly code: string;
  readonly source: 'parser' | 'geojson' | 'rule' | 'budget' | 'regression';
  readonly severity: 'warning' | 'error';
  readonly message: string;
  readonly filePath: string;
  readonly path?: JsonPointer;
  readonly featureIndex?: number;
  readonly featureId?: string | number;
  readonly byteOffset?: number;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface SuppressionSummary {
  readonly code: string;
  readonly severity: 'warning' | 'error';
  readonly suppressedCount: number;
}

export type SkippedPolicy =
  | {
      readonly code: string;
      readonly source: 'rule' | 'budget' | 'regression';
      readonly reason: 'incomplete-facts';
      readonly requiredFacts: readonly SummaryFactName[];
      readonly incompleteFacts: readonly SummaryFactName[];
      readonly configuredSeverity?: 'warning' | 'error';
    }
  | {
      readonly code: string;
      readonly source: 'regression';
      readonly reason: 'no-baseline';
      readonly configuredSeverity?: 'warning' | 'error';
    };

export interface FileLintResult {
  readonly filePath: string;
  readonly diagnostics: readonly Diagnostic[];
  readonly suppressedDiagnostics: readonly SuppressionSummary[];
  readonly skippedPolicies: readonly SkippedPolicy[];
  readonly summary?: FileSummary;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly durationMs: number;
}
