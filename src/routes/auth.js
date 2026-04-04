import { Router } from 'express';
import { google } from 'googleapis';
import { signToken } from '../lib/jwt.js';
import prisma from '../lib/prisma.js';
import { env } from '../config/env.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/fitness.activity.read',
  'https://www.googleapis.com/auth/fitness.body.read',
  'https://www.googleapis.com/auth/fitness.heart_rate.read',
];

function createOAuthClient() {
  return new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI
  );
}

// Add this function at the top of the file after imports
function generateEmployeeId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = 'WRK-';
  for (let i = 0; i < 5; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// GET /auth/google/login
router.get('/google/login', (req, res) => {
  const client = createOAuthClient();
  const url = client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    include_granted_scopes: true,
  });
  res.json({ authorization_url: url });
});

// GET /auth/google/callback
router.get('/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ detail: 'Missing code' });

  try {
    const client = createOAuthClient();

    // Exchange code for tokens
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    // Get user info from Google
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const { data: userInfo } = await oauth2.userinfo.get();

    const { id: googleId, email, name, picture } = userInfo;
    const fullName = name || email.split('@')[0];

    // Upsert user — match by google_id or email
    let user = await prisma.users.findFirst({
      where: {
        OR: [{ google_id: googleId }, { email }],
      },
    });

    if (user) {
      user = await prisma.users.update({
        where: { id: user.id },
        data: {
          google_id: googleId,
          full_name: fullName,
          profile_picture: picture,
          updated_at: new Date(),
        },
      });
    } else {

      let employeeId;
      let isUnique = false;
      while (!isUnique) {
        employeeId = generateEmployeeId();
        const existing = await prisma.users.findFirst({
          where: { employee_id: employeeId }
        });
        isUnique = !existing;
      }
      user = await prisma.users.create({
        data: {
          id: crypto.randomUUID(),
          email,
          full_name: fullName,
          google_id: googleId,
          profile_picture: picture,
          role: 'WORKER',
          is_active: true,
          employee_id: employeeId, 
        },
      });
    }

    // Upsert fitness connection
    const existingConn = await prisma.fitness_connections.findUnique({
      where: { user_id: user.id },
    });

    const tokenExpiry = tokens.expiry_date
      ? new Date(tokens.expiry_date)
      : new Date(Date.now() + 3600 * 1000);

    if (existingConn) {
      await prisma.fitness_connections.update({
        where: { user_id: user.id },
        data: {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token || existingConn.refresh_token,
          token_expiry: tokenExpiry,
          scopes: SCOPES,
          is_active: true,
        },
      });
    } else {
      await prisma.fitness_connections.create({
        data: {
          id: crypto.randomUUID(),
          user_id: user.id,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          token_expiry: tokenExpiry,
          scopes: SCOPES,
          is_active: true,
        },
      });
    }

    // Sign JWT — same payload shape as FastAPI
    const accessToken = signToken({ sub: user.id, role: user.role });

    const redirectUrl = `${env.FRONTEND_URL}/login?token=${accessToken}&fitness=connected`;
    return res.redirect(redirectUrl);

  } catch (err) {
    console.error('OAuth callback error:', err);
    return res.status(500).json({ detail: 'OAuth flow failed', error: err.message });
  }
});

// GET /auth/me
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await prisma.users.findUnique({
      where: { id: req.user.sub },
    });
    if (!user) return res.status(404).json({ detail: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// GET /auth/google/status
router.get('/google/status', requireAuth, async (req, res) => {
  try {
    const connection = await prisma.fitness_connections.findFirst({
      where: { user_id: req.user.sub, is_active: true },
    });
    res.json({
      connected: connection !== null,
      connected_at: connection?.connected_at || null,
      last_synced_at: connection?.last_synced_at || null,
    });
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// DELETE /auth/google/disconnect
router.delete('/google/disconnect', requireAuth, async (req, res) => {
  try {
    const connection = await prisma.fitness_connections.findFirst({
      where: { user_id: req.user.sub },
    });
    if (!connection) {
      return res.status(404).json({ detail: 'No active connection found' });
    }
    await prisma.fitness_connections.update({
      where: { id: connection.id },
      data: { is_active: false },
    });
    res.json({ message: 'Google Fit disconnected successfully' });
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

export default router;