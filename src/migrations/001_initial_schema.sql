-- =============================================================================
-- Quotation Engine - Full Schema Migration
-- Version: 001
-- Description: Initial schema with workspaces, users, products, clients,
--              quotations, and quotation_line_items tables.
--              All monetary values use NUMERIC(12,2) to prevent float errors.
-- =============================================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================================================
-- WORKSPACES
-- Represents a tenant / organization using the quotation engine.
-- =============================================================================
CREATE TABLE IF NOT EXISTS workspaces (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name                VARCHAR(255) NOT NULL,
    slug                VARCHAR(100) NOT NULL UNIQUE,
    logo_url            TEXT,
    business_address    TEXT,
    business_email      VARCHAR(255),
    business_phone      VARCHAR(50),
    gst_number          VARCHAR(50),
    terms_and_conditions TEXT,
    currency_code       CHAR(3) NOT NULL DEFAULT 'INR',
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspaces_slug ON workspaces(slug);

-- =============================================================================
-- USERS
-- Platform users scoped to a workspace. Supports email/password, Google OAuth,
-- and phone-based identity. Identity merging is handled at application layer.
-- =============================================================================
CREATE TABLE IF NOT EXISTS users (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id        UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    email               VARCHAR(255) NOT NULL,
    password_hash       TEXT,                          -- NULL if OAuth-only account
    full_name           VARCHAR(255) NOT NULL,
    phone_number        VARCHAR(30),
    phone_verified      BOOLEAN NOT NULL DEFAULT FALSE,
    google_provider_id  VARCHAR(255),                  -- Google sub claim; NULL if not linked
    role                VARCHAR(20) NOT NULL DEFAULT 'member'
                            CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    last_login_at       TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Email must be unique within a workspace
    CONSTRAINT uq_users_email_workspace UNIQUE (workspace_id, email)
);

CREATE INDEX IF NOT EXISTS idx_users_workspace_id     ON users(workspace_id);
CREATE INDEX IF NOT EXISTS idx_users_email            ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_google_provider  ON users(google_provider_id) WHERE google_provider_id IS NOT NULL;

-- =============================================================================
-- PRODUCTS
-- Product catalog scoped per workspace. Prices stored as NUMERIC(12,2).
-- =============================================================================
CREATE TABLE IF NOT EXISTS products (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id        UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    sku                 VARCHAR(100) NOT NULL,
    name                VARCHAR(500) NOT NULL,
    description         TEXT,
    base_price          NUMERIC(12, 2) NOT NULL CHECK (base_price >= 0),
    tax_rate            NUMERIC(5, 2) NOT NULL DEFAULT 18.00 CHECK (tax_rate >= 0 AND tax_rate <= 100),
    stock_quantity      INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
    unit                VARCHAR(50) NOT NULL DEFAULT 'pcs',
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- SKU must be unique within a workspace
    CONSTRAINT uq_products_sku_workspace UNIQUE (workspace_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_products_workspace_id  ON products(workspace_id);
CREATE INDEX IF NOT EXISTS idx_products_sku           ON products(workspace_id, sku);
CREATE INDEX IF NOT EXISTS idx_products_is_active     ON products(workspace_id, is_active);

-- =============================================================================
-- CLIENTS
-- Customer/client records scoped per workspace.
-- =============================================================================
CREATE TABLE IF NOT EXISTS clients (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id        UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    company_name        VARCHAR(500) NOT NULL,
    contact_name        VARCHAR(255) NOT NULL,
    email               VARCHAR(255) NOT NULL,
    phone               VARCHAR(50),
    billing_address     TEXT,
    gst_number          VARCHAR(50),
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clients_workspace_id  ON clients(workspace_id);
CREATE INDEX IF NOT EXISTS idx_clients_email         ON clients(workspace_id, email);

-- =============================================================================
-- QUOTATIONS
-- Master quotation records. All monetary columns use NUMERIC(12,2).
-- =============================================================================
CREATE TABLE IF NOT EXISTS quotations (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id        UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    client_id           UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
    created_by          UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    quotation_number    VARCHAR(100) NOT NULL,
    status              VARCHAR(20) NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft', 'sent', 'accepted', 'rejected', 'expired')),
    issue_date          DATE NOT NULL DEFAULT CURRENT_DATE,
    valid_until         DATE,
    notes               TEXT,
    -- All monetary totals computed by application layer
    subtotal            NUMERIC(12, 2) NOT NULL DEFAULT 0.00 CHECK (subtotal >= 0),
    total_discount      NUMERIC(12, 2) NOT NULL DEFAULT 0.00 CHECK (total_discount >= 0),
    total_tax           NUMERIC(12, 2) NOT NULL DEFAULT 0.00 CHECK (total_tax >= 0),
    grand_total         NUMERIC(12, 2) NOT NULL DEFAULT 0.00 CHECK (grand_total >= 0),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_quotation_number_workspace UNIQUE (workspace_id, quotation_number)
);

CREATE INDEX IF NOT EXISTS idx_quotations_workspace_id  ON quotations(workspace_id);
CREATE INDEX IF NOT EXISTS idx_quotations_client_id     ON quotations(client_id);
CREATE INDEX IF NOT EXISTS idx_quotations_created_by    ON quotations(created_by);
CREATE INDEX IF NOT EXISTS idx_quotations_status        ON quotations(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_quotations_created_at    ON quotations(workspace_id, created_at DESC);

-- =============================================================================
-- QUOTATION_LINE_ITEMS
-- Individual line items for each quotation.
-- unit_price_at_creation is a historical SNAPSHOT of the price at quote time —
-- future product price changes must NOT retroactively alter this value.
-- All monetary columns use NUMERIC(12,2).
-- =============================================================================
CREATE TABLE IF NOT EXISTS quotation_line_items (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    quotation_id            UUID NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
    product_id              UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    description             TEXT NOT NULL,              -- snapshot of product name
    quantity                INTEGER NOT NULL CHECK (quantity > 0),
    unit_price_at_creation  NUMERIC(12, 2) NOT NULL CHECK (unit_price_at_creation >= 0),  -- historical price lock
    discount_percent        NUMERIC(5, 2) NOT NULL DEFAULT 0.00
                                CHECK (discount_percent >= 0 AND discount_percent <= 100),
    tax_rate                NUMERIC(5, 2) NOT NULL DEFAULT 0.00
                                CHECK (tax_rate >= 0 AND tax_rate <= 100),
    -- All computed fields stored for historical accuracy
    line_subtotal           NUMERIC(12, 2) NOT NULL CHECK (line_subtotal >= 0),         -- qty * unit_price_at_creation
    line_discount_amount    NUMERIC(12, 2) NOT NULL DEFAULT 0.00 CHECK (line_discount_amount >= 0),
    line_tax_amount         NUMERIC(12, 2) NOT NULL DEFAULT 0.00 CHECK (line_tax_amount >= 0),
    line_total              NUMERIC(12, 2) NOT NULL CHECK (line_total >= 0),             -- net after discount + tax
    sort_order              INTEGER NOT NULL DEFAULT 0,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_line_items_quotation_id  ON quotation_line_items(quotation_id);
CREATE INDEX IF NOT EXISTS idx_line_items_product_id    ON quotation_line_items(product_id);
CREATE INDEX IF NOT EXISTS idx_line_items_sort_order    ON quotation_line_items(quotation_id, sort_order);

-- =============================================================================
-- REFRESH TOKENS
-- Stores issued refresh tokens for secure JWT rotation.
-- =============================================================================
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,     -- bcrypt hash of the raw refresh token
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked     BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id     ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token_hash  ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at  ON refresh_tokens(expires_at);

-- =============================================================================
-- SCHEMA MIGRATIONS TRACKING
-- =============================================================================
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     VARCHAR(50) PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO schema_migrations (version) VALUES ('001_initial_schema')
ON CONFLICT (version) DO NOTHING;

-- =============================================================================
-- TRIGGERS — auto-update updated_at columns
-- =============================================================================
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
    tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY['workspaces', 'users', 'products', 'clients', 'quotations']
    LOOP
        EXECUTE format('
            DROP TRIGGER IF EXISTS set_updated_at ON %I;
            CREATE TRIGGER set_updated_at
                BEFORE UPDATE ON %I
                FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
        ', tbl, tbl);
    END LOOP;
END;
$$;
