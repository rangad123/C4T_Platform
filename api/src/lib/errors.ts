/**
 * Typed application errors. Every error that reaches the client goes through
 * one of these, so the response shape is always:
 *   { error: { code, message, details? }, requestId }
 */
export class AppError extends Error {
  public readonly statusCode: number
  public readonly code: string
  public readonly details?: unknown
  public readonly expose: boolean

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = new.target.name
    this.statusCode = statusCode
    this.code = code
    this.details = details
    this.expose = statusCode < 500
    Error.captureStackTrace?.(this, new.target)
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', details?: unknown) {
    super(400, 'BAD_REQUEST', message, details)
  }
}

export class ValidationError extends AppError {
  constructor(details: unknown, message = 'Validation failed') {
    super(422, 'VALIDATION_ERROR', message, details)
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(401, 'UNAUTHORIZED', message)
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have access to this resource') {
    super(403, 'FORBIDDEN', message)
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(404, 'NOT_FOUND', `${resource} not found`)
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource already exists', details?: unknown) {
    super(409, 'CONFLICT', message, details)
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = 'Too many requests') {
    super(429, 'TOO_MANY_REQUESTS', message)
  }
}

export class InternalError extends AppError {
  constructor(message = 'Something went wrong') {
    super(500, 'INTERNAL_ERROR', message)
  }
}

/**
 * A feature the code supports but this deployment has not configured — Google
 * sign-in without OAuth credentials, for instance.
 *
 * 503 rather than 404 or 501: the endpoint exists and will work once configured,
 * which is what a client needs to know. 404 would suggest the route was removed.
 */
export class ServiceUnavailableError extends AppError {
  constructor(message = 'This feature is not available') {
    super(503, 'SERVICE_UNAVAILABLE', message)
  }
}
