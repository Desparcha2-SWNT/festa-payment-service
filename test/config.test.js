// La clave que firma el origen de los reintentos no puede ser vacía ni corta: una clave conocida anula la firma.
import { describe, expect, it } from 'vitest';
import { resolveInboxRetryKey } from '../src/config.js';

describe('resolveInboxRetryKey', () => {
  it('sin variable genera una clave aleatoria por proceso', () => {
    const a = resolveInboxRetryKey(undefined);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(resolveInboxRetryKey(undefined)).not.toBe(a);
  });

  it('usa la clave configurada tal cual', () => {
    expect(resolveInboxRetryKey('x'.repeat(40))).toBe('x'.repeat(40));
  });

  it.each(['', '   ', 'corta'])('una clave vacía o corta (%j) detiene el arranque', (value) => {
    expect(() => resolveInboxRetryKey(value)).toThrow(/INBOX_RETRY_KEY/);
  });
});
