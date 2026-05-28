import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

const app = express();

// ── BODY PARSING MUST BE FIRST — before anything else ──
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Handle preflight requests
app.options('*', cors());

app.get('/health', (_req: express.Request, res: express.Response) => {
    res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Debug middleware — log incoming body to confirm parsing works
app.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
    console.log('Incoming request body:', JSON.stringify(req.body));
    next();
});

import authController from '../src/controllers/authController';
import productController from '../src/controllers/productController';
import quotationController from '../src/controllers/quotationController';
import clientController from '../src/controllers/clientController';
import workspaceController from '../src/controllers/workspaceController';
import { errorHandler, notFoundHandler } from '../src/middleware/errorHandler';

app.use('/api/auth', authController);
app.use('/api/workspace', workspaceController);
app.use('/api/products', productController);
app.use('/api/clients', clientController);
app.use('/api/quotations', quotationController);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;