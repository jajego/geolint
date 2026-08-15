/**
 * Formatting boundary for text written to a terminal. Structured reporters
 * deliberately do not use these helpers: their values remain semantic data.
 */
const namedEscapes: Readonly<Record<string, string>> = {
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

const maximumDebugCauseDepth = 32;

function unicodeEscape(character: string): string {
  return `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`;
}

function isUnsafeTerminalCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0)!;
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x61c ||
    (codePoint >= 0x200e && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

/** Keeps ordinary display text natural while making it safe for one terminal line. */
export function formatTerminalText(value: string): string {
  let formatted = '';
  for (const character of value) {
    formatted += isUnsafeTerminalCharacter(character)
      ? (namedEscapes[character] ?? unicodeEscape(character))
      : character;
  }
  return formatted;
}

/** Formats an arbitrary semantic string safely for inclusion in human-readable prose. */
export function formatQuotedValue(value: string): string {
  return formatTerminalText(JSON.stringify(value));
}

function debugStackLines(error: Error): string[] {
  const stack = error.stack;
  const header = Error.prototype.toString.call(error);
  const lines = [formatTerminalText(header)];
  if (header.length === 0 || !stack?.startsWith(header)) return lines;

  const frames = stack
    .slice(header.length)
    .replace(/^\r?\n/, '')
    .split(/\r?\nCaused by: /, 1)[0]!;
  if (frames.length === 0) return lines;

  const frameLines = frames.split(/\r?\n/);
  if (!frameLines.every((line) => line.length === 0 || /^\s+at\s/.test(line)))
    return lines;
  lines.push(...frameLines.map(formatTerminalText));
  return lines;
}

/** Preserves validated runtime stack frames while sanitizing error-controlled text. */
export function formatDebugStack(error: Error): string {
  const seen = new Set<Error>();
  const lines: string[] = [];
  let current: Error | undefined = error;
  for (let depth = 0; current; depth += 1) {
    if (seen.has(current)) {
      lines.push('Caused by: [circular cause]');
      break;
    }
    if (depth === maximumDebugCauseDepth) {
      lines.push('Caused by: [cause chain truncated]');
      break;
    }
    seen.add(current);
    const rendered = debugStackLines(current);
    if (depth === 0) lines.push(...rendered);
    else lines.push(`Caused by: ${rendered[0]!}`, ...rendered.slice(1));
    current = current.cause instanceof Error ? current.cause : undefined;
  }
  return lines.join('\n');
}
