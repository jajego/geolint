import type { JsonValue } from '../types/semantic.js';

export type BufferedParseResult =
  { readonly ok: true; readonly value: JsonValue } | { readonly ok: false };

export function parseBufferedJSON(text: string): BufferedParseResult {
  try {
    return { ok: true, value: JSON.parse(text) as JsonValue };
  } catch (error) {
    if (error instanceof SyntaxError) return { ok: false };
    throw error;
  }
}
