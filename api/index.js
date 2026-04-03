import express from 'express';
import serverless from "serverless-http";
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from '../src/config/env.js';
import authRoutes from '../src/routes/auth.js';
import fitnessRoutes from '../src/routes/fitness.js';


const app = express();

app.use(cors({ origin: env.FRONTEND_URL, credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.use('api/auth', authRoutes);
app.use('api/fitness', fitnessRoutes);
app.get('api/health', (_req, res) => res.json({ status: 'ok' }));

// app.listen(env.PORT, () => {
//   console.log(`Auth server running on port ${env.PORT}`);
// });

// // DB connection check
// prisma.$connect()
//   .then(() => console.log('Database connected'))
//   .catch((err) => {
//     console.error('Database connection failed:', err.message);
//     process.exit(1);
//   });

export default serverless(app);