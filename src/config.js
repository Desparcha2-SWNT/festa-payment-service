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
 * Clave que firma el origen de los reintentos de la inbox. Es OBLIGATORIA y debe ser estable: con una distinta en
 * cada arranque, un reintento pendiente que sobreviva a un reinicio (o que otra réplica reciba) llegaría con una firma
 * que ya no vale y se iría a la DLQ. Tampoco puede ser vacía, corta ni un valor de ejemplo (`change-me…`): una clave
 * conocida dejaría la firma sin ningún efecto, sin que nadie lo notara. Se genera con `openssl rand -hex 32`.
 */
export function resolveInboxRetryKey(value) {
  if (value === undefined) throw new Error('Falta la variable de entorno INBOX_RETRY_KEY (openssl rand -hex 32)');
  const key = value.trim();
  if (key.length < MIN_RETRY_KEY_LENGTH || /^change-?me/i.test(key)) {
    throw new Error(
      `INBOX_RETRY_KEY está vacía, tiene menos de ${MIN_RETRY_KEY_LENGTH} caracteres o es un valor de ejemplo: define una clave real (openssl rand -hex 32)`,
    );
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
  // Firma el origen de los reintentos (ver inboxConsumer.originExchange). Con varias réplicas, todas deben compartirla (estable entre reinicios).
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
    // En centavos de peso (como todos los montos): COP 700 = 70000.
    wompiFixedCents: number('WOMPI_FEE_FIXED_CENTS', 70_000),
    ivaPercent: number('IVA_PERCENT', 19),
  },

  reservationHoldMinutes: number('RESERVATION_HOLD_MINUTES', 15),
};
