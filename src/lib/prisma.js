// import pkg from '@prisma/client';
// const { PrismaClient } = pkg;
// import { PrismaPg } from '@prisma/adapter-pg';
// import { env } from '../config/env.js';

// const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });

// const prisma = new PrismaClient({
//   adapter,
//   log: ['error', 'warn'],
// });

// export default prisma;

import pkg from '@prisma/client';
const { PrismaClient } = pkg;

import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '../config/env.js';

const globalForPrisma = globalThis;

const adapter = new PrismaPg({
  connectionString: env.DATABASE_URL,
});

const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    adapter,
    log: ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export default prisma;