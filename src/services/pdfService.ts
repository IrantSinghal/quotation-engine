import PDFDocument from 'pdfkit';
import { PassThrough } from 'stream';
import Decimal from 'decimal.js';
import { query } from '../config/database';
import { QuotationWithDetails, Workspace } from '../types';
import { getQuotationById } from './quotationService';
import { logger } from '../config/logger';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

// ─────────────────────────────────────────────────────────────────────────────
// Color Palette & Typography Constants
// ─────────────────────────────────────────────────────────────────────────────
const COLORS = {
  primary: '#1A365D',
  primaryLight: '#2B4C7E',
  accent: '#2D9CDB',
  headerBg: '#EBF4FB',
  rowAlt: '#F7FAFC',
  border: '#CBD5E0',
  text: '#2D3748',
  textLight: '#718096',
  white: '#FFFFFF',
  success: '#276749',
};

const FONT = {
  regular: 'Helvetica',
  bold: 'Helvetica-Bold',
  oblique: 'Helvetica-Oblique',
};

const PAGE = {
  width: 595.28, // A4
  height: 841.89,
  marginX: 48,
  marginTop: 48,
  marginBottom: 60,
};

const CONTENT_WIDTH = PAGE.width - PAGE.marginX * 2;

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Format currency
// ─────────────────────────────────────────────────────────────────────────────
const CURRENCY_SYMBOLS: Record<string, string> = {
  INR: 'Rs. ',
  USD: '$ ',
  EUR: 'EUR ',
  GBP: 'GBP ',
  AED: 'AED ',
  SGD: 'SGD ',
  AUD: 'AUD ',
  CAD: 'CAD ',
};
function formatIndianNumber(num: number): string {
  const fixed = num.toFixed(2);
  const [intPart, decPart] = fixed.split('.');
  if (intPart.length <= 3) return `${intPart}.${decPart}`;
  const lastThree = intPart.slice(-3);
  const remaining = intPart.slice(0, -3);
  const grouped = remaining.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${grouped},${lastThree}.${decPart}`;
}

function formatCurrency(amount: string | number, currencyCode: string): string {
  const num = new Decimal(String(amount)).toDecimalPlaces(2).toNumber();
  const symbol = CURRENCY_SYMBOLS[currencyCode] || `${currencyCode} `;
  const formatted = currencyCode === 'INR'
    ? formatIndianNumber(num)
    : num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${symbol}${formatted}`;
}

function formatDate(date: Date | string): string {
  const d = date instanceof Date ? date : new Date(date);
  const day = String(d.getDate()).padStart(2, '0');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${day} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// render watermark
// ─────────────────────────────────────────────────────────────────────────────
function drawWatermarkOnCurrentPage(doc: PDFKit.PDFDocument, companyName: string): void {
  const name = companyName.toUpperCase();
  const tileW = 180;
  const tileH = 100;
  const cols = Math.ceil(PAGE.width / tileW) + 2;
  const rows = Math.ceil(PAGE.height / tileH) + 2;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = (col - 0.5) * tileW;
      const y = (row - 0.5) * tileH;

      doc
        .save()
        .translate(x, y)
        .rotate(-35)
        .font(FONT.bold)
        .fontSize(13)
        .fillColor('#1A365D')
        .fillOpacity(0.09)
        .text(name, -90, 0, {
          width: 180,
          align: 'center',
          lineBreak: false,
        })
        .restore();
    }
  }

  // Reset graphics state
  doc.fillOpacity(1);
  doc.fillColor('#000000');
}

// ─────────────────────────────────────────────────────────────────────────────
// Main PDF Compilation Engine
// ─────────────────────────────────────────────────────────────────────────────

