// ─────────────────────────────────────────────────────────────────────────────
// Workspace Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  business_address: string | null;
  business_email: string | null;
  business_phone: string | null;
  gst_number: string | null;
  terms_and_conditions: string | null;
  currency_code: string;
  created_at: Date;
  updated_at: Date;
}

export interface CreateWorkspaceDto {
  name: string;
  slug: string;
  logo_url?: string;
  business_address?: string;
  business_email?: string;
  business_phone?: string;
  gst_number?: string;
  terms_and_conditions?: string;
  currency_code?: string;
}

export interface UpdateWorkspaceDto {
  name?: string;
  logo_url?: string;
  business_address?: string;
  business_email?: string;
  business_phone?: string;
  gst_number?: string;
  terms_and_conditions?: string;
  currency_code?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// User / Auth Types
// ─────────────────────────────────────────────────────────────────────────────

export type UserRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface User {
  id: string;
  workspace_id: string;
  email: string;
  password_hash: string | null;
  full_name: string;
  phone_number: string | null;
  phone_verified: boolean;
  google_provider_id: string | null;
  role: UserRole;
  is_active: boolean;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface UserPublic {
  id: string;
  workspace_id: string;
  email: string;
  full_name: string;
  phone_number: string | null;
  phone_verified: boolean;
  role: UserRole;
  is_active: boolean;
  last_login_at: Date | null;
  created_at: Date;
}

export interface RegisterDto {
  email: string;
  password: string;
  full_name: string;
  workspace_name: string;
  workspace_slug: string;
  phone_number?: string;
}

export interface LoginDto {
  email: string;
  password: string;
  workspace_slug: string;
}

export interface GoogleAuthDto {
  id_token: string;
  workspace_slug: string;
}

export interface AuthTokenPayload {
  sub: string;
  email: string;
  workspace_id: string;
  role: UserRole;
  iat?: number;
  exp?: number;
}

export interface AuthResult {
  access_token: string;
  refresh_token: string;
  user: UserPublic;
  workspace: Workspace;
}

// ─────────────────────────────────────────────────────────────────────────────
// Product Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Product {
  id: string;
  workspace_id: string;
  sku: string;
  name: string;
  description: string | null;
  base_price: string; // NUMERIC from PG comes as string
  tax_rate: string;   // e.g. "18.00" for 18% GST
  stock_quantity: number;
  unit: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface CreateProductDto {
  sku: string;
  name: string;
  description?: string;
  base_price: number;
  tax_rate?: number;
  stock_quantity?: number;
  unit?: string;
}

export interface UpdateProductDto {
  name?: string;
  description?: string;
  base_price?: number;
  tax_rate?: number;
  stock_quantity?: number;
  unit?: string;
  is_active?: boolean;
}

export interface BulkProductRow {
  sku: string;
  name: string;
  description?: string;
  base_price: number;
  tax_rate?: number;
  stock_quantity?: number;
  unit?: string;
}

export interface BulkIngestionResult {
  total_rows: number;
  inserted: number;
  updated: number;
  errors: BulkRowError[];
}

export interface BulkRowError {
  row_index: number;
  sku?: string;
  error: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Client Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Client {
  id: string;
  workspace_id: string;
  company_name: string;
  contact_name: string;
  email: string;
  phone: string | null;
  billing_address: string | null;
  gst_number: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface CreateClientDto {
  company_name: string;
  contact_name: string;
  email: string;
  phone?: string;
  billing_address?: string;
  gst_number?: string;
}

export interface UpdateClientDto {
  company_name?: string;
  contact_name?: string;
  email?: string;
  phone?: string;
  billing_address?: string;
  gst_number?: string;
  is_active?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Quotation Types
// ─────────────────────────────────────────────────────────────────────────────

export type QuotationStatus = 'draft' | 'sent' | 'accepted' | 'rejected' | 'expired';

export interface Quotation {
  id: string;
  workspace_id: string;
  client_id: string;
  created_by: string;
  quotation_number: string;
  status: QuotationStatus;
  issue_date: Date;
  valid_until: Date | null;
  notes: string | null;
  subtotal: string;       // NUMERIC(12,2)
  total_discount: string; // NUMERIC(12,2)
  total_tax: string;      // NUMERIC(12,2)
  grand_total: string;    // NUMERIC(12,2)
  created_at: Date;
  updated_at: Date;
}

export interface QuotationLineItem {
  id: string;
  quotation_id: string;
  product_id: string;
  description: string;
  quantity: number;
  unit_price_at_creation: string; // NUMERIC(12,2) — historical snapshot
  discount_percent: string;       // NUMERIC(5,2)
  tax_rate: string;               // NUMERIC(5,2)
  line_subtotal: string;          // NUMERIC(12,2)
  line_discount_amount: string;   // NUMERIC(12,2)
  line_tax_amount: string;        // NUMERIC(12,2)
  line_total: string;             // NUMERIC(12,2)
  sort_order: number;
  created_at: Date;
}

export interface CreateLineItemDto {
  product_id: string;
  quantity: number;
  discount_percent?: number;
  description?: string;
}

export interface CreateQuotationDto {
  client_id: string;
  valid_until?: string;
  notes?: string;
  line_items: CreateLineItemDto[];
}

export interface UpdateQuotationStatusDto {
  status: QuotationStatus;
}

export interface QuotationWithDetails extends Quotation {
  client: Client;
  line_items: QuotationLineItemWithProduct[];
  created_by_user: UserPublic;
}

export interface QuotationLineItemWithProduct extends QuotationLineItem {
  product: Product;
}

// ─────────────────────────────────────────────────────────────────────────────
// API Response Envelopes
// ─────────────────────────────────────────────────────────────────────────────

export interface ApiSuccess<T> {
  success: true;
  data: T;
  message?: string;
}

export interface ApiError {
  success: false;
  error: string;
  code?: string;
  details?: unknown;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  total_pages: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Request Extension
// ─────────────────────────────────────────────────────────────────────────────

declare global {
  namespace Express {
    interface Request {
      user?: AuthTokenPayload;
      workspace_id?: string;
    }
  }
}
