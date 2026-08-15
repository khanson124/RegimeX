import { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { AppError } from "@regimex/shared";

/**
 * Central error handler. Typed AppErrors with `expose` return their message;
 * everything else becomes an opaque 500 — stack traces never reach clients.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid request payload",
          details: error.issues.map((i) => ({ path: i.path.join("."), message: i.message }))
        }
      });
    }

    if (error instanceof AppError) {
      request.log.warn(
        { code: error.code, statusCode: error.statusCode, requestId: request.id },
        error.message
      );
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.expose ? error.message : "Internal server error",
          details: error.expose ? error.details : undefined
        }
      });
    }

    // Fastify rate-limit and similar plugins attach statusCode.
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 429) {
      return reply.status(429).send({
        error: { code: "RATE_LIMITED", message: "Too many requests" }
      });
    }

    request.log.error({ err: error, requestId: request.id }, "Unhandled error");
    return reply.status(500).send({
      error: { code: "INTERNAL_ERROR", message: "Internal server error" }
    });
  });
}
