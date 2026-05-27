import { Router, Request, Response, NextFunction } from 'express';
import { body, param, query as queryValidator } from 'express-validator';
import { validate } from '../middleware/validate';
import { authenticateJWT, requireRole } from '../middleware/auth';
import { uploadMiddleware } from '../middleware/upload';
import {
  getProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
  bulkIngestProducts,
} from '../services/productService';

const router = Router();

// All product routes require authentication
router.use(authenticateJWT);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/products
// List all products in the workspace (paginated)
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/',
  validate([
    queryValidator('page').optional().isInt({ min: 1 }).toInt().withMessage('page must be a positive integer.'),
    queryValidator('limit').optional().isInt({ min: 1, max: 200 }).toInt().withMessage('limit must be between 1 and 200.'),
    queryValidator('active_only').optional().isBoolean().withMessage('active_only must be true or false.'),
  ]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = Number(req.query.page) || 1;
      const limit = Number(req.query.limit) || 50;
      const activeOnly = req.query.active_only !== 'false';
      const result = await getProducts(req.workspace_id!, page, limit, activeOnly);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/products/:id
// Get a single product by ID
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/:id',
  validate([param('id').isUUID().withMessage('Product ID must be a valid UUID.')]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const product = await getProductById(req.workspace_id!, req.params.id);
      res.status(200).json({ success: true, data: product });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/products
// Create a single product
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/',
  requireRole('admin', 'owner'),
  validate([
    body('sku').trim().notEmpty().withMessage('SKU is required.').isLength({ max: 100 }).withMessage('SKU must not exceed 100 characters.'),
    body('name').trim().isLength({ min: 2, max: 500 }).withMessage('Name must be between 2 and 500 characters.'),
    body('description').optional().trim().isLength({ max: 5000 }).withMessage('Description must not exceed 5000 characters.'),
    body('base_price').isFloat({ min: 0 }).withMessage('base_price must be a non-negative number.').toFloat(),
    body('tax_rate').optional().isFloat({ min: 0, max: 100 }).withMessage('tax_rate must be between 0 and 100.').toFloat(),
    body('stock_quantity').optional().isInt({ min: 0 }).withMessage('stock_quantity must be a non-negative integer.').toInt(),
    body('unit').optional().trim().isLength({ max: 50 }).withMessage('unit must not exceed 50 characters.'),
  ]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const product = await createProduct(req.workspace_id!, req.body);
      res.status(201).json({ success: true, data: product, message: 'Product created successfully.' });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/products/:id
// Update a product
// ─────────────────────────────────────────────────────────────────────────────
router.patch(
  '/:id',
  requireRole('admin', 'owner'),
  validate([
    param('id').isUUID().withMessage('Product ID must be a valid UUID.'),
    body('name').optional().trim().isLength({ min: 2, max: 500 }).withMessage('Name must be between 2 and 500 characters.'),
    body('description').optional().trim().isLength({ max: 5000 }),
    body('base_price').optional().isFloat({ min: 0 }).withMessage('base_price must be non-negative.').toFloat(),
    body('tax_rate').optional().isFloat({ min: 0, max: 100 }).withMessage('tax_rate must be 0–100.').toFloat(),
    body('stock_quantity').optional().isInt({ min: 0 }).withMessage('stock_quantity must be non-negative.').toInt(),
    body('unit').optional().trim().isLength({ max: 50 }),
    body('is_active').optional().isBoolean().withMessage('is_active must be a boolean.'),
  ]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const product = await updateProduct(req.workspace_id!, req.params.id, req.body);
      res.status(200).json({ success: true, data: product });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/products/:id
// Delete a product (only if not referenced by any quotation)
// ─────────────────────────────────────────────────────────────────────────────
router.delete(
  '/:id',
  requireRole('owner'),
  validate([param('id').isUUID().withMessage('Product ID must be a valid UUID.')]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await deleteProduct(req.workspace_id!, req.params.id);
      res.status(200).json({ success: true, message: 'Product deleted successfully.' });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/products/bulk-import
// Upload and parse an Excel/CSV file to bulk upsert products
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/bulk-import',
  //requireRole('admin', 'owner'),
  uploadMiddleware.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        res.status(422).json({
          success: false,
          error: 'No file uploaded. Please attach a file under the "file" field.',
          code: 'MISSING_FILE',
        });
        return;
      }
      

      const result = await bulkIngestProducts(
        req.workspace_id!,
        req.file.buffer,
        req.file.originalname
      );

      const statusCode = result.errors.length > 0 && result.inserted === 0 && result.updated === 0
        ? 422
        : 200;

      res.status(statusCode).json({
        success: statusCode === 200,
        data: result,
        message: `Import complete. Inserted: ${result.inserted}, Updated: ${result.updated}, Errors: ${result.errors.length}`,
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
