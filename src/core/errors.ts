/**
 * Domain errors. The core never throws HTTP errors (it must not know about HTTP); the API layer maps
 * these to status codes in exactly one place (api/middleware.ts).
 */
export abstract class DomainError extends Error {
  constructor(
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends DomainError {}
export class UnauthorizedError extends DomainError {}
export class NotFoundError extends DomainError {}
export class ConflictError extends DomainError {}
export class RateLimitedError extends DomainError {
  constructor(
    message: string,
    public readonly retryAfterSec: number,
  ) {
    super(message);
  }
}
/** A unique index rejected an insert; repositories raise it so services never see driver error codes. */
export class DuplicateKeyError extends DomainError {}
