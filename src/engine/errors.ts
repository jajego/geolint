export class GeoLintError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class GeoLintConfigError extends GeoLintError {}
export class GeoLintTargetError extends GeoLintError {}
