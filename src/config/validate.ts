import { assertGlob } from './glob.js';
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

function validatePolicy(value: Record<string, unknown>, path: string): void {
  if ('rules' in value) validateRules(value.rules, `${path}.rules`);
  if ('budgets' in value) record(value.budgets, `${path}.budgets`);
  if ('regression' in value) {
    const regression = record(value.regression, `${path}.regression`);
    if ('baseline' in regression && typeof regression.baseline !== 'string') {
      fail(`${path}.regression.baseline`, 'a string');
    }
  }
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
