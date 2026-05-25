import winston from 'winston';
import path from 'path';
import fs from 'fs';

const { NODE_ENV = 'development', LOG_LEVEL = 'debug', LOG_FILE = './logs/app.log' } = process.env;

// Check if running on Vercel's serverless platform
const isVercel = !!process.env.VERCEL;
const logDir = path.dirname(LOG_FILE);

// Only create a local logging directory if NOT on Vercel
if (!isVercel && !fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ level, message, timestamp, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] ${level}: ${message}${metaStr}`;
  })
);

const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.json()
);

// Base transports array - Console logging is safe and required everywhere
const transports: winston.transport[] = [
  new winston.transports.Console({
    format: consoleFormat,
    silent: NODE_ENV === 'test',
  }),
];

// Dynamically push file transports ONLY when running locally, avoiding Vercel's read-only crash
if (!isVercel) {
  transports.push(
    new winston.transports.File({
      filename: LOG_FILE,
      format: fileFormat,
      maxsize: 10 * 1024 * 1024, // 10 MB
      maxFiles: 5,
      tailable: true,
    }),
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error',
      format: fileFormat,
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
    })
  );
}

export const logger = winston.createLogger({
  level: LOG_LEVEL,
  transports: transports,
});