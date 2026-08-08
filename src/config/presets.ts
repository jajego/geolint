import type { GeoLintConfig } from '../types/config.js';

const recommended: GeoLintConfig = Object.freeze({
  rules: Object.freeze({
    'unique-feature-id': 'error',
    'consistent-feature-id-type': 'error',
    'consistent-property-types': 'error',
    'valid-coordinate-range': 'error',
    'consistent-coordinate-dimensions': 'error',
  }),
});

const web: GeoLintConfig = Object.freeze({
  extends: ['geolint/recommended'],
  rules: Object.freeze({
    'require-feature-id': 'warn',
    'consistent-geometry-types': 'warn',
    'no-null-geometry': 'warn',
    'coordinate-precision': ['warn', { maximumDecimals: 6 }] as const,
  }),
});

export function getPreset(reference: string): GeoLintConfig | undefined {
  return reference === 'geolint/recommended'
    ? recommended
    : reference === 'geolint/web'
      ? web
      : undefined;
}
