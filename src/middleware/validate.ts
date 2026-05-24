import { Request, Response, NextFunction } from 'express';
import { validationResult, ValidationChain } from 'express-validator';

/**
 * Runs an array of validation chains then checks for errors.
 * Returns 422 with structured field errors if any validation fails.
 */
export function validate(chains: ValidationChain[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Run all validation chains in parallel
    await Promise.all(chains.map((chain) => chain.run(req)));

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(422).json({
        success: false,
        error: 'Validation failed',
        code: 'VALIDATION_ERROR',
        details: errors.array().map((e) => ({
          field: e.type === 'field' ? (e as { path: string }).path : 'unknown',
          message: e.msg,
        })),
      });
      return;
    }

    next();
  };
}
