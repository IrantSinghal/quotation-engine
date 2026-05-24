import { Router, Request, Response, NextFunction } from 'express';
import { body } from 'express-validator';
import { validate } from '../middleware/validate';
import { authenticateJWT, requireRole } from '../middleware/auth';
import { getWorkspaceById, updateWorkspace } from '../services/workspaceService';

const router = Router();

router.use(authenticateJWT);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/workspace
// Get the current workspace's details
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspace = await getWorkspaceById(req.workspace_id!);
      res.status(200).json({ success: true, data: workspace });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/workspace
// Update workspace settings (owner only)
// ─────────────────────────────────────────────────────────────────────────────
router.patch(
  '/',
  requireRole('owner'),
  validate([
    body('name').optional().trim().isLength({ min: 2, max: 255 }).withMessage('Name must be 2–255 characters.'),
    body('logo_url').optional().trim().isURL().withMessage('logo_url must be a valid URL.'),
    body('business_address').optional().trim().isLength({ max: 1000 }),
    body('business_email').optional().isEmail().normalizeEmail().withMessage('business_email must be a valid email.'),
    body('business_phone').optional().trim().isLength({ max: 50 }),
    body('gst_number').optional().trim().isLength({ max: 50 }),
    body('terms_and_conditions').optional().trim().isLength({ max: 10000 }),
    body('currency_code')
      .optional()
      .trim()
      .isLength({ min: 3, max: 3 })
      .isAlpha()
      .withMessage('currency_code must be a 3-letter ISO 4217 code (e.g. INR, USD).'),
  ]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspace = await updateWorkspace(req.workspace_id!, req.body);
      res.status(200).json({ success: true, data: workspace, message: 'Workspace updated successfully.' });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
