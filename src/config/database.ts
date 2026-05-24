import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import dotenv from 'dotenv';
import { logger } from './logger';

dotenv.config();

const {
  DB_HOST = 'localhost',
  DB_PORT = '5432',
  DB_NAME = 'quotation_engine',
  DB_USER = 'postgres',
  DB_PASSWORD = '',
  DB_POOL_MIN = '2',
  DB_POOL_MAX = '10',
  DB_SSL = 'false',
} = process.env;

export const pool = new Pool({
  host: DB_HOST,
  port: parseInt(DB_PORT, 10),
  database: DB_NAME,
  user: DB_USER,
  password: DB_PASSWORD,
  min: parseInt(DB_POOL_MIN, 10),
  max: parseInt(DB_POOL_MAX, 10),
  ssl: DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('connect', () => {
  logger.debug('New database client connected');
});

pool.on('error', (err: Error) => {
  logger.error('Unexpected database pool error', { error: err.message });
});

/**
 * Execute a parameterized query using a pool connection.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  const start = Date.now();
  try {
    const result = await pool.query<T>(text, params);
    const duration = Date.now() - start;
    logger.debug('Query executed', { text, duration, rows: result.rowCount });
    return result;
  } catch (err) {
    logger.error('Query failed', { text, error: (err as Error).message });
    throw err;
  }
}

/**
 * Acquire a dedicated client for transaction management.
 * Caller is responsible for calling client.release() in a finally block.
 */
export async function getClient(): Promise<PoolClient> {
  const client = await pool.connect();
  return client;
}

/**
 * Execute a function within an atomic database transaction.
 * Automatically commits on success or rolls back on error.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Transaction rolled back', { error: (err as Error).message });
    throw err;
  } finally {
    client.release();
  }
}

export async function testConnection(): Promise<void> {
  const client = await getClient();
  try {
    await client.query('SELECT NOW()');
    logger.info('Database connection verified successfully');
  } finally {
    client.release();
  }
}
