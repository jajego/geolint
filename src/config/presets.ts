import type { GeoLintConfig } from '../types/config.js';

const recommended: GeoLintConfig = Object.freeze({
  rules: Object.freeze({}),
});

const web: GeoLintConfig = Object.freeze({
  extends: ['geolint/recommended'],
});

export function getPreset(reference: string): GeoLintConfig | undefined {
  return reference === 'geolint/recommended'
    ? recommended
    : reference === 'geolint/web'
      ? web
      : undefined;
}
