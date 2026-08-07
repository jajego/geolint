import picomatch from 'picomatch';

import { GeoLintConfigError } from '../engine/errors.js';

export function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}

export function assertGlob(pattern: string): void {
  if (
    pattern.startsWith('!') ||
    /(^|[^\\])[+@?!*]\(/.test(pattern) ||
    /\{[^{}]*\{/.test(pattern)
  ) {
    throw new GeoLintConfigError(
      `Unsupported GeoLint glob pattern "${pattern}".`,
      'GEOLINT_INVALID_GLOB',
    );
  }
}

export function matchesGlob(
  path: string,
  patterns: readonly string[],
): boolean {
  return patterns.some((pattern) => {
    assertGlob(pattern);
    return picomatch(normalizePath(pattern), {
      bash: false,
      dot: false,
      nocase: false,
      nonegate: true,
      noextglob: true,
    })(normalizePath(path));
  });
}
