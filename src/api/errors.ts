import type { FastifyReply } from 'fastify';
import { ZodError, type ZodTypeAny, type z } from 'zod';

/** Error body every endpoint uses: { error: { code, message, details? } }. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new ApiError(404, 'not_found', `${what} not found`);
export const unauthorized = () => new ApiError(401, 'unauthorized', 'a valid API key is required');

export function parse<S extends ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  try {
    return schema.parse(value);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new ApiError(400, 'invalid_request', 'request validation failed', err.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })));
    }
    throw err;
  }
}

export function sendError(reply: FastifyReply, err: ApiError): FastifyReply {
  return reply.status(err.statusCode).send({
    error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
  });
}
