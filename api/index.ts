import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

import authController from '../src/controllers/authController';
import productController from '../src/controllers/productController';
import quotationController from '../src/controllers/quotationController';
import clientController from '../src/controllers/clientController';
import workspaceController from '../src/controllers/workspaceController';
import { errorHandler, notFoundHandler } from '../src/middleware/errorHandler';

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.use('/api/auth', authController);
app.use('/api/workspace', workspaceController);
app.use('/api/products', productController);
app.use('/api/clients', clientController);
app.use('/api/quotations', quotationController);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;