export async function compileQuotationPdf(
  workspaceId: string,
  quotationId: string
): Promise<Buffer> {
  const quotation = await getQuotationById(workspaceId, quotationId);

  const wsResult = await query<Workspace>(
    'SELECT * FROM workspaces WHERE id = $1',
    [workspaceId]
  );
  const workspace = wsResult.rows[0];
  console.log('Workspace T&C:', workspace.terms_and_conditions);

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: {
        top: PAGE.marginTop,
        bottom: PAGE.marginBottom,
        left: PAGE.marginX,
        right: PAGE.marginX,
      },
      info: {
        Title: `Quotation ${quotation.quotation_number}`,
        Author: workspace.name,
        Subject: `Quotation for ${quotation.client.company_name}`,
        Creator: 'Quotation Engine',
      },
      bufferPages: true,
      autoFirstPage: true,
    });

    // Draw watermark on the first page immediately when it opens
    doc.on('pageAdded', () => {
      drawWatermarkOnCurrentPage(doc, workspace.name);
    });

    // Also draw on the very first page since pageAdded doesn't fire for it
    drawWatermarkOnCurrentPage(doc, workspace.name);

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      renderHeader(doc, workspace, quotation);
      renderClientAndMetaSection(doc, workspace, quotation);
      renderLineItemsTable(doc, quotation, workspace.currency_code);
      renderTotalsSection(doc, quotation, workspace.currency_code);
      renderTermsSection(doc, workspace);
      renderFooter(doc, workspace);
    } catch (err) {
      reject(err);
      return;
    }

    doc.end();
    logger.info('PDF compiled', { quotationId, workspaceId });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Section: Header — Logo area + document title
// ─────────────────────────────────────────────────────────────────────────────
function renderHeader(doc: PDFKit.PDFDocument, workspace: Workspace, quotation: QuotationWithDetails): void {
  const topY = PAGE.marginTop;

  // Background banner
  doc
    .rect(0, 0, PAGE.width, 120)
    .fill(COLORS.primary);

  // Workspace name (top-left)
  doc
    .font(FONT.bold)
    .fontSize(22)
    .fillColor(COLORS.white)
    .text(workspace.name, PAGE.marginX, topY + 8, { width: 280 });

  // Business details under name
  if (workspace.business_address) {
    doc
      .font(FONT.regular)
      .fontSize(8)
      .fillColor('#B0C4DE')
      .text(workspace.business_address, PAGE.marginX, topY + 38, { width: 260 });
  }

  const contactParts: string[] = [];
  if (workspace.business_email) contactParts.push(workspace.business_email);
  if (workspace.business_phone) contactParts.push(workspace.business_phone);
  if (contactParts.length > 0) {
    doc
      .font(FONT.regular)
      .fontSize(8)
      .fillColor('#B0C4DE')
      .text(contactParts.join('  ·  '), PAGE.marginX, topY + 52, { width: 260 });
  }

  if (workspace.gst_number) {
    doc
      .font(FONT.regular)
      .fontSize(7.5)
      .fillColor('#90A4AE')
      .text(`GSTIN: ${workspace.gst_number}`, PAGE.marginX, topY + 64, { width: 200 });
  }

  // QUOTATION label (top-right)
  doc
    .font(FONT.bold)
    .fontSize(28)
    .fillColor(COLORS.accent)
    .text('QUOTATION', PAGE.marginX + 290, topY + 10, { width: 210, align: 'right' });

  doc
    .font(FONT.regular)
    .fontSize(10)
    .fillColor(COLORS.white)
    .text(quotation.quotation_number, PAGE.marginX + 290, topY + 50, { width: 210, align: 'right' });

  // Status badge
  const statusColors: Record<string, string> = {
    draft: '#718096',
    sent: COLORS.accent,
    accepted: COLORS.success,
    rejected: '#C53030',
    expired: '#975A16',
  };
  const statusColor = statusColors[quotation.status] || '#718096';

  doc
    .roundedRect(PAGE.width - PAGE.marginX - 80, topY + 66, 80, 20, 4)
    .fill(statusColor);

  doc
    .font(FONT.bold)
    .fontSize(8)
    .fillColor(COLORS.white)
    .text(quotation.status.toUpperCase(), PAGE.width - PAGE.marginX - 80, topY + 72, {
      width: 80,
      align: 'center',
    });

  doc.moveDown(0.5);
}

