import { builtInRules } from '../rules/builtins.js';
import { compileRegression } from '../regression/compare.js';
import type { BaselineFileEntry } from '../regression/schema.js';
import { appendPointer } from '../scanner/json-pointer.js';
import type {
  CoordinateObservation,
  FeatureIdObservation,
} from '../scanner/scan.js';
import { validateRuleListener } from '../rules/define-rule.js';
import type {
  RuleContext,
  RuleDiagnosticInput,
  RuleListener,
} from '../rules/define-rule.js';
import type { RuleOptionsSchema } from '../rules/option-schema.js';
import type {
  BudgetConfig,
  BudgetSeverity,
  ResolvedConfig,
  RuleSetting,
} from '../types/config.js';
import type {
  FeatureSummary,
  FileSummary,
  SkippedPolicy,
  SummaryFactName,
} from '../types/semantic.js';
import { DiagnosticCollector } from './diagnostics.js';
import { parseByteSize } from './byte-size.js';
import {
  GeoLintCapabilityError,
  GeoLintConfigError,
  GeoLintPluginError,
} from './errors.js';
import {
  skipPolicyForIncompleteFacts,
  type SemanticListener,
} from './requirements.js';

type InputKind = 'object' | 'text';
type Severity = 'warning' | 'error';

interface ErasedRule {
  readonly meta: {
    readonly name: string;
    readonly schema: RuleOptionsSchema<unknown> | null;
    readonly requires?: readonly SummaryFactName[];
  };
  readonly create: (
    context: RuleContext,
    options?: unknown,
  ) => RuleListener<readonly SummaryFactName[]>;
}

interface AggregatePolicy {
  readonly code: string;
  readonly source: 'rule' | 'budget';
  readonly severity: Severity;
  readonly requires: readonly SummaryFactName[];
  readonly evaluate: (summary: FileSummary) => void;
}

export interface CompiledPolicy {
  readonly listener?: SemanticListener;
  readonly coordinateObservation?: CoordinateObservation;
  readonly featureIdObservation?: FeatureIdObservation;
  readonly facts: readonly SummaryFactName[];
  readonly exactFileBytes: boolean;
  finish(summary: FileSummary): readonly SkippedPolicy[];
}

const ruleRegistry = new Map<string, ErasedRule>(
  builtInRules.map((rule) => [rule.meta.name, rule as unknown as ErasedRule]),
);

function severity(value: 'warn' | 'error'): Severity {
  return value === 'warn' ? 'warning' : 'error';
}

function context(
  ruleId: string,
  filePath: string,
  configuredSeverity: Severity,
  diagnostics: DiagnosticCollector,
): RuleContext {
  return Object.freeze({
    ruleId,
    filePath,
    report(input: RuleDiagnosticInput): void {
      diagnostics.report({
        ...input,
        code: ruleId,
        source: 'rule',
        severity: configuredSeverity,
      });
    },
  });
}

function combine<T>(
  subscribers: readonly ((event: T) => void)[],
): ((event: T) => void) | undefined {
  if (subscribers.length === 0) return undefined;
  if (subscribers.length === 1) return subscribers[0];
  return (event) => {
    for (const subscriber of subscribers) subscriber(event);
  };
}

function composite(
  listeners: readonly SemanticListener[],
): SemanticListener | undefined {
  if (listeners.length === 0) return undefined;
  const featureStart = combine(
    listeners.flatMap((listener) =>
      listener.featureStart ? [listener.featureStart] : [],
    ),
  );
  const property = combine(
    listeners.flatMap((listener) =>
      listener.property ? [listener.property] : [],
    ),
  );
  const propertyValue = combine(
    listeners.flatMap((listener) =>
      listener.propertyValue ? [listener.propertyValue] : [],
    ),
  );
  const coordinate = combine(
    listeners.flatMap((listener) =>
      listener.coordinate ? [listener.coordinate] : [],
    ),
  );
  const coordinateLexeme = combine(
    listeners.flatMap((listener) =>
      listener.coordinateLexeme ? [listener.coordinateLexeme] : [],
    ),
  );
  const geometry = combine(
    listeners.flatMap((listener) =>
      listener.geometry ? [listener.geometry] : [],
    ),
  );
  const feature = combine(
    listeners.flatMap((listener) =>
      listener.feature ? [listener.feature] : [],
    ),
  );
  return {
    ...(featureStart ? { featureStart } : {}),
    ...(property ? { property } : {}),
    ...(propertyValue ? { propertyValue } : {}),
    ...(coordinate ? { coordinate } : {}),
    ...(coordinateLexeme ? { coordinateLexeme } : {}),
    ...(geometry ? { geometry } : {}),
    ...(feature ? { feature } : {}),
  };
}

