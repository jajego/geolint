import { lintGeoJSONText } from '../engine/lint-input.js';

interface Fixture {
  readonly name: string;
  readonly vertices: number;
  readonly source: () => string;
}

function positions(count: number): number[][] {
  const result = new Array<number[]>(count);
  for (let index = 0; index < count; index += 1) {
    result[index] = [(index % 360) - 180, (index % 180) - 90];
  }
  return result;
}

function geometry(type: 'MultiPoint' | 'LineString', count: number): string {
  return JSON.stringify({ type, coordinates: positions(count) });
}

function polygon(count: number): string {
  const ring = positions(count);
  if (ring.length > 0) ring[ring.length - 1] = [...ring[0]!];
  return JSON.stringify({ type: 'Polygon', coordinates: [ring] });
}

function features(count: number): string {
  const values = new Array<unknown>(count);
  for (let index = 0; index < count; index += 1) {
    values[index] = {
      type: 'Feature',
      properties: { category: `c${index % 10}` },
      geometry: {
        type: 'Point',
        coordinates: [(index % 360) - 180, (index % 180) - 90],
      },
    };
  }
  return JSON.stringify({ type: 'FeatureCollection', features: values });
}

const fixtures: readonly Fixture[] = [
  {
    name: 'points-10k',
    vertices: 10_000,
    source: () => geometry('MultiPoint', 10_000),
  },
  {
    name: 'points-100k',
    vertices: 100_000,
    source: () => geometry('MultiPoint', 100_000),
  },
  {
    name: 'points-1m',
    vertices: 1_000_000,
    source: () => geometry('MultiPoint', 1_000_000),
  },
  {
    name: 'line-heavy-100k',
    vertices: 100_000,
    source: () => geometry('LineString', 100_000),
  },
  {
    name: 'polygon-heavy-100k',
    vertices: 100_000,
    source: () => polygon(100_000),
  },
  {
    name: 'small-features-10k',
    vertices: 10_000,
    source: () => features(10_000),
  },
];

await lintGeoJSONText(geometry('MultiPoint', 1_000), { config: {} });

console.log('fixture                  ms    vertices/s       MB/s');
for (const fixture of fixtures) {
  const source = fixture.source();
  const bytes = Buffer.byteLength(source, 'utf8');
  const startedAt = performance.now();
  const result = await lintGeoJSONText(source, { config: {} });
  const elapsed = performance.now() - startedAt;
  if (result.summary?.totalVertices !== fixture.vertices) {
    throw new Error(
      `Benchmark fixture ${fixture.name} traversed an unexpected vertex count.`,
    );
  }
  const verticesPerSecond = fixture.vertices / (elapsed / 1_000);
  const megabytesPerSecond = bytes / 1_000_000 / (elapsed / 1_000);
  console.log(
    `${fixture.name.padEnd(22)} ${elapsed.toFixed(1).padStart(7)} ${Math.round(verticesPerSecond).toLocaleString('en-US').padStart(13)} ${megabytesPerSecond.toFixed(1).padStart(10)}`,
  );
}
