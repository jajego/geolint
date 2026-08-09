import type { ResolvedConfig, ResolvedFileConfig } from '../types/config.js';
import { formatJson } from './json.js';

function plugins(config: ResolvedConfig) {
  return Object.fromEntries(
    Object.keys(config.plugins)
      .sort()
      .map((namespace) => {
        const plugin = config.plugins[namespace]!;
        return [
          namespace,
          {
            apiVersion: plugin.meta.apiVersion,
            ...(plugin.meta.moduleUrl
              ? {
                  moduleUrl: plugin.meta.moduleUrl,
                  exportName: plugin.meta.exportName,
                }
              : {}),
            rules: Object.keys(plugin.rules).sort(),
          },
        ];
      }),
  );
}

export function formatResolvedConfig(
  base: ResolvedConfig,
  file: ResolvedFileConfig,
  baselinePath: string,
): string {
  return formatJson({
    projectRoot: base.projectRoot,
    ...(base.files ? { files: base.files } : {}),
    ...(base.ignores ? { ignores: base.ignores } : {}),
    plugins: plugins(base),
    filePath: file.filePath,
    matchingOverrides: file.matchingOverrides,
    matchingOverridePatterns: file.matchingOverrides.map((index) => ({
      index,
      files: base.overrides[index]!.files,
      ...(base.overrides[index]!.ignores
        ? { ignores: base.overrides[index]!.ignores }
        : {}),
    })),
    rules: file.rules,
    budgets: file.budgets,
    regression: file.regression,
    diagnostics: file.diagnostics,
    baselinePath,
  });
}
