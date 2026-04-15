import { Router } from 'express';
import { google } from 'googleapis';
import prisma from '../lib/prisma.js';
import { env } from '../config/env.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

const router = Router();

function createFitnessClient(accessToken, refreshToken, userId) {
  const client = new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI
  );
  client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
  });

  client.on('tokens', async (tokens) => {
    console.log('Token refreshed for user:', userId);
    if (tokens.access_token) {
      await prisma.fitness_connections.updateMany({
        where: { user_id: userId },
        data: {
          access_token: tokens.access_token,
          token_expiry: tokens.expiry_date
            ? new Date(tokens.expiry_date)
            : new Date(Date.now() + 3600 * 1000),
        },
      });
      console.log('New token saved to DB');
    }
  });

  return client;
}

async function syncUserFitness(userId) {
  const conn = await prisma.fitness_connections.findFirst({
    where: { user_id: userId, is_active: true },
  });
  if (!conn) return null;

  const auth = createFitnessClient(conn.access_token, conn.refresh_token, userId);

  // Proactive refresh — refresh if expiring within 5 minutes
  const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);
  if (new Date(conn.token_expiry) < fiveMinutesFromNow) {
    try {
      const { credentials } = await auth.refreshAccessToken();
      await prisma.fitness_connections.updateMany({
        where: { user_id: userId },
        data: {
          access_token: credentials.access_token,
          token_expiry: credentials.expiry_date
            ? new Date(credentials.expiry_date)
            : new Date(Date.now() + 3600 * 1000),
        },
      });
      auth.setCredentials(credentials);
    } catch (err) {
        console.error('Token refresh failed:', err.message);

        await prisma.fitness_connections.updateMany({
          where: { user_id: userId },
          data: { is_active: false }  // mark as invalid
        });

        return { needs_reauth: true };
      }
  }

  const fitness = google.fitness({ version: 'v1', auth });

  const now = Date.now();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const startNs = String(startOfDay.getTime() * 1_000_000);
  const endNs = String(now * 1_000_000);
  const datasetId = `${startNs}-${endNs}`;

  let steps = 0, heartRateAvg = 0, calories = 0;

  try {
    const stepsRes = await fitness.users.dataSources.datasets.get({
      userId: 'me',
      dataSourceId: 'derived:com.google.step_count.delta:com.google.android.gms:estimated_steps',
      datasetId,
    });
    steps = stepsRes.data.point?.reduce((sum, p) => sum + (p.value[0].intVal || 0), 0) || 0;
  } catch (err) {
    if (err?.code === 401) {
      await prisma.fitness_connections.updateMany({
        where: { user_id: userId },
        data: { is_active: false },
      });
      return { needs_reauth: true };
    }
  }

  try {
    const heartRes = await fitness.users.dataSources.datasets.get({
      userId: 'me',
      dataSourceId: 'derived:com.google.heart_rate.bpm:com.google.android.gms:merge_heart_rate_bpm',
      datasetId,
    });
    const rates = heartRes.data.point?.map(p => p.value[0].fpVal) || [];
    heartRateAvg = rates.length ? Math.round(rates.reduce((a, b) => a + b) / rates.length) : 0;
  } catch (err) {
    if (err?.code === 401) {
      await prisma.fitness_connections.updateMany({
        where: { user_id: userId },
        data: { is_active: false },
      });
      return { needs_reauth: true };
    }
  }

  try {
    const calRes = await fitness.users.dataSources.datasets.get({
      userId: 'me',
      dataSourceId: 'derived:com.google.calories.expended:com.google.android.gms:merge_calories_expended',
      datasetId,
    });
    calories = Math.round(calRes.data.point?.reduce((sum, p) => sum + (p.value[0].fpVal || 0), 0) || 0);
  } catch (err) {
    if (err?.code === 401) {
      await prisma.fitness_connections.updateMany({
        where: { user_id: userId },
        data: { is_active: false },
      });
      return { needs_reauth: true };
    }
  }

  // Upsert today's fitness data
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const existing = await prisma.fitness_data.findFirst({
    where: { user_id: userId, date: today },
  });

  let result;
  if (existing) {
    result = await prisma.fitness_data.update({
      where: { id: existing.id },
      data: { steps, heart_rate_avg: heartRateAvg, calories, sync_timestamp: new Date() },
    });
  } else {
    result = await prisma.fitness_data.create({
      data: {
        id: crypto.randomUUID(),
        user_id: userId,
        date: today,
        steps,
        heart_rate_avg: heartRateAvg,
        calories,
      },
    });
  }

  // Update last_synced_at
  await prisma.fitness_connections.updateMany({
    where: { user_id: userId },
    data: { last_synced_at: new Date() },
  });

  return result;
}

// GET /fitness/summary
router.get('/summary', requireAuth, async (req, res) => {
  try {
    await syncUserFitness(req.user.sub);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const data = await prisma.fitness_data.findFirst({
      where: { user_id: req.user.sub, date: today },
    });
    res.json({
      steps: data?.steps || 0,
      heart_rate: data?.heart_rate_avg || 0,
      calories: data?.calories || 0,
      date: today.toISOString().split('T')[0],
    });
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// GET /fitness/connected-workers
router.get('/connected-workers', requireAdmin, async (req, res) => {
  try {
    const workers = await prisma.users.findMany({
      where: {
        role: 'WORKER',
        fitness_connections: { is_active: true },
      },
      include: { fitness_connections: true },
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const results = await Promise.all(workers.map(async (worker) => {
      const syncResult = await syncUserFitness(worker.id);
      const data = await prisma.fitness_data.findFirst({
        where: { user_id: worker.id, date: today },
      });
      return {
        id: worker.id,
        email: worker.email,
        full_name: worker.full_name,
        profile_picture: worker.profile_picture,
        employee_id: worker.employee_id,
        connected_at: worker.fitness_connections?.connected_at || null,
        last_synced_at: worker.fitness_connections?.last_synced_at || null,
        needs_reauth:
          syncResult?.needs_reauth === true ||
          worker.fitness_connections?.is_active === false,
        steps: data?.steps || 0,
        heart_rate: data?.heart_rate_avg || 0,
        calories: data?.calories || 0,
      };
    }));

    res.json({ total_connected: results.length, workers: results });
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// GET /fitness/summary/:userId
router.get('/summary/:userId', requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const worker = await prisma.users.findFirst({
      where: { id: userId, role: 'WORKER' },
    });
    if (!worker) return res.status(404).json({ detail: 'Worker not found' });

    await syncUserFitness(userId);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const data = await prisma.fitness_data.findFirst({
      where: { user_id: userId, date: today },
    });
    res.json({
      steps: data?.steps || 0,
      heart_rate: data?.heart_rate_avg || 0,
      calories: data?.calories || 0,
      date: today.toISOString().split('T')[0],
    });
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});


//to be deleted as included in the profile routes
// GET /fitness/users/:userId
router.get('/users/:userId', requireAdmin, async (req, res) => {
  try {
    const user = await prisma.users.findUnique({
      where: { id: req.params.userId },
    });
    if (!user) return res.status(404).json({ detail: 'User not found' });
    res.json({
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      employee_id: user.employee_id,
      role: user.role,
      profile_picture: user.profile_picture,
    });
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

export default router