function settingParts(setting: Exclude<RuleSetting, 'off'>): {
  readonly severity: Severity;
  readonly options: unknown;
  readonly hasOptions: boolean;
} {
  return Array.isArray(setting)
    ? {
        severity: severity(setting[0]),
        options: setting[1],
        hasOptions: setting.length === 2,
      }
    : {
        severity: severity(setting as 'warn' | 'error'),
        options: undefined,
        hasOptions: false,
      };
}

function compileRules(
  rules: ResolvedConfig['rules'],
  filePath: string,
  inputKind: InputKind,
  diagnostics: DiagnosticCollector,
  listeners: SemanticListener[],
  facts: Set<SummaryFactName>,
  aggregates: AggregatePolicy[],
  coordinateObservations: CoordinateObservation[],
  featureIdObservations: FeatureIdObservation[],
): void {
  for (const [name, setting] of Object.entries(rules)) {
    if (setting !== 'off' && !ruleRegistry.has(name)) {
      throw new GeoLintConfigError(
        `Unknown enabled rule "${name}".`,
        'GEOLINT_UNKNOWN_RULE',
      );
    }
  }
  for (const rule of ruleRegistry.values()) {
    const setting = rules[rule.meta.name];
    if (!setting || setting === 'off') continue;
    const compiled = settingParts(setting);
    let options: unknown;
    if (rule.meta.schema === null) {
      if (compiled.hasOptions) {
        throw new GeoLintConfigError(
          `Rule "${rule.meta.name}" does not accept options.`,
          'GEOLINT_INVALID_RULE_OPTIONS',
        );
      }
    } else {
      options = rule.meta.schema.parse(
        compiled.options,
        `rules.${rule.meta.name}`,
      );
    }
    const ruleContext = context(
      rule.meta.name,
      filePath,
      compiled.severity,
      diagnostics,
    );
    const instance = rule.create(ruleContext, options);
    const requires = rule.meta.requires ?? [];
    validateRuleListener(rule.meta.name, requires, instance);
    if (instance.coordinateLexeme) {
      throw new GeoLintCapabilityError(
        inputKind === 'object'
          ? `Rule "${rule.meta.name}" requires numeric source lexemes, which parsed object input cannot provide.`
          : `Rule "${rule.meta.name}" requires indexed numeric source lexemes, which the buffered text strategy does not provide yet.`,
        'GEOLINT_CAPABILITY_NUMERIC_LEXEMES',
      );
    }
    if (rule.meta.name === 'require-feature-id') {
      featureIdObservations.push((index, path, status) => {
        if (status === 'missing') {
          diagnostics.reportLazy(
            {
              code: rule.meta.name,
              source: 'rule',
              severity: compiled.severity,
            },
            () => ({
              message: 'Expected Feature to have an ID.',
              featureIndex: index,
              path,
            }),
          );
        }
      });
      continue;
    }
    if (rule.meta.name === 'unique-feature-id') {
      const strings = new Set<string>();
      const numbers = new Set<number>();
      featureIdObservations.push((index, path, status, id) => {
        if (status !== 'valid' || id === undefined) return;
        const duplicate =
          typeof id === 'string' ? strings.has(id) : numbers.has(id);
        if (duplicate) {
          diagnostics.reportLazy(
            {
              code: rule.meta.name,
              source: 'rule',
              severity: compiled.severity,
            },
            () => ({
              message: 'Feature ID is duplicated.',
              featureIndex: index,
              featureId: id,
              path,
              data: { featureId: id },
            }),
          );
        } else if (typeof id === 'string') strings.add(id);
        else numbers.add(id);
      });
      continue;
    }
    if (rule.meta.name === 'valid-coordinate-range') {
      coordinateObservations.push(
        (values, featureIndex, parentPath, positionIndex) => {
          const longitude = values[0]!;
          const latitude = values[1]!;
          if (
            longitude < -180 ||
            longitude > 180 ||
            latitude < -90 ||
            latitude > 90
          ) {
            diagnostics.reportLazy(
              {
                code: rule.meta.name,
                source: 'rule',
                severity: compiled.severity,
              },
              () => ({
                message:
                  'Coordinate is outside valid longitude/latitude ranges.',
                ...(featureIndex === undefined ? {} : { featureIndex }),
                path:
                  positionIndex === undefined
                    ? parentPath
                    : appendPointer(parentPath, positionIndex),
                data: { longitude, latitude },
              }),
            );
          }
        },
      );
      continue;
    }
    const { document, ...local } = instance;
    if (Object.keys(local).length > 0) listeners.push(local);
    for (const fact of requires) facts.add(fact);
    if (document) {
      aggregates.push({
        code: rule.meta.name,
        source: 'rule',
        severity: compiled.severity,
        requires,
        evaluate: document as (summary: FileSummary) => void,
      });
    }
  }
}

