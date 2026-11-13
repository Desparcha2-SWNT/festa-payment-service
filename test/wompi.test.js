// Firmas de Wompi: integridad del checkout y verificación del webhook.
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkoutData, integritySignature, mapPaymentMethod, referenceFor, verifyEventSignature } from '../src/wompi/wompi.js';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

describe('integritySignature', () => {
  it('es SHA256(referencia + monto + moneda + secreto)', () => {
    expect(integritySignature({ reference: 'FESTA-1', amountInCents: 5400000 }, 'secreto')).toBe(sha('FESTA-15400000COPsecreto'));
  });

  it('checkoutData arma la URL del Web Checkout con la firma', () => {
    const data = checkoutData({ reference: 'FESTA-1', amountInCents: 100 });
    expect(data.checkoutUrl).toContain('https://checkout.wompi.co/p/?');
    expect(data.checkoutUrl).toContain('reference=FESTA-1');
    expect(data.checkoutUrl).toContain(`signature%3Aintegrity=${data.signature}`);
  });
});

function signedEvent(secret, overrides = {}) {
  const transaction = { id: '1234-1610641025-49201', status: 'APPROVED', amount_in_cents: 5400000, reference: 'FESTA-1', ...overrides };
  const timestamp = 1530291411;
  const properties = ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'];
  const checksum = sha(`${transaction.id}${transaction.status}${transaction.amount_in_cents}${timestamp}${secret}`);
  return { event: 'transaction.updated', data: { transaction }, signature: { properties, checksum }, timestamp };
}

describe('verifyEventSignature', () => {
  it('acepta un evento firmado con el secreto de eventos', () => {
    expect(verifyEventSignature(signedEvent('evt-secret'), 'evt-secret')).toBe(true);
  });

  it('rechaza si alguien cambió el estado después de firmar', () => {
    const body = signedEvent('evt-secret');
    body.data.transaction.status = 'DECLINED';
    expect(verifyEventSignature(body, 'evt-secret')).toBe(false);
  });

  it('rechaza con otro secreto', () => {
    expect(verifyEventSignature(signedEvent('evt-secret'), 'otro')).toBe(false);
  });

  it('rechaza un cuerpo sin firma o sin secreto configurado', () => {
    expect(verifyEventSignature({}, 'evt-secret')).toBe(false);
    expect(verifyEventSignature(signedEvent('x'), '')).toBe(false);
  });
});

describe('utilidades', () => {
  it('referenceFor quita los guiones', () => {
    expect(referenceFor('e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7a8b')).toBe('FESTA-e5f6a7b8c9d04e1f8a2b3c4d5e6f7a8b');
  });

  it('mapPaymentMethod usa OTHER para lo desconocido', () => {
    expect(mapPaymentMethod('NEQUI')).toBe('NEQUI');
    expect(mapPaymentMethod('DAVIPLATA')).toBe('OTHER');
  });
});
