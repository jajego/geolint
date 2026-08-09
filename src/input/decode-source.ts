const utf8Decoder = new TextDecoder('utf-8', {
  fatal: true,
  ignoreBOM: true,
});

export function decodeSource(source: Uint8Array): string {
  return utf8Decoder.decode(source);
}
