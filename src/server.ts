import 'dotenv/config';
import app from './app';
import { config } from './config/app';
import { testConnection } from './config/database';
import { runMigrations } from './migrations/runner';
import { logger } from './config/logger';

async function bootstrap(): Promise<void> {
  logger.info('Starting Quotation Engine...', { env: config.env, port: config.port });

  // 1. Verify database connection
  try {
    await testConnection();
  } catch (err) {
    logger.error('Database connection failed. Exiting.', { error: (err as Error).message });
    process.exit(1);
  }

  // 2. Run any pending migrations
  try {
    await runMigrations();
  } catch (err) {
    logger.error('Database migrations failed. Exiting.', { error: (err as Error).message });
    process.exit(1);
  }

  // 3. Start HTTP server
  const server = app.listen(config.port, () => {
    logger.info(`✅ Server running at http://localhost:${config.port}`, {
      environment: config.env,
    });
    logger.info('Available endpoints:', {
      health: `GET  /health`,
      auth: `POST /api/auth/register | /login | /google | /refresh | /logout`,
      workspace: `GET|PATCH /api/workspace`,
      products: `GET|POST|PATCH|DELETE /api/products  |  POST /api/products/bulk-import`,
      clients: `GET|POST|PATCH|DELETE /api/clients`,
      quotations: `GET|POST /api/quotations  |  PATCH /api/quotations/:id/status  |  GET /api/quotations/:id/pdf`,
    });
  });

  // ── Graceful shutdown ──
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}. Shutting down gracefully...`);
    server.close(async () => {
      logger.info('HTTP server closed.');
      const { pool } = await import('./config/database');
      await pool.end();
      logger.info('Database pool closed. Bye.');
      process.exit(0);
    });

    // Force exit after 15 seconds if graceful shutdown stalls
    setTimeout(() => {
      logger.error('Forced shutdown after timeout.');
      process.exit(1);
    }, 15000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('Unhandled Promise Rejection', { reason: String(reason) });
  });

  process.on('uncaughtException', (err: Error) => {
    logger.error('Uncaught Exception', { error: err.message, stack: err.stack });
    process.exit(1);
  });
}

bootstrap();
