import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

const EXPIRES_IN = env.ACCESS_TOKEN_EXPIRE_MINUTES * 60; // convert to seconds

export function signToken(payload) {
  return jwt.sign(payload, env.JWT_SECRET, {
    algorithm: env.JWT_ALGORITHM,
    expiresIn: EXPIRES_IN,
  });
}

export function verifyToken(token) {
  return jwt.verify(token, env.JWT_SECRET, {
    algorithms: [env.JWT_ALGORITHM],
  });
}