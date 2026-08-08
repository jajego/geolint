import type { SemanticListener } from '../engine/requirements.js';
import type {
  FileSummary,
  SummaryFactName,
  Diagnostic,
  JsonPointer,
} from '../types/semantic.js';
import type { InferRuleOptions, RuleOptionsSchema } from './option-schema.js';

export interface RuleDiagnosticInput {
  readonly message: string;
  readonly featureIndex?: number;
  readonly featureId?: string | number;
  readonly path?: JsonPointer;
  readonly byteOffset?: number;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface RuleContext {
  readonly ruleId: string;
  readonly filePath: string;
  report(diagnostic: RuleDiagnosticInput): void;
}

type RequiredFactFields<F extends SummaryFactName> = F extends 'vertexCount'
  ? Required<Pick<FileSummary, 'largestFeatureVertices'>>
  : F extends 'propertyStats'
    ? Required<Pick<FileSummary, 'propertyStats' | 'propertiesNullCount'>>
    : F extends 'geometryStats'
      ? Required<
          Pick<
            FileSummary,
            'featureGeometryTypes' | 'geometryNodeTypes' | 'nullGeometryCount'
          >
        >
      : F extends 'idStats'
        ? Required<Pick<FileSummary, 'ids'>>
        : F extends 'coordinateDimensionStats'
          ? Required<Pick<FileSummary, 'coordinateDimensionStats'>>
          : F extends 'derivedExtent'
            ? Required<Pick<FileSummary, 'derivedExtent'>>
            : object;

type UnionToIntersection<U> = (
  U extends unknown ? (value: U) => void : never
) extends (value: infer I) => void
  ? I
  : never;

export type RuleDocumentSummary<R extends readonly SummaryFactName[]> =
  FileSummary & UnionToIntersection<RequiredFactFields<R[number]>>;

type SyncHook<F> = F extends (event: infer E) => void
  ? (event: E) => undefined
  : never;

export type RuleListener<R extends readonly SummaryFactName[]> = {
  readonly [K in keyof Omit<SemanticListener, 'document'>]?: SyncHook<
    NonNullable<SemanticListener[K]>
  >;
} & {
  readonly document?: (summary: RuleDocumentSummary<R>) => undefined;
};

export interface RuleMeta<
  S extends RuleOptionsSchema<unknown> | null,
  R extends readonly SummaryFactName[],
> {
  readonly name: string;
  readonly schema: S;
  readonly requires?: R;
  readonly docs?: string;
  readonly recommended?: boolean;
  readonly performance?: string;
  readonly capability?: 'numeric-lexemes';
}

export interface RuleDefinition<
  S extends RuleOptionsSchema<unknown> | null,
  R extends readonly SummaryFactName[],
> {
  readonly meta: RuleMeta<S, R>;
  readonly create: S extends RuleOptionsSchema<unknown>
    ? (context: RuleContext, options: InferRuleOptions<S>) => RuleListener<R>
    : (context: RuleContext) => RuleListener<R>;
}

export function defineRule<
  S extends RuleOptionsSchema<unknown> | null,
  const R extends readonly SummaryFactName[],
>(
  definition: RuleDefinition<S, R> & {
    readonly meta: { readonly requires: R };
  },
): RuleDefinition<S, R>;
export function defineRule<S extends RuleOptionsSchema<unknown> | null>(
  definition: RuleDefinition<S, readonly []>,
): RuleDefinition<S, readonly []>;
export function defineRule(
  definition: RuleDefinition<
    RuleOptionsSchema<unknown> | null,
    readonly SummaryFactName[]
  >,
) {
  return Object.freeze(definition);
}

export type CompiledRuleSeverity = Extract<
  Diagnostic['severity'],
  'warning' | 'error'
>;
