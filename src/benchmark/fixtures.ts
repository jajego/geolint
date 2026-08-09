export type FixtureId =
  | 'points-10k'
  | 'points-100k'
  | 'points-1m'
  | 'line-100k'
  | 'polygon-100k'
  | 'geometry-collections-10k'
  | 'wide-properties-10k'
  | 'sparse-properties-10k'
  | 'mixed-properties-10k'
  | 'huge-feature-100k'
  | 'tiny-features-10k'
  | 'tiny-features-100k'
  | 'canonical-order-10k'
  | 'random-order-10k'
  | 'duplicate-losing-100k'
  | 'duplicate-winning-100k'
  | 'minified-100k'
  | 'pretty-100k'
  | 'range-failures-100k'
  | 'missing-ids-10k'
  | 'duplicate-ids-10k'
  | 'feature-budget-10k';

export interface BenchmarkFixture {
  readonly id: FixtureId;
  readonly source: string;
  readonly expectedFeatures: number;
  readonly expectedVertices: number;
}

function positions(count: number): number[][] {
  return Array.from({ length: count }, (_, index) => [
    (index % 360) - 180,
    (index % 180) - 90,
  ]);
}

function feature(index: number, withId = true): Record<string, unknown> {
  return {
    type: 'Feature',
    ...(withId ? { id: index } : {}),
    properties: { category: `c${index % 10}` },
    geometry: {
      type: 'Point',
      coordinates: [(index % 360) - 180, (index % 180) - 90],
    },
  };
}

function featureCollection(count: number, withId = true): unknown {
  return {
    type: 'FeatureCollection',
    features: Array.from({ length: count }, (_, index) =>
      feature(index, withId),
    ),
  };
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function reorder(value: unknown, next: () => number): unknown {
  if (Array.isArray(value)) return value.map((entry) => reorder(entry, next));
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source);
  for (let index = keys.length - 1; index > 0; index -= 1) {
    const target = Math.floor(next() * (index + 1));
    [keys[index], keys[target]] = [keys[target]!, keys[index]!];
  }
  return Object.fromEntries(
    keys.map((key) => [key, reorder(source[key], next)]),
  );
}

function fixture(
  id: FixtureId,
  value: unknown,
  expectedFeatures: number,
  expectedVertices: number,
  pretty = false,
): BenchmarkFixture {
  return {
    id,
    source: JSON.stringify(value, null, pretty ? 2 : undefined),
    expectedFeatures,
    expectedVertices,
  };
}

export function createFixture(id: FixtureId): BenchmarkFixture {
  if (id === 'points-10k' || id === 'points-100k' || id === 'points-1m') {
    const count =
      id === 'points-10k' ? 10_000 : id === 'points-100k' ? 100_000 : 1_000_000;
    return fixture(
      id,
      { type: 'MultiPoint', coordinates: positions(count) },
      0,
      count,
    );
  }
  if (id === 'line-100k') {
    return fixture(
      id,
      { type: 'LineString', coordinates: positions(100_000) },
      0,
      100_000,
    );
  }
  if (id === 'polygon-100k') {
    const ring = positions(100_000);
    ring[ring.length - 1] = [...ring[0]!];
    return fixture(id, { type: 'Polygon', coordinates: [ring] }, 0, 100_000);
  }
  if (id === 'geometry-collections-10k') {
    const geometries = Array.from({ length: 2_000 }, (_, index) => ({
      type: 'GeometryCollection',
      geometries: [
        { type: 'Point', coordinates: [index % 180, index % 90] },
        {
          type: 'LineString',
          coordinates: [
            [index % 180, index % 90],
            [(index + 1) % 180, (index + 1) % 90],
            [(index + 2) % 180, (index + 2) % 90],
            [(index + 3) % 180, (index + 3) % 90],
          ],
        },
      ],
    }));
    return fixture(id, { type: 'GeometryCollection', geometries }, 0, 10_000);
  }
  if (id === 'wide-properties-10k') {
    const properties = Object.fromEntries(
      Array.from({ length: 10_000 }, (_, index) => [`p${index}`, index]),
    );
    return fixture(
      id,
      {
        type: 'Feature',
        id: 1,
        properties,
        geometry: { type: 'Point', coordinates: [0, 0] },
      },
      1,
      1,
    );
  }
  if (id === 'sparse-properties-10k') {
    const features = Array.from({ length: 10_000 }, (_, index) => ({
      ...feature(index),
      properties: {
        [`p${index % 100}`]: index,
        [`p${(index * 17) % 100}`]: `v${index % 10}`,
      },
    }));
    return fixture(id, { type: 'FeatureCollection', features }, 10_000, 10_000);
  }
  if (id === 'mixed-properties-10k') {
    const values: readonly unknown[] = ['x', 1, true, null, [1], { x: 1 }];
    const features = Array.from({ length: 10_000 }, (_, index) => ({
      ...feature(index),
      properties: { value: values[index % values.length] },
    }));
    return fixture(id, { type: 'FeatureCollection', features }, 10_000, 10_000);
  }
  if (id === 'huge-feature-100k') {
    return fixture(
      id,
      {
        type: 'Feature',
        id: 1,
        properties: { category: 'huge' },
        geometry: { type: 'MultiPoint', coordinates: positions(100_000) },
      },
      1,
      100_000,
    );
  }
  if (id === 'tiny-features-10k' || id === 'tiny-features-100k') {
    const count = id === 'tiny-features-10k' ? 10_000 : 100_000;
    return fixture(id, featureCollection(count), count, count);
  }
  if (id === 'canonical-order-10k' || id === 'random-order-10k') {
    const value = featureCollection(10_000);
    return fixture(
      id,
      id === 'canonical-order-10k' ? value : reorder(value, random(0x5eed)),
      10_000,
      10_000,
    );
  }
  if (id === 'duplicate-losing-100k' || id === 'duplicate-winning-100k') {
    const huge = JSON.stringify(positions(100_000));
    const small = '[[1,2]]';
    const coordinates =
      id === 'duplicate-losing-100k'
        ? `${huge},"coordinates":${small}`
        : `${small},"coordinates":${huge}`;
    return {
      id,
      source: `{"type":"MultiPoint","coordinates":${coordinates}}`,
      expectedFeatures: 0,
      expectedVertices: id === 'duplicate-losing-100k' ? 1 : 100_000,
    };
  }
  if (id === 'minified-100k' || id === 'pretty-100k') {
    return fixture(
      id,
      { type: 'MultiPoint', coordinates: positions(100_000) },
      0,
      100_000,
      id === 'pretty-100k',
    );
  }
  if (id === 'range-failures-100k') {
    return fixture(
      id,
      {
        type: 'MultiPoint',
        coordinates: Array.from({ length: 100_000 }, () => [181, 91]),
      },
      0,
      100_000,
    );
  }
  if (id === 'missing-ids-10k') {
    return fixture(id, featureCollection(10_000, false), 10_000, 10_000);
  }
  if (id === 'duplicate-ids-10k') {
    const value = featureCollection(10_000) as {
      features: Record<string, unknown>[];
    };
    for (const item of value.features) item.id = 'same';
    return fixture(id, value, 10_000, 10_000);
  }
  const features = Array.from({ length: 10_000 }, (_, index) => ({
    ...feature(index),
    geometry: {
      type: 'MultiPoint',
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    },
  }));
  return fixture(id, { type: 'FeatureCollection', features }, 10_000, 20_000);
}
