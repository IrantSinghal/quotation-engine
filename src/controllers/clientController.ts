import { Router, Request, Response, NextFunction } from 'express';
import { body, param, query as queryValidator } from 'express-validator';
import { validate } from '../middleware/validate';
import { authenticateJWT, requireRole } from '../middleware/auth';
import {
  getClients,
  getClientById,
  createClient,
  updateClient,
  deleteClient,
} from '../services/clientService';

const router = Router();

router.use(authenticateJWT);

// GET /api/clients
router.get(
  '/',
  validate([
    queryValidator('page').optional().isInt({ min: 1 }).toInt(),
    queryValidator('limit').optional().isInt({ min: 1, max: 200 }).toInt(),
    queryValidator('active_only').optional().isBoolean(),
  ]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = Number(req.query.page) || 1;
      const limit = Number(req.query.limit) || 50;
      const activeOnly = req.query.active_only !== 'false';
      const result = await getClients(req.workspace_id!, page, limit, activeOnly);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/clients/:id
router.get(
  '/:id',
  validate([param('id').isUUID().withMessage('Client ID must be a valid UUID.')]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const client = await getClientById(req.workspace_id!, req.params.id);
      res.status(200).json({ success: true, data: client });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/clients
router.post(
  '/',
  validate([
    body('company_name').trim().isLength({ min: 1, max: 500 }).withMessage('company_name is required.'),
    body('contact_name').trim().isLength({ min: 1, max: 255 }).withMessage('contact_name is required.'),
    body('email').isEmail().normalizeEmail().withMessage('A valid email is required.'),
    body('phone').optional().isMobilePhone('any').withMessage('Invalid phone number.'),
    body('billing_address').optional().trim().isLength({ max: 1000 }),
    body('gst_number').optional().trim().isLength({ max: 50 }),
  ]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const client = await createClient(req.workspace_id!, req.body);
      res.status(201).json({ success: true, data: client, message: 'Client created successfully.' });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/clients/:id
router.patch(
  '/:id',
  validate([
    param('id').isUUID().withMessage('Client ID must be a valid UUID.'),
    body('company_name').optional().trim().isLength({ min: 1, max: 500 }),
    body('contact_name').optional().trim().isLength({ min: 1, max: 255 }),
    body('email').optional().isEmail().normalizeEmail(),
    body('phone').optional().isMobilePhone('any'),
    body('billing_address').optional().trim().isLength({ max: 1000 }),
    body('gst_number').optional().trim().isLength({ max: 50 }),
    body('is_active').optional().isBoolean(),
  ]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const client = await updateClient(req.workspace_id!, req.params.id, req.body);
      res.status(200).json({ success: true, data: client });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/clients/:id
router.delete(
  '/:id',
  requireRole('owner'),
  validate([param('id').isUUID().withMessage('Client ID must be a valid UUID.')]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await deleteClient(req.workspace_id!, req.params.id);
      res.status(200).json({ success: true, message: 'Client deleted successfully.' });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
