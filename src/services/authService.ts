import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../config/database';
import { config } from '../config/app';
import { logger } from '../config/logger';
import {
  RegisterDto,
  LoginDto,
  GoogleAuthDto,
  AuthResult,
  AuthTokenPayload,
  User,
  UserPublic,
  Workspace,
} from '../types';
import {
  ConflictError,
  AppError,
  NotFoundError,
  ValidationError,
} from '../middleware/errorHandler';
import { PoolClient } from 'pg';

const googleClient = new OAuth2Client(config.google.clientId);

// ─────────────────────────────────────────────────────────────────────────────
// Token Utilities
// ─────────────────────────────────────────────────────────────────────────────

function generateAccessToken(payload: Omit<AuthTokenPayload, 'iat' | 'exp'>): string {
  return jwt.sign(payload, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
  } as jwt.SignOptions);
}

function generateRefreshToken(payload: Omit<AuthTokenPayload, 'iat' | 'exp'>): string {
  return jwt.sign(payload, config.jwt.refreshSecret, {
    expiresIn: config.jwt.refreshExpiresIn,
  } as jwt.SignOptions);
}

async function storeRefreshToken(userId: string, rawRefreshToken: string): Promise<void> {
  const tokenHash = await bcrypt.hash(rawRefreshToken, config.bcrypt.saltRounds);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);

  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, tokenHash, expiresAt]
  );
}

function toUserPublic(user: User): UserPublic {
  return {
    id: user.id,
    workspace_id: user.workspace_id,
    email: user.email,
    full_name: user.full_name,
    phone_number: user.phone_number,
    phone_verified: user.phone_verified,
    role: user.role,
    is_active: user.is_active,
    last_login_at: user.last_login_at,
    created_at: user.created_at,
  };
}

