import { defineRule } from './define-rule.js';
import { optionSchema } from './option-schema.js';
import type { GeoJSONGeometryType, JsonValueType } from '../types/semantic.js';

const geometryTypes = [
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
  'GeometryCollection',
] as const satisfies readonly GeoJSONGeometryType[];

const requireFeatureId = defineRule({
  meta: { name: 'require-feature-id', schema: null },
  create(context) {
    return {
      feature(feature) {
        if (feature.id === undefined) {
          context.report({
            message: 'Expected Feature to have an ID.',
            featureIndex: feature.index,
            path: feature.path,
          });
        }
      },
    };
  },
});

const uniqueFeatureId = defineRule({
  meta: { name: 'unique-feature-id', schema: null, recommended: true },
  create(context) {
    const strings = new Set<string>();
    const numbers = new Set<number>();
    return {
      feature(feature) {
        const id = feature.id;
        if (id === undefined) return;
        const duplicate =
          typeof id === 'string' ? strings.has(id) : numbers.has(id);
        if (duplicate) {
          context.report({
            message: 'Feature ID is duplicated.',
            featureIndex: feature.index,
            featureId: id,
            path: feature.path,
            data: { featureId: id },
          });
        } else {
          if (typeof id === 'string') strings.add(id);
          else numbers.add(id);
        }
      },
    };
  },
});

const consistentFeatureIdType = defineRule({
  meta: {
    name: 'consistent-feature-id-type',
    schema: null,
    requires: ['idStats'] as const,
    recommended: true,
  },
  create(context) {
    return {
      document(summary) {
        if (summary.ids.stringCount > 0 && summary.ids.numberCount > 0) {
          context.report({
            message: 'Feature IDs use both string and number types.',
            data: {
              stringCount: summary.ids.stringCount,
              numberCount: summary.ids.numberCount,
            },
          });
        }
      },
    };
  },
});

const propertyTypes = [
  'string',
  'number',
  'boolean',
  'null',
  'array',
  'object',
] as const satisfies readonly JsonValueType[];

const consistentPropertyTypes = defineRule({
  meta: {
    name: 'consistent-property-types',
    schema: optionSchema.object({
      nullPolicy: optionSchema.optional(
        optionSchema.enum(['compatible', 'strict']),
        'compatible',
      ),
    }),
    requires: ['propertyStats'] as const,
    recommended: true,
  },
  create(context, options) {
    return {
      document(summary) {
        for (const property of [...summary.propertyStats.keys()].sort()) {
          const stats = summary.propertyStats.get(property)!;
          const observedTypes = propertyTypes.filter(
            (type) => (stats.types.get(type) ?? 0) > 0,
          );
          const compared =
            options.nullPolicy === 'strict'
              ? observedTypes
              : observedTypes.filter((type) => type !== 'null');
          if (compared.length > 1) {
            context.report({
              message: `Property "${property}" uses inconsistent types.`,
              data: { property, observedTypes },
            });
          }
        }
      },
    };
  },
});

const consistentPropertyPresence = defineRule({
  meta: {
    name: 'consistent-property-presence',
    schema: optionSchema.object({
      minimumPresenceRatio: optionSchema.optional(
        optionSchema.refine(
          optionSchema.number(),
          (value) => value > 0 && value <= 1,
          'a number greater than zero and at most one',
        ),
        1,
      ),
      minimumFeatureCount: optionSchema.optional(
        optionSchema.refine(
          optionSchema.number(),
          (value) => Number.isSafeInteger(value) && value >= 0,
          'a non-negative safe integer',
        ),
        1,
      ),
    }),
    requires: ['featureCount', 'propertyStats'] as const,
  },
  create(context, options) {
    return {
      document(summary) {
        for (const property of [...summary.propertyStats.keys()].sort()) {
          const stats = summary.propertyStats.get(property)!;
          if (stats.present < (options.minimumFeatureCount ?? 1)) continue;
          const ratio =
            summary.featureCount === 0
              ? 1
              : stats.present / summary.featureCount;
          if (ratio < (options.minimumPresenceRatio ?? 1)) {
            context.report({
              message: `Property "${property}" is not consistently present.`,
              data: {
                property,
                present: stats.present,
                missing: stats.missing,
                ratio,
                minimumPresenceRatio: options.minimumPresenceRatio,
              },
            });
          }
        }
      },
    };
  },
});

