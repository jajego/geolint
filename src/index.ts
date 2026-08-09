import type { GeoLintConfig } from './types/config.js';

export { lintFile, lintGeoJSON, lintGeoJSONText } from './engine/lint-input.js';
export type {
  FileLintOptions,
  InMemoryLintOptions,
} from './engine/lint-input.js';
export {
  GeoLintBatchError,
  GeoLintCapabilityError,
  GeoLintConfigError,
  GeoLintError,
  GeoLintInputError,
  GeoLintInternalError,
  GeoLintIOError,
  GeoLintPluginError,
  GeoLintTargetError,
} from './engine/errors.js';
export { jsonPointer } from './scanner/json-pointer.js';
export { defineRule } from './rules/define-rule.js';
export { definePlugin } from './plugins/plugin.js';
export { optionSchema } from './rules/option-schema.js';

export type {
  DiagnosticLimitConfig,
  BudgetConfig,
  BudgetSetting,
  BudgetSeverity,
  GeoLintConfig,
  GeoLintConfigFragment,
  GeoLintOverride,
  RegressionChecks,
  RegressionConfig,
  RegressionPolicyOverride,
  RegressionSeverity,
  RegressionThresholds,
} from './types/config.js';
export type { GeoLintPlugin } from './plugins/plugin.js';
export type {
  RuleContext,
  RuleDefinition,
  RuleDiagnosticInput,
  RuleDocs,
  RuleDocumentSummary,
  RuleListener,
  RuleMeta,
} from './rules/define-rule.js';
export type {
  InferRuleOptions,
  RuleOptionsSchema,
} from './rules/option-schema.js';
export type {
  CoordinateDimensions,
  CoordinateEvent,
  CoordinateLexemeEvent,
  Diagnostic,
  FactStatus,
  FeatureStartEvent,
  FeatureSummary,
  FileCompleteness,
  FileLintResult,
  FileSummary,
  GeographicExtent,
  GeoJSONGeometryType,
  GeometrySummary,
  JsonObject,
  JsonPointer,
  JsonPrimitive,
  JsonValue,
  JsonValueType,
  PropertyEvent,
  PropertyStats,
  PropertyValueEvent,
  SkippedPolicy,
  SummaryFactName,
  SuppressionSummary,
} from './types/semantic.js';

/** Defines a GeoLint configuration without changing its inferred type. */
export function defineConfig<const T extends GeoLintConfig>(config: T): T {
  return config;
}
