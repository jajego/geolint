import { constants as bufferConstants } from 'node:buffer';
import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  type PathLike,
} from 'node:fs';

const defaultWindowBytes = 64 * 1024;

export interface ByteSource {
  readonly length: number;
  byte(offset: number): number | undefined;
  text(start: number, end: number): string;
  number(
    start: number,
    end: number,
    includeRaw: boolean,
  ): { readonly value: number; readonly raw?: string };
  readonly directText: boolean;
  close(): void;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    bytes,
  );
}

class MemoryByteSource implements ByteSource {
  readonly directText = true;

  constructor(private readonly bytes: Buffer) {}

  get length(): number {
    return this.bytes.length;
  }

  byte(offset: number): number | undefined {
    return this.bytes[offset];
  }

  text(start: number, end: number): string {
    return decode(this.bytes.subarray(start, end));
  }

  number(
    start: number,
    end: number,
    includeRaw: boolean,
  ): { readonly value: number; readonly raw?: string } {
    const raw = this.bytes.subarray(start, end).toString('ascii');
    return { value: Number(raw), ...(includeRaw ? { raw } : {}) };
  }

  close(): void {}
}

class FileByteSource implements ByteSource {
  readonly directText = false;
  readonly length: number;
  private readonly descriptor: number;
  private window = Buffer.alloc(0);
  private windowStart = 0;

  constructor(
    path: PathLike,
    private readonly windowBytes = defaultWindowBytes,
  ) {
    this.descriptor = openSync(path, 'r');
    this.length = fstatSync(this.descriptor).size;
  }

  byte(offset: number): number | undefined {
    if (offset < 0 || offset >= this.length) return undefined;
    if (
      offset < this.windowStart ||
      offset >= this.windowStart + this.window.length
    )
      this.readWindow(offset);
    return this.window[offset - this.windowStart];
  }

  text(start: number, end: number): string {
    if (start < 0 || end < start || end > this.length)
      throw new RangeError('Invalid byte source span.');
    if (
      start >= this.windowStart &&
      end <= this.windowStart + this.window.length
    )
      return decode(
        this.window.subarray(start - this.windowStart, end - this.windowStart),
      );
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const chunks: string[] = [];
    let textLength = 0;
    for (let offset = start; offset < end;) {
      const size = Math.min(this.windowBytes, end - offset);
      const bytes = Buffer.allocUnsafe(size);
      const read = readSync(this.descriptor, bytes, 0, size, offset);
      if (read !== size) throw new RangeError('Unexpected end of byte source.');
      const chunk = decoder.decode(bytes, { stream: offset + size < end });
      textLength += chunk.length;
      if (textLength > bufferConstants.MAX_STRING_LENGTH)
        throw new ByteSourceMaterializationError();
      chunks.push(chunk);
      offset += size;
    }
    try {
      return chunks.join('') + decoder.decode();
    } catch (error) {
      if (error instanceof RangeError)
        throw new ByteSourceMaterializationError();
      throw error;
    }
  }

  number(
    start: number,
    end: number,
    includeRaw: boolean,
  ): { readonly value: number; readonly raw?: string } {
    let raw = '';
    for (let offset = start; offset < end; offset += 1)
      raw += String.fromCharCode(this.byte(offset)!);
    return { value: Number(raw), ...(includeRaw ? { raw } : {}) };
  }

  close(): void {
    closeSync(this.descriptor);
  }

  private readWindow(offset: number): void {
    const start = Math.floor(offset / this.windowBytes) * this.windowBytes;
    const size = Math.min(this.windowBytes, this.length - start);
    const bytes = Buffer.allocUnsafe(size);
    const read = readSync(this.descriptor, bytes, 0, size, start);
    if (read !== size) throw new RangeError('Unexpected end of byte source.');
    this.window = bytes;
    this.windowStart = start;
  }
}

export class ByteSourceMaterializationError extends Error {
  constructor() {
    super(
      'A requested JSON value exceeds the JavaScript string representation limit.',
    );
  }
}

export function memoryByteSource(text: string): ByteSource {
  return new MemoryByteSource(Buffer.from(text, 'utf8'));
}

export function fileByteSource(
  path: PathLike,
  windowBytes?: number,
): ByteSource {
  return new FileByteSource(path, windowBytes);
}
