import { readFile } from 'node:fs/promises';

import type { BenchmarkArtifact, BenchmarkComparison } from './types.js';

function nodeMajor(version: string): string {
  return version.replace(/^v/, '').split('.')[0]!;
}

export function compareArtifacts(
  baseline: BenchmarkArtifact,
  current: BenchmarkArtifact,
  thresholdPercent = 20,
): {
  readonly compatibleEnvironment: boolean;
  readonly comparisons: readonly BenchmarkComparison[];
} {
  const compatibleEnvironment =
    baseline.environment.platform === current.environment.platform &&
    baseline.environment.arch === current.environment.arch &&
    nodeMajor(baseline.environment.node) ===
      nodeMajor(current.environment.node);
  const currentCases = new Map(current.cases.map((item) => [item.id, item]));
  const comparisons = baseline.cases.flatMap((before) => {
    const after = currentCases.get(before.id);
    if (!after) return [];
    return [
      ['wallClockMs', before.medianMs, after.medianMs, false],
      [
        'megabytesPerSecond',
        before.megabytesPerSecond,
        after.megabytesPerSecond,
        true,
      ],
      ['peakRssBytes', before.peakRssBytes, after.peakRssBytes, false],
    ].flatMap(([metric, baselineValue, currentValue, lowerIsRegression]) => {
      if (
        typeof baselineValue !== 'number' ||
        typeof currentValue !== 'number' ||
        baselineValue <= 0
      ) {
        return [];
      }
      const deltaPercent = (currentValue / baselineValue - 1) * 100;
      return [
        {
          id: before.id,
          metric: metric as BenchmarkComparison['metric'],
          baseline: baselineValue,
          current: currentValue,
          deltaPercent,
          advisoryRegression: lowerIsRegression
            ? deltaPercent <= -thresholdPercent
            : deltaPercent >= thresholdPercent,
        },
      ];
    });
  });
  return { compatibleEnvironment, comparisons };
}

export async function runComparison(argv: readonly string[]): Promise<string> {
  const [baselinePath, currentPath, rawThreshold] = argv;
  if (!baselinePath || !currentPath) {
    throw new TypeError(
      'Usage: benchmark:compare <baseline.json> <current.json> [threshold-percent]',
    );
  }
  const threshold = rawThreshold === undefined ? 20 : Number(rawThreshold);
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new TypeError('Comparison threshold must be a non-negative number.');
  }
  const baseline = JSON.parse(
    await readFile(baselinePath, 'utf8'),
  ) as BenchmarkArtifact;
  const current = JSON.parse(
    await readFile(currentPath, 'utf8'),
  ) as BenchmarkArtifact;
  const comparison = compareArtifacts(baseline, current, threshold);
  const lines = [
    `GeoLint benchmark comparison (${threshold}% advisory threshold)`,
    ...(comparison.compatibleEnvironment
      ? []
      : ['warning: OS, architecture, or Node major version differs']),
  ];
  for (const item of comparison.comparisons) {
    lines.push(
      `${item.advisoryRegression ? 'ADVISORY ' : ''}${item.id} ${item.metric} ${item.baseline.toFixed(1)} → ${item.current.toFixed(1)} (${item.deltaPercent >= 0 ? '+' : ''}${item.deltaPercent.toFixed(1)}%)`,
    );
  }
  return `${lines.join('\n')}\n`;
}
