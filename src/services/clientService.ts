import { query } from '../config/database';
import { Client, CreateClientDto, UpdateClientDto, PaginatedResult } from '../types';
import { NotFoundError } from '../middleware/errorHandler';

export async function getClients(
  workspaceId: string,
  page = 1,
  limit = 50,
  activeOnly = true
): Promise<PaginatedResult<Client>> {
  const offset = (page - 1) * limit;
  const activeFilter = activeOnly ? 'AND is_active = TRUE' : '';

  const countResult = await query<{ total: string }>(
    `SELECT COUNT(*) AS total FROM clients WHERE workspace_id = $1 ${activeFilter}`,
    [workspaceId]
  );
  const total = parseInt(countResult.rows[0].total, 10);

  const dataResult = await query<Client>(
    `SELECT * FROM clients
     WHERE workspace_id = $1 ${activeFilter}
     ORDER BY company_name ASC
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

export async function getClientById(workspaceId: string, clientId: string): Promise<Client> {
  const result = await query<Client>(
    'SELECT * FROM clients WHERE id = $1 AND workspace_id = $2',
    [clientId, workspaceId]
  );
  if (result.rows.length === 0) {
    throw new NotFoundError('Client');
  }
  return result.rows[0];
}

export async function createClient(workspaceId: string, dto: CreateClientDto): Promise<Client> {
  const result = await query<Client>(
    `INSERT INTO clients (workspace_id, company_name, contact_name, email, phone, billing_address, gst_number)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      workspaceId,
      dto.company_name.trim(),
      dto.contact_name.trim(),
      dto.email.toLowerCase().trim(),
      dto.phone?.trim() || null,
      dto.billing_address?.trim() || null,
      dto.gst_number?.trim().toUpperCase() || null,
    ]
  );
  return result.rows[0];
}

export async function updateClient(
  workspaceId: string,
  clientId: string,
  dto: UpdateClientDto
): Promise<Client> {
  await getClientById(workspaceId, clientId); // Ensure exists and belongs to workspace

  const result = await query<Client>(
    `UPDATE clients
     SET company_name    = COALESCE($1, company_name),
         contact_name    = COALESCE($2, contact_name),
         email           = COALESCE($3, email),
         phone           = COALESCE($4, phone),
         billing_address = COALESCE($5, billing_address),
         gst_number      = COALESCE($6, gst_number),
         is_active       = COALESCE($7, is_active),
         updated_at      = NOW()
     WHERE id = $8 AND workspace_id = $9
     RETURNING *`,
    [
      dto.company_name?.trim() || null,
      dto.contact_name?.trim() || null,
      dto.email?.toLowerCase().trim() || null,
      dto.phone?.trim() || null,
      dto.billing_address?.trim() || null,
      dto.gst_number?.trim().toUpperCase() || null,
      dto.is_active ?? null,
      clientId,
      workspaceId,
    ]
  );
  return result.rows[0];
}

export async function deleteClient(workspaceId: string, clientId: string): Promise<void> {
  // Check if any quotations reference this client
  const usageCheck = await query<{ cnt: string }>(
    'SELECT COUNT(*) AS cnt FROM quotations WHERE client_id = $1',
    [clientId]
  );
  const count = parseInt(usageCheck.rows[0].cnt, 10);
  if (count > 0) {
    throw new Error(
      `Cannot delete client: they have ${count} associated quotation(s). Deactivate the client instead.`
    );
  }

  const result = await query(
    'DELETE FROM clients WHERE id = $1 AND workspace_id = $2',
    [clientId, workspaceId]
  );
  if (result.rowCount === 0) {
    throw new NotFoundError('Client');
  }
}
