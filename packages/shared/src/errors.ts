/**
 * Typed application errors. `expose` controls whether the message is safe
 * to send to clients; stack traces are never sent.
 */
export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly expose: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    statusCode = 500,
    expose = false,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.statusCode = statusCode;
    this.expose = expose;
    this.details = details;
  }
}

export class AuthenticationError extends AppError {
  constructor(message = "Authentication required") {
    super("AUTHENTICATION_ERROR", message, 401, true);
  }
}

export class AuthorizationError extends AppError {
  constructor(message = "Not allowed") {
    super("AUTHORIZATION_ERROR", message, 403, true);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("VALIDATION_ERROR", message, 400, true, details);
  }
}

export class NotFoundError extends AppError {
  constructor(resource = "Resource") {
    super("NOT_FOUND", `${resource} not found`, 404, true);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super("CONFLICT", message, 409, true);
  }
}

export class RateLimitError extends AppError {
  constructor(message = "Too many requests") {
    super("RATE_LIMITED", message, 429, true);
  }
}

export class DerivConnectionError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("DERIV_CONNECTION_ERROR", message, 502, true, details);
  }
}

export class DerivAuthenticationError extends AppError {
  constructor(message = "Deriv token was rejected") {
    super("DERIV_AUTH_ERROR", message, 401, true);
  }
}

export class MarketDataStaleError extends AppError {
  constructor(message = "Market data is stale") {
    super("MARKET_DATA_STALE", message, 409, true);
  }
}

export class StrategyEvaluationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("STRATEGY_EVALUATION_ERROR", message, 500, false, details);
  }
}

export class RiskRejectedError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("RISK_REJECTED", message, 409, true, details);
  }
}

export class DatabaseError extends AppError {
  constructor(message: string) {
    super("DATABASE_ERROR", message, 500, false);
  }
}

export class JobCancelledError extends AppError {
  constructor(message = "Job was cancelled") {
    super("JOB_CANCELLED", message, 409, true);
  }
}
