import type {
  CoordinateEvent,
  FeatureStartEvent,
  FeatureSummary,
  FileSummary,
  GeometrySummary,
  PropertyEvent,
  PropertyValueEvent,
  SummaryFactName,
} from '../types/semantic.js';

export interface SemanticListener {
  readonly featureStart?: (event: FeatureStartEvent) => void;
  readonly property?: (event: PropertyEvent) => void;
  readonly propertyValue?: (event: PropertyValueEvent) => void;
  readonly coordinate?: (event: CoordinateEvent) => void;
  readonly geometry?: (summary: GeometrySummary) => void;
  readonly feature?: (summary: FeatureSummary) => void;
  readonly document?: (summary: FileSummary) => void;
}

export interface ExecutionRequirements {
  readonly featureCount: boolean;
  readonly featureIds: boolean;
  readonly propertyNames: boolean;
  readonly propertyTypes: boolean;
  readonly propertyValues: boolean;
  readonly positions: boolean;
  readonly vertexCounts: boolean;
  readonly ringCounts: boolean;
  readonly geometryNodeCounts: boolean;
  readonly featureGeometryTypes: boolean;
  readonly geographicExtents: boolean;
  readonly coordinateDimensions: boolean;
  readonly propertyStats: boolean;
  readonly idStats: boolean;
  readonly exactFileBytes: boolean;
}

export interface RequirementOptions {
  readonly facts?: readonly SummaryFactName[];
  readonly listener?: SemanticListener;
  readonly exactFileBytes?: boolean;
}

export function createExecutionRequirements(
  options: RequirementOptions = {},
): ExecutionRequirements {
  const facts = new Set(options.facts);
  const listener = options.listener;
  const wantsGeometrySummary = Boolean(listener?.geometry || listener?.feature);
  const propertyStats = facts.has('propertyStats');
  const geometryStats = facts.has('geometryStats');
  const idStats = facts.has('idStats');
  const vertexCounts = facts.has('vertexCount') || wantsGeometrySummary;
  const coordinateDimensions =
    facts.has('coordinateDimensionStats') || wantsGeometrySummary;

  return Object.freeze({
    featureCount:
      facts.has('featureCount') || propertyStats || geometryStats || idStats,
    featureIds: idStats || Boolean(listener?.feature),
    propertyNames:
      propertyStats || Boolean(listener?.property || listener?.propertyValue),
    propertyTypes:
      propertyStats || Boolean(listener?.property || listener?.propertyValue),
    propertyValues: Boolean(listener?.propertyValue),
    positions:
      Boolean(listener?.coordinate) ||
      vertexCounts ||
      coordinateDimensions ||
      facts.has('derivedExtent'),
    vertexCounts,
    ringCounts: wantsGeometrySummary,
    geometryNodeCounts: geometryStats || wantsGeometrySummary,
    featureGeometryTypes: geometryStats,
    geographicExtents: facts.has('derivedExtent') || wantsGeometrySummary,
    coordinateDimensions,
    propertyStats,
    idStats,
    exactFileBytes: options.exactFileBytes ?? false,
  });
}

export const noExecutionRequirements = createExecutionRequirements();
