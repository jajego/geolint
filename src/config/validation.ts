import { GeoLintConfigError } from '../engine/errors.js';

export function invalidConfig(path: string, expected: string): never {
  throw new GeoLintConfigError(
    `Invalid configuration at ${path}: expected ${expected}.`,
    'GEOLINT_INVALID_CONFIG',
  );
}

export function isConfigRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

export function configRecord(
  value: unknown,
  path: string,
): Record<string, unknown> {
  return isConfigRecord(value) ? value : invalidConfig(path, 'an object');
}

export function configStringArray(
  value: unknown,
  path: string,
): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    invalidConfig(path, 'an array of strings');
  }
  return value;
}

export function validateConfigKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown)
    invalidConfig(`${path}.${unknown}`, 'a supported Phase 1 setting');
}
