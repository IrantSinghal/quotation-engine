import fs from 'fs';
import path from 'path';
import { getClient } from '../config/database';
import { logger } from '../config/logger';

async function runMigrations(): Promise<void> {
  const client = await getClient();
  try {
    // Ensure the migrations tracking table exists first
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     VARCHAR(50) PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const migrationsDir = path.join(__dirname);
    const sqlFiles = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort(); // lexicographic sort ensures numerical order (001_, 002_, ...)

    for (const file of sqlFiles) {
      const version = path.basename(file, '.sql');

      // Check if already applied
      const { rows } = await client.query(
        'SELECT version FROM schema_migrations WHERE version = $1',
        [version]
      );

      if (rows.length > 0) {
        logger.info(`Migration already applied, skipping: ${version}`);
        continue;
      }

      logger.info(`Applying migration: ${version}`);
      const sqlContent = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');

      await client.query('BEGIN');
      try {
        await client.query(sqlContent);
        await client.query(
          'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
          [version]
        );
        await client.query('COMMIT');
        logger.info(`Migration applied successfully: ${version}`);
      } catch (err) {
        await client.query('ROLLBACK');
        logger.error(`Migration failed: ${version}`, { error: (err as Error).message });
        throw err;
      }
    }

    logger.info('All migrations completed successfully');
  } finally {
    client.release();
  }
}

// Allow this to be run directly
if (require.main === module) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('Migration runner failed', { error: err.message });
      process.exit(1);
    });
}

export { runMigrations };
