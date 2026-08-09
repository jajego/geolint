import { definePlugin, defineRule, optionSchema } from '../../index.js';

const propertyAllowlist = defineRule({
  meta: {
    name: 'property-allowlist',
    schema: optionSchema.object({
      allow: optionSchema.array(optionSchema.string()),
    }),
  },
  create(context, options) {
    const allowed = new Set(options.allow);
    return {
      propertyValue(event) {
        if (!allowed.has(event.key)) {
          context.report({
            message: `Property "${event.key}" is not allowed.`,
            featureIndex: event.featureIndex,
            path: event.path,
          });
        }
      },
    };
  },
});

export const namedPlugin = definePlugin({
  meta: {
    apiVersion: 1,
    moduleUrl: import.meta.url,
    exportName: 'namedPlugin',
  },
  rules: {},
});

export default definePlugin({
  meta: {
    apiVersion: 1,
    moduleUrl: import.meta.url,
    exportName: 'default',
  },
  rules: { 'property-allowlist': propertyAllowlist },
});
