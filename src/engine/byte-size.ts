import { GeoLintConfigError } from './errors.js';

const byteUnits = Object.freeze({
  B: 1,
  KB: 1_000,
  MB: 1_000_000,
  GB: 1_000_000_000,
  KiB: 1_024,
  MiB: 1_048_576,
  GiB: 1_073_741_824,
});

export function parseByteSize(value: unknown, path: string): number {
  if (typeof value !== 'string') {
    throw new GeoLintConfigError(
      `Invalid budget at ${path}: expected a byte-size string.`,
      'GEOLINT_INVALID_BUDGET',
    );
  }
  const match = /^(\d+(?:\.\d+)?)(B|KB|MB|GB|KiB|MiB|GiB)$/.exec(value);
  const unit = match?.[2] as keyof typeof byteUnits | undefined;
  const bytes = match && unit ? Number(match[1]) * byteUnits[unit] : NaN;
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new GeoLintConfigError(
      `Invalid budget at ${path}: expected a safe byte size using B, KB, MB, GB, KiB, MiB, or GiB.`,
      'GEOLINT_INVALID_BUDGET',
    );
  }
  return bytes;
}
