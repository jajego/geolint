export type Severity = 'off' | 'warn' | 'error';
export type RuleSetting =
  Severity | readonly [Exclude<Severity, 'off'>, unknown?];
export type RuleConfigMap = Readonly<Record<string, RuleSetting>>;
export type BudgetConfig = Readonly<Record<string, unknown>>;
export type RegressionConfig = Readonly<Record<string, unknown>>;

export interface DiagnosticLimitConfig {
  maxPerCodePerFile?: number;
  maxPerFile?: number;
}

export interface GeoLintOverride {
  files: readonly string[];
  ignores?: readonly string[];
  rules?: RuleConfigMap;
  budgets?: BudgetConfig;
  regression?: RegressionConfig;
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
