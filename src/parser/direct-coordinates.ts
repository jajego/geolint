export type DirectCoordinateKind = 'array' | 'number' | 'other';

export interface DirectPosition {
  readonly length: number;
  readonly x: number;
  readonly y: number;
  readonly values?: readonly number[];
}

export function directCoordinateElements(
  text: string,
  start: number,
  end: number,
  visit: (start: number, end: number, kind: DirectCoordinateKind) => void,
): void {
  let index = skipWhitespace(text, start + 1, end);
  while (index < end - 1) {
    const valueStart = index;
    index = skipValue(text, index, end);
    visit(valueStart, index, coordinateKind(text[valueStart]));
    index = skipWhitespace(text, index, end);
    if (text[index] !== ',') break;
    index = skipWhitespace(text, index + 1, end);
  }
}

export function directPosition(
  text: string,
  start: number,
  end: number,
  kind: DirectCoordinateKind,
  materialize: boolean,
): DirectPosition | undefined {
  if (kind !== 'array') return undefined;
  const values: number[] | undefined = materialize ? [] : undefined;
  let index = skipWhitespace(text, start + 1, end);
  let length = 0;
  let x = 0;
  let y = 0;
  while (index < end - 1) {
    if (!isNumber(text[index])) return undefined;
    const numberStart = index;
    index = skipValue(text, index, end);
    const value = Number(text.slice(numberStart, index));
    if (!Number.isFinite(value)) return undefined;
    if (length === 0) x = value;
    else if (length === 1) y = value;
    values?.push(value);
    length += 1;
    index = skipWhitespace(text, index, end);
    if (text[index] !== ',') break;
    index = skipWhitespace(text, index + 1, end);
  }
  return length < 2
    ? undefined
    : { length, x, y, ...(values ? { values } : {}) };
}

function coordinateKind(value: string | undefined): DirectCoordinateKind {
  if (value === '[') return 'array';
  return isNumber(value) ? 'number' : 'other';
}

function skipWhitespace(text: string, index: number, end: number): number {
  while (index < end && /[ \t\n\r]/.test(text[index]!)) index += 1;
  return index;
}

function isNumber(value: string | undefined): boolean {
  return value === '-' || (value !== undefined && value >= '0' && value <= '9');
}

function skipValue(text: string, index: number, end: number): number {
  const first = text[index];
  if (first === '"') return skipString(text, index + 1, end);
  if (isNumber(first)) {
    index += 1;
    while (index < end && /[0-9.eE+-]/.test(text[index]!)) index += 1;
    return index;
  }
  if (first === 't') return index + 4;
  if (first === 'f') return index + 5;
  if (first === 'n') return index + 4;
  let depth = 0;
  while (index < end) {
    const value = text[index]!;
    if (value === '"') {
      index = skipString(text, index + 1, end);
      continue;
    }
    if (value === '[' || value === '{') depth += 1;
    else if (value === ']' || value === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return end;
}

function skipString(text: string, index: number, end: number): number {
  while (index < end) {
    if (text[index] === '\\') index += 2;
    else if (text[index] === '"') return index + 1;
    else index += 1;
  }
  return end;
}
