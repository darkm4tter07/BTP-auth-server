import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from './src/config/env.js';
import prisma from './src/lib/prisma.js';
import authRoutes from './src/routes/auth.js';
import fitnessRoutes from './src/routes/fitness.js';

const app = express();

app.use(cors({ origin: env.FRONTEND_URL, credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.use('/auth', authRoutes);
app.use('/fitness', fitnessRoutes);
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(env.PORT, () => {
  console.log(`Auth server running on port ${env.PORT}`);
});

// DB connection check
prisma.$connect()
  .then(() => console.log('Database connected'))
  .catch((err) => {
    console.error('Database connection failed:', err.message);
    process.exit(1);
  });