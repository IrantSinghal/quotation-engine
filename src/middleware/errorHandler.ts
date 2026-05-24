import { Request, Response, NextFunction } from 'express';
import { logger } from '../config/logger';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly isOperational: boolean;

  constructor(message: string, statusCode: number, code?: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code || 'INTERNAL_ERROR';
    this.isOperational = true;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 404, 'NOT_FOUND');
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 422, 'VALIDATION_ERROR');
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, 'CONFLICT');
  }
}

export class StockAllocationError extends AppError {
  constructor(productName: string, requested: number, available: number) {
    super(
      `Insufficient stock for "${productName}". Requested: ${requested}, Available: ${available}.`,
      422,
      'STOCK_ALLOCATION_FAILED'
    );
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Access denied') {
    super(message, 403, 'FORBIDDEN');
  }
}

// Central error handling middleware — must have 4 parameters for Express to treat as error handler
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: Error, req: Request, res: Response, next: NextFunction): void {
  if (err instanceof AppError) {
    logger.warn('Operational error', {
      statusCode: err.statusCode,
      code: err.code,
      message: err.message,
      path: req.path,
      method: req.method,
    });
    res.status(err.statusCode).json({
      success: false,
      error: err.message,
      code: err.code,
    });
    return;
  }

  // PostgreSQL unique constraint violation
  const pgError = err as { code?: string; detail?: string; constraint?: string };
  if (pgError.code === '23505') {
    const detail = pgError.detail || 'A record with these values already exists.';
    res.status(409).json({
      success: false,
      error: detail,
      code: 'DUPLICATE_ENTRY',
    });
    return;
  }

  // PostgreSQL foreign key violation
  if (pgError.code === '23503') {
    res.status(422).json({
      success: false,
      error: 'Referenced record does not exist.',
      code: 'FOREIGN_KEY_VIOLATION',
    });
    return;
  }

  // Unhandled / unexpected errors
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  res.status(500).json({
    success: false,
    error: 'An internal server error occurred. Please try again later.',
    code: 'INTERNAL_SERVER_ERROR',
  });
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    error: `Route ${req.method} ${req.path} not found.`,
    code: 'ROUTE_NOT_FOUND',
  });
}
