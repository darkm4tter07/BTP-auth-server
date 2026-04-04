import pkg from '@prisma/client';
const { PrismaClient } = pkg;
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '../config/env.js';

const globalForPrisma = globalThis;

const adapter = new PrismaPg({ 
  connectionString: env.DATABASE_URL,
  max: 1, // limit connections for free tier
});

const prisma = globalForPrisma.prisma || new PrismaClient({
  adapter,
  log: ['error'],
});

globalForPrisma.prisma = prisma;

export default prisma;