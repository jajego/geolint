import type { BaselineFileEntry } from '../regression/schema.js';
import type {
  SnapshotEntryChange,
  SnapshotProposal,
} from '../regression/snapshot.js';
import { formatTerminalText } from '../terminal-text.js';

function count(value: number): string {
  return value.toLocaleString('en-US');
}

function bytes(value: number): string {
  if (value < 1_000) return `${value} B`;
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)} KB`;
  return `${(value / 1_000_000).toFixed(1)} MB`;
}

function summary(entry: BaselineFileEntry): string {
  return `${count(entry.featureCount)} features · ${count(entry.totalVertices)} vertices · ${bytes(entry.bytes)}`;
}

function changed(
  lines: string[],
  label: string,
  before: number,
  after: number,
  format: (value: number) => string = count,
): void {
  if (before !== after)
    lines.push(`  ${label}  ${format(before)} → ${format(after)}`);
}

function update(entry: SnapshotEntryChange): string[] {
  const before = entry.before!;
  const after = entry.after!;
  const lines = [formatTerminalText(entry.filePath)];
  changed(lines, 'bytes', before.bytes, after.bytes, bytes);
  changed(lines, 'featureCount', before.featureCount, after.featureCount);
  changed(lines, 'totalVertices', before.totalVertices, after.totalVertices);
  changed(
    lines,
    'largestFeatureVertices',
    before.largestFeatureVertices,
    after.largestFeatureVertices,
  );
  const geometryTypes = new Set([
    ...Object.keys(before.featureGeometryTypes),
    ...Object.keys(after.featureGeometryTypes),
  ]);
  const geometryLines = [...geometryTypes].sort().flatMap((type) => {
    const previous =
      before.featureGeometryTypes[
        type as keyof typeof before.featureGeometryTypes
      ] ?? 0;
    const next =
      after.featureGeometryTypes[
        type as keyof typeof after.featureGeometryTypes
      ] ?? 0;
    if (previous === next) return [];
    if (previous === 0) return [`    + ${type}`];
    if (next === 0) return [`    - ${type}`];
    return [`    ${type}  ${count(previous)} → ${count(next)}`];
  });
  if (geometryLines.length > 0) lines.push('  geometryTypes', ...geometryLines);
  return lines;
}

export function formatSnapshot(proposal: SnapshotProposal): string {
  const lines = ['GeoLint baseline update', ''];
  for (const entry of proposal.added)
    lines.push(
      formatTerminalText(entry.filePath),
      '  added',
      `  ${summary(entry.after!)}`,
      '',
    );
  for (const entry of proposal.updated) lines.push(...update(entry), '');
  for (const entry of proposal.removed)
    lines.push(formatTerminalText(entry.filePath), '  removed', '');
  const changed =
    proposal.added.length + proposal.updated.length + proposal.removed.length;
  lines.push(
    `${changed} ${changed === 1 ? 'file' : 'files'} changed.`,
    `Baseline written: ${formatTerminalText(proposal.baselinePath)}`,
  );
  return `${lines.join('\n')}\n`;
}
