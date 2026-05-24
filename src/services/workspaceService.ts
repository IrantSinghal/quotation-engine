import { query } from '../config/database';
import { Workspace, UpdateWorkspaceDto } from '../types';
import { NotFoundError } from '../middleware/errorHandler';

export async function getWorkspaceById(workspaceId: string): Promise<Workspace> {
  const result = await query<Workspace>(
    'SELECT * FROM workspaces WHERE id = $1 AND is_active = TRUE',
    [workspaceId]
  );
  if (result.rows.length === 0) {
    throw new NotFoundError('Workspace');
  }
  return result.rows[0];
}

export async function updateWorkspace(
  workspaceId: string,
  dto: UpdateWorkspaceDto
): Promise<Workspace> {
  const result = await query<Workspace>(
    `UPDATE workspaces
     SET name                 = COALESCE($1, name),
         logo_url             = COALESCE($2, logo_url),
         business_address     = COALESCE($3, business_address),
         business_email       = COALESCE($4, business_email),
         business_phone       = COALESCE($5, business_phone),
         gst_number           = COALESCE($6, gst_number),
         terms_and_conditions = COALESCE($7, terms_and_conditions),
         currency_code        = COALESCE($8, currency_code),
         updated_at           = NOW()
     WHERE id = $9
     RETURNING *`,
    [
      dto.name?.trim() || null,
      dto.logo_url?.trim() || null,
      dto.business_address?.trim() || null,
      dto.business_email?.toLowerCase().trim() || null,
      dto.business_phone?.trim() || null,
      dto.gst_number?.trim().toUpperCase() || null,
      dto.terms_and_conditions?.trim() || null,
      dto.currency_code?.toUpperCase() || null,
      workspaceId,
    ]
  );
  if (result.rows.length === 0) {
    throw new NotFoundError('Workspace');
  }
  return result.rows[0];
}
