import { builtInRules } from '../rules/builtins.js';
import { compileRegression } from '../regression/compare.js';
import type { BaselineFileEntry } from '../regression/schema.js';
import { appendPointer } from '../scanner/json-pointer.js';
import type {
  CoordinateObservation,
  CoordinateLexemeObservation,
  FeatureIdObservation,
  FeatureByteObservation,
} from '../scanner/scan.js';
import { validateRuleListener } from '../rules/define-rule.js';
import type {
  RuleContext,
  RuleDiagnosticInput,
  RuleListener,
} from '../rules/define-rule.js';
import type { RuleOptionsSchema } from '../rules/option-schema.js';
import type { GeoLintPlugin } from '../plugins/plugin.js';
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
import type { DiagnosticCollector } from './diagnostics.js';
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

interface RegistryRule {
  readonly id: string;
  readonly rule: ErasedRule;
  readonly plugin: boolean;
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
  readonly featureByteObservation?: FeatureByteObservation;
  readonly facts: readonly SummaryFactName[];
  readonly exactFileBytes: boolean;
  readonly numericLexemes: boolean;
  readonly featureByteSpans: boolean;
  readonly coordinateLexemeObservation?: CoordinateLexemeObservation;
  finish(summary: FileSummary): readonly SkippedPolicy[];
}

const builtInRegistry = Object.freeze(
  builtInRules.map((rule) => ({
    id: rule.meta.name,
    rule: rule as unknown as ErasedRule,
    plugin: false,
  })),
);

function effectiveRegistry(
  plugins: Readonly<Record<string, GeoLintPlugin>>,
): readonly RegistryRule[] {
  if (Object.keys(plugins).length === 0) return builtInRegistry;
  const registry: RegistryRule[] = [...builtInRegistry];
  for (const namespace of Object.keys(plugins).sort()) {
    const plugin = plugins[namespace]!;
    for (const localName of Object.keys(plugin.rules).sort()) {
      registry.push({
        id: `${namespace}/${localName}`,
        rule: plugin.rules[localName] as unknown as ErasedRule,
        plugin: true,
      });
    }
  }
  return registry;
}

const listenerHooks = Object.freeze([
  'featureStart',
  'property',
  'propertyValue',
  'coordinate',
  'coordinateLexeme',
  'geometry',
  'feature',
  'document',
] as const satisfies readonly (keyof RuleListener<
  readonly SummaryFactName[]
>)[]);

function pluginFailure(
  ruleId: string,
  filePath: string,
  cause: unknown,
): GeoLintPluginError {
  const error = new GeoLintPluginError(
    `Plugin rule "${ruleId}" failed while linting ${filePath}.`,
    'GEOLINT_PLUGIN_ERROR',
    ruleId,
    filePath,
    { cause },
  );
  if (cause instanceof Error && cause.stack)
    error.stack = `${error.stack}\nCaused by: ${cause.stack}`;
  return error;
}

function isPluginThenable(
  value: unknown,
  ruleId: string,
  filePath: string,
): boolean {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  ) {
    return false;
  }
  let then: unknown;
  try {
    then = (value as { readonly then?: unknown }).then;
  } catch (error) {
    throw pluginFailure(ruleId, filePath, error);
  }
  if (typeof then !== 'function') return false;
  try {
    void Promise.resolve(value).catch(() => undefined);
  } catch (error) {
    throw pluginFailure(ruleId, filePath, error);
  }
  return true;
}

