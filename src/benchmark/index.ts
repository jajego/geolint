import { lintGeoJSONText } from '../engine/lint-input.js';
import { DiagnosticCollector } from '../engine/diagnostics.js';
import { createExecutionRequirements } from '../engine/requirements.js';
import { scanGeoJSON, type ScanInstrumentation } from '../scanner/scan.js';

interface Fixture {
  readonly name: string;
  readonly positions: number;
  readonly expectedVertices?: number;
  readonly expectedErrors?: number;
  readonly diagnosticLimit?: number;
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

function sparseMalformedFeatures(count: number): string {
  const value = JSON.parse(features(count)) as { features: unknown[] };
  for (let index = 999; index < count; index += 1_000) {
    value.features[index] = null;
  }
  return JSON.stringify({
    type: 'FeatureCollection',
    features: value.features,
  });
}

function sparseMalformedGeometries(count: number): string {
  const geometries = Array.from({ length: count }, (_, index) =>
    index % 1_000 === 999
      ? null
      : { type: 'Point', coordinates: [index % 180, index % 90] },
  );
  return JSON.stringify({ type: 'GeometryCollection', geometries });
}

const fixtures: readonly Fixture[] = [
  {
    name: 'points-10k',
    positions: 10_000,
    source: () => geometry('MultiPoint', 10_000),
  },
  {
    name: 'points-100k',
    positions: 100_000,
    source: () => geometry('MultiPoint', 100_000),
  },
  {
    name: 'points-1m',
    positions: 1_000_000,
    source: () => geometry('MultiPoint', 1_000_000),
  },
  {
    name: 'line-heavy-100k',
    positions: 100_000,
    source: () => geometry('LineString', 100_000),
  },
  {
    name: 'polygon-heavy-100k',
    positions: 100_000,
    source: () => polygon(100_000),
  },
  {
    name: 'small-features-10k',
    positions: 10_000,
    source: () => features(10_000),
  },
  {
    name: 'points-1m-late-bad',
    positions: 1_000_000,
    expectedVertices: 999_999,
    expectedErrors: 1,
    source: () => {
      const values: unknown[] = positions(1_000_000);
      values[999_998] = [0];
      return JSON.stringify({ type: 'MultiPoint', coordinates: values });
    },
  },
  {
    name: 'features-10k-sparse-bad',
    positions: 10_000,
    expectedVertices: 9_990,
    expectedErrors: 10,
    source: () => sparseMalformedFeatures(10_000),
  },
  {
    name: 'collections-10k-sparse',
    positions: 10_000,
    expectedVertices: 9_990,
    expectedErrors: 10,
    source: () => sparseMalformedGeometries(10_000),
  },
  {
    name: 'bad-positions-500k',
    positions: 500_000,
    expectedVertices: 0,
    expectedErrors: 500_000,
    diagnosticLimit: 2,
    source: () =>
      JSON.stringify({
        type: 'MultiPoint',
        coordinates: Array.from({ length: 500_000 }, (_, index) => [index]),
      }),
  },
];

await lintGeoJSONText(geometry('MultiPoint', 1_000), { config: {} });

console.log(
  'fixture                         ms   positions/s       MB/s  kept/errors',
);
for (const fixture of fixtures) {
  const source = fixture.source();
  const bytes = Buffer.byteLength(source, 'utf8');
  const startedAt = performance.now();
  const result = await lintGeoJSONText(source, {
    config: fixture.diagnosticLimit
      ? {
          diagnostics: {
            maxPerCodePerFile: fixture.diagnosticLimit,
            maxPerFile: fixture.diagnosticLimit,
          },
        }
      : {},
  });
  const elapsed = performance.now() - startedAt;
  const expectedVertices = fixture.expectedVertices ?? fixture.positions;
  const expectedErrors = fixture.expectedErrors ?? 0;
  if (
    result.summary?.totalVertices !== expectedVertices ||
    result.errorCount !== expectedErrors
  ) {
    throw new Error(
      `Benchmark fixture ${fixture.name} produced unexpected results.`,
    );
  }
  const positionsPerSecond = fixture.positions / (elapsed / 1_000);
  const megabytesPerSecond = bytes / 1_000_000 / (elapsed / 1_000);
  console.log(
    `${fixture.name.padEnd(30)} ${elapsed.toFixed(1).padStart(7)} ${Math.round(positionsPerSecond).toLocaleString('en-US').padStart(13)} ${megabytesPerSecond.toFixed(1).padStart(10)} ${`${result.diagnostics.length}/${result.errorCount}`.padStart(12)}`,
  );
}

const malformedCount = 500_000;
const instrumentation: ScanInstrumentation = {
  coordinateTraversals: 0,
  positionVisits: 0,
  coordinatePathMaterializations: 0,
  propertyPathMaterializations: 0,
};
const diagnostics = new DiagnosticCollector('<benchmark>', {
  maxPerCodePerFile: 2,
  maxPerFile: 2,
});
const malformedStartedAt = performance.now();
scanGeoJSON(
  {
    type: 'MultiPoint',
    coordinates: Array.from({ length: malformedCount }, (_, index) => [index]),
  },
  {
    filePath: '<benchmark>',
    diagnostics,
    instrumentation,
    requirements: createExecutionRequirements({ facts: ['vertexCount'] }),
  },
);
const malformedElapsed = performance.now() - malformedStartedAt;
console.log(
  `suppressed-path-check ${malformedElapsed.toFixed(1)}ms ` +
    `${Math.round(malformedCount / (malformedElapsed / 1_000)).toLocaleString('en-US')} positions/s ` +
    `${diagnostics.diagnostics.length}/${diagnostics.errorCount} kept/errors ` +
    `${instrumentation.coordinatePathMaterializations} paths`,
);
