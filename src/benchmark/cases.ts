import type { GeoLintConfig } from '../types/config.js';
import type { FixtureId } from './fixtures.js';
import type { BenchmarkGroup } from './types.js';

export interface LintBenchmarkCase {
  readonly id: string;
  readonly group: BenchmarkGroup;
  readonly fixture: FixtureId;
  readonly profile: string;
  readonly strategy: 'auto' | 'buffered' | 'indexed';
  readonly config: GeoLintConfig;
  readonly expectedErrors?: number;
}

const recommended: GeoLintConfig = { extends: ['geolint/recommended'] };
const sourcePrecision: GeoLintConfig = {
  ...recommended,
  rules: { 'coordinate-precision': 'error' },
};
const sourceFeatureBytes: GeoLintConfig = {
  ...recommended,
  budgets: { feature: { bytes: '1GiB' } },
};
const sourceCombined: GeoLintConfig = {
  ...sourcePrecision,
  budgets: { feature: { bytes: '1GiB' } },
};
const diagnostics = { maxPerCodePerFile: 2, maxPerFile: 2 } as const;

export const lintCases: readonly LintBenchmarkCase[] = [
  {
    id: 'structural/points-100k',
    group: 'product-lint',
    fixture: 'points-100k',
    profile: 'structural',
    strategy: 'auto',
    config: {},
  },
  {
    id: 'recommended/points-100k',
    group: 'product-lint',
    fixture: 'points-100k',
    profile: 'recommended',
    strategy: 'auto',
    config: recommended,
  },
  {
    id: 'recommended/points-1m',
    group: 'product-lint',
    fixture: 'points-1m',
    profile: 'recommended',
    strategy: 'auto',
    config: recommended,
  },
  {
    id: 'recommended/line-100k',
    group: 'product-lint',
    fixture: 'line-100k',
    profile: 'recommended',
    strategy: 'auto',
    config: recommended,
  },
  {
    id: 'recommended/polygon-100k',
    group: 'product-lint',
    fixture: 'polygon-100k',
    profile: 'recommended',
    strategy: 'auto',
    config: recommended,
  },
  {
    id: 'recommended/geometry-collections-10k',
    group: 'product-lint',
    fixture: 'geometry-collections-10k',
    profile: 'recommended',
    strategy: 'auto',
    config: recommended,
  },
  {
    id: 'recommended/huge-feature-100k',
    group: 'product-lint',
    fixture: 'huge-feature-100k',
    profile: 'recommended',
    strategy: 'auto',
    config: recommended,
  },
  {
    id: 'recommended/tiny-features-100k',
    group: 'product-lint',
    fixture: 'tiny-features-100k',
    profile: 'recommended',
    strategy: 'auto',
    config: recommended,
  },
  {
    id: 'buffered/points-10k',
    group: 'parser-strategy',
    fixture: 'points-10k',
    profile: 'recommended',
    strategy: 'buffered',
    config: recommended,
  },
  {
    id: 'indexed/points-10k',
    group: 'parser-strategy',
    fixture: 'points-10k',
    profile: 'recommended',
    strategy: 'indexed',
    config: recommended,
  },
  {
    id: 'buffered/points-100k',
    group: 'parser-strategy',
    fixture: 'points-100k',
    profile: 'recommended',
    strategy: 'buffered',
    config: recommended,
  },
  {
    id: 'indexed/points-100k',
    group: 'parser-strategy',
    fixture: 'points-100k',
    profile: 'recommended',
    strategy: 'indexed',
    config: recommended,
  },
  {
    id: 'buffered/points-1m',
    group: 'parser-strategy',
    fixture: 'points-1m',
    profile: 'recommended',
    strategy: 'buffered',
    config: recommended,
  },
  {
    id: 'indexed/points-1m',
    group: 'parser-strategy',
    fixture: 'points-1m',
    profile: 'recommended',
    strategy: 'indexed',
    config: recommended,
  },
  {
    id: 'source-precision/points-100k',
    group: 'source-aware',
    fixture: 'points-100k',
    profile: 'source-precision',
    strategy: 'auto',
    config: sourcePrecision,
  },
  {
    id: 'source-precision/points-1m',
    group: 'source-aware',
    fixture: 'points-1m',
    profile: 'source-precision',
    strategy: 'auto',
    config: sourcePrecision,
  },
  {
    id: 'source-feature-bytes/huge-feature-100k',
    group: 'source-aware',
    fixture: 'huge-feature-100k',
    profile: 'source-feature-bytes',
    strategy: 'auto',
    config: sourceFeatureBytes,
  },
  {
    id: 'source-combined/tiny-features-10k',
    group: 'source-aware',
    fixture: 'tiny-features-10k',
    profile: 'source-combined',
    strategy: 'auto',
    config: sourceCombined,
  },
  {
    id: 'properties/wide',
    group: 'properties',
    fixture: 'wide-properties-10k',
    profile: 'property-stats',
    strategy: 'auto',
    config: { rules: { 'consistent-property-types': 'error' } },
  },
  {
    id: 'properties/sparse',
    group: 'properties',
    fixture: 'sparse-properties-10k',
    profile: 'property-presence',
    strategy: 'auto',
    config: {
      rules: {
        'consistent-property-presence': [
          'error',
          { minimumPresenceRatio: 0.001 },
        ],
      },
    },
  },
  {
    id: 'properties/mixed',
    group: 'properties',
    fixture: 'mixed-properties-10k',
    profile: 'mixed-property-types',
    strategy: 'auto',
    config: { rules: { 'consistent-property-types': 'error' }, diagnostics },
    expectedErrors: 1,
  },
  {
    id: 'member-order/canonical',
    group: 'hostile-inputs',
    fixture: 'canonical-order-10k',
    profile: 'recommended',
    strategy: 'auto',
    config: recommended,
  },
  {
    id: 'member-order/random',
    group: 'hostile-inputs',
    fixture: 'random-order-10k',
    profile: 'recommended',
    strategy: 'auto',
    config: recommended,
  },
  {
    id: 'source/minified-100k',
    group: 'source-aware',
    fixture: 'minified-100k',
    profile: 'source-precision',
    strategy: 'auto',
    config: sourcePrecision,
  },
  {
    id: 'source/pretty-100k',
    group: 'source-aware',
    fixture: 'pretty-100k',
    profile: 'source-precision',
    strategy: 'auto',
    config: sourcePrecision,
  },
  {
    id: 'diagnostics/range-100k',
    group: 'diagnostics',
    fixture: 'range-failures-100k',
    profile: 'high-cardinality-failure',
    strategy: 'auto',
    config: { rules: { 'valid-coordinate-range': 'error' }, diagnostics },
    expectedErrors: 100_000,
  },
  {
    id: 'diagnostics/missing-ids-10k',
    group: 'diagnostics',
    fixture: 'missing-ids-10k',
    profile: 'high-cardinality-failure',
    strategy: 'auto',
    config: { rules: { 'require-feature-id': 'error' }, diagnostics },
    expectedErrors: 10_000,
  },
  {
    id: 'diagnostics/duplicate-ids-10k',
    group: 'diagnostics',
    fixture: 'duplicate-ids-10k',
    profile: 'high-cardinality-failure',
    strategy: 'auto',
    config: { rules: { 'unique-feature-id': 'error' }, diagnostics },
    expectedErrors: 9_999,
  },
  {
    id: 'diagnostics/feature-budget-10k',
    group: 'diagnostics',
    fixture: 'feature-budget-10k',
    profile: 'high-cardinality-failure',
    strategy: 'auto',
    config: { budgets: { feature: { vertices: 1 } }, diagnostics },
    expectedErrors: 10_000,
  },
];
