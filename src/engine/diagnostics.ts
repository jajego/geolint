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

type DiagnosticHeader = Pick<DiagnosticInput, 'code' | 'source' | 'severity'>;
type DiagnosticDetails = Omit<DiagnosticInput, 'code' | 'source' | 'severity'>;

interface MutableSuppression {
  count: number;
  readonly order: number;
}

interface MutableSuppressionsBySeverity {
  error?: MutableSuppression;
  warning?: MutableSuppression;
}

export class DiagnosticCollector {
  readonly diagnostics: Diagnostic[] = [];
  readonly #retainedByCode = new Map<string, number>();
  readonly #suppressed = new Map<string, MutableSuppressionsBySeverity>();
  readonly #maxPerCode: number;
  readonly #maxPerFile: number;
  #suppressionOrder = 0;
  errorCount = 0;
  warningCount = 0;
  lazyDetailCount = 0;

  constructor(
    readonly filePath: string,
    limits: DiagnosticLimitConfig = {},
  ) {
    this.#maxPerCode = limits.maxPerCodePerFile ?? defaultMaxPerCodePerFile;
    this.#maxPerFile = limits.maxPerFile ?? defaultMaxPerFile;
  }

  report(input: DiagnosticInput): void {
    const severity = input.severity ?? 'error';
    if (!this.#retain(input.code, severity)) return;
    this.diagnostics.push({ ...input, severity, filePath: this.filePath });
  }

  reportLazy(header: DiagnosticHeader, details: () => DiagnosticDetails): void {
    const severity = header.severity ?? 'error';
    // Suppressed hot-path findings never build messages, paths, or detail objects.
    if (!this.#retain(header.code, severity)) return;
    this.lazyDetailCount += 1;
    this.diagnostics.push({
      ...details(),
      ...header,
      severity,
      filePath: this.filePath,
    });
  }

  #retain(code: string, severity: Diagnostic['severity']): boolean {
    if (severity === 'error') this.errorCount += 1;
    else this.warningCount += 1;
    const retainedForCode = this.#retainedByCode.get(code) ?? 0;
    if (
      retainedForCode < this.#maxPerCode &&
      this.diagnostics.length < this.#maxPerFile
    ) {
      this.#retainedByCode.set(code, retainedForCode + 1);
      return true;
    }
    let bySeverity = this.#suppressed.get(code);
    if (!bySeverity) {
      bySeverity = {};
      this.#suppressed.set(code, bySeverity);
    }
    let counter = bySeverity[severity];
    if (!counter) {
      counter = { count: 0, order: this.#suppressionOrder };
      this.#suppressionOrder += 1;
      bySeverity[severity] = counter;
    }
    counter.count += 1;
    return false;
  }

  get suppressedDiagnostics(): readonly SuppressionSummary[] {
    const summaries: (SuppressionSummary & { readonly order: number })[] = [];
    for (const [code, bySeverity] of this.#suppressed) {
      for (const severity of ['error', 'warning'] as const) {
        const counter = bySeverity[severity];
        if (counter) {
          summaries.push({
            code,
            severity,
            suppressedCount: counter.count,
            order: counter.order,
          });
        }
      }
    }
    summaries.sort((left, right) => left.order - right.order);
    return summaries.map(({ code, severity, suppressedCount }) => ({
      code,
      severity,
      suppressedCount,
    }));
  }
}
