import { Router, Request, Response, NextFunction } from 'express';
import { body, param, query as queryValidator } from 'express-validator';
import { validate } from '../middleware/validate';
import { authenticateJWT, requireRole } from '../middleware/auth';
import {
  createQuotation,
  getQuotations,
  getQuotationById,
  updateQuotationStatus,
} from '../services/quotationService';
import { compileQuotationPdf } from '../services/pdfService';

const router = Router();

router.use(authenticateJWT);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/quotations
// List quotations (paginated, optional status filter)
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/',
  validate([
    queryValidator('page').optional().isInt({ min: 1 }).toInt(),
    queryValidator('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    queryValidator('status')
      .optional()
      .isIn(['draft', 'sent', 'accepted', 'rejected', 'expired'])
      .withMessage('status must be one of: draft, sent, accepted, rejected, expired.'),
  ]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = Number(req.query.page) || 1;
      const limit = Number(req.query.limit) || 20;
      const status = req.query.status as string | undefined;
      const result = await getQuotations(req.workspace_id!, page, limit, status);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/quotations/:id
// Get full quotation details with line items
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/:id',
  validate([param('id').isUUID().withMessage('Quotation ID must be a valid UUID.')]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const quotation = await getQuotationById(req.workspace_id!, req.params.id);
      res.status(200).json({ success: true, data: quotation });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/quotations
// Create a new quotation (with atomic stock reservation)
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/',
  validate([
    body('client_id').isUUID().withMessage('client_id must be a valid UUID.'),
    body('valid_until')
      .optional()
      .isISO8601()
      .withMessage('valid_until must be a valid ISO 8601 date (YYYY-MM-DD).')
      .toDate(),
    body('notes')
      .optional()
      .trim()
      .isLength({ max: 5000 })
      .withMessage('Notes must not exceed 5000 characters.'),
    body('line_items')
      .isArray({ min: 1 })
      .withMessage('line_items must be a non-empty array.'),
    body('line_items.*.product_id')
      .isUUID()
      .withMessage('Each line item product_id must be a valid UUID.'),
    body('line_items.*.quantity')
      .isInt({ min: 1 })
      .withMessage('Each line item quantity must be a positive integer.')
      .toInt(),
    body('line_items.*.discount_percent')
      .optional()
      .isFloat({ min: 0, max: 100 })
      .withMessage('discount_percent must be between 0 and 100.')
      .toFloat(),
    body('line_items.*.description')
      .optional()
      .trim()
      .isLength({ max: 500 })
      .withMessage('Line item description must not exceed 500 characters.'),
  ]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const quotation = await createQuotation(req.workspace_id!, req.user!.sub, req.body);
      res.status(201).json({
        success: true,
        data: quotation,
        message: `Quotation ${quotation.quotation_number} created successfully.`,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/quotations/:id/status
// Update quotation status
// ─────────────────────────────────────────────────────────────────────────────
router.patch(
  '/:id/status',
  validate([
    param('id').isUUID().withMessage('Quotation ID must be a valid UUID.'),
    body('status')
      .isIn(['draft', 'sent', 'accepted', 'rejected', 'expired'])
      .withMessage('status must be one of: draft, sent, accepted, rejected, expired.'),
  ]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const quotation = await updateQuotationStatus(req.workspace_id!, req.params.id, req.body);
      res.status(200).json({ success: true, data: quotation });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/quotations/:id/pdf
// Compile and stream a PDF of the quotation
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/:id/pdf',
  validate([param('id').isUUID().withMessage('Quotation ID must be a valid UUID.')]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const pdfBuffer = await compileQuotationPdf(req.workspace_id!, req.params.id);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="quotation-${req.params.id}.pdf"`
      );
      res.setHeader('Content-Length', pdfBuffer.length);
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.end(pdfBuffer);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
