import { lintGeoJSONText } from '../engine/lint-input.js';
import { DiagnosticCollector } from '../engine/diagnostics.js';
import { createExecutionRequirements } from '../engine/requirements.js';
import { scanGeoJSON, type ScanInstrumentation } from '../scanner/scan.js';
import type { GeoLintConfig } from '../types/config.js';

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

function featuresWithIds(count: number, duplicate = false): string {
  const value = JSON.parse(features(count)) as {
    features: Record<string, unknown>[];
  };
  value.features.forEach((feature, index) => {
    feature.id = duplicate ? 'same' : index;
  });
  return JSON.stringify({
    type: 'FeatureCollection',
    features: value.features,
  });
}

function wideProperties(count: number): string {
  const properties = Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`p${index}`, index]),
  );
  return JSON.stringify({
    type: 'Feature',
    properties,
    geometry: { type: 'Point', coordinates: [0, 0] },
  });
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

const policyFixtures = [
  ['points-100k', 100_000, () => geometry('MultiPoint', 100_000)],
  ['points-1m', 1_000_000, () => geometry('MultiPoint', 1_000_000)],
  ['line-heavy-100k', 100_000, () => geometry('LineString', 100_000)],
  ['polygon-heavy-100k', 100_000, () => polygon(100_000)],
  ['small-features-10k', 10_000, () => features(10_000)],
  ['wide-properties-10k', 1, () => wideProperties(10_000)],
  ['unique-ids-10k', 10_000, () => featuresWithIds(10_000)],
] as const;
console.log(
  '\nstructural vs recommended        structural  recommended  overhead',
);
for (const [name, count, sourceFactory] of policyFixtures) {
  const source = sourceFactory();
  const startedStructural = performance.now();
  const structural = await lintGeoJSONText(source, { config: {} });
  const structuralMs = performance.now() - startedStructural;
  const startedRecommended = performance.now();
  const recommended = await lintGeoJSONText(source);
  const recommendedMs = performance.now() - startedRecommended;
  if (
    structural.errorCount !== 0 ||
    recommended.errorCount !== 0 ||
    recommended.summary?.totalVertices !== count
  ) {
    throw new Error(`Policy benchmark fixture ${name} was not clean.`);
  }
  console.log(
    `${name.padEnd(30)} ${structuralMs.toFixed(1).padStart(10)} ${recommendedMs.toFixed(1).padStart(12)} ${`${((recommendedMs / structuralMs - 1) * 100).toFixed(1)}%`.padStart(9)}`,
  );
}

async function failingPolicy(
  name: string,
  source: string,
  config: GeoLintConfig,
  expectedErrors: number,
): Promise<void> {
  const startedAt = performance.now();
  const result = await lintGeoJSONText(source, {
    config: {
      ...config,
      diagnostics: { maxPerCodePerFile: 2, maxPerFile: 2 },
    },
  });
  const elapsed = performance.now() - startedAt;
  if (result.errorCount !== expectedErrors || result.diagnostics.length !== 2) {
    throw new Error(`Failure benchmark ${name} produced unexpected results.`);
  }
  console.log(
    `${name.padEnd(30)} ${elapsed.toFixed(1).padStart(8)}ms ${`${result.diagnostics.length}/${result.errorCount}`.padStart(14)} kept/errors`,
  );
}

console.log('\nhigh-cardinality policy failures');
await failingPolicy(
  'range-failures-100k',
  JSON.stringify({
    type: 'MultiPoint',
    coordinates: Array.from({ length: 100_000 }, () => [181, 91]),
  }),
  { rules: { 'valid-coordinate-range': 'error' } },
  100_000,
);
await failingPolicy(
  'missing-ids-10k',
  features(10_000),
  { rules: { 'require-feature-id': 'error' } },
  10_000,
);
await failingPolicy(
  'duplicate-ids-10k',
  featuresWithIds(10_000, true),
  { rules: { 'unique-feature-id': 'error' } },
  9_999,
);
const inconsistentProperties = Object.fromEntries(
  Array.from({ length: 5_000 }, (_, index) => [`p${index}`, 'x']),
);
await failingPolicy(
  'property-types-5k',
  JSON.stringify({
    type: 'FeatureCollection',
    features: [
      JSON.parse(wideProperties(5_000)),
      {
        type: 'Feature',
        properties: inconsistentProperties,
        geometry: null,
      },
    ],
  }),
  { rules: { 'consistent-property-types': 'error' } },
  5_000,
);
await failingPolicy(
  'feature-budget-10k',
  JSON.stringify({
    type: 'FeatureCollection',
    features: Array.from({ length: 10_000 }, (_, id) => ({
      type: 'Feature',
      id,
      properties: {},
      geometry: {
        type: 'MultiPoint',
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      },
    })),
  }),
  { budgets: { feature: { vertices: 1 } } },
  10_000,
);
console.log(
  '\nstructural/malformed fixtures    ms   positions/s       MB/s  kept/errors',
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
