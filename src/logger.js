import pino from 'pino';
import { config } from './config.js';

// Los logs de petición (pino-http) serializan las cabeceras: sin esto quedan en claro el bearer token
// y las cookies. Las rutas se aplican a todos los hijos del logger, incluido `req.log`.
export const redact = {
  paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
  censor: '[REDACTED]',
};

export function createLogger(destination, level = config.logLevel) {
  return pino({ level, redact }, destination);
}

export const logger = createLogger();
