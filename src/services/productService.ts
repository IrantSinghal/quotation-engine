import * as XLSX from 'xlsx';
import { query, withTransaction } from '../config/database';
import { logger } from '../config/logger';
import {
  Product,
  CreateProductDto,
  UpdateProductDto,
  BulkProductRow,
  BulkIngestionResult,
  BulkRowError,
  PaginatedResult,
} from '../types';
import { NotFoundError, ConflictError, ForbiddenError, ValidationError } from '../middleware/errorHandler';
import { PoolClient } from 'pg';

// ─────────────────────────────────────────────────────────────────────────────
// CRUD Operations
// ─────────────────────────────────────────────────────────────────────────────

export async function getProducts(
  workspaceId: string,
  page = 1,
  limit = 50,
  activeOnly = true
): Promise<PaginatedResult<Product>> {
  const offset = (page - 1) * limit;
  const activeFilter = activeOnly ? 'AND is_active = TRUE' : '';

  const countResult = await query<{ total: string }>(
    `SELECT COUNT(*) AS total FROM products WHERE workspace_id = $1 ${activeFilter}`,
    [workspaceId]
  );
  const total = parseInt(countResult.rows[0].total, 10);

  const dataResult = await query<Product>(
    `SELECT * FROM products
     WHERE workspace_id = $1 ${activeFilter}
     ORDER BY name ASC
     LIMIT $2 OFFSET $3`,
    [workspaceId, limit, offset]
  );

  return {
    data: dataResult.rows,
    total,
    page,
    limit,
    total_pages: Math.ceil(total / limit),
  };
}

export async function getProductById(workspaceId: string, productId: string): Promise<Product> {
  const result = await query<Product>(
    'SELECT * FROM products WHERE id = $1 AND workspace_id = $2',
    [productId, workspaceId]
  );
  if (result.rows.length === 0) {
    throw new NotFoundError('Product');
  }
  return result.rows[0];
}