const allowedGeometryTypes = defineRule({
  meta: {
    name: 'allowed-geometry-types',
    schema: optionSchema.object({
      allow: optionSchema.refine(
        optionSchema.array(optionSchema.enum(geometryTypes)),
        (value) => value.length > 0,
        'a non-empty array',
      ),
    }),
  },
  create(context, options) {
    const allowed = new Set(options.allow);
    return {
      geometry(geometry) {
        if (!allowed.has(geometry.type)) {
          context.report({
            message: `Geometry type "${geometry.type}" is not allowed.`,
            path: geometry.path,
            data: { observed: geometry.type, allowed: [...allowed].sort() },
          });
        }
      },
    };
  },
});

const consistentGeometryTypes = defineRule({
  meta: {
    name: 'consistent-geometry-types',
    schema: null,
    requires: ['geometryStats'] as const,
  },
  create(context) {
    return {
      document(summary) {
        const observed = geometryTypes.filter(
          (type) => (summary.featureGeometryTypes.get(type) ?? 0) > 0,
        );
        if (observed.length > 1) {
          context.report({
            message: 'Features use inconsistent geometry types.',
            data: { observed },
          });
        }
      },
    };
  },
});

const noNullGeometry = defineRule({
  meta: { name: 'no-null-geometry', schema: null },
  create(context) {
    return {
      feature(feature) {
        if (feature.geometry === null) {
          context.report({
            message: 'Feature has a null geometry.',
            featureIndex: feature.index,
            ...(feature.id === undefined ? {} : { featureId: feature.id }),
            path: feature.path,
          });
        }
      },
    };
  },
});

const validCoordinateRange = defineRule({
  meta: { name: 'valid-coordinate-range', schema: null, recommended: true },
  create(context) {
    return {
      coordinate(coordinate) {
        const longitude = coordinate.values[0]!;
        const latitude = coordinate.values[1]!;
        if (
          longitude < -180 ||
          longitude > 180 ||
          latitude < -90 ||
          latitude > 90
        ) {
          context.report({
            message: 'Coordinate is outside valid longitude/latitude ranges.',
            ...(coordinate.featureIndex === undefined
              ? {}
              : { featureIndex: coordinate.featureIndex }),
            path: coordinate.path,
            data: { longitude, latitude },
          });
        }
      },
    };
  },
});

const consistentCoordinateDimensions = defineRule({
  meta: {
    name: 'consistent-coordinate-dimensions',
    schema: null,
    requires: ['coordinateDimensionStats'] as const,
    recommended: true,
  },
  create(context) {
    return {
      document(summary) {
        const counts = summary.coordinateDimensionStats;
        if (
          Number(counts.two > 0) +
            Number(counts.three > 0) +
            Number(counts.fourOrMore > 0) >
          1
        ) {
          context.report({
            message: 'Coordinates use inconsistent dimensions.',
            data: { ...counts },
          });
        }
      },
    };
  },
});

const coordinatePrecision = defineRule({
  meta: {
    name: 'coordinate-precision',
    schema: optionSchema.object({
      maximumDecimals: optionSchema.optional(
        optionSchema.refine(
          optionSchema.number(),
          (value) => Number.isSafeInteger(value) && value >= 0,
          'a non-negative safe integer',
        ),
        6,
      ),
    }),
  },
  create() {
    return {
      // The hook is the capability declaration; indexed parsing will supply it.
      coordinateLexeme() {},
    };
  },
});

export const builtInRules = Object.freeze([
  requireFeatureId,
  uniqueFeatureId,
  consistentFeatureIdType,
  consistentPropertyTypes,
  consistentPropertyPresence,
  allowedGeometryTypes,
  consistentGeometryTypes,
  noNullGeometry,
  validCoordinateRange,
  consistentCoordinateDimensions,
  coordinatePrecision,
]);
