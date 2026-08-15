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

/** Keeps ordinary display text natural while making terminal controls visible. */
export function formatTerminalText(value: string): string {
  let formatted = '';
  for (const character of value) {
    formatted += isUnsafeTerminalCharacter(character)
      ? (namedEscapes[character] ?? unicodeEscape(character))
      : character;
  }
  return formatted;
}

/** Formats an arbitrary semantic value safely for inclusion in prose. */
export function formatQuotedValue(value: string): string {
  return formatTerminalText(JSON.stringify(value));
}