export async function createProduct(workspaceId: string, dto: CreateProductDto): Promise<Product> {
  const result = await query<Product>(
    `INSERT INTO products (workspace_id, sku, name, description, base_price, tax_rate, stock_quantity, unit)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      workspaceId,
      dto.sku.trim().toUpperCase(),
      dto.name.trim(),
      dto.description?.trim() || null,
      dto.base_price,
      dto.tax_rate ?? 18.0,
      dto.stock_quantity ?? 0,
      dto.unit?.trim() || 'pcs',
    ]
  );
  return result.rows[0];
}

export async function updateProduct(
  workspaceId: string,
  productId: string,
  dto: UpdateProductDto
): Promise<Product> {
  const existing = await getProductById(workspaceId, productId);

  const result = await query<Product>(
    `UPDATE products
     SET name           = COALESCE($1, name),
         description    = COALESCE($2, description),
         base_price     = COALESCE($3, base_price),
         tax_rate       = COALESCE($4, tax_rate),
         stock_quantity = COALESCE($5, stock_quantity),
         unit           = COALESCE($6, unit),
         is_active      = COALESCE($7, is_active),
         updated_at     = NOW()
     WHERE id = $8 AND workspace_id = $9
     RETURNING *`,
    [
      dto.name?.trim() || null,
      dto.description?.trim() || null,
      dto.base_price ?? null,
      dto.tax_rate ?? null,
      dto.stock_quantity ?? null,
      dto.unit?.trim() || null,
      dto.is_active ?? null,
      productId,
      workspaceId,
    ]
  );
  return result.rows[0];
}

export async function deleteProduct(workspaceId: string, productId: string): Promise<void> {
  // Check if product is referenced by any quotation line items
  const usageCheck = await query(
    'SELECT COUNT(*) AS cnt FROM quotation_line_items WHERE product_id = $1',
    [productId]
  );
  const count = parseInt((usageCheck.rows[0] as { cnt: string }).cnt, 10);
  if (count > 0) {
    throw new ConflictError(
      'Cannot delete product: it is referenced by one or more quotation line items. Deactivate it instead.'
    );
  }

  const result = await query(
    'DELETE FROM products WHERE id = $1 AND workspace_id = $2',
    [productId, workspaceId]
  );
  if (result.rowCount === 0) {
    throw new NotFoundError('Product');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bulk Ingestion — Parse Excel/CSV buffer and upsert products
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Header normalization map. Maps arbitrary column header strings to
 * canonical field names used in the database.
 */
const HEADER_ALIASES: Record<string, keyof BulkProductRow> = {
  sku: 'sku',
  'product code': 'sku',
  'item code': 'sku',
  code: 'sku',
  name: 'name',
  'product name': 'name',
  'item name': 'name',
  title: 'name',
  description: 'description',
  desc: 'description',
  details: 'description',
  price: 'base_price',
  'base price': 'base_price',
  'unit price': 'base_price',
  'selling price': 'base_price',
  'tax rate': 'tax_rate',
  'gst rate': 'tax_rate',
  tax: 'tax_rate',
  gst: 'tax_rate',
  stock: 'stock_quantity',
  'stock quantity': 'stock_quantity',
  quantity: 'stock_quantity',
  qty: 'stock_quantity',
  unit: 'unit',
  uom: 'unit',
  'unit of measure': 'unit',
};

function normalizeHeader(raw: string): keyof BulkProductRow | null {
  const normalized = raw.toLowerCase().trim().replace(/[^a-z0-9 ]/g, '');
  return HEADER_ALIASES[normalized] ?? null;
}

function parseNumericCell(value: unknown, fieldName: string, rowIndex: number): { value: number | null; error: string | null } {
  if (value === undefined || value === null || value === '') {
    return { value: null, error: null };
  }
  const str = String(value).replace(/,/g, '').trim();
  const num = parseFloat(str);
  if (isNaN(num)) {
    return { value: null, error: `Row ${rowIndex}: "${fieldName}" value "${value}" is not a valid number.` };
  }
  if (num < 0) {
    return { value: null, error: `Row ${rowIndex}: "${fieldName}" must be a non-negative number.` };
  }
  return { value: num, error: null };
}

export async function bulkIngestProducts(
  workspaceId: string,
  fileBuffer: Buffer,
  originalFilename: string
): Promise<BulkIngestionResult> {
  const ext = originalFilename.split('.').pop()?.toLowerCase();

  let rows: Record<string, unknown>[];

  if (ext === 'csv') {
    // Parse CSV via XLSX (supports CSV parsing)
    const workbook = XLSX.read(fileBuffer, { type: 'buffer', raw: false });
    const sheetName = workbook.SheetNames[0];
    rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName], { defval: '' });
  } else if (ext === 'xlsx' || ext === 'xls') {
    const workbook = XLSX.read(fileBuffer, { type: 'buffer', raw: false });
    const sheetName = workbook.SheetNames[0];
    rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName], { defval: '' });
  } else {
    throw new ValidationError('Unsupported file format. Please upload an .xlsx, .xls, or .csv file.');
  }

  if (rows.length === 0) {
    throw new ValidationError('The uploaded file contains no data rows.');
  }

  // Build header mapping from first row's keys
  const sampleRow = rows[0];
  const headerMap = new Map<string, keyof BulkProductRow>();
  for (const rawKey of Object.keys(sampleRow)) {
    const canonical = normalizeHeader(rawKey);
    if (canonical) {
      headerMap.set(rawKey, canonical);
    }
  }

  // Validate required columns are present
  const canonicalFields = new Set(headerMap.values());
  if (!canonicalFields.has('sku')) {
    throw new ValidationError('Required column "sku" (or equivalent: "product code", "item code") not found in file headers.');
  }
  if (!canonicalFields.has('name')) {
    throw new ValidationError('Required column "name" (or equivalent: "product name", "item name") not found in file headers.');
  }
  if (!canonicalFields.has('base_price')) {
    throw new ValidationError('Required column "price" (or equivalent: "base price", "unit price") not found in file headers.');
  }

  const validRows: BulkProductRow[] = [];
  const errors: BulkRowError[] = [];

  for (let i = 0; i < rows.length; i++) {
    const rawRow = rows[i];
    const rowNum = i + 2; // +2 because row 1 is header, 0-indexed arrays
    const mapped: Partial<BulkProductRow> = {};

    // Map raw keys to canonical field names
    for (const [rawKey, canonicalKey] of headerMap.entries()) {
      mapped[canonicalKey] = rawRow[rawKey] as never;
    }

    // ── Validate SKU ──
    const sku = String(mapped.sku ?? '').trim().toUpperCase();
    if (!sku) {
      errors.push({ row_index: rowNum, error: `Row ${rowNum}: SKU is required and cannot be empty.` });
      continue;
    }

    // ── Validate Name ──
    const name = String(mapped.name ?? '').trim();
    if (!name || name.length < 2) {
      errors.push({ row_index: rowNum, sku, error: `Row ${rowNum}: Product name is required (min 2 characters).` });
      continue;
    }

    // ── Validate base_price ──
    const priceResult = parseNumericCell(mapped.base_price, 'base_price', rowNum);
    if (priceResult.error) {
      errors.push({ row_index: rowNum, sku, error: priceResult.error });
      continue;
    }
    if (priceResult.value === null) {
      errors.push({ row_index: rowNum, sku, error: `Row ${rowNum}: base_price is required.` });
      continue;
    }

    // ── Validate tax_rate (optional, defaults to 18) ──
    const taxResult = parseNumericCell(mapped.tax_rate, 'tax_rate', rowNum);
    if (taxResult.error) {
      errors.push({ row_index: rowNum, sku, error: taxResult.error });
      continue;
    }
    if (taxResult.value !== null && taxResult.value > 100) {
      errors.push({ row_index: rowNum, sku, error: `Row ${rowNum}: tax_rate cannot exceed 100%.` });
      continue;
    }

    // ── Validate stock_quantity (optional, defaults to 0) ──
    const stockResult = parseNumericCell(mapped.stock_quantity, 'stock_quantity', rowNum);
    if (stockResult.error) {
      errors.push({ row_index: rowNum, sku, error: stockResult.error });
      continue;
    }

    validRows.push({
      sku,
      name,
      description: String(mapped.description ?? '').trim() || undefined,
      base_price: priceResult.value,
      tax_rate: taxResult.value ?? undefined,
      stock_quantity: stockResult.value !== null ? Math.round(stockResult.value) : undefined,
      unit: String(mapped.unit ?? '').trim() || undefined,
    });
  }

  if (validRows.length === 0) {
    return {
      total_rows: rows.length,
      inserted: 0,
      updated: 0,
      errors,
    };
  }

  // Atomic bulk upsert using a single transaction
  let inserted = 0;
  let updated = 0;

  await withTransaction(async (client: PoolClient) => {
    for (const row of validRows) {
      const result = await client.query<{ operation: string }>(
        `INSERT INTO products (workspace_id, sku, name, description, base_price, tax_rate, stock_quantity, unit)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (workspace_id, sku)
         DO UPDATE SET
           name           = EXCLUDED.name,
           description    = COALESCE(EXCLUDED.description, products.description),
           base_price     = EXCLUDED.base_price,
           tax_rate       = COALESCE(EXCLUDED.tax_rate, products.tax_rate),
           stock_quantity = COALESCE(EXCLUDED.stock_quantity, products.stock_quantity),
           unit           = COALESCE(EXCLUDED.unit, products.unit),
           updated_at     = NOW()
         RETURNING (xmax = 0) AS is_insert`,
        [
          workspaceId,
          row.sku,
          row.name,
          row.description || null,
          row.base_price,
          row.tax_rate ?? 18.0,
          row.stock_quantity ?? 0,
          row.unit || 'pcs',
        ]
      );

      const isInsert = (result.rows[0] as unknown as { is_insert: boolean }).is_insert;
      if (isInsert) {
        inserted++;
      } else {
        updated++;
      }
    }
  });

  logger.info('Bulk product ingestion complete', {
    workspaceId,
    total: rows.length,
    inserted,
    updated,
    errors: errors.length,
  });

  return {
    total_rows: rows.length,
    inserted,
    updated,
    errors,
  };
}
