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

/** Preserves runtime-owned stack frames while sanitizing error-controlled text. */
export function formatDebugStack(error: Error): string | undefined {
  const stack = error.stack;
  const header = `${error.name}: ${error.message}`;
  if (!stack?.startsWith(header)) return undefined;

  const ownStack = stack
    .slice(header.length)
    .replace(/^\r?\n/, '')
    .split(/\r?\nCaused by: /, 1)[0]!;
  const lines = [formatTerminalText(header)];
  if (ownStack.length > 0)
    lines.push(...ownStack.split(/\r?\n/).map(formatTerminalText));

  if (error.cause instanceof Error) {
    const cause = formatDebugStack(error.cause);
    if (cause) lines.push('Caused by:', cause);
  }
  return lines.join('\n');
}
