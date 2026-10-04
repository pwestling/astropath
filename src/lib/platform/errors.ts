import { AppError } from "../errors";

export type EffectState = "none" | "committed" | "partial" | "unknown";
export type RetryAdvice =
  "same_key" | "rediscover" | "after_approval" | "reconcile" | "do_not_retry";
export interface PlatformErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  effect_state: EffectState;
  retry_advice: RetryAdvice;
}
const STATUS: Record<string, number> = {
  UNAUTHENTICATED: 401,
  NOT_AVAILABLE: 404,
  FORBIDDEN: 403,
  CATALOG_EXPIRED: 410,
  OPERATION_RETIRED: 410,
  INVALID_ARGUMENTS: 400,
  INVALID_MANIFEST: 400,
  CURSOR_INVALID: 400,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  RELEASE_CONFLICT: 409,
  CATALOG_CONFLICT: 409,
  APPROVAL_REQUIRED: 403,
  RATE_LIMITED: 429,
  DEPENDENCY_UNAVAILABLE: 502,
  OUTCOME_UNKNOWN: 504,
  OUTPUT_VALIDATION_FAILED: 502,
  EXECUTION_LIMIT: 400,
};
export const httpStatusFor = (code: string) => STATUS[code] ?? 422;

// A platform error carries the spec's effect and retry guidance so a client
// knows whether anything happened and what to do next.
export class PlatformError extends AppError {
  constructor(
    code: string,
    message: string,
    public effectState: EffectState = "none",
    public retryAdvice: RetryAdvice = "do_not_retry",
    public details?: Record<string, unknown>,
  ) {
    super(httpStatusFor(code), code, message, {
      ...(details ? { details } : {}),
      effect_state: effectState,
      retry_advice: retryAdvice,
    });
  }
  body(): PlatformErrorBody {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
      effect_state: this.effectState,
      retry_advice: this.retryAdvice,
    };
  }
}
export function platformErrorBody(error: unknown): PlatformErrorBody {
  if (error instanceof PlatformError) return error.body();
  if (error instanceof AppError)
    return {
      code:
        error.status === 403
          ? "FORBIDDEN"
          : error.status === 404
            ? "NOT_AVAILABLE"
            : error.status === 429
              ? "RATE_LIMITED"
              : error.status === 401
                ? "UNAUTHENTICATED"
                : error.status < 500
                  ? "INVALID_ARGUMENTS"
                  : "DEPENDENCY_UNAVAILABLE",
      message: error.message,
      details: { reason: error.code },
      effect_state: "none",
      retry_advice: error.status === 429 ? "same_key" : "do_not_retry",
    };
  throw error;
}
