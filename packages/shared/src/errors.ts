/**
 * Error de negocio con código HTTP y código estable (lo usa el orquestador
 * SAGA para decidir si reintenta o compensa).
 */
export class DomainError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const badRequest = (code: string, message: string, details?: Record<string, unknown>) =>
  new DomainError(400, code, message, details);
export const notFound = (code: string, message: string, details?: Record<string, unknown>) =>
  new DomainError(404, code, message, details);
export const conflict = (code: string, message: string, details?: Record<string, unknown>) =>
  new DomainError(409, code, message, details);
