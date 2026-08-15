import type { JsonPointer } from '../types/semantic.js';

type JsonTokenKind =
  'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

export interface JsonSourceSpan {
  readonly start: number;
  readonly end: number;
  readonly startByte: number;
  readonly endByteExclusive: number;
  readonly kind: JsonTokenKind;
}

export interface DuplicateJsonKey {
  readonly key: string;
  readonly path: JsonPointer;
  readonly byteOffset: number;
}

interface SourcePath {
  readonly parent?: SourcePath;
  readonly segment: string | number;
}

export class JsonSourceSyntaxError extends Error {
  constructor(readonly byteOffset: number) {
    super('Input is not valid JSON.');
  }
}

export class JsonSourceCursor {
  index: number;
  byte: number;

  constructor(
    readonly text: string,
    index = 0,
    byte = 0,
    readonly end = text.length,
  ) {
    this.index = index;
    this.byte = byte;
  }

  fail(): never {
    throw new JsonSourceSyntaxError(this.byte);
  }

  whitespace(): void {
    while (this.index < this.end) {
      const code = this.text.charCodeAt(this.index);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)
        return;
      this.index += 1;
      this.byte += 1;
    }
  }

  ascii(expected?: string): string {
    const value = this.text[this.index];
    if (value === undefined || (expected !== undefined && value !== expected))
      return this.fail();
    this.index += 1;
    this.byte += 1;
    return value;
  }

  unicode(): void {
    const first = this.text.charCodeAt(this.index);
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = this.text.charCodeAt(this.index + 1);
      if (second >= 0xdc00 && second <= 0xdfff) {
        this.index += 2;
        this.byte += 4;
        return;
      }
    }
    this.index += 1;
    this.byte += utf8Length(first);
  }

  string(capture = true): JsonSourceSpan | undefined {
    const start = this.index;
    const startByte = this.byte;
    this.ascii('"');
    while (this.index < this.end) {
      const code = this.text.charCodeAt(this.index);
      if (code === 0x22) {
        this.ascii('"');
        return capture
          ? {
              start,
              end: this.index,
              startByte,
              endByteExclusive: this.byte,
              kind: 'string',
            }
          : undefined;
      }
      if (code < 0x20) this.fail();
      if (code === 0x5c) {
        this.ascii('\\');
        const escape = this.ascii();
        if ('"\\/bfnrt'.includes(escape)) continue;
        if (escape !== 'u') this.fail();
        for (let index = 0; index < 4; index += 1) {
          if (!/[0-9a-fA-F]/.test(this.ascii())) this.fail();
        }
        continue;
      }
      this.unicode();
    }
    return this.fail();
  }

  number(capture = true): JsonSourceSpan | undefined {
    const start = this.index;
    const startByte = this.byte;
    if (this.text[this.index] === '-') this.ascii('-');
    if (this.text[this.index] === '0') this.ascii('0');
    else {
      const first = this.text.charCodeAt(this.index);
      if (first < 0x31 || first > 0x39) this.fail();
      while (isDigit(this.text.charCodeAt(this.index))) this.ascii();
    }
    if (this.text[this.index] === '.') {
      this.ascii('.');
      if (!isDigit(this.text.charCodeAt(this.index))) this.fail();
      while (isDigit(this.text.charCodeAt(this.index))) this.ascii();
    }
    if (this.text[this.index] === 'e' || this.text[this.index] === 'E') {
      this.ascii();
      if (this.text[this.index] === '+' || this.text[this.index] === '-')
        this.ascii();
      if (!isDigit(this.text.charCodeAt(this.index))) this.fail();
      while (isDigit(this.text.charCodeAt(this.index))) this.ascii();
    }
    return capture
      ? {
          start,
          end: this.index,
          startByte,
          endByteExclusive: this.byte,
          kind: 'number',
        }
      : undefined;
  }

  literal(
    text: 'true' | 'false' | 'null',
    capture = true,
  ): JsonSourceSpan | undefined {
    const start = this.index;
    const startByte = this.byte;
    for (const character of text) this.ascii(character);
    return capture
      ? {
          start,
          end: this.index,
          startByte,
          endByteExclusive: this.byte,
          kind: text === 'null' ? 'null' : 'boolean',
        }
      : undefined;
  }

  value(
    capture = true,
    duplicate?: (occurrence: DuplicateJsonKey) => void,
  ): JsonSourceSpan | undefined {
    this.whitespace();
    const start = this.index;
    const startByte = this.byte;
    const character = this.text[this.index];
    if (character === '"') return this.string(capture);
    if (character === '-' || isDigit(this.text.charCodeAt(this.index)))
      return this.number(capture);
    if (character === 't') return this.literal('true', capture);
    if (character === 'f') return this.literal('false', capture);
    if (character === 'n') return this.literal('null', capture);
    if (character !== '[' && character !== '{') return this.fail();
    const arrayFirst = 0,
      arrayValue = 1,
      arrayAfter = 2,
      objectFirst = 3,
      objectKey = 4,
      objectColon = 5,
      objectValue = 6,
      objectAfter = 7;
    const kind = character === '[' ? 'array' : 'object';
    const stack: {
      state: number;
      path?: SourcePath;
      arrayIndex?: number;
      key?: string;
      keys?: Set<string>;
    }[] = [
      {
        state: character === '[' ? arrayFirst : objectFirst,
        ...(duplicate && character === '[' ? { arrayIndex: 0 } : {}),
        ...(duplicate && character === '{' ? { keys: new Set() } : {}),
      },
    ];
    this.ascii(character);
    const appendPath = (
      parent: SourcePath | undefined,
      segment: string | number,
    ): SourcePath => ({ ...(parent ? { parent } : {}), segment });
    const consumeValue = (path?: SourcePath): void => {
      this.whitespace();
      const next = this.text[this.index];
      if (next === '"') this.string(false);
      else if (next === '-' || isDigit(this.text.charCodeAt(this.index)))
        this.number(false);
      else if (next === 't') this.literal('true', false);
      else if (next === 'f') this.literal('false', false);
      else if (next === 'n') this.literal('null', false);
      else if (next === '[' || next === '{') {
        this.ascii(next);
        stack.push({
          state: next === '[' ? arrayFirst : objectFirst,
          ...(path ? { path } : {}),
          ...(duplicate && next === '[' ? { arrayIndex: 0 } : {}),
          ...(duplicate && next === '{' ? { keys: new Set() } : {}),
        });
      } else this.fail();
    };
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const state = frame.state;
      this.whitespace();
      if (state <= arrayAfter) {
        if (state === arrayFirst && this.text[this.index] === ']') {
          this.ascii(']');
          stack.pop();
        } else if (state === arrayFirst || state === arrayValue) {
          frame.state = arrayAfter;
          if (duplicate) {
            const index = frame.arrayIndex!;
            frame.arrayIndex = index + 1;
            consumeValue(appendPath(frame.path, index));
          } else consumeValue();
        } else if (this.text[this.index] === ',') {
          this.ascii(',');
          frame.state = arrayValue;
        } else if (this.text[this.index] === ']') {
          this.ascii(']');
          stack.pop();
        } else this.fail();
      } else if (state === objectFirst && this.text[this.index] === '}') {
        this.ascii('}');
        stack.pop();
      } else if (state === objectFirst || state === objectKey) {
        if (this.text[this.index] !== '"') this.fail();
        if (duplicate) {
          const keySpan = this.string()!;
          const key = JSON.parse(
            this.text.slice(keySpan.start, keySpan.end),
          ) as string;
          if (frame.keys!.has(key))
            duplicate({
              key,
              path: renderPath(appendPath(frame.path, key)),
              byteOffset: keySpan.startByte,
            });
          else frame.keys!.add(key);
          frame.key = key;
        } else this.string(false);
        frame.state = objectColon;
      } else if (state === objectColon) {
        this.ascii(':');
        frame.state = objectValue;
      } else if (state === objectValue) {
        frame.state = objectAfter;
        consumeValue(
          duplicate ? appendPath(frame.path, frame.key!) : undefined,
        );
      } else if (this.text[this.index] === ',') {
        this.ascii(',');
        frame.state = objectKey;
      } else if (this.text[this.index] === '}') {
        this.ascii('}');
        stack.pop();
      } else this.fail();
    }
    return capture
      ? { start, end: this.index, startByte, endByteExclusive: this.byte, kind }
      : undefined;
  }
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function utf8Length(code: number): number {
  if (code <= 0x7f) return 1;
  return code <= 0x7ff ? 2 : 3;
}

function escapePathSegment(segment: string | number): string | number {
  if (typeof segment === 'number') return segment;
  return segment.includes('~') || segment.includes('/')
    ? segment.replaceAll('~', '~0').replaceAll('/', '~1')
    : segment;
}

function renderPath(path: SourcePath): JsonPointer {
  const segments: (string | number)[] = [];
  for (
    let current: SourcePath | undefined = path;
    current;
    current = current.parent
  )
    segments.push(current.segment);
  return `/${segments.toReversed().map(escapePathSegment).join('/')}` as JsonPointer;
}
