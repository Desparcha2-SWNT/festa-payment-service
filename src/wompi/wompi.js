import crypto from 'node:crypto';
import { config } from '../config.js';

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/**
 * Firma de integridad del Widget / Web Checkout de Wompi:
 *   SHA256("<referencia><monto_en_centavos><moneda><secreto_de_integridad>")
 * Sin ella Wompi rechaza el pago; así el monto no se puede alterar desde el cliente.
 */
export function integritySignature({ reference, amountInCents, currency = 'COP' }, secret = config.wompi.integritySecret) {
  return sha256(`${reference}${amountInCents}${currency}${secret}`);
}

/** Datos que la app necesita para abrir el checkout de Wompi. La app nunca envía datos de tarjeta a Festa. */
export function checkoutData({ reference, amountInCents, currency = 'COP' }) {
  const signature = integritySignature({ reference, amountInCents, currency });
  const params = new URLSearchParams({
    'public-key': config.wompi.publicKey,
    currency,
    'amount-in-cents': String(amountInCents),
    reference,
    'signature:integrity': signature,
    'redirect-url': config.wompi.redirectUrl,
  });
  return {
    provider: 'wompi',
    environment: config.wompi.env,
    publicKey: config.wompi.publicKey,
    currency,
    amountInCents,
    reference,
    signature,
    redirectUrl: config.wompi.redirectUrl,
    checkoutUrl: `https://checkout.wompi.co/p/?${params.toString()}`,
  };
}

function getPath(obj, dotted) {
  return dotted.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

/**
 * Verifica la firma de un evento de Wompi (webhook):
 *   checksum = SHA256(valores de signature.properties tomados de `data`, concatenados
 *                     + timestamp + secreto_de_eventos)
 * Compara en tiempo constante.
 */
export function verifyEventSignature(body, secret = config.wompi.eventsSecret) {
  const properties = body?.signature?.properties;
  const checksum = body?.signature?.checksum;
  if (!Array.isArray(properties) || typeof checksum !== 'string' || body.timestamp == null || !secret) return false;

  const values = properties.map((p) => getPath(body.data, p));
  if (values.some((v) => v === undefined)) return false;

  const expected = sha256(`${values.join('')}${body.timestamp}${secret}`);
  const a = Buffer.from(expected.toLowerCase());
  const b = Buffer.from(checksum.toLowerCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Método de pago de Wompi → el enum del contrato order.approved. */
export function mapPaymentMethod(type) {
  return ['CARD', 'NEQUI', 'PSE', 'BANCOLOMBIA_TRANSFER'].includes(type) ? type : 'OTHER';
}

/** Referencia legible y única para Wompi: FESTA-<orderId sin guiones>. */
export function referenceFor(orderId) {
  return `FESTA-${orderId.replace(/-/g, '')}`;
}
