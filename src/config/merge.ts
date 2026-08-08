import type {
  GeoLintConfig,
  GeoLintOverride,
  RegressionConfig,
} from '../types/config.js';
import { GeoLintConfigError } from '../engine/errors.js';

function mergeObject<T extends object>(
  base: T | undefined,
  next: T | undefined,
): T {
  return { ...base, ...next } as T;
}

function mergeNested(
  base: Readonly<Record<string, unknown>> | undefined,
  next: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  if (!next) return { ...base };
  const merged = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(next)) {
    const previous = merged[key];
    merged[key] =
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      previous &&
      typeof previous === 'object' &&
      !Array.isArray(previous)
        ? mergeNested(
            previous as Record<string, unknown>,
            value as Record<string, unknown>,
          )
        : value;
  }
  return merged;
}

function mergeRegression(
  base: RegressionConfig | undefined,
  next: RegressionConfig | undefined,
): RegressionConfig {
  const merged = mergeNested(
    base as Readonly<Record<string, unknown>> | undefined,
    next as Readonly<Record<string, unknown>> | undefined,
  ) as Record<string, unknown>;
  const baseThresholds = base?.thresholds;
  const nextThresholds = next?.thresholds;
  if (
    baseThresholds &&
    typeof baseThresholds === 'object' &&
    !Array.isArray(baseThresholds) &&
    nextThresholds &&
    typeof nextThresholds === 'object' &&
    !Array.isArray(nextThresholds)
  ) {
    merged.thresholds = {
      ...(baseThresholds as Record<string, unknown>),
      ...(nextThresholds as Record<string, unknown>),
    };
  }
  return merged as RegressionConfig;
}

function mergePlugins(
  base: Readonly<Record<string, unknown>> | undefined,
  next: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  for (const [namespace, plugin] of Object.entries(next ?? {})) {
    if (base?.[namespace] && base[namespace] !== plugin) {
      throw new GeoLintConfigError(
        `Plugin namespace "${namespace}" has conflicting identities.`,
        'GEOLINT_PLUGIN_CONFLICT',
      );
    }
  }
  return mergeObject(base, next);
}

export function mergeConfig(
  base: GeoLintConfig,
  next: GeoLintConfig,
): GeoLintConfig {
  const files = next.files ?? base.files;
  const ignores = next.ignores ?? base.ignores;
  return {
    plugins: mergePlugins(base.plugins, next.plugins),
    rules: mergeObject(base.rules, next.rules),
    budgets: mergeNested(
      base.budgets as Readonly<Record<string, unknown>> | undefined,
      next.budgets as Readonly<Record<string, unknown>> | undefined,
    ),
    regression: mergeRegression(base.regression, next.regression),
    diagnostics: mergeObject(base.diagnostics, next.diagnostics),
    overrides: [...(base.overrides ?? []), ...(next.overrides ?? [])],
    ...(files ? { files } : {}),
    ...(ignores ? { ignores } : {}),
  };
}

export function mergeOverride(
  base: GeoLintConfig,
  override: GeoLintOverride,
): GeoLintConfig {
  return mergeConfig(base, {
    ...(override.rules ? { rules: override.rules } : {}),
    ...(override.budgets ? { budgets: override.budgets } : {}),
    ...(override.regression ? { regression: override.regression } : {}),
    ...(override.diagnostics ? { diagnostics: override.diagnostics } : {}),
  });
}
