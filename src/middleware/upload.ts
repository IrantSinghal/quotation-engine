import multer, { FileFilterCallback } from 'multer';
import path from 'path';
import fs from 'fs';
import { Request } from 'express';
import { config } from '../config/app';

const isVercel = !!process.env.VERCEL;

// Ensure upload directory exists ONLY when running locally
if (!isVercel && !fs.existsSync(config.upload.dir)) {
  fs.mkdirSync(config.upload.dir, { recursive: true });
}

const storage = multer.memoryStorage(); // Store files in memory as Buffer for direct processing

const fileFilter = (req: Request, file: Express.Multer.File, cb: FileFilterCallback): void => {
  const allowedMimeTypes = [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
    'application/vnd.ms-excel',                                            // .xls
    'text/csv',
    'application/csv',
    'text/plain', // Some CSV uploads come as text/plain
  ];

  const ext = path.extname(file.originalname).toLowerCase();
  const allowedExts = ['.xlsx', '.xls', '.csv'];

  if (allowedMimeTypes.includes(file.mimetype) || allowedExts.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error(`Invalid file type. Accepted formats: .xlsx, .xls, .csv. Received: ${file.originalname}`));
  }
};

export const uploadMiddleware = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: config.upload.maxFileSizeMb * 1024 * 1024,
    files: 1,
  },
});