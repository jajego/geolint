import { cpus, totalmem } from 'node:os';

import { geolintVersion } from '../version.js';
import type {
  BenchmarkArtifact,
  BenchmarkCaseResult,
  BenchmarkEnvironment,
  BenchmarkGroup,
} from './types.js';

const groupOrder: readonly BenchmarkGroup[] = [
  'product-lint',
  'parser-strategy',
  'source-aware',
  'properties',
  'hostile-inputs',
  'diagnostics',
  'instrumentation',
  'batch',
  'cold-start',
  'memory',
];

function benchmarkEnvironment(): BenchmarkEnvironment {
  const processors = cpus();
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuModel: processors[0]?.model ?? 'unknown',
    logicalCpuCount: processors.length,
    totalMemoryBytes: totalmem(),
  };
}

export function createArtifact(
  cases: readonly BenchmarkCaseResult[],
  extended: boolean,
): BenchmarkArtifact {
  return {
    schemaVersion: 1,
    geolintVersion,
    suite: extended ? 'extended' : 'standard',
    environment: benchmarkEnvironment(),
    cases,
  };
}

function memory(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export function formatBenchmark(artifact: BenchmarkArtifact): string {
  const lines = [
    `GeoLint benchmark (${artifact.suite})`,
    `${artifact.environment.node} · ${artifact.environment.platform}/${artifact.environment.arch} · ${artifact.environment.cpuModel}`,
  ];
  for (const group of groupOrder) {
    const cases = artifact.cases.filter((item) => item.group === group);
    if (cases.length === 0) continue;
    lines.push('', group.replaceAll('-', ' '));
    for (const item of cases) {
      const metrics = [
        `${item.medianMs.toFixed(1)} ms median (${item.sampleCount} samples)`,
        ...(item.megabytesPerSecond === undefined
          ? []
          : [`${item.megabytesPerSecond.toFixed(1)} MB/s`]),
        ...(item.verticesPerSecond === undefined
          ? []
          : [
              `${Math.round(item.verticesPerSecond).toLocaleString('en-US')} vertices/s`,
            ]),
        ...(item.filesPerSecond === undefined
          ? []
          : [`${item.filesPerSecond.toFixed(1)} files/s`]),
        ...(item.peakRssBytes === undefined
          ? []
          : [`${memory(item.peakRssBytes)} peak RSS`]),
      ];
      lines.push(`  ${item.id}`, `    ${metrics.join(' · ')}`);
      if (item.instrumentation) {
        lines.push(
          `    ${Object.entries(item.instrumentation)
            .map(([key, value]) => `${key}=${value}`)
            .join(' · ')}`,
        );
      }
    }
  }
  return `${lines.join('\n')}\n`;
}
