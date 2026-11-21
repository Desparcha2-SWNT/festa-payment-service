import { randomBytes } from 'node:crypto';
import path from 'node:path';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

function number(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`La variable ${name} debe ser numérica`);
  return value;
}

// Valor de `trust proxy` de Express. Un número es la cantidad de proxies delante del servicio.
export function parseTrustProxy(value) {
  if (value === undefined || value === '') return 1;
  if (/^\d+$/.test(value)) return Number(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

const MIN_RETRY_KEY_LENGTH = 16;

/**
 * Clave que firma el origen de los reintentos de la inbox. Si la variable no existe se genera una por proceso
 * (sirve con una réplica). Si existe pero está vacía o es demasiado corta se detiene el arranque: una clave vacía
 * es conocida por todos y dejaría la firma sin ningún efecto, sin que nadie lo notara.
 */
export function resolveInboxRetryKey(value) {
  if (value === undefined) return randomBytes(32).toString('hex');
  if (value.trim().length < MIN_RETRY_KEY_LENGTH) {
    throw new Error(`INBOX_RETRY_KEY está vacía o tiene menos de ${MIN_RETRY_KEY_LENGTH} caracteres: define una clave real (openssl rand -hex 32)`);
  }
  return value;
}

export const config = {
  serviceName: 'payment-service',
  port: Number(process.env.PORT ?? 8085),
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  databaseUrl: required('DATABASE_URL'),
  amqpUrl: required('AMQP_URL'),
  jwtIssuer: required('JWT_ISSUER'),
  jwtPublicKeyPath: required('JWT_PUBLIC_KEY_PATH'),
  contractsDir: process.env.FESTA_CONTRACTS_DIR ?? path.resolve('../festa-infra/contracts'),
  // Firma el origen de los reintentos (ver inboxConsumer.originExchange). Con varias réplicas, todas deben compartirla.
  inboxRetryKey: resolveInboxRetryKey(process.env.INBOX_RETRY_KEY),

  wompi: {
    env: process.env.WOMPI_ENV ?? 'sandbox',
    publicKey: process.env.WOMPI_PUBLIC_KEY ?? '',
    privateKey: process.env.WOMPI_PRIVATE_KEY ?? '',
    eventsSecret: process.env.WOMPI_EVENTS_SECRET ?? '',
    integritySecret: process.env.WOMPI_INTEGRITY_SECRET ?? '',
    // Página a la que Wompi devuelve al usuario al terminar el pago (deep link de la app).
    redirectUrl: process.env.WOMPI_REDIRECT_URL ?? 'festa://payments/result',
  },

  fees: {
    // Plan Avanzado de Wompi Colombia (página oficial, consultada 16-11-2026): 2,65 % + COP 700 + IVA por transacción exitosa.
    wompiPercent: number('WOMPI_FEE_PERCENT', 2.65),
    wompiFixedCents: number('WOMPI_FEE_FIXED_CENTS', 700),
    ivaPercent: number('IVA_PERCENT', 19),
  },

  reservationHoldMinutes: number('RESERVATION_HOLD_MINUTES', 15),
};
