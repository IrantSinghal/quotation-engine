# Quotation Engine — Phase 1

A production-ready, multi-tenant, workspace-based quotation engine built with **Node.js + TypeScript**, **PostgreSQL**, and **PDFKit**.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Tech Stack](#tech-stack)
3. [Project Structure](#project-structure)
4. [Prerequisites](#prerequisites)
5. [Getting Started](#getting-started)
6. [Environment Variables](#environment-variables)
7. [Database Schema](#database-schema)
8. [API Reference](#api-reference)
9. [Key Design Decisions](#key-design-decisions)
10. [Security](#security)

---

## Architecture Overview

```
Client App
    │
    ▼
Express HTTP Server (port 3000)
    │
    ├── /api/auth          → JWT + Google OAuth + Identity Merging
    ├── /api/workspace     → Tenant settings
    ├── /api/products      → CRUD + Excel/CSV bulk import
    ├── /api/clients       → Customer management
    └── /api/quotations    → Quote creation + PDF download
              │
              ▼
    PostgreSQL (multi-tenant via workspace_id scoping)
```

**Multi-tenancy** is enforced at the application layer: every database query is scoped by `workspace_id`, which is extracted directly from the verified JWT payload — never from user-supplied request data.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 18+ / TypeScript 5 |
| Framework | Express 4 |
| Database | PostgreSQL 14+ |
| DB Driver | `pg` (node-postgres) with connection pooling |
| Auth | JWT (jsonwebtoken) + Google OAuth (google-auth-library) |
| PDF | PDFKit |
| Excel/CSV | SheetJS (xlsx) |
| Decimal Math | decimal.js |
| Validation | express-validator |
| Security | helmet, express-rate-limit, bcryptjs |
| Logging | winston |

---

## Project Structure

```
quotation-engine/
├── src/
│   ├── config/
│   │   ├── app.ts          # Central config constants from env
│   │   ├── database.ts     # pg Pool, query(), withTransaction()
│   │   └── logger.ts       # Winston logger setup
│   │
│   ├── controllers/        # Route handlers (thin — delegate to services)
│   │   ├── authController.ts
│   │   ├── clientController.ts
│   │   ├── productController.ts
│   │   ├── quotationController.ts
│   │   └── workspaceController.ts
│   │
│   ├── services/           # Business logic
│   │   ├── authService.ts       # Registration, login, Google OAuth, token rotation
│   │   ├── clientService.ts     # Client CRUD
│   │   ├── pdfService.ts        # PDFKit invoice compilation engine
│   │   ├── productService.ts    # Product CRUD + bulk Excel/CSV ingestion
│   │   ├── quotationService.ts  # Quote creation with stock locks + decimal pricing
│   │   └── workspaceService.ts  # Workspace settings
│   │
│   ├── middleware/
│   │   ├── auth.ts         # JWT verification + role-based guards
│   │   ├── errorHandler.ts # Typed AppError hierarchy + central error handler
│   │   ├── upload.ts       # Multer (memory storage) for file uploads
│   │   └── validate.ts     # express-validator runner wrapper
│   │
│   ├── migrations/
│   │   ├── 001_initial_schema.sql   # Full DDL: all tables, indexes, triggers
│   │   └── runner.ts                # Migration runner (auto-applies on startup)
│   │
│   ├── types/
│   │   └── index.ts        # All TypeScript interfaces and DTOs
│   │
│   ├── app.ts              # Express app factory (middleware, routes)
│   └── server.ts           # Entry point: DB check → migrate → listen
│
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

---

## Prerequisites

- **Node.js** 18.x or higher
- **PostgreSQL** 14.x or higher
- **npm** 9.x or higher
- A Google Cloud project with OAuth 2.0 credentials (optional — only needed for Google Sign-In)

---

## Getting Started

### 1. Clone and install dependencies

```bash
git clone <repository-url>
cd quotation-engine
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
# Edit .env with your database credentials and secrets
```

At minimum, set:
- `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`
- `JWT_SECRET` (min 64 random chars)
- `JWT_REFRESH_SECRET` (min 64 random chars, different from JWT_SECRET)

### 3. Create the PostgreSQL database

```sql
CREATE DATABASE quotation_engine;
```

### 4. Run in development mode

```bash
npm run dev
```

On startup, the server automatically:
1. Verifies the database connection
2. Runs any pending SQL migrations (idempotent)
3. Starts listening on the configured port

### 5. Build for production

```bash
npm run build
npm start
```

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NODE_ENV` | No | `development` | `development` / `production` / `test` |
| `PORT` | No | `3000` | HTTP server port |
| `DB_HOST` | **Yes** | `localhost` | PostgreSQL host |
| `DB_PORT` | No | `5432` | PostgreSQL port |
| `DB_NAME` | **Yes** | — | Database name |
| `DB_USER` | **Yes** | — | Database user |
| `DB_PASSWORD` | **Yes** | — | Database password |
| `DB_POOL_MIN` | No | `2` | Min pool connections |
| `DB_POOL_MAX` | No | `10` | Max pool connections |
| `DB_SSL` | No | `false` | Set `true` for SSL connections |
| `JWT_SECRET` | **Yes** | — | HS256 signing secret (≥64 chars) |
| `JWT_EXPIRES_IN` | No | `7d` | Access token TTL |
| `JWT_REFRESH_SECRET` | **Yes** | — | Refresh token signing secret (≥64 chars) |
| `JWT_REFRESH_EXPIRES_IN` | No | `30d` | Refresh token TTL |
| `GOOGLE_CLIENT_ID` | No | — | Google OAuth Client ID |
| `GOOGLE_CLIENT_SECRET` | No | — | Google OAuth Client Secret |
| `GOOGLE_REDIRECT_URI` | No | — | Google OAuth redirect URI |
| `UPLOAD_DIR` | No | `./uploads` | Temp directory for uploads |
| `MAX_FILE_SIZE_MB` | No | `10` | Max upload file size in MB |
| `LOG_LEVEL` | No | `debug` | Winston log level |

---

## Database Schema

### Entity Relationship Summary

```
workspaces
  └── users          (workspace_id FK)
  └── products       (workspace_id FK)
  └── clients        (workspace_id FK)
  └── quotations     (workspace_id FK, client_id FK, created_by FK)
        └── quotation_line_items  (quotation_id FK, product_id FK)

users
  └── refresh_tokens (user_id FK)
```

### Monetary Precision

All price, tax, and total columns are declared as **`NUMERIC(12, 2)`** — never `FLOAT` or `DOUBLE`. Arithmetic at the application layer uses `decimal.js` with `ROUND_HALF_UP` rounding, matching standard accounting practice.

### Key Constraint Rules

| Table | Rule |
|-------|------|
| `users` | `UNIQUE (workspace_id, email)` — email unique per workspace |
| `products` | `UNIQUE (workspace_id, sku)` — SKU unique per workspace |
| `quotations` | `UNIQUE (workspace_id, quotation_number)` |
| `quotation_line_items` | `ON DELETE CASCADE` from quotations |
| `clients` → quotations | `ON DELETE RESTRICT` (prevent orphaned quotes) |
| `products` → line_items | `ON DELETE RESTRICT` (preserve historical data) |

---

## API Reference

All endpoints (except `/health` and `/api/auth/*`) require an `Authorization: Bearer <token>` header.

All responses follow the envelope format:
```json
{ "success": true, "data": { ... } }
{ "success": false, "error": "...", "code": "ERROR_CODE" }
```

---

### Authentication — `/api/auth`

#### `POST /api/auth/register`
Register a new workspace and owner account.
```json
{
  "email": "owner@example.com",
  "password": "SecurePass1",
  "full_name": "Jane Doe",
  "workspace_name": "Acme Corp",
  "workspace_slug": "acme-corp"
}
```

#### `POST /api/auth/login`
Login with email and password.
```json
{
  "email": "owner@example.com",
  "password": "SecurePass1",
  "workspace_slug": "acme-corp"
}
```

#### `POST /api/auth/google`
Authenticate via Google ID token. Performs identity merging: if the Google email matches an existing account, the `google_provider_id` is bound to that record rather than creating a duplicate.
```json
{
  "id_token": "<google_id_token>",
  "workspace_slug": "acme-corp"
}
```

#### `POST /api/auth/refresh`
Rotate refresh token. The old token is immediately revoked.
```json
{ "refresh_token": "..." }
```

#### `POST /api/auth/logout`
Revokes all active refresh tokens for the current user.

#### `GET /api/auth/me`
Returns current user identity from the JWT.

---

### Workspace — `/api/workspace`

| Method | Path | Role Required | Description |
|--------|------|---------------|-------------|
| `GET` | `/api/workspace` | Any | Get workspace details |
| `PATCH` | `/api/workspace` | `owner` | Update workspace settings |

**PATCH body fields** (all optional):
`name`, `logo_url`, `business_address`, `business_email`, `business_phone`, `gst_number`, `terms_and_conditions`, `currency_code`

---

### Products — `/api/products`

| Method | Path | Role Required | Description |
|--------|------|---------------|-------------|
| `GET` | `/api/products` | Any | List products (paginated) |
| `GET` | `/api/products/:id` | Any | Get single product |
| `POST` | `/api/products` | `admin`/`owner` | Create product |
| `PATCH` | `/api/products/:id` | `admin`/`owner` | Update product |
| `DELETE` | `/api/products/:id` | `owner` | Delete product |
| `POST` | `/api/products/bulk-import` | `admin`/`owner` | Upload Excel/CSV |

#### Bulk Import

Upload a `multipart/form-data` POST with field name `file` containing an `.xlsx`, `.xls`, or `.csv` file.

**Supported column headers** (case-insensitive, flexible aliases):

| Field | Accepted Headers |
|-------|-----------------|
| `sku` *(required)* | `sku`, `product code`, `item code`, `code` |
| `name` *(required)* | `name`, `product name`, `item name`, `title` |
| `base_price` *(required)* | `price`, `base price`, `unit price`, `selling price` |
| `tax_rate` | `tax rate`, `gst rate`, `tax`, `gst` |
| `stock_quantity` | `stock`, `stock quantity`, `quantity`, `qty` |
| `unit` | `unit`, `uom`, `unit of measure` |
| `description` | `description`, `desc`, `details` |

**Response:**
```json
{
  "success": true,
  "data": {
    "total_rows": 100,
    "inserted": 85,
    "updated": 10,
    "errors": [
      { "row_index": 7, "sku": "SKU-003", "error": "Row 7: base_price value \"abc\" is not a valid number." }
    ]
  }
}
```

---

### Clients — `/api/clients`

| Method | Path | Role | Description |
|--------|------|------|-------------|
| `GET` | `/api/clients` | Any | List clients (paginated) |
| `GET` | `/api/clients/:id` | Any | Get single client |
| `POST` | `/api/clients` | Any | Create client |
| `PATCH` | `/api/clients/:id` | Any | Update client |
| `DELETE` | `/api/clients/:id` | `owner` | Delete client |

**Create body:**
```json
{
  "company_name": "Buyer Ltd",
  "contact_name": "John Smith",
  "email": "john@buyerltd.com",
  "phone": "+919876543210",
  "billing_address": "123 MG Road, Mumbai 400001",
  "gst_number": "27AABCU9603R1ZX"
}
```

---

### Quotations — `/api/quotations`

| Method | Path | Role | Description |
|--------|------|------|-------------|
| `GET` | `/api/quotations` | Any | List quotations (paginated, filterable by status) |
| `GET` | `/api/quotations/:id` | Any | Full quotation with line items |
| `POST` | `/api/quotations` | Any | Create quotation |
| `PATCH` | `/api/quotations/:id/status` | Any | Update status |
| `GET` | `/api/quotations/:id/pdf` | Any | Download PDF |

#### Create Quotation
```json
{
  "client_id": "uuid-of-client",
  "valid_until": "2025-12-31",
  "notes": "Prices valid for 30 days. Delivery in 2 weeks.",
  "line_items": [
    {
      "product_id": "uuid-of-product-1",
      "quantity": 5,
      "discount_percent": 10,
      "description": "Premium Widget (customized)"
    },
    {
      "product_id": "uuid-of-product-2",
      "quantity": 2
    }
  ]
}
```

**Stock Gate:** If any product has insufficient `stock_quantity`, the entire transaction is rolled back and a `422 STOCK_ALLOCATION_FAILED` error is returned. No partial quotes are created.

**Price Isolation:** The current `base_price` is captured into `unit_price_at_creation` at creation time. Future price changes to the product have no effect on existing quotations.

#### Update Status
```json
{ "status": "sent" }
```
Valid statuses: `draft` → `sent` → `accepted` | `rejected` | `expired`

#### Download PDF
`GET /api/quotations/:id/pdf`

Returns a binary PDF stream with headers:
```
Content-Type: application/pdf
Content-Disposition: attachment; filename="quotation-<id>.pdf"
```

---

## Key Design Decisions

### 1. Decimal Arithmetic
All financial calculations use `decimal.js` configured with `ROUND_HALF_UP` (Decimal mode 4). Intermediate values retain 20 digits of precision; only the final storage values are rounded to 2 decimal places. This eliminates IEEE 754 floating-point drift.

**Formula:**
```
line_subtotal       = quantity × unit_price_at_creation
line_discount_amount = line_subtotal × (discount_percent / 100)
taxable_amount      = line_subtotal − line_discount_amount
line_tax_amount     = taxable_amount × (tax_rate / 100)
line_total          = taxable_amount + line_tax_amount
```

### 2. Concurrency-Safe Stock Reservation
Stock checking uses PostgreSQL row-level locking:
```sql
SELECT * FROM products WHERE id = $1 FOR UPDATE
```
This serializes concurrent quote creation requests for the same product, preventing double-allocation under high load. The lock is held for the duration of the transaction.

### 3. Google OAuth Identity Merging
```
Verify Google ID token
    ↓
Email from token → check users table
    ↓
Found by google_provider_id?  → Use existing user
    ↓ no
Found by email?               → Bind google_provider_id to that record (MERGE)
    ↓ no
Create new user
```

### 4. Historical Price Isolation
`quotation_line_items.unit_price_at_creation` stores a snapshot of the product price at creation time. This column is write-once — the update path for quotations never modifies it. Future calls to `products.base_price` updates will not affect any existing line items.

### 5. Refresh Token Rotation
Every token refresh call revokes the presented token and issues a new pair. This ensures that stolen refresh tokens can only be used once before detection. All tokens are stored as bcrypt hashes.

---

## Security

- **Helmet** sets secure HTTP headers (X-Frame-Options, X-Content-Type-Options, etc.)
- **CORS** with origin whitelist (configure `ALLOWED_ORIGINS` env var in production)
- **Rate limiting**: 100 req/15min globally; 20 req/15min on auth endpoints
- **JWT** HS256 with separate secrets for access and refresh tokens
- **Passwords** hashed with bcrypt (12 rounds)
- **SQL injection** prevention: all queries use parameterized `$1, $2, ...` placeholders — no string interpolation
- **Workspace isolation**: `workspace_id` always sourced from the verified JWT, never from request body/params
- **Input validation**: express-validator on all inputs with strict type coercion

---

## Running Migrations Manually

```bash
npm run migrate
```

Migrations are also run automatically on every server start. Each migration file is tracked in the `schema_migrations` table and skipped if already applied (idempotent).
