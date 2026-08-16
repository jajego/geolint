import type { JsonPointer } from '../types/semantic.js';
import type { DuplicateJsonKey } from './json-source.js';

interface ArrayFrame {
  readonly kind: 'array';
  segment: string | number | undefined;
  index: number;
}

interface ObjectFrame {
  readonly kind: 'object';
  segment: string | number | undefined;
  key: string;
  readonly keys: string[];
  wideKeys: Set<string> | undefined;
  expectsKey: boolean;
}

type Frame = ArrayFrame | ObjectFrame;

interface DuplicateAtIndex {
  readonly key: string;
  readonly path: JsonPointer;
  readonly index: number;
}

function escapePathSegment(segment: string | number): string | number {
  if (typeof segment === 'number') return segment;
  return segment.includes('~') || segment.includes('/')
    ? segment.replaceAll('~', '~0').replaceAll('/', '~1')
    : segment;
}

function renderPath(
  stack: readonly Frame[],
  depth: number,
  key: string,
): JsonPointer {
  const segments: (string | number)[] = [];
  for (let index = 0; index < depth; index += 1) {
    const frame = stack[index]!;
    if (frame.segment !== undefined) segments.push(frame.segment);
  }
  segments.push(key);
  return `/${segments.map(escapePathSegment).join('/')}` as JsonPointer;
}

/**
 * Recovers duplicate object members after JSON.parse has validated the source.
 * This is intentionally not a JSON parser: it visits only structural tokens
 * and object keys, and all branches rely on valid JSON.
 */
export function scanDuplicateKeysFromValidJSON(
  text: string,
): readonly DuplicateJsonKey[] {
  const duplicates: DuplicateAtIndex[] = [];
  const stack: Frame[] = [];
  let depth = 0;
  let index = 0;

  const string = (decode: boolean): string => {
    const start = index;
    index += 1;
    while (true) {
      const quote = text.indexOf('"', index);
      let backslashes = 0;
      for (let cursor = quote - 1; text[cursor] === '\\'; cursor -= 1)
        backslashes += 1;
      if (backslashes % 2 === 0) {
        index = quote + 1;
        break;
      }
      index = quote + 1;
    }
    if (!decode) return '';
    const raw = text.slice(start + 1, index - 1);
    return raw.includes('\\')
      ? (JSON.parse(text.slice(start, index)) as string)
      : raw;
  };

  while (index < text.length) {
    const character = text[index];
    if (character === '{') {
      index += 1;
      const parent = stack[depth - 1];
      stack[depth] = {
        kind: 'object',
        segment: parent?.kind === 'object' ? parent.key : parent?.index,
        keys: [],
        key: '',
        wideKeys: undefined,
        expectsKey: true,
      };
      depth += 1;
    } else if (character === '[') {
      index += 1;
      const parent = stack[depth - 1];
      const segment = parent?.kind === 'object' ? parent.key : parent?.index;
      const frame = stack[depth];
      if (frame?.kind === 'array') {
        frame.segment = segment;
        frame.index = 0;
      } else stack[depth] = { kind: 'array', segment, index: 0 };
      depth += 1;
    } else if (character === '}' || character === ']') {
      index += 1;
      depth -= 1;
    } else if (character === ',') {
      index += 1;
      const frame = stack[depth - 1];
      if (frame?.kind === 'object') frame.expectsKey = true;
      else if (frame) frame.index += 1;
    } else if (character === '"') {
      const frame = stack[depth - 1];
      if (frame?.kind !== 'object' || !frame.expectsKey) {
        string(false);
        continue;
      }
      const keyIndex = index;
      const key = string(true);
      const duplicate = frame.wideKeys
        ? frame.wideKeys.has(key)
        : frame.keys.includes(key);
      if (duplicate)
        duplicates.push({
          key,
          path: renderPath(stack, depth, key),
          index: keyIndex,
        });
      else if (frame.wideKeys) frame.wideKeys.add(key);
      else {
        frame.keys.push(key);
        if (frame.keys.length === 8) frame.wideKeys = new Set(frame.keys);
      }
      frame.key = key;
      frame.expectsKey = false;
    } else index += 1;
  }
  let previousIndex = 0;
  let byteOffset = 0;
  return duplicates.map((duplicate) => {
    byteOffset += Buffer.byteLength(
      text.slice(previousIndex, duplicate.index),
      'utf8',
    );
    previousIndex = duplicate.index;
    return { key: duplicate.key, path: duplicate.path, byteOffset };
  });
}
