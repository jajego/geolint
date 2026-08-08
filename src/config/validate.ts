import { assertGlob } from './glob.js';
import { parseByteSize } from '../engine/byte-size.js';
import { GeoLintConfigError } from '../engine/errors.js';
import type { GeoLintConfig } from '../types/config.js';

const configKeys = new Set([
  'extends',
  'files',
  'ignores',
  'plugins',
  'rules',
  'budgets',
  'regression',
  'diagnostics',
  'overrides',
]);
const overrideKeys = new Set([
  'files',
  'ignores',
  'rules',
  'budgets',
  'regression',
  'diagnostics',
]);

function fail(path: string, expected: string): never {
  throw new GeoLintConfigError(
    `Invalid configuration at ${path}: expected ${expected}.`,
    'GEOLINT_INVALID_CONFIG',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function record(value: unknown, path: string): Record<string, unknown> {
  return isRecord(value) ? value : fail(path, 'an object');
}

function stringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    fail(path, 'an array of strings');
  }
  return value;
}

function patterns(value: unknown, path: string): void {
  for (const pattern of stringArray(value, path)) assertGlob(pattern);
}

function validateKnownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) fail(`${path}.${unknown}`, 'a supported Phase 1 setting');
}

function validateRules(value: unknown, path: string): void {
  for (const [name, setting] of Object.entries(record(value, path))) {
    const severity = Array.isArray(setting) ? setting[0] : setting;
    if (
      !['off', 'warn', 'error'].includes(String(severity)) ||
      (Array.isArray(setting) && severity === 'off') ||
      (Array.isArray(setting) && (setting.length < 1 || setting.length > 2))
    ) {
      fail(`${path}.${name}`, 'a severity or [severity, options] tuple');
    }
  }
}

function validateDiagnostics(value: unknown, path: string): void {
  const diagnostics = record(value, path);
  validateKnownKeys(
    diagnostics,
    new Set(['maxPerCodePerFile', 'maxPerFile']),
    path,
  );
  for (const [key, limit] of Object.entries(diagnostics)) {
    if (!Number.isSafeInteger(limit) || Number(limit) < 0) {
      fail(`${path}.${key}`, 'a non-negative safe integer');
    }
  }
}

function validateSeverities(
  value: unknown,
  allowed: readonly string[],
  path: string,
): void {
  const settings = record(value, path);
  validateKnownKeys(settings, new Set(allowed), path);
  for (const [key, severity] of Object.entries(settings)) {
    if (!['off', 'warn', 'error'].includes(String(severity))) {
      fail(`${path}.${key}`, 'off, warn, or error');
    }
  }
}

function validatePercentage(value: unknown, path: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(path, 'a non-negative finite number');
  }
}

function validateCount(value: unknown, path: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    fail(path, 'a non-negative safe integer');
  }
}

function validateThreshold(
  value: unknown,
  path: string,
  absoluteKey: 'minimumIncrease' | 'minimumDecrease',
  bytes = false,
): void {
  const threshold = record(value, path);
  validateKnownKeys(threshold, new Set(['percentage', absoluteKey]), path);
  if (!('percentage' in threshold) && !(absoluteKey in threshold)) {
    fail(path, `an object containing percentage or ${absoluteKey}`);
  }
  if ('percentage' in threshold) {
    validatePercentage(threshold.percentage, `${path}.percentage`);
  }
  if (absoluteKey in threshold) {
    if (bytes) {
      try {
        parseByteSize(threshold[absoluteKey], `${path}.${absoluteKey}`);
      } catch {
        fail(`${path}.${absoluteKey}`, 'a valid byte-size string');
      }
    } else {
      validateCount(threshold[absoluteKey], `${path}.${absoluteKey}`);
    }
  }
}