function normalizeBudget<T>(
  value:
    | T
    | false
    | { readonly limit?: T; readonly severity?: BudgetSeverity }
    | undefined,
  path: string,
  parseLimit: (value: unknown, path: string) => number,
): { readonly limit: number; readonly severity: Severity } | undefined {
  if (value === undefined || value === false) return undefined;
  const object = (
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value
      : undefined
  ) as { readonly limit?: T; readonly severity?: BudgetSeverity } | undefined;
  const unknown = object
    ? Object.keys(object).find((key) => key !== 'limit' && key !== 'severity')
    : undefined;
  if (unknown) {
    throw new GeoLintConfigError(
      `Unknown option "${unknown}" for budget "${path.slice('budgets.'.length)}".`,
      'GEOLINT_INVALID_BUDGET',
    );
  }
  const limit = parseLimit(object ? object.limit : value, `${path}.limit`);
  const configuredSeverity = object?.severity ?? 'error';
  if (configuredSeverity !== 'warn' && configuredSeverity !== 'error') {
    throw new GeoLintConfigError(
      `Invalid budget at ${path}.severity: expected warn or error.`,
      'GEOLINT_INVALID_BUDGET',
    );
  }
  return { limit, severity: severity(configuredSeverity) };
}

function numericLimit(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new GeoLintConfigError(
      `Invalid budget at ${path}: expected a non-negative safe integer.`,
      'GEOLINT_INVALID_BUDGET',
    );
  }
  return Number(value);
}

function reportBudget(
  diagnostics: DiagnosticCollector,
  code: string,
  configuredSeverity: Severity,
  message: string,
  actual: number,
  limit: number,
  feature?: FeatureSummary,
): void {
  diagnostics.reportLazy(
    { code, source: 'budget', severity: configuredSeverity },
    () => ({
      message,
      data: { actual, limit },
      ...(feature
        ? {
            featureIndex: feature.index,
            ...(feature.id === undefined ? {} : { featureId: feature.id }),
            path: feature.path,
          }
        : {}),
    }),
  );
}

function compileBudgets(
  budgets: BudgetConfig,
  inputKind: InputKind,
  diagnostics: DiagnosticCollector,
  listeners: SemanticListener[],
  facts: Set<SummaryFactName>,
  aggregates: AggregatePolicy[],
): boolean {
  const unknown = Object.keys(budgets).find(
    (key) =>
      !['fileSize', 'featureCount', 'totalVertices', 'feature'].includes(key),
  );
  if (unknown) {
    throw new GeoLintConfigError(
      `Unknown budget "${unknown}".`,
      'GEOLINT_UNKNOWN_BUDGET',
    );
  }
  const fileSize = normalizeBudget(
    budgets.fileSize,
    'budgets.fileSize',
    parseByteSize,
  );
  if (fileSize && inputKind === 'object') {
    throw new GeoLintCapabilityError(
      'File-size budgets require exact source bytes, which parsed object input cannot provide.',
      'GEOLINT_CAPABILITY_FILE_BYTES',
    );
  }
  if (fileSize) {
    aggregates.push({
      code: 'budget/file-size',
      source: 'budget',
      severity: fileSize.severity,
      requires: [],
      evaluate(summary) {
        if (summary.bytes! > fileSize.limit) {
          reportBudget(
            diagnostics,
            'budget/file-size',
            fileSize.severity,
            'File size exceeds its configured budget.',
            summary.bytes!,
            fileSize.limit,
          );
        }
      },
    });
  }
  const featureCount = normalizeBudget(
    budgets.featureCount,
    'budgets.featureCount',
    numericLimit,
  );
  if (featureCount) {
    facts.add('featureCount');
    aggregates.push({
      code: 'budget/feature-count',
      source: 'budget',
      severity: featureCount.severity,
      requires: ['featureCount'],
      evaluate(summary) {
        if (summary.featureCount > featureCount.limit) {
          reportBudget(
            diagnostics,
            'budget/feature-count',
            featureCount.severity,
            'Feature count exceeds its configured budget.',
            summary.featureCount,
            featureCount.limit,
          );
        }
      },
    });
  }
  const totalVertices = normalizeBudget(
    budgets.totalVertices,
    'budgets.totalVertices',
    numericLimit,
  );
  if (totalVertices) {
    facts.add('vertexCount');
    aggregates.push({
      code: 'budget/total-vertices',
      source: 'budget',
      severity: totalVertices.severity,
      requires: ['vertexCount'],
      evaluate(summary) {
        if (summary.totalVertices > totalVertices.limit) {
          reportBudget(
            diagnostics,
            'budget/total-vertices',
            totalVertices.severity,
            'Total vertices exceed their configured budget.',
            summary.totalVertices,
            totalVertices.limit,
          );
        }
      },
    });
  }
  const feature = budgets.feature;
  if (feature) {
    const unknownFeature = Object.keys(feature).find(
      (key) => !['bytes', 'vertices'].includes(key),
    );
    if (unknownFeature) {
      throw new GeoLintConfigError(
        `Unknown budget "feature.${unknownFeature}".`,
        'GEOLINT_UNKNOWN_BUDGET',
      );
    }
    const bytes = normalizeBudget(
      feature.bytes,
      'budgets.feature.bytes',
      parseByteSize,
    );
    if (bytes) {
      throw new GeoLintCapabilityError(
        inputKind === 'object'
          ? 'Feature-byte budgets require source spans, which parsed object input cannot provide.'
          : 'Feature-byte budgets require indexed source spans, which the buffered text strategy does not provide yet.',
        'GEOLINT_CAPABILITY_FEATURE_BYTES',
      );
    }
    const vertices = normalizeBudget(
      feature.vertices,
      'budgets.feature.vertices',
      numericLimit,
    );
    if (vertices) {
      listeners.push({
        feature(summary) {
          const actual = summary.geometry?.vertices ?? 0;
          if (actual > vertices.limit) {
            reportBudget(
              diagnostics,
              'budget/feature-vertices',
              vertices.severity,
              'Feature vertices exceed their configured budget.',
              actual,
              vertices.limit,
              summary,
            );
          }
        },
      });
    }
  }
  return Boolean(fileSize);
}

