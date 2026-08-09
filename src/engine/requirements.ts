import type {
  CoordinateEvent,
  CoordinateLexemeEvent,
  FeatureStartEvent,
  FeatureSummary,
  FileSummary,
  GeometrySummary,
  PropertyEvent,
  PropertyValueEvent,
  SkippedPolicy,
  SummaryFactName,
} from '../types/semantic.js';
import { GeoLintInternalError } from './errors.js';

export interface SemanticListener {
  readonly featureStart?: (event: FeatureStartEvent) => void;
  readonly property?: (event: PropertyEvent) => void;
  readonly propertyValue?: (event: PropertyValueEvent) => void;
  readonly coordinate?: (event: CoordinateEvent) => void;
  readonly coordinateLexeme?: (event: CoordinateLexemeEvent) => void;
  readonly geometry?: (summary: GeometrySummary) => void;
  readonly feature?: (summary: FeatureSummary) => void;
  readonly document?: (summary: FileSummary) => void;
}

export interface ExecutionRequirements {
  readonly geometrySummaries: boolean;
  readonly featureCount: boolean;
  readonly featureIds: boolean;
  readonly propertyNames: boolean;
  readonly propertyTypes: boolean;
  readonly propertyValues: boolean;
  readonly positions: boolean;
  readonly numericLexemes: boolean;
  readonly vertexCounts: boolean;
  readonly ringCounts: boolean;
  readonly geometryNodeCounts: boolean;
  readonly featureGeometryTypes: boolean;
  readonly geographicExtents: boolean;
  readonly coordinateDimensions: boolean;
  readonly propertyStats: boolean;
  readonly idStats: boolean;
  readonly exactFileBytes: boolean;
  readonly featureByteSpans: boolean;
}

export interface RequirementOptions {
  readonly facts?: readonly SummaryFactName[];
  readonly listener?: SemanticListener;
  readonly exactFileBytes?: boolean;
  readonly numericLexemes?: boolean;
  readonly featureByteSpans?: boolean;
}

export function createExecutionRequirements(
  options: RequirementOptions = {},
): ExecutionRequirements {
  const facts = new Set(options.facts);
  const listener = options.listener;
  const geometrySummaries = Boolean(listener?.geometry || listener?.feature);
  const propertyStats = facts.has('propertyStats');
  const geometryStats = facts.has('geometryStats');
  const idStats = facts.has('idStats');
  const vertexCounts = facts.has('vertexCount');
  const coordinateDimensions = facts.has('coordinateDimensionStats');
  const geographicExtents = facts.has('derivedExtent');
  const numericLexemes =
    options.numericLexemes ?? Boolean(listener?.coordinateLexeme);

  return Object.freeze({
    geometrySummaries,
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
      numericLexemes ||
      vertexCounts ||
      coordinateDimensions ||
      geographicExtents ||
      geometrySummaries,
    vertexCounts,
    ringCounts: geometrySummaries,
    geometryNodeCounts: geometryStats || geometrySummaries,
    featureGeometryTypes: geometryStats,
    geographicExtents,
    coordinateDimensions,
    propertyStats,
    idStats,
    numericLexemes,
    exactFileBytes: options.exactFileBytes ?? false,
    featureByteSpans: options.featureByteSpans ?? false,
  });
}

export const noExecutionRequirements = createExecutionRequirements();

export function skipPolicyForIncompleteFacts(options: {
  readonly code: string;
  readonly source: 'rule' | 'budget' | 'regression';
  readonly requiredFacts: readonly SummaryFactName[];
  readonly completeness: FileSummary['completeness'];
  readonly configuredSeverity?: 'warning' | 'error';
}): SkippedPolicy | undefined {
  const notComputed = options.requiredFacts.find(
    (fact) => options.completeness.facts[fact] === 'not-computed',
  );
  if (notComputed) {
    throw new GeoLintInternalError(
      `Policy "${options.code}" required uncomputed fact "${notComputed}".`,
      'GEOLINT_POLICY_PLAN_INVARIANT',
    );
  }
  const incompleteFacts = options.requiredFacts.filter(
    (fact) => options.completeness.facts[fact] === 'partial',
  );
  return incompleteFacts.length === 0
    ? undefined
    : {
        code: options.code,
        source: options.source,
        reason: 'incomplete-facts',
        requiredFacts: options.requiredFacts,
        incompleteFacts,
        ...(options.configuredSeverity
          ? { configuredSeverity: options.configuredSeverity }
          : {}),
      };
}
