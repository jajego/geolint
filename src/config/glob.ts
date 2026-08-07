import picomatch from 'picomatch';

import { GeoLintConfigError } from '../engine/errors.js';

export function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}

/** Validates GeoLint's deliberately small V1 glob language. */
export function assertGlob(pattern: string): void {
  const normalized = normalizePath(pattern);
  if (normalized.length === 0 || normalized.startsWith('!'))
    invalidGlob(pattern);
  for (const segment of normalized.split('/'))
    validateSegment(segment, pattern);
}

function validateSegment(segment: string, pattern: string): void {
  // Picomatch treats these as regex operators; GeoLint V1 does not expose them.
  if (/[()|+^$]/.test(segment)) invalidGlob(pattern);
  if (segment.includes('**') && segment !== '**') invalidGlob(pattern);

  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index]!;
    if ('+@?!*'.includes(character) && segment[index + 1] === '(') {
      invalidGlob(pattern);
    }
    if (character === '{') {
      const closing = segment.indexOf('}', index + 1);
      if (closing === -1) invalidGlob(pattern);
      const alternatives = segment.slice(index + 1, closing).split(',');
      if (
        alternatives.length < 2 ||
        alternatives.some(
          (alternative) =>
            alternative.length === 0 ||
            alternative.includes('{') ||
            alternative.includes('}') ||
            alternative.includes('..'),
        )
      ) {
        invalidGlob(pattern);
      }
      index = closing;
    } else if (character === '}') {
      invalidGlob(pattern);
    } else if (character === '[') {
      const closing = segment.indexOf(']', index + 1);
      if (closing === -1) invalidGlob(pattern);
      const contents = segment.slice(index + 1, closing);
      if (
        contents.length === 0 ||
        contents.startsWith('!') ||
        contents.startsWith('^') ||
        contents.includes('[')
      ) {
        invalidGlob(pattern);
      }
      index = closing;
    } else if (character === ']') {
      invalidGlob(pattern);
    }
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
      nobrace: false,
      nocase: false,
      nonegate: true,
      noextglob: true,
      noglobstar: false,
    })(normalizePath(path));
  });
}