function pluginListener(
  value: unknown,
  ruleId: string,
  filePath: string,
  requires: readonly SummaryFactName[],
): RuleListener<readonly SummaryFactName[]> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    isPluginThenable(value, ruleId, filePath)
  ) {
    throw pluginFailure(
      ruleId,
      filePath,
      new TypeError('create() must return a synchronous listener object.'),
    );
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw pluginFailure(
      ruleId,
      filePath,
      new TypeError('create() must return a plain listener object.'),
    );
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find(
    (key) => !listenerHooks.includes(key as (typeof listenerHooks)[number]),
  );
  if (unknown) {
    throw pluginFailure(
      ruleId,
      filePath,
      new TypeError(`Unsupported listener hook "${unknown}".`),
    );
  }
  const wrapped: Record<string, (event: unknown) => undefined> = {};
  for (const hook of listenerHooks) {
    const descriptor = Object.getOwnPropertyDescriptor(record, hook);
    if (!descriptor) continue;
    if (!('value' in descriptor) || typeof descriptor.value !== 'function') {
      throw pluginFailure(
        ruleId,
        filePath,
        new TypeError(`Listener hook "${hook}" must be a function.`),
      );
    }
    const callback = descriptor.value as (event: unknown) => unknown;
    wrapped[hook] = (event): undefined => {
      let result: unknown;
      try {
        result = callback(event);
      } catch (error) {
        throw pluginFailure(ruleId, filePath, error);
      }
      if (isPluginThenable(result, ruleId, filePath)) {
        throw pluginFailure(
          ruleId,
          filePath,
          new TypeError(`Listener hook "${hook}" returned a thenable.`),
        );
      }
      return undefined;
    };
  }
  if (requires.length > 0 && typeof wrapped.document !== 'function') {
    throw pluginFailure(
      ruleId,
      filePath,
      new TypeError(
        'A rule with aggregate requirements must provide a document hook.',
      ),
    );
  }
  return wrapped as RuleListener<readonly SummaryFactName[]>;
}

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
  plugins: ResolvedConfig['plugins'],
  rules: ResolvedConfig['rules'],
  filePath: string,
  inputKind: InputKind,
  diagnostics: DiagnosticCollector,
  listeners: SemanticListener[],
  facts: Set<SummaryFactName>,
  aggregates: AggregatePolicy[],
  coordinateObservations: CoordinateObservation[],
  coordinateLexemeObservations: CoordinateLexemeObservation[],
  featureIdObservations: FeatureIdObservation[],
): void {
  const registry = effectiveRegistry(plugins);
  const knownRules = new Set(registry.map(({ id }) => id));
  for (const [name, setting] of Object.entries(rules)) {
    if (setting !== 'off' && !knownRules.has(name)) {
      throw new GeoLintConfigError(
        `Unknown enabled rule "${name}".`,
        'GEOLINT_UNKNOWN_RULE',
      );
    }
  }
  for (const entry of registry) {
    const { rule, id: ruleId } = entry;
    const setting = rules[ruleId];
    if (!setting || setting === 'off') continue;
    const compiled = settingParts(setting);
    let options: unknown;
    if (rule.meta.schema === null) {
      if (compiled.hasOptions) {
        throw new GeoLintConfigError(
          `Rule "${ruleId}" does not accept options.`,
          'GEOLINT_INVALID_RULE_OPTIONS',
        );
      }
    } else {
      options = rule.meta.schema.parse(compiled.options, `rules.${ruleId}`);
    }
    const ruleContext = context(
      ruleId,
      filePath,
      compiled.severity,
      diagnostics,
    );
    const requires = rule.meta.requires ?? [];
    let instance: RuleListener<readonly SummaryFactName[]>;
    if (entry.plugin) {
      let created: unknown;
      try {
        created = rule.create(ruleContext, options);
      } catch (error) {
        throw pluginFailure(ruleId, filePath, error);
      }
      instance = pluginListener(created, ruleId, filePath, requires);
    } else {
      instance = rule.create(ruleContext, options);
      validateRuleListener(ruleId, requires, instance);
    }
    if (ruleId === 'coordinate-precision') {
      if (inputKind === 'object') {
        throw new GeoLintCapabilityError(
          'Rule "coordinate-precision" requires numeric source lexemes, which parsed object input cannot provide.',
          'GEOLINT_CAPABILITY_NUMERIC_LEXEMES',
        );
      }
      const maximumDecimals = (options as { maximumDecimals: number })
        .maximumDecimals;
      coordinateLexemeObservations.push(
        (rawValues, featureIndex, parentPath, positionIndex, byteOffset) => {
          let maximumObserved = 0;
          let offendingToken: string | undefined;
          for (const raw of rawValues) {
            const observed = effectiveDecimals(raw);
            if (observed > maximumObserved) maximumObserved = observed;
            if (offendingToken === undefined && observed > maximumDecimals) {
              offendingToken = raw;
            }
          }
          if (offendingToken === undefined) return;
          diagnostics.reportLazy(
            {
              code: ruleId,
              source: 'rule',
              severity: compiled.severity,
            },
            () => ({
              message: 'Coordinate precision exceeds its configured limit.',
              ...(featureIndex === undefined ? {} : { featureIndex }),
              path:
                positionIndex === undefined
                  ? parentPath
                  : appendPointer(parentPath, positionIndex),
              byteOffset,
              data: {
                maximumDecimals,
                maximumObserved,
                offendingToken,
              },
            }),
          );
        },
      );
      continue;
    }
    if (instance.coordinateLexeme && inputKind === 'object') {
      throw new GeoLintCapabilityError(
        `Rule "${ruleId}" requires numeric source lexemes, which parsed object input cannot provide.`,
        'GEOLINT_CAPABILITY_NUMERIC_LEXEMES',
      );
    }
    if (ruleId === 'require-feature-id') {
      featureIdObservations.push((index, path, status) => {
        if (status === 'missing') {
          diagnostics.reportLazy(
            {
              code: ruleId,
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
    if (ruleId === 'unique-feature-id') {
      const strings = new Set<string>();
      const numbers = new Set<number>();
      featureIdObservations.push((index, path, status, id) => {
        if (status !== 'valid' || id === undefined) return;
        const duplicate =
          typeof id === 'string' ? strings.has(id) : numbers.has(id);
        if (duplicate) {
          diagnostics.reportLazy(
            {
              code: ruleId,
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
    if (ruleId === 'valid-coordinate-range') {
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
                code: ruleId,
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
        code: ruleId,
        source: 'rule',
        severity: compiled.severity,
        requires,
        evaluate: document as (summary: FileSummary) => void,
      });
    }
  }
}

function effectiveDecimals(raw: string): number {
  const exponentAt = raw.search(/[eE]/);
  const mantissa = exponentAt === -1 ? raw : raw.slice(0, exponentAt);
  const decimalAt = mantissa.indexOf('.');
  const fractionDigits = decimalAt === -1 ? 0 : mantissa.length - decimalAt - 1;
  if (exponentAt === -1) return fractionDigits;
  const exponent = raw.slice(exponentAt + 1);
  const negative = exponent.startsWith('-');
  const digits = exponent.replace(/^[+-]?0*/, '');
  if (digits.length > 15) return negative ? Number.MAX_SAFE_INTEGER : 0;
  const magnitude = digits.length === 0 ? 0 : Number(digits);
  if (!negative) return Math.max(0, fractionDigits - magnitude);
  return Math.min(Number.MAX_SAFE_INTEGER, fractionDigits + magnitude);
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
  featureByteObservations: FeatureByteObservation[],
): { readonly exactFileBytes: boolean; readonly featureByteSpans: boolean } {
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
    if (bytes && inputKind === 'object') {
      throw new GeoLintCapabilityError(
        'Feature-byte budgets require source spans, which parsed object input cannot provide.',
        'GEOLINT_CAPABILITY_FEATURE_BYTES',
      );
    }
    if (bytes) {
      featureByteObservations.push((index, path, actual, byteOffset, id) => {
        if (actual <= bytes.limit) return;
        diagnostics.reportLazy(
          {
            code: 'budget/feature-bytes',
            source: 'budget',
            severity: bytes.severity,
          },
          () => ({
            message: 'Feature bytes exceed their configured budget.',
            featureIndex: index,
            ...(id === undefined ? {} : { featureId: id }),
            path,
            byteOffset,
            data: { actual, limit: bytes.limit },
          }),
        );
      });
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
  return {
    exactFileBytes: Boolean(fileSize),
    featureByteSpans: Boolean(
      feature && feature.bytes !== undefined && feature.bytes !== false,
    ),
  };
}

export function compilePolicy(
  config: ResolvedConfig,
  filePath: string,
  inputKind: InputKind,
  diagnostics: DiagnosticCollector,
  baseline?: BaselineFileEntry,
): CompiledPolicy {
  const listeners: SemanticListener[] = [];
  const facts = new Set<SummaryFactName>();
  const aggregates: AggregatePolicy[] = [];
  const coordinateObservations: CoordinateObservation[] = [];
  const coordinateLexemeObservations: CoordinateLexemeObservation[] = [];
  const featureIdObservations: FeatureIdObservation[] = [];
  const featureByteObservations: FeatureByteObservation[] = [];
  compileRules(
    config.plugins,
    config.rules,
    filePath,
    inputKind,
    diagnostics,
    listeners,
    facts,
    aggregates,
    coordinateObservations,
    coordinateLexemeObservations,
    featureIdObservations,
  );
  const budgetRequirements = compileBudgets(
    config.budgets,
    inputKind,
    diagnostics,
    listeners,
    facts,
    aggregates,
    featureByteObservations,
  );
  const regression = compileRegression(
    config.regression,
    inputKind,
    diagnostics,
    baseline,
  );
  for (const fact of regression.facts) facts.add(fact);
  const listener = composite(listeners);
  let coordinateObservation: CoordinateObservation | undefined;
  if (coordinateObservations.length === 1)
    coordinateObservation = coordinateObservations[0];
  else if (coordinateObservations.length > 1) {
    coordinateObservation = (
      values,
      featureIndex,
      parentPath,
      positionIndex,
    ) => {
      for (const observe of coordinateObservations)
        observe(values, featureIndex, parentPath, positionIndex);
    };
  }
  let featureIdObservation: FeatureIdObservation | undefined;
  if (featureIdObservations.length === 1)
    featureIdObservation = featureIdObservations[0];
  else if (featureIdObservations.length > 1) {
    featureIdObservation = (index, path, status, id) => {
      for (const observe of featureIdObservations)
        observe(index, path, status, id);
    };
  }
  let coordinateLexemeObservation: CoordinateLexemeObservation | undefined;
  if (coordinateLexemeObservations.length === 1)
    coordinateLexemeObservation = coordinateLexemeObservations[0];
  else if (coordinateLexemeObservations.length > 1) {
    coordinateLexemeObservation = (
      rawValues,
      featureIndex,
      parentPath,
      positionIndex,
      byteOffset,
    ) => {
      for (const observe of coordinateLexemeObservations)
        observe(rawValues, featureIndex, parentPath, positionIndex, byteOffset);
    };
  }
  let featureByteObservation: FeatureByteObservation | undefined;
  if (featureByteObservations.length === 1)
    featureByteObservation = featureByteObservations[0];
  else if (featureByteObservations.length > 1) {
    featureByteObservation = (index, path, bytes, byteOffset, id) => {
      for (const observe of featureByteObservations)
        observe(index, path, bytes, byteOffset, id);
    };
  }
  return {
    ...(listener ? { listener } : {}),
    ...(coordinateObservation ? { coordinateObservation } : {}),
    ...(featureIdObservation ? { featureIdObservation } : {}),
    ...(coordinateLexemeObservation ? { coordinateLexemeObservation } : {}),
    ...(featureByteObservation ? { featureByteObservation } : {}),
    facts: [...facts],
    exactFileBytes:
      budgetRequirements.exactFileBytes || regression.exactFileBytes,
    numericLexemes:
      coordinateLexemeObservations.length > 0 ||
      Boolean(listener?.coordinateLexeme),
    featureByteSpans: budgetRequirements.featureByteSpans,
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
