import type { SnapshotProposal } from '../regression/snapshot.js';

export function formatSnapshot(proposal: SnapshotProposal): string {
  const lines = ['GeoLint baseline update', ''];
  for (const [label, entries] of [
    ['added', proposal.added],
    ['updated', proposal.updated],
    ['removed', proposal.removed],
  ] as const) {
    for (const entry of entries) lines.push(`${entry.filePath}  ${label}`);
  }
  for (const filePath of proposal.unchanged)
    lines.push(`${filePath}  unchanged`);
  const changed =
    proposal.added.length + proposal.updated.length + proposal.removed.length;
  lines.push('', `${changed} ${changed === 1 ? 'file' : 'files'} changed.`);
  return `${lines.join('\n')}\n`;
}
