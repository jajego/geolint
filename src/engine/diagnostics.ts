import type { DiagnosticLimitConfig } from '../types/config.js';
import type {
  Diagnostic,
  JsonPointer,
  SuppressionSummary,
} from '../types/semantic.js';

const defaultMaxPerCodePerFile = 50;
const defaultMaxPerFile = 500;

export interface DiagnosticInput {
  readonly code: string;
  readonly source: Diagnostic['source'];
  readonly severity?: Diagnostic['severity'];
  readonly message: string;
  readonly path?: JsonPointer;
  readonly featureIndex?: number;
  readonly featureId?: string | number;
  readonly byteOffset?: number;
  readonly data?: Readonly<Record<string, unknown>>;
}

export class DiagnosticCollector {
  readonly diagnostics: Diagnostic[] = [];
  readonly #retainedByCode = new Map<string, number>();
  readonly #suppressed = new Map<string, SuppressionSummary>();
  readonly #maxPerCode: number;
  readonly #maxPerFile: number;
  errorCount = 0;
  warningCount = 0;

  constructor(
    readonly filePath: string,
    limits: DiagnosticLimitConfig = {},
  ) {
    this.#maxPerCode = limits.maxPerCodePerFile ?? defaultMaxPerCodePerFile;
    this.#maxPerFile = limits.maxPerFile ?? defaultMaxPerFile;
  }

  report(input: DiagnosticInput): void {
    const severity = input.severity ?? 'error';
    if (severity === 'error') this.errorCount += 1;
    else this.warningCount += 1;
    const retainedForCode = this.#retainedByCode.get(input.code) ?? 0;
    if (
      retainedForCode < this.#maxPerCode &&
      this.diagnostics.length < this.#maxPerFile
    ) {
      this.#retainedByCode.set(input.code, retainedForCode + 1);
      this.diagnostics.push({
        ...input,
        severity,
        filePath: this.filePath,
      });
      return;
    }
    const key = `${input.code}\0${severity}`;
    const previous = this.#suppressed.get(key);
    this.#suppressed.set(key, {
      code: input.code,
      severity,
      suppressedCount: (previous?.suppressedCount ?? 0) + 1,
    });
  }

  get suppressedDiagnostics(): readonly SuppressionSummary[] {
    return [...this.#suppressed.values()];
  }
}
