export function median(values: readonly number[]): number {
  if (values.length === 0) throw new TypeError('Median requires samples.');
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

export function round(value: number, digits = 3): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
