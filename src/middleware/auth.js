import fs from 'node:fs';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

const publicKey = fs.readFileSync(config.jwtPublicKeyPath, 'utf8');

/**
 * El gateway (Kong) ya rechaza las peticiones sin un JWT válido. Esto vuelve a verificar la firma
 * (defensa en profundidad) y deja la identidad en `req.auth`.
 */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  if (!token) return res.status(401).json({ error: 'falta el token' });

  try {
    const claims = jwt.verify(token, publicKey, { algorithms: ['RS256'], issuer: config.jwtIssuer });
    // auth-service emite el claim "role" (user | merchant | admin).
    req.auth = { userId: claims.sub, email: claims.email, role: claims.role };
    next();
  } catch {
    res.status(401).json({ error: 'token inválido' });
  }
}

/** Solo administradores (reembolsos, liquidaciones). Va después de requireAuth. */
export function requireAdmin(req, res, next) {
  if (req.auth?.role !== 'admin') return res.status(403).json({ error: 'solo un administrador puede hacer esto' });
  next();
}
