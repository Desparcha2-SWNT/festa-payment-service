// La clave que firma el origen de los reintentos: obligatoria, estable y nunca un valor de ejemplo.
import { describe, expect, it } from 'vitest';
import { resolveInboxRetryKey } from '../src/config.js';

describe('resolveInboxRetryKey', () => {
  it('sin variable detiene el arranque: no se inventa una clave por proceso (cambiaría al reiniciar)', () => {
    expect(() => resolveInboxRetryKey(undefined)).toThrow(/Falta la variable de entorno INBOX_RETRY_KEY/);
  });

  it('usa la clave configurada tal cual', () => {
    const key = 'a1b2c3d4'.repeat(8);
    expect(resolveInboxRetryKey(key)).toBe(key);
  });

  it.each(['', '   ', 'corta'])('una clave vacía o corta (%j) detiene el arranque', (value) => {
    expect(() => resolveInboxRetryKey(value)).toThrow(/INBOX_RETRY_KEY/);
  });

  it.each(['change-me-inbox-retry-key', 'CHANGE-ME-payment-inbox-retry-key', 'changeme-changeme-changeme'])(
    'un valor de ejemplo (%j) detiene el arranque aunque tenga longitud suficiente',
    (value) => {
      expect(() => resolveInboxRetryKey(value)).toThrow(/valor de ejemplo/);
    },
  );
});
