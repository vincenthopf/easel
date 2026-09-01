export class UserError extends Error {
  readonly exitCode: number;

  constructor(message: string, options: { cause?: unknown; exitCode?: number } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.exitCode = options.exitCode ?? 1;
  }
}

export function isUserError(error: unknown): error is UserError {
  return error instanceof UserError;
}
