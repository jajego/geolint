import type { JsonPointer } from '../types/semantic.js';

function escapeSegment(segment: string | number): string {
  return String(segment).replaceAll('~', '~0').replaceAll('/', '~1');
}

export function jsonPointer(
  ...segments: readonly (string | number)[]
): JsonPointer {
  return (
    segments.length === 0 ? '' : `/${segments.map(escapeSegment).join('/')}`
  ) as JsonPointer;
}

export function appendPointer(
  path: JsonPointer,
  segment: string | number,
): JsonPointer {
  return `${path}/${escapeSegment(segment)}` as JsonPointer;
}