// ─────────────────────────────────────────────────────────────────────────────
// Section: Bill-To + Quote Metadata
// ─────────────────────────────────────────────────────────────────────────────
function renderClientAndMetaSection(
  doc: PDFKit.PDFDocument,
  workspace: Workspace,
  quotation: QuotationWithDetails
): void {
  const startY = 140;
  const colWidth = CONTENT_WIDTH / 2 - 10;

  // ── Left: Bill To ──
  doc
    .rect(PAGE.marginX, startY, colWidth, 100)
    .fill(COLORS.headerBg);

  doc
    .font(FONT.bold)
    .fontSize(8)
    .fillColor(COLORS.textLight)
    .text('BILL TO', PAGE.marginX + 10, startY + 10);

  doc
    .font(FONT.bold)
    .fontSize(12)
    .fillColor(COLORS.text)
    .text(quotation.client.company_name, PAGE.marginX + 10, startY + 24, { width: colWidth - 20 });

  doc
    .font(FONT.regular)
    .fontSize(9)
    .fillColor(COLORS.textLight)
    .text(quotation.client.contact_name, PAGE.marginX + 10, startY + 44, { width: colWidth - 20 });

  doc
    .text(quotation.client.email, PAGE.marginX + 10, startY + 57, { width: colWidth - 20 });

  if (quotation.client.billing_address) {
    doc
      .text(quotation.client.billing_address, PAGE.marginX + 10, startY + 70, {
        width: colWidth - 20,
        lineBreak: false,
      });
  }

  if (quotation.client.gst_number) {
    doc
      .font(FONT.oblique)
      .fontSize(8)
      .fillColor(COLORS.textLight)
      .text(`GSTIN: ${quotation.client.gst_number}`, PAGE.marginX + 10, startY + 83, {
        width: colWidth - 20,
      });
  }

  // ── Right: Quote Details ──
  const rightX = PAGE.marginX + colWidth + 20;
  doc
    .rect(rightX, startY, colWidth, 100)
    .fill(COLORS.headerBg);

  const metaRows: [string, string][] = [
    ['Quotation No.', quotation.quotation_number],
    ['Issue Date', formatDate(quotation.issue_date)],
    ['Valid Until', quotation.valid_until ? formatDate(quotation.valid_until) : 'No expiry'],
    ['Prepared By', quotation.created_by_user.full_name],
  ];

  let metaY = startY + 10;
  for (const [label, value] of metaRows) {
    doc
      .font(FONT.bold)
      .fontSize(8)
      .fillColor(COLORS.textLight)
      .text(label, rightX + 10, metaY);

    doc
      .font(FONT.regular)
      .fontSize(9)
      .fillColor(COLORS.text)
      .text(value, rightX + 110, metaY);

    metaY += 20;
  }

  doc.y = startY + 115;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section: Line Items Table
// ─────────────────────────────────────────────────────────────────────────────
function renderLineItemsTable(
  doc: PDFKit.PDFDocument,
  quotation: QuotationWithDetails,
  currencyCode: string
): void {
  const tableTop = doc.y + 10;

  // Column definitions: [label, x offset, width, align]
  const cols: Array<{ label: string; x: number; width: number; align: 'left' | 'right' | 'center' }> = [
    { label: '#', x: PAGE.marginX, width: 20, align: 'center' },
    { label: 'Description', x: PAGE.marginX + 20, width: 158, align: 'left' },
    { label: 'SKU', x: PAGE.marginX + 178, width: 62, align: 'left' },
    { label: 'Qty', x: PAGE.marginX + 240, width: 32, align: 'right' },
    { label: 'Unit Price', x: PAGE.marginX + 272, width: 78, align: 'right' },
    { label: 'Disc %', x: PAGE.marginX + 350, width: 38, align: 'right' },
    { label: 'Tax %', x: PAGE.marginX + 388, width: 36, align: 'right' },
    { label: 'Total', x: PAGE.marginX + 424, width: 75, align: 'right' },
  ];

  const headerH = 22;

  // ── Table Header ──
  doc.rect(PAGE.marginX, tableTop, CONTENT_WIDTH, headerH).fill(COLORS.primary);

  for (const col of cols) {
    doc
      .font(FONT.bold)
      .fontSize(8)
      .fillColor(COLORS.white)
      .text(col.label, col.x + 4, tableTop + 7, { width: col.width - 8, align: col.align });
  }

  // ── Table Rows ──
  let rowY = tableTop + headerH;

  for (let i = 0; i < quotation.line_items.length; i++) {
    const li = quotation.line_items[i];
    const rowH = 26;
    const isAlt = i % 2 === 1;

    // Row background
    doc.rect(PAGE.marginX, rowY, CONTENT_WIDTH, rowH).fill(isAlt ? COLORS.rowAlt : COLORS.white);

    // Row separator
    doc
      .moveTo(PAGE.marginX, rowY + rowH)
      .lineTo(PAGE.marginX + CONTENT_WIDTH, rowY + rowH)
      .strokeColor(COLORS.border)
      .lineWidth(0.5)
      .stroke();

    const textY = rowY + 8;

    // # number
    doc.font(FONT.regular).fontSize(8).fillColor(COLORS.textLight)
      .text(String(i + 1), PAGE.marginX + 2, textY, { width: 16, align: 'center' });

    // Description
    doc.font(FONT.bold).fontSize(8.5).fillColor(COLORS.text)
      .text(li.description, PAGE.marginX + 22, textY, { width: 152, align: 'left', lineBreak: false });

    // SKU
    doc.font(FONT.regular).fontSize(7.5).fillColor(COLORS.textLight)
      .text(li.product?.sku || '', PAGE.marginX + 180, textY, { width: 56, align: 'left' });

    // Qty
    doc.font(FONT.regular).fontSize(8.5).fillColor(COLORS.text)
      .text(String(li.quantity), PAGE.marginX + 242, textY, { width: 26, align: 'right' });

    // Unit Price
    doc.text(
      formatCurrency(li.unit_price_at_creation, currencyCode),
      PAGE.marginX + 274, textY,
      { width: 72, align: 'right' }
    );

    // Discount %
    doc.text(
      `${new Decimal(li.discount_percent).toFixed(1)}%`,
      PAGE.marginX + 352, textY,
      { width: 32, align: 'right' }
    );

    // Tax %
    doc.text(
      `${new Decimal(li.tax_rate).toFixed(1)}%`,
      PAGE.marginX + 390, textY,
      { width: 30, align: 'right' }
    );

    // Line Total
    doc.font(FONT.bold).fontSize(8.5).fillColor(COLORS.text)
      .text(formatCurrency(li.line_total, currencyCode), PAGE.marginX + 426, textY, {
        width: 69, align: 'right',
      });

    rowY += rowH;

    // Dynamic page break
    if (rowY > PAGE.height - PAGE.marginBottom - 160) {
      doc.addPage();
      rowY = PAGE.marginTop;
      // Repeat header on new page
      doc.rect(PAGE.marginX, rowY, CONTENT_WIDTH, headerH).fill(COLORS.primary);
      for (const col of cols) {
        doc.font(FONT.bold).fontSize(8).fillColor(COLORS.white)
          .text(col.label, col.x + 4, rowY + 7, { width: col.width - 8, align: col.align });
      }
      rowY += headerH;
    }
  }

  doc.y = rowY + 10;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section: Totals Summary
// ─────────────────────────────────────────────────────────────────────────────
function renderTotalsSection(
  doc: PDFKit.PDFDocument,
  quotation: QuotationWithDetails,
  currencyCode: string
): void {
  const boxWidth = 240;
  const boxX = PAGE.width - PAGE.marginX - boxWidth;
  const startY = doc.y;
  const lineH = 22;

  const totalsRows: Array<{ label: string; value: string; bold?: boolean; accent?: boolean }> = [
    { label: 'Subtotal', value: formatCurrency(quotation.subtotal, currencyCode) },
    { label: 'Total Discount', value: `- ${formatCurrency(quotation.total_discount, currencyCode)}` },
    { label: 'Total Tax (GST)', value: formatCurrency(quotation.total_tax, currencyCode) },
    {
      label: 'GRAND TOTAL',
      value: formatCurrency(quotation.grand_total, currencyCode),
      bold: true,
      accent: true,
    },
  ];

  let ty = startY;
  for (const row of totalsRows) {
    if (row.accent) {
      doc.rect(boxX, ty, boxWidth, lineH + 4).fill(COLORS.primary);
      doc
        .font(FONT.bold)
        .fontSize(11)
        .fillColor(COLORS.white)
        .text(row.label, boxX + 10, ty + 7, { width: 110 });
      doc
        .font(FONT.bold)
        .fontSize(12)
        .fillColor(COLORS.accent)
        .text(row.value, boxX + 10, ty + 6, { width: boxWidth - 20, align: 'right' });
      ty += lineH + 4;
    } else {
      doc
        .rect(boxX, ty, boxWidth, lineH)
        .fill(ty % (lineH * 2) < lineH ? COLORS.rowAlt : COLORS.white);

      doc
        .font(row.bold ? FONT.bold : FONT.regular)
        .fontSize(9)
        .fillColor(COLORS.textLight)
        .text(row.label, boxX + 10, ty + 6, { width: 110 });

      doc
        .font(row.bold ? FONT.bold : FONT.regular)
        .fontSize(9)
        .fillColor(COLORS.text)
        .text(row.value, boxX + 10, ty + 6, { width: boxWidth - 20, align: 'right' });

      ty += lineH;
    }
  }

  // Notes section (left of totals)
  if (quotation.notes) {
    const notesWidth = boxX - PAGE.marginX - 20;
    doc
      .font(FONT.bold)
      .fontSize(8.5)
      .fillColor(COLORS.textLight)
      .text('NOTES', PAGE.marginX, startY);

    doc
      .font(FONT.regular)
      .fontSize(9)
      .fillColor(COLORS.text)
      .text(quotation.notes, PAGE.marginX, startY + 14, {
        width: notesWidth,
        lineBreak: true,
      });
  }

  doc.y = ty + 20;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section: Terms and Conditions
// ─────────────────────────────────────────────────────────────────────────────
function renderTermsSection(doc: PDFKit.PDFDocument, workspace: Workspace): void {
  if (!workspace.terms_and_conditions) return;

  const startY = doc.y;

  // Check if there's enough space; add page if not
  if (startY > PAGE.height - PAGE.marginBottom - 120) {
    doc.addPage();
  }

  doc
    .moveTo(PAGE.marginX, doc.y)
    .lineTo(PAGE.marginX + CONTENT_WIDTH, doc.y)
    .strokeColor(COLORS.border)
    .lineWidth(1)
    .stroke();

  doc.moveDown(0.5);

  doc
    .font(FONT.bold)
    .fontSize(9)
    .fillColor(COLORS.textLight)
    .text('TERMS & CONDITIONS', PAGE.marginX, doc.y);

  doc
    .font(FONT.regular)
    .fontSize(8.5)
    .fillColor(COLORS.textLight)
    .text(workspace.terms_and_conditions, PAGE.marginX, doc.y + 12, {
      width: CONTENT_WIDTH,
      lineBreak: true,
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Section: Footer (page numbers)
// ─────────────────────────────────────────────────────────────────────────────
function renderFooter(doc: PDFKit.PDFDocument, workspace: Workspace): void {
  doc.flushPages();

  const range = doc.bufferedPageRange();
  const totalPages = range.count;

  for (let i = 0; i < totalPages; i++) {
    doc.switchToPage(range.start + i);



    // ── Footer divider ──
    const footerY = PAGE.height - PAGE.marginBottom + 10;
    doc
      .moveTo(PAGE.marginX, footerY)
      .lineTo(PAGE.marginX + CONTENT_WIDTH, footerY)
      .strokeColor(COLORS.border)
      .lineWidth(0.5)
      .stroke();

    // Left: workspace name
    doc
      .font(FONT.regular).fontSize(7.5).fillColor(COLORS.textLight)
      .text(workspace.name, PAGE.marginX, footerY + 8, { width: 180 });

    // Center: thank you
    doc
      .font(FONT.oblique).fontSize(7.5).fillColor(COLORS.textLight)
      .text('Thank you for your business.', PAGE.marginX + 160, footerY + 8, {
        width: 180, align: 'center',
      });

    // Right: page number
    doc
      .font(FONT.regular).fontSize(7.5).fillColor(COLORS.textLight)
      .text(
        `Page ${i + 1} of ${totalPages}`,
        PAGE.width - PAGE.marginX - 80, footerY + 8,
        { width: 80, align: 'right' }
      );
  }
}