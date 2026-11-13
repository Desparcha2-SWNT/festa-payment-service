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
    wompiPercent: number('WOMPI_FEE_PERCENT', 2.99),
    wompiFixedCents: number('WOMPI_FEE_FIXED_CENTS', 0),
    ivaPercent: number('IVA_PERCENT', 19),
    commissionPercent: number('COMMISSION_PERCENT', 8),
    commissionFixedCents: number('COMMISSION_FIXED_CENTS', 0),
  },

  reservationHoldMinutes: number('RESERVATION_HOLD_MINUTES', 15),
};
