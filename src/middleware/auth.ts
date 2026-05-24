import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/app';
import { AuthTokenPayload } from '../types';
import { logger } from '../config/logger';

export function authenticateJWT(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      success: false,
      error: 'Authorization header missing or malformed. Expected: Bearer <token>',
      code: 'UNAUTHORIZED',
    });
    return;
  }

  const token = authHeader.split(' ')[1];

  try {
    const payload = jwt.verify(token, config.jwt.secret) as AuthTokenPayload;
    req.user = payload;
    req.workspace_id = payload.workspace_id;
    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      res.status(401).json({
        success: false,
        error: 'Access token has expired. Please refresh your session.',
        code: 'TOKEN_EXPIRED',
      });
      return;
    }
    if (err instanceof jwt.JsonWebTokenError) {
      logger.warn('Invalid JWT token presented', { ip: req.ip });
      res.status(401).json({
        success: false,
        error: 'Invalid access token.',
        code: 'TOKEN_INVALID',
      });
      return;
    }
    next(err);
  }
}

/**
 * Require a minimum role level. Role hierarchy: owner > admin > member > viewer
 */
const ROLE_HIERARCHY: Record<string, number> = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ success: false, error: 'Unauthenticated', code: 'UNAUTHORIZED' });
      return;
    }

    const userLevel = ROLE_HIERARCHY[user.role] ?? -1;
    const hasPermission = roles.some((r) => {
      const requiredLevel = ROLE_HIERARCHY[r] ?? 999;
      return userLevel >= requiredLevel;
    });

    if (!hasPermission) {
      res.status(403).json({
        success: false,
        error: `Insufficient permissions. Required role: ${roles.join(' or ')}.`,
        code: 'FORBIDDEN',
      });
      return;
    }

    next();
  };
}
