import picomatch from 'picomatch';

import { GeoLintConfigError } from '../engine/errors.js';

export function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}

export function assertGlob(pattern: string): void {
  let braceDepth = 0;
  for (const character of pattern) {
    if (character === '{' && ++braceDepth > 1) invalidGlob(pattern);
    if (character === '}' && --braceDepth < 0) invalidGlob(pattern);
  }
  if (
    pattern.length === 0 ||
    pattern.startsWith('!') ||
    /(^|[^\\])[+@?!*]\(/.test(pattern) ||
    braceDepth !== 0
  ) {
    invalidGlob(pattern);
  }
}

function invalidGlob(pattern: string): never {
  throw new GeoLintConfigError(
    `Unsupported GeoLint glob pattern "${pattern}".`,
    'GEOLINT_INVALID_GLOB',
  );
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
