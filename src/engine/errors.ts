export class GeoLintError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

export class GeoLintConfigError extends GeoLintError {}
export class GeoLintCapabilityError extends GeoLintError {}
export class GeoLintInputError extends GeoLintError {}
export class GeoLintTargetError extends GeoLintError {}
export class GeoLintIOError extends GeoLintError {}
export class GeoLintPluginError extends GeoLintError {}
export class GeoLintBatchError extends GeoLintError {}
export class GeoLintInternalError extends GeoLintError {}
