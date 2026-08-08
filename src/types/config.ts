export type Severity = 'off' | 'warn' | 'error';
export type RuleSetting =
  Severity | readonly [Exclude<Severity, 'off'>, unknown?];
export type RuleConfigMap = Readonly<Record<string, RuleSetting>>;
export type BudgetSeverity = 'warn' | 'error';
export type BudgetSetting<T> =
  | T
  | false
  | {
      readonly limit?: T;
      readonly severity?: BudgetSeverity;
    };
export interface BudgetConfig {
  readonly fileSize?: BudgetSetting<string>;
  readonly featureCount?: BudgetSetting<number>;
  readonly totalVertices?: BudgetSetting<number>;
  readonly feature?:
    | false
    | {
        readonly bytes?: BudgetSetting<string>;
        readonly vertices?: BudgetSetting<number>;
      };
}
export type RegressionSeverity = Severity;

export interface RegressionChecks {
  readonly propertyTypes?: {
    readonly widened?: RegressionSeverity;
    readonly narrowed?: RegressionSeverity;
    readonly changed?: RegressionSeverity;
  };
  readonly properties?: {
    readonly added?: RegressionSeverity;
    readonly removed?: RegressionSeverity;
  };
  readonly geometryTypes?: {
    readonly added?: RegressionSeverity;
    readonly removed?: RegressionSeverity;
  };
  readonly duplicateIds?: { readonly increased?: RegressionSeverity };
  readonly missingIds?: { readonly increased?: RegressionSeverity };
  readonly nullGeometries?: { readonly increased?: RegressionSeverity };
}

export interface RegressionThresholds {
  readonly fileSizeIncrease?: {
    readonly percentage?: number;
    readonly minimumIncrease?: string;
  };
  readonly totalVerticesIncrease?: {
    readonly percentage?: number;
    readonly minimumIncrease?: number;
  };
  readonly featureCountDecrease?: {
    readonly percentage?: number;
    readonly minimumDecrease?: number;
  };
}

export interface RegressionConfig {
  readonly baseline?: string;
  readonly checks?: RegressionChecks;
  readonly thresholds?: RegressionThresholds;
}

export type RegressionPolicyOverride = Omit<RegressionConfig, 'baseline'> & {
  readonly baseline?: never;
};

export interface DiagnosticLimitConfig {
  maxPerCodePerFile?: number;
  maxPerFile?: number;
}

export interface GeoLintOverride {
  files: readonly string[];
  ignores?: readonly string[];
  rules?: RuleConfigMap;
  budgets?: BudgetConfig;
  regression?: RegressionPolicyOverride;
  diagnostics?: DiagnosticLimitConfig;
}

export interface GeoLintConfig {
  extends?: readonly string[];
  files?: readonly string[];
  ignores?: readonly string[];
  plugins?: Readonly<Record<string, unknown>>;
  rules?: RuleConfigMap;
  budgets?: BudgetConfig;
  regression?: RegressionConfig;
  diagnostics?: DiagnosticLimitConfig;
  overrides?: readonly GeoLintOverride[];
}

export interface ResolvedConfig {
  readonly projectRoot: string;
  readonly files?: readonly string[];
  readonly ignores?: readonly string[];
  readonly plugins: Readonly<Record<string, unknown>>;
  readonly rules: RuleConfigMap;
  readonly budgets: BudgetConfig;
  readonly regression: RegressionConfig;
  readonly diagnostics: DiagnosticLimitConfig;
  readonly overrides: readonly GeoLintOverride[];
}

export interface ResolvedFileConfig extends ResolvedConfig {
  readonly filePath: string;
  readonly matchingOverrides: readonly number[];
}

export interface GeoLintRuntimeContext {
  cwd?: string;
  config?: GeoLintConfig | string;
}
