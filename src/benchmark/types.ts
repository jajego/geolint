export const benchmarkGroups = [
  'product-lint',
  'parser-strategy',
  'source-aware',
  'properties',
  'hostile-inputs',
  'diagnostics',
  'batch',
  'cold-start',
  'memory',
  'instrumentation',
] as const;

export type BenchmarkGroup = (typeof benchmarkGroups)[number];

export interface BenchmarkEnvironment {
  readonly node: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly cpuModel: string;
  readonly logicalCpuCount: number;
  readonly totalMemoryBytes: number;
}

export interface BenchmarkMemorySample {
  readonly peakRssBytes: number;
  readonly finalRssBytes: number;
  readonly heapUsedBytes: number;
  readonly externalBytes: number;
  readonly arrayBuffersBytes: number;
}

export interface BenchmarkCaseResult {
  readonly id: string;
  readonly group: BenchmarkGroup;
  readonly fixture: string;
  readonly profile: string;
  readonly strategy: string;
  readonly workerCount?: number;
  readonly sourceBytes: number;
  readonly sampleCount: number;
  readonly samplesMs: readonly number[];
  readonly medianMs: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly megabytesPerSecond?: number;
  readonly featuresPerSecond?: number;
  readonly verticesPerSecond?: number;
  readonly filesPerSecond?: number;
  readonly peakRssBytes?: number;
  readonly finalRssBytes?: number;
  readonly heapUsedBytes?: number;
  readonly externalBytes?: number;
  readonly arrayBuffersBytes?: number;
  readonly memorySamples?: readonly BenchmarkMemorySample[];
  readonly shape?: string;
  readonly requestedMiB?: number;
  readonly fileBytes?: number;
  readonly coordinateConsumer?: 'direct' | 'generic' | 'not-applicable';
  readonly semanticCounts?: {
    readonly files?: number;
    readonly features?: number;
    readonly vertices?: number;
    readonly errors?: number;
    readonly warnings?: number;
    readonly retainedDiagnostics?: number;
    readonly suppressedDiagnostics?: number;
  };
  readonly instrumentation?: Readonly<Record<string, number>>;
}

export interface BenchmarkArtifact {
  readonly schemaVersion: 1;
  readonly geolintVersion: string;
  readonly suite: 'standard' | 'extended' | 'large-memory';
  readonly environment: BenchmarkEnvironment;
  readonly cases: readonly BenchmarkCaseResult[];
}

export interface BenchmarkComparison {
  readonly id: string;
  readonly metric: 'wallClockMs' | 'megabytesPerSecond' | 'peakRssBytes';
  readonly baseline: number;
  readonly current: number;
  readonly deltaPercent: number;
  readonly advisoryRegression: boolean;
}
