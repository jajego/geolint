import type { JsonPointer } from '../types/semantic.js';
import type { DuplicateJsonKey } from './json-source.js';

interface ArrayFrame {
  readonly kind: 'array';
  segment: string | number | undefined;
  index: number;
  state: 0 | 1;
}

interface ObjectFrame {
  readonly kind: 'object';
  segment: string | number | undefined;
  key: string;
  readonly keys: string[];
  wideKeys: Set<string> | undefined;
  state: 0 | 1 | 2 | 3;
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
 * This is intentionally not a JSON parser: all branches rely on valid JSON.
 */
export function scanDuplicateKeysFromValidJSON(
  text: string,
): readonly DuplicateJsonKey[] {
  const duplicates: DuplicateAtIndex[] = [];
  const stack: Frame[] = [];
  let depth = 0;
  let index = 0;

  const whitespace = (): void => {
    while (
      text[index] === ' ' ||
      text[index] === '\t' ||
      text[index] === '\n' ||
      text[index] === '\r'
    ) {
      index += 1;
    }
  };

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

  const value = (segment?: string | number): void => {
    whitespace();
    const character = text[index];
    if (character === '{') {
      index += 1;
      const frame = stack[depth];
      if (frame?.kind === 'object') {
        frame.segment = segment;
        frame.keys.length = 0;
        frame.wideKeys?.clear();
        frame.key = '';
        frame.state = 0;
      } else
        stack[depth] = {
          kind: 'object',
          segment,
          keys: [],
          key: '',
          wideKeys: undefined,
          state: 0,
        };
      depth += 1;
    } else if (character === '[') {
      index += 1;
      const frame = stack[depth];
      if (frame?.kind === 'array') {
        frame.segment = segment;
        frame.index = 0;
        frame.state = 0;
      } else
        stack[depth] = {
          kind: 'array',
          segment,
          index: 0,
          state: 0,
        };
      depth += 1;
    } else if (character === '"') {
      string(false);
    } else {
      while (
        index < text.length &&
        text[index] !== ',' &&
        text[index] !== ']' &&
        text[index] !== '}' &&
        text[index] !== ' ' &&
        text[index] !== '\t' &&
        text[index] !== '\n' &&
        text[index] !== '\r'
      )
        index += 1;
    }
  };

  value();
  while (depth > 0) {
    whitespace();
    const frame = stack[depth - 1]!;
    if (frame.kind === 'array') {
      if (frame.state === 0) {
        if (text[index] === ']') {
          index += 1;
          depth -= 1;
        } else {
          const segment = frame.index;
          frame.index += 1;
          frame.state = 1;
          value(segment);
        }
      } else if (text[index] === ']') {
        index += 1;
        depth -= 1;
      } else {
        index += 1;
        frame.state = 0;
      }
    } else if (frame.state === 0) {
      if (text[index] === '}') {
        index += 1;
        depth -= 1;
      } else {
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
        frame.state = 1;
      }
    } else if (frame.state === 1) {
      index += 1;
      frame.state = 2;
    } else if (frame.state === 2) {
      frame.state = 3;
      value(frame.key);
    } else if (text[index] === '}') {
      index += 1;
      depth -= 1;
    } else {
      index += 1;
      frame.state = 0;
    }
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
