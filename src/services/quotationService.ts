import Decimal from 'decimal.js';
import { query, withTransaction, getClient } from '../config/database';
import { logger } from '../config/logger';
import {
  Quotation,
  QuotationLineItem,
  QuotationWithDetails,
  CreateQuotationDto,
  UpdateQuotationStatusDto,
  Client,
  Product,
  UserPublic,
  PaginatedResult,
  QuotationLineItemWithProduct,
} from '../types';
import {
  NotFoundError,
  ValidationError,
  ForbiddenError,
  StockAllocationError,
} from '../middleware/errorHandler';
import { PoolClient } from 'pg';

// ─────────────────────────────────────────────────────────────────────────────
// Decimal.js configuration: ROUND_HALF_UP, 4 decimal places during computation
// then round to 2 for storage
// ─────────────────────────────────────────────────────────────────────────────
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

function roundToTwo(d: Decimal): Decimal {
  return d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

// ─────────────────────────────────────────────────────────────────────────────
// Quotation Number Generator
// ─────────────────────────────────────────────────────────────────────────────
async function generateQuotationNumber(workspaceId: string, client: PoolClient): Promise<string> {
  const result = await client.query<{ count: string }>(
    'SELECT COUNT(*) AS count FROM quotations WHERE workspace_id = $1',
    [workspaceId]
  );
  const count = parseInt(result.rows[0].count, 10) + 1;
  const year = new Date().getFullYear();
  const padded = String(count).padStart(5, '0');
  return `QUO-${year}-${padded}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Create Quotation — with atomic stock reservation and decimal price calculation
// ─────────────────────────────────────────────────────────────────────────────

export async function createQuotation(
  workspaceId: string,
  userId: string,
  dto: CreateQuotationDto
): Promise<QuotationWithDetails> {
  if (!dto.line_items || dto.line_items.length === 0) {
    throw new ValidationError('A quotation must have at least one line item.');
  }

  return withTransaction(async (client: PoolClient) => {
    // ── 1. Verify client belongs to this workspace ──
    const clientResult = await client.query<Client>(
      'SELECT * FROM clients WHERE id = $1 AND workspace_id = $2 AND is_active = TRUE',
      [dto.client_id, workspaceId]
    );
    if (clientResult.rows.length === 0) {
      throw new NotFoundError('Client');
    }
    const clientRecord = clientResult.rows[0];

    // ── 2. For each line item, acquire row-level lock on the product ──
    //    This prevents double-allocation race conditions under concurrent load.
    const lockedProducts = new Map<string, Product>();
    for (const item of dto.line_items) {
      const productResult = await client.query<Product>(
        `SELECT * FROM products
         WHERE id = $1 AND workspace_id = $2 AND is_active = TRUE
         FOR UPDATE`,  // Exclusive row-level lock
        [item.product_id, workspaceId]
      );

      if (productResult.rows.length === 0) {
        throw new NotFoundError(`Product with id "${item.product_id}"`);
      }

      const product = productResult.rows[0];

      // ── 3. Stock gate: check availability before proceeding ──
      if (product.stock_quantity < item.quantity) {
        // Rollback is handled automatically by withTransaction on throw
        throw new StockAllocationError(product.name, item.quantity, product.stock_quantity);
      }

      lockedProducts.set(item.product_id, product);
    }

    // ── 4. Generate quotation number (within transaction for uniqueness) ──
    const quotationNumber = await generateQuotationNumber(workspaceId, client);

    // ── 5. Calculate line item totals using decimal.js for precision ──
    const computedLineItems: Array<{
      product_id: string;
      description: string;
      quantity: number;
      unit_price_at_creation: Decimal;
      discount_percent: Decimal;
      tax_rate: Decimal;
      line_subtotal: Decimal;
      line_discount_amount: Decimal;
      line_tax_amount: Decimal;
      line_total: Decimal;
      sort_order: number;
    }> = [];

    let totalSubtotal = new Decimal(0);
    let totalDiscount = new Decimal(0);
    let totalTax = new Decimal(0);
    let totalGrand = new Decimal(0);

    for (let i = 0; i < dto.line_items.length; i++) {
      const item = dto.line_items[i];
      const product = lockedProducts.get(item.product_id)!;

      // Historical price snapshot — locked at creation time
      const unitPrice = new Decimal(product.base_price);
      const qty = new Decimal(item.quantity);
      const discountPct = new Decimal(item.discount_percent ?? 0);
      const taxRate = new Decimal(product.tax_rate); // Use product's current tax rate

      // line_subtotal = qty * unit_price (before discount/tax)
      const lineSubtotal = roundToTwo(qty.mul(unitPrice));

      // line_discount_amount = line_subtotal * (discount_percent / 100)
      const lineDiscountAmount = roundToTwo(lineSubtotal.mul(discountPct.div(100)));

      // taxable_amount = line_subtotal - discount_amount
      const taxableAmount = lineSubtotal.minus(lineDiscountAmount);

      // line_tax_amount = taxable_amount * (tax_rate / 100)
      const lineTaxAmount = roundToTwo(taxableAmount.mul(taxRate.div(100)));

      // line_total = taxable_amount + tax_amount
      const lineTotal = roundToTwo(taxableAmount.plus(lineTaxAmount));

      computedLineItems.push({
        product_id: item.product_id,
        description: item.description?.trim() || product.name,
        quantity: item.quantity,
        unit_price_at_creation: unitPrice,
        discount_percent: discountPct,
        tax_rate: taxRate,
        line_subtotal: lineSubtotal,
        line_discount_amount: lineDiscountAmount,
        line_tax_amount: lineTaxAmount,
        line_total: lineTotal,
        sort_order: i,
      });

      totalSubtotal = totalSubtotal.plus(lineSubtotal);
      totalDiscount = totalDiscount.plus(lineDiscountAmount);
      totalTax = totalTax.plus(lineTaxAmount);
      totalGrand = totalGrand.plus(lineTotal);
    }

    // ── 6. Insert the master quotation record ──
    const quotationResult = await client.query<Quotation>(
      `INSERT INTO quotations
         (workspace_id, client_id, created_by, quotation_number, valid_until, notes,
          subtotal, total_discount, total_tax, grand_total)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        workspaceId,
        dto.client_id,
        userId,
        quotationNumber,
        dto.valid_until || null,
        dto.notes?.trim() || null,
        roundToTwo(totalSubtotal).toString(),
        roundToTwo(totalDiscount).toString(),
        roundToTwo(totalTax).toString(),
        roundToTwo(totalGrand).toString(),
      ]
    );
    const quotation = quotationResult.rows[0];

    // ── 7. Insert all line items ──
    const insertedLineItems: QuotationLineItem[] = [];
    for (const li of computedLineItems) {
      const liResult = await client.query<QuotationLineItem>(
        `INSERT INTO quotation_line_items
           (quotation_id, product_id, description, quantity,
            unit_price_at_creation, discount_percent, tax_rate,
            line_subtotal, line_discount_amount, line_tax_amount, line_total, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          quotation.id,
          li.product_id,
          li.description,
          li.quantity,
          li.unit_price_at_creation.toString(),
          li.discount_percent.toString(),
          li.tax_rate.toString(),
          li.line_subtotal.toString(),
          li.line_discount_amount.toString(),
          li.line_tax_amount.toString(),
          li.line_total.toString(),
          li.sort_order,
        ]
      );
      insertedLineItems.push(liResult.rows[0]);
    }

    // ── 8. Decrement stock quantities now that quote is confirmed ──
    for (const item of dto.line_items) {
      await client.query(
        `UPDATE products
         SET stock_quantity = stock_quantity - $1, updated_at = NOW()
         WHERE id = $2 AND workspace_id = $3`,
        [item.quantity, item.product_id, workspaceId]
      );
    }

    // ── 9. Fetch user for response assembly ──
    const userResult = await client.query<UserPublic>(
      `SELECT id, workspace_id, email, full_name, phone_number, phone_verified, role,
              is_active, last_login_at, created_at
       FROM users WHERE id = $1`,
      [userId]
    );

    // ── 10. Assemble full response with nested relations ──
    const lineItemsWithProducts: QuotationLineItemWithProduct[] = insertedLineItems.map((li) => ({
      ...li,
      product: lockedProducts.get(li.product_id)!,
    }));

    logger.info('Quotation created', {
      quotationId: quotation.id,
      workspaceId,
      userId,
      quotationNumber,
      grandTotal: roundToTwo(totalGrand).toString(),
    });

    return {
      ...quotation,
      client: clientRecord,
      line_items: lineItemsWithProducts,
      created_by_user: userResult.rows[0],
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Get Quotations (paginated)
// ─────────────────────────────────────────────────────────────────────────────

export async function getQuotations(
  workspaceId: string,
  page = 1,
  limit = 20,
  status?: string
): Promise<PaginatedResult<Quotation>> {
  const offset = (page - 1) * limit;
  const statusFilter = status ? 'AND status = $4' : '';
  const params: unknown[] = [workspaceId, limit, offset];
  if (status) params.push(status);

  const countResult = await query<{ total: string }>(
    `SELECT COUNT(*) AS total FROM quotations WHERE workspace_id = $1 ${statusFilter}`,
    status ? [workspaceId, status] : [workspaceId]
  );
  const total = parseInt(countResult.rows[0].total, 10);

  const dataResult = await query<Quotation>(
    `SELECT * FROM quotations
     WHERE workspace_id = $1 ${statusFilter}
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    params
  );

  return {
    data: dataResult.rows,
    total,
    page,
    limit,
    total_pages: Math.ceil(total / limit),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Get Quotation by ID with full details
// ─────────────────────────────────────────────────────────────────────────────

export async function getQuotationById(
  workspaceId: string,
  quotationId: string
): Promise<QuotationWithDetails> {
  const quotationResult = await query<Quotation>(
    'SELECT * FROM quotations WHERE id = $1 AND workspace_id = $2',
    [quotationId, workspaceId]
  );
  if (quotationResult.rows.length === 0) {
    throw new NotFoundError('Quotation');
  }
  const quotation = quotationResult.rows[0];

  const clientResult = await query<Client>(
    'SELECT * FROM clients WHERE id = $1',
    [quotation.client_id]
  );

  const lineItemsResult = await query<QuotationLineItem>(
    `SELECT * FROM quotation_line_items WHERE quotation_id = $1 ORDER BY sort_order ASC`,
    [quotationId]
  );

  const productIds = [...new Set(lineItemsResult.rows.map((li) => li.product_id))];
  const productsResult = productIds.length > 0
    ? await query<Product>(
        `SELECT * FROM products WHERE id = ANY($1::uuid[])`,
        [productIds]
      )
    : { rows: [] as Product[] };

  const productMap = new Map<string, Product>(
    productsResult.rows.map((p) => [p.id, p])
  );

  const userResult = await query<UserPublic>(
    `SELECT id, workspace_id, email, full_name, phone_number, phone_verified, role,
            is_active, last_login_at, created_at
     FROM users WHERE id = $1`,
    [quotation.created_by]
  );

  const lineItemsWithProducts: QuotationLineItemWithProduct[] = lineItemsResult.rows.map((li) => ({
    ...li,
    product: productMap.get(li.product_id) as Product,
  }));

  return {
    ...quotation,
    client: clientResult.rows[0],
    line_items: lineItemsWithProducts,
    created_by_user: userResult.rows[0],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Update Quotation Status
// ─────────────────────────────────────────────────────────────────────────────

export async function updateQuotationStatus(
  workspaceId: string,
  quotationId: string,
  dto: UpdateQuotationStatusDto
): Promise<Quotation> {
  const result = await query<Quotation>(
    `UPDATE quotations
     SET status = $1, updated_at = NOW()
     WHERE id = $2 AND workspace_id = $3
     RETURNING *`,
    [dto.status, quotationId, workspaceId]
  );
  if (result.rows.length === 0) {
    throw new NotFoundError('Quotation');
  }
  return result.rows[0];
}
