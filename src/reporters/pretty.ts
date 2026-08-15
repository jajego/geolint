import type {
  Diagnostic,
  FileLintResult,
  LintResult,
} from '../types/semantic.js';
import { formatByteSize } from '../engine/byte-size.js';
import { formatQuotedValue, formatTerminalText } from '../terminal-text.js';

export interface PrettyOptions {
  readonly color?: boolean;
}

function plural(value: number, singular: string, pluralForm = `${singular}s`) {
  return `${value.toLocaleString('en-US')} ${value === 1 ? singular : pluralForm}`;
}

function location(diagnostic: Diagnostic): string {
  if (diagnostic.featureId !== undefined) {
    return `id ${formatQuotedValue(diagnostic.featureId)}`;
  }
  if (diagnostic.featureIndex !== undefined) {
    return `feature[${diagnostic.featureIndex}]`;
  }
  return diagnostic.path ? formatTerminalText(diagnostic.path) : 'artifact';
}

function fileLines(file: FileLintResult, color: boolean): string[] {
  const red = (value: string) =>
    color ? `\u001b[31m${value}\u001b[0m` : value;
  const yellow = (value: string) =>
    color ? `\u001b[33m${value}\u001b[0m` : value;
  const lines = [formatTerminalText(file.filePath), ''];
  for (const diagnostic of file.diagnostics) {
    const severity =
      diagnostic.severity === 'error' ? red('error') : yellow('warning');
    lines.push(
      `  ${location(diagnostic)}  ${severity}  ${formatTerminalText(diagnostic.message)}  ${diagnostic.code}`,
    );
  }
  for (const item of file.suppressedDiagnostics) {
    const shown = file.diagnostics.filter(
      ({ code, severity }) => code === item.code && severity === item.severity,
    ).length;
    lines.push(
      `  ${item.code}  ${shown.toLocaleString('en-US')} shown · ${item.suppressedCount.toLocaleString('en-US')} additional occurrences suppressed`,
    );
  }
  if (file.skippedPolicies.length > 0) {
    lines.push(
      '',
      `  ${plural(file.skippedPolicies.length, 'configured policy', 'configured policies')} not evaluated:`,
    );
    for (const skipped of file.skippedPolicies) {
      lines.push(
        skipped.reason === 'no-baseline'
          ? `    ${skipped.code} · no baseline exists`
          : `    ${skipped.code} · incomplete ${skipped.incompleteFacts.join(', ')}`,
      );
    }
  }
  if (file.summary) {
    const facts = [
      plural(file.summary.featureCount, 'feature'),
      plural(file.summary.totalVertices, 'vertex', 'vertices'),
      ...(file.summary.bytes === undefined
        ? []
        : [formatByteSize(file.summary.bytes)]),
      `${Math.round(file.durationMs)} ms`,
    ];
    lines.push('', `  ${facts.join(' · ')}`);
  }
  return lines;
}

export function formatPretty(
  result: LintResult,
  options: PrettyOptions = {},
): string {
  const lines = result.files.flatMap((file, index) => [
    ...(index === 0 ? [] : ['']),
    ...fileLines(file, options.color ?? false),
  ]);
  lines.push(
    '',
    result.errorCount === 0 && result.warningCount === 0
      ? '✓ no errors or warnings'
      : `✖ ${plural(result.errorCount, 'error')}, ${plural(result.warningCount, 'warning')}`,
  );
  if (
    result.files.some((file) =>
      file.diagnostics.some(({ source }) => source === 'regression'),
    )
  ) {
    lines.push(
      '  Run `geolint snapshot` to review and approve an intentional baseline change.',
    );
  }
  return `${lines.join('\n')}\n`;
}