function validateRegression(value: unknown, path: string): void {
  const regression = record(value, path);
  validateKnownKeys(
    regression,
    new Set(['baseline', 'checks', 'thresholds']),
    path,
  );
  if (
    'baseline' in regression &&
    (typeof regression.baseline !== 'string' ||
      regression.baseline.length === 0)
  ) {
    fail(`${path}.baseline`, 'a non-empty string');
  }
  if ('checks' in regression) {
    const checks = record(regression.checks, `${path}.checks`);
    validateKnownKeys(
      checks,
      new Set([
        'propertyTypes',
        'properties',
        'geometryTypes',
        'duplicateIds',
        'missingIds',
        'nullGeometries',
      ]),
      `${path}.checks`,
    );
    if ('propertyTypes' in checks)
      validateSeverities(
        checks.propertyTypes,
        ['widened', 'narrowed', 'changed'],
        `${path}.checks.propertyTypes`,
      );
    if ('properties' in checks)
      validateSeverities(
        checks.properties,
        ['added', 'removed'],
        `${path}.checks.properties`,
      );
    if ('geometryTypes' in checks)
      validateSeverities(
        checks.geometryTypes,
        ['added', 'removed'],
        `${path}.checks.geometryTypes`,
      );
    for (const name of [
      'duplicateIds',
      'missingIds',
      'nullGeometries',
    ] as const) {
      if (name in checks)
        validateSeverities(
          checks[name],
          ['increased'],
          `${path}.checks.${name}`,
        );
    }
  }
  if ('thresholds' in regression) {
    const thresholds = record(regression.thresholds, `${path}.thresholds`);
    validateKnownKeys(
      thresholds,
      new Set([
        'fileSizeIncrease',
        'totalVerticesIncrease',
        'featureCountDecrease',
      ]),
      `${path}.thresholds`,
    );
    if ('fileSizeIncrease' in thresholds)
      validateThreshold(
        thresholds.fileSizeIncrease,
        `${path}.thresholds.fileSizeIncrease`,
        'minimumIncrease',
        true,
      );
    if ('totalVerticesIncrease' in thresholds)
      validateThreshold(
        thresholds.totalVerticesIncrease,
        `${path}.thresholds.totalVerticesIncrease`,
        'minimumIncrease',
      );
    if ('featureCountDecrease' in thresholds)
      validateThreshold(
        thresholds.featureCountDecrease,
        `${path}.thresholds.featureCountDecrease`,
        'minimumDecrease',
      );
  }
}

function validatePolicy(value: Record<string, unknown>, path: string): void {
  if ('rules' in value) validateRules(value.rules, `${path}.rules`);
  if ('budgets' in value) record(value.budgets, `${path}.budgets`);
  if ('regression' in value)
    validateRegression(value.regression, `${path}.regression`);
  if ('diagnostics' in value)
    validateDiagnostics(value.diagnostics, `${path}.diagnostics`);
}

export function validateConfig(value: unknown): asserts value is GeoLintConfig {
  const config = record(value, 'config');
  validateKnownKeys(config, configKeys, 'config');
  if ('extends' in config) stringArray(config.extends, 'config.extends');
  if ('files' in config) patterns(config.files, 'config.files');
  if ('ignores' in config) patterns(config.ignores, 'config.ignores');
  if ('plugins' in config) record(config.plugins, 'config.plugins');
  validatePolicy(config, 'config');
  if (!('overrides' in config)) return;
  if (!Array.isArray(config.overrides)) fail('config.overrides', 'an array');
  config.overrides.forEach((candidate, index) => {
    const path = `config.overrides[${index}]`;
    const override = record(candidate, path);
    validateKnownKeys(override, overrideKeys, path);
    if (!('files' in override)) fail(`${path}.files`, 'an array of strings');
    patterns(override.files, `${path}.files`);
    if ((override.files as readonly unknown[]).length === 0) {
      fail(`${path}.files`, 'a non-empty array of strings');
    }
    if ('ignores' in override) patterns(override.ignores, `${path}.ignores`);
    validatePolicy(override, path);
    if (
      isRecord(override.regression) &&
      Object.hasOwn(override.regression, 'baseline')
    ) {
      fail(`${path}.regression.baseline`, 'a base-config-only setting');
    }
  });
}