async function updateLastLogin(userId: string): Promise<void> {
  await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [userId]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Register (Email + Password) — creates workspace + owner user atomically
// ─────────────────────────────────────────────────────────────────────────────

export async function registerWithEmail(dto: RegisterDto): Promise<AuthResult> {
  return withTransaction(async (client: PoolClient) => {
    // Check workspace slug uniqueness
    const slugCheck = await client.query(
      'SELECT id FROM workspaces WHERE slug = $1',
      [dto.workspace_slug]
    );
    if (slugCheck.rows.length > 0) {
      throw new ConflictError(`Workspace slug "${dto.workspace_slug}" is already taken.`);
    }

    // Create the workspace
    const workspaceResult = await client.query<Workspace>(
      `INSERT INTO workspaces (name, slug)
       VALUES ($1, $2)
       RETURNING *`,
      [dto.workspace_name, dto.workspace_slug]
    );
    const workspace = workspaceResult.rows[0];

    // Check email uniqueness within the workspace
    const emailCheck = await client.query(
      'SELECT id FROM users WHERE workspace_id = $1 AND email = $2',
      [workspace.id, dto.email.toLowerCase()]
    );
    if (emailCheck.rows.length > 0) {
      throw new ConflictError('An account with this email already exists.');
    }

    const passwordHash = await bcrypt.hash(dto.password, config.bcrypt.saltRounds);

    // Create the owner user
    const userResult = await client.query<User>(
      `INSERT INTO users (workspace_id, email, password_hash, full_name, phone_number, role)
       VALUES ($1, $2, $3, $4, $5, 'owner')
       RETURNING *`,
      [workspace.id, dto.email.toLowerCase(), passwordHash, dto.full_name, dto.phone_number || null]
    );
    const user = userResult.rows[0];

    const tokenPayload: Omit<AuthTokenPayload, 'iat' | 'exp'> = {
      sub: user.id,
      email: user.email,
      workspace_id: workspace.id,
      role: user.role,
    };

    const accessToken = generateAccessToken(tokenPayload);
    const refreshToken = generateRefreshToken(tokenPayload);
    await storeRefreshToken(user.id, refreshToken);

    logger.info('New workspace and owner registered', { userId: user.id, workspaceId: workspace.id });

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      user: toUserPublic(user),
      workspace,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Login (Email + Password)
// ─────────────────────────────────────────────────────────────────────────────

export async function loginWithEmail(dto: LoginDto): Promise<AuthResult> {
  // Fetch workspace first
  const workspaceResult = await query<Workspace>(
    'SELECT * FROM workspaces WHERE slug = $1 AND is_active = TRUE',
    [dto.workspace_slug]
  );
  if (workspaceResult.rows.length === 0) {
    throw new NotFoundError('Workspace');
  }
  const workspace = workspaceResult.rows[0];

  // Fetch user within workspace
  const userResult = await query<User>(
    'SELECT * FROM users WHERE workspace_id = $1 AND email = $2 AND is_active = TRUE',
    [workspace.id, dto.email.toLowerCase()]
  );
  if (userResult.rows.length === 0) {
    throw new AppError('Invalid email or password.', 401, 'INVALID_CREDENTIALS');
  }
  const user = userResult.rows[0];

  if (!user.password_hash) {
    throw new AppError(
      'This account uses Google Sign-In. Please authenticate via Google.',
      401,
      'OAUTH_ACCOUNT'
    );
  }

  const passwordValid = await bcrypt.compare(dto.password, user.password_hash);
  if (!passwordValid) {
    throw new AppError('Invalid email or password.', 401, 'INVALID_CREDENTIALS');
  }

  const tokenPayload: Omit<AuthTokenPayload, 'iat' | 'exp'> = {
    sub: user.id,
    email: user.email,
    workspace_id: workspace.id,
    role: user.role,
  };

  const accessToken = generateAccessToken(tokenPayload);
  const refreshToken = generateRefreshToken(tokenPayload);
  await storeRefreshToken(user.id, refreshToken);
  await updateLastLogin(user.id);

  logger.info('User logged in via email', { userId: user.id, workspaceId: workspace.id });

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    user: toUserPublic(user),
    workspace,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Google OAuth — with Identity Merging
// If the verified Google email matches an existing user record, bind the
// google_provider_id to that record instead of creating a duplicate.
// ─────────────────────────────────────────────────────────────────────────────

export async function loginWithGoogle(dto: GoogleAuthDto): Promise<AuthResult> {
  // 1. Verify the Google ID token
  let googlePayload: {
    sub: string;
    email: string;
    name?: string;
    email_verified?: boolean;
  };

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: dto.id_token,
      audience: config.google.clientId,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      throw new ValidationError('Google token payload is missing email claim.');
    }
    googlePayload = {
      sub: payload.sub,
      email: payload.email,
      name: payload.name,
      email_verified: payload.email_verified,
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('Google token verification failed.', 401, 'GOOGLE_AUTH_FAILED');
  }

  if (!googlePayload.email_verified) {
    throw new ValidationError('Google account email is not verified.');
  }

  // 2. Fetch the workspace
  const workspaceResult = await query<Workspace>(
    'SELECT * FROM workspaces WHERE slug = $1 AND is_active = TRUE',
    [dto.workspace_slug]
  );
  if (workspaceResult.rows.length === 0) {
    throw new NotFoundError('Workspace');
  }
  const workspace = workspaceResult.rows[0];

  // 3. Identity Merging Strategy:
  //    a) Check if a user with this google_provider_id already exists
  //    b) If not, check if a user with this email already exists → MERGE
  //    c) If neither, create a new user
  let user: User;

  const byGoogleId = await query<User>(
    'SELECT * FROM users WHERE workspace_id = $1 AND google_provider_id = $2',
    [workspace.id, googlePayload.sub]
  );

  if (byGoogleId.rows.length > 0) {
    // Returning Google user — just update last login
    user = byGoogleId.rows[0];
  } else {
    const byEmail = await query<User>(
      'SELECT * FROM users WHERE workspace_id = $1 AND email = $2',
      [workspace.id, googlePayload.email.toLowerCase()]
    );

    if (byEmail.rows.length > 0) {
      // IDENTITY MERGE: existing email/password account → bind Google provider ID
      const existingUser = byEmail.rows[0];
      const mergeResult = await query<User>(
        `UPDATE users
         SET google_provider_id = $1, updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [googlePayload.sub, existingUser.id]
      );
      user = mergeResult.rows[0];
      logger.info('Google identity merged with existing account', {
        userId: user.id,
        workspaceId: workspace.id,
      });
    } else {
      // New user — create account via Google
      const createResult = await query<User>(
        `INSERT INTO users (workspace_id, email, full_name, google_provider_id, role)
         VALUES ($1, $2, $3, $4, 'member')
         RETURNING *`,
        [workspace.id, googlePayload.email.toLowerCase(), googlePayload.name || googlePayload.email, googlePayload.sub]
      );
      user = createResult.rows[0];
      logger.info('New user created via Google OAuth', {
        userId: user.id,
        workspaceId: workspace.id,
      });
    }
  }

  if (!user.is_active) {
    throw new AppError('Your account has been deactivated. Contact your workspace administrator.', 403, 'ACCOUNT_DEACTIVATED');
  }

  const tokenPayload: Omit<AuthTokenPayload, 'iat' | 'exp'> = {
    sub: user.id,
    email: user.email,
    workspace_id: workspace.id,
    role: user.role,
  };

  const accessToken = generateAccessToken(tokenPayload);
  const refreshToken = generateRefreshToken(tokenPayload);
  await storeRefreshToken(user.id, refreshToken);
  await updateLastLogin(user.id);

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    user: toUserPublic(user),
    workspace,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Refresh Token Rotation
// ─────────────────────────────────────────────────────────────────────────────

export async function refreshAccessToken(rawRefreshToken: string): Promise<{ access_token: string; refresh_token: string }> {
  let payload: AuthTokenPayload;
  try {
    payload = jwt.verify(rawRefreshToken, config.jwt.refreshSecret) as AuthTokenPayload;
  } catch {
    throw new AppError('Invalid or expired refresh token.', 401, 'REFRESH_TOKEN_INVALID');
  }

  // Find a non-revoked, non-expired token for this user
  const tokenRows = await query<{ id: string; token_hash: string; revoked: boolean }>(
    `SELECT id, token_hash, revoked FROM refresh_tokens
     WHERE user_id = $1 AND revoked = FALSE AND expires_at > NOW()
     ORDER BY created_at DESC`,
    [payload.sub]
  );

  let matchedTokenId: string | null = null;
  for (const row of tokenRows.rows) {
    const matches = await bcrypt.compare(rawRefreshToken, row.token_hash);
    if (matches) {
      matchedTokenId = row.id;
      break;
    }
  }

  if (!matchedTokenId) {
    throw new AppError('Refresh token not recognized or already revoked.', 401, 'REFRESH_TOKEN_INVALID');
  }

  // Revoke the used token (rotation)
  await query('UPDATE refresh_tokens SET revoked = TRUE WHERE id = $1', [matchedTokenId]);

  const newTokenPayload: Omit<AuthTokenPayload, 'iat' | 'exp'> = {
    sub: payload.sub,
    email: payload.email,
    workspace_id: payload.workspace_id,
    role: payload.role,
  };

  const newAccessToken = generateAccessToken(newTokenPayload);
  const newRefreshToken = generateRefreshToken(newTokenPayload);
  await storeRefreshToken(payload.sub, newRefreshToken);

  return { access_token: newAccessToken, refresh_token: newRefreshToken };
}

// ─────────────────────────────────────────────────────────────────────────────
// Logout — revoke all refresh tokens for the user
// ─────────────────────────────────────────────────────────────────────────────

export async function logoutUser(userId: string): Promise<void> {
  await query(
    'UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1 AND revoked = FALSE',
    [userId]
  );
  logger.info('User logged out, all refresh tokens revoked', { userId });
}