export function compilePolicy(
  config: ResolvedConfig,
  filePath: string,
  inputKind: InputKind,
  diagnostics: DiagnosticCollector,
  baseline?: BaselineFileEntry,
): CompiledPolicy {
  if (Object.keys(config.plugins).length > 0) {
    throw new GeoLintPluginError(
      'External plugin loading is not implemented yet.',
      'GEOLINT_PLUGIN_LOADING_UNAVAILABLE',
    );
  }
  const listeners: SemanticListener[] = [];
  const facts = new Set<SummaryFactName>();
  const aggregates: AggregatePolicy[] = [];
  const coordinateObservations: CoordinateObservation[] = [];
  const featureIdObservations: FeatureIdObservation[] = [];
  compileRules(
    config.rules,
    filePath,
    inputKind,
    diagnostics,
    listeners,
    facts,
    aggregates,
    coordinateObservations,
    featureIdObservations,
  );
  const budgetFileBytes = compileBudgets(
    config.budgets,
    inputKind,
    diagnostics,
    listeners,
    facts,
    aggregates,
  );
  const regression = compileRegression(
    config.regression,
    inputKind,
    diagnostics,
    baseline,
  );
  for (const fact of regression.facts) facts.add(fact);
  const listener = composite(listeners);
  const coordinateObservation: CoordinateObservation | undefined =
    coordinateObservations.length === 0
      ? undefined
      : coordinateObservations.length === 1
        ? coordinateObservations[0]
        : (values, featureIndex, parentPath, positionIndex) => {
            for (const observe of coordinateObservations) {
              observe(values, featureIndex, parentPath, positionIndex);
            }
          };
  const featureIdObservation: FeatureIdObservation | undefined =
    featureIdObservations.length === 0
      ? undefined
      : featureIdObservations.length === 1
        ? featureIdObservations[0]
        : (index, path, status, id) => {
            for (const observe of featureIdObservations) {
              observe(index, path, status, id);
            }
          };
  return {
    ...(listener ? { listener } : {}),
    ...(coordinateObservation ? { coordinateObservation } : {}),
    ...(featureIdObservation ? { featureIdObservation } : {}),
    facts: [...facts],
    exactFileBytes: budgetFileBytes || regression.exactFileBytes,
    finish(summary) {
      const skipped: SkippedPolicy[] = [];
      for (const policy of aggregates) {
        const skip = skipPolicyForIncompleteFacts({
          code: policy.code,
          source: policy.source,
          requiredFacts: policy.requires,
          completeness: summary.completeness,
          configuredSeverity: policy.severity,
        });
        if (skip) skipped.push(skip);
        else policy.evaluate(summary);
      }
      skipped.push(...regression.finish(summary));
      return skipped;
    },
  };
}
