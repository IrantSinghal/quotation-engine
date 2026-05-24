import { Router, Request, Response, NextFunction } from 'express';
import { body } from 'express-validator';
import { validate } from '../middleware/validate';
import { authenticateJWT } from '../middleware/auth';
import {
  registerWithEmail,
  loginWithEmail,
  loginWithGoogle,
  refreshAccessToken,
  logoutUser,
} from '../services/authService';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/register
// Register a new workspace + owner user via email/password
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/register',
  validate([
    body('email').isEmail().normalizeEmail().withMessage('A valid email address is required.'),
    body('password')
      .isLength({ min: 8 })
      .withMessage('Password must be at least 8 characters.')
      .matches(/[A-Z]/)
      .withMessage('Password must contain at least one uppercase letter.')
      .matches(/[0-9]/)
      .withMessage('Password must contain at least one number.'),
    body('full_name')
      .trim()
      .isLength({ min: 2, max: 255 })
      .withMessage('Full name must be between 2 and 255 characters.'),
    body('workspace_name')
      .trim()
      .isLength({ min: 2, max: 255 })
      .withMessage('Workspace name must be between 2 and 255 characters.'),
    body('workspace_slug')
      .trim()
      .toLowerCase()
      .matches(/^[a-z0-9-]+$/)
      .withMessage('Workspace slug may only contain lowercase letters, numbers, and hyphens.')
      .isLength({ min: 2, max: 100 })
      .withMessage('Workspace slug must be between 2 and 100 characters.'),
    body('phone_number')
      .optional()
      .isMobilePhone('any')
      .withMessage('Invalid phone number format.'),
  ]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await registerWithEmail(req.body);
      res.status(201).json({ success: true, data: result, message: 'Workspace and account created successfully.' });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/login
// Login with email and password
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/login',
  validate([
    body('email').isEmail().normalizeEmail().withMessage('A valid email address is required.'),
    body('password').notEmpty().withMessage('Password is required.'),
    body('workspace_slug').trim().notEmpty().withMessage('Workspace slug is required.'),
  ]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await loginWithEmail(req.body);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/google
// Login or register via Google ID token (with identity merging)
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/google',
  validate([
    body('id_token').notEmpty().withMessage('Google ID token is required.'),
    body('workspace_slug').trim().notEmpty().withMessage('Workspace slug is required.'),
  ]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await loginWithGoogle(req.body);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/refresh
// Rotate refresh token and return new access + refresh tokens
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/refresh',
  validate([
    body('refresh_token').notEmpty().withMessage('Refresh token is required.'),
  ]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { refresh_token } = req.body as { refresh_token: string };
      const tokens = await refreshAccessToken(refresh_token);
      res.status(200).json({ success: true, data: tokens });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/logout
// Revoke all refresh tokens for the authenticated user
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/logout',
  authenticateJWT,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await logoutUser(req.user!.sub);
      res.status(200).json({ success: true, message: 'Logged out successfully.' });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/me
// Return current authenticated user info
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/me',
  authenticateJWT,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(200).json({
        success: true,
        data: {
          user_id: req.user!.sub,
          email: req.user!.email,
          workspace_id: req.user!.workspace_id,
          role: req.user!.role,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
