import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { getSchemaRegistry, _resetForTests } from '../../src/messaging/schemaRegistry.js';

const contractsDir = process.env.FESTA_CONTRACTS_DIR ?? path.resolve('../festa-infra/contracts');
const hasContracts = fs.existsSync(path.join(contractsDir, 'envelope.schema.json'));

describe.skipIf(!hasContracts)('schemaRegistry', () => {
  // Dentro de beforeAll (no al nivel del describe): con skipIf, vitest igual EJECUTA el
  // cuerpo del describe al recolectar las pruebas — solo se saltan los hooks y los it().
  // Si esto se llamara aquí directo, tronaría aunque hasContracts fuera false.
  let registry;
  beforeAll(() => {
    _resetForTests();
    registry = getSchemaRegistry(contractsDir);
  });

  it('valida un sobre real (del ejemplo de merchant.verified)', () => {
    const data = {
      merchantId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      userId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
      businessName: 'Café Bohemio',
      category: 'gastronomico',
      place: { name: 'Café Bohemio', address: 'Cl. 11 #3-45, Bogotá', location: { lat: 4.5981, lng: -74.0758 } },
      verifiedBy: '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b',
      verifiedAt: '2026-10-25T09:00:00Z',
    };
    const envelope = {
      eventId: '1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a',
      eventType: 'merchant.verified',
      version: 1,
      occurredAt: '2026-10-25T09:00:00Z',
      producer: 'user-service',
      correlationId: null,
      causationId: null,
      data,
    };

    expect(registry.validateEnvelope(envelope)).toBe(true);

    const validateData = registry.getDataValidator('merchant.verified');
    expect(validateData).toBeDefined();
    expect(validateData(data)).toBe(true);
  });

  it('rechaza un `data` de merchant.verified incompleto (sin businessName)', () => {
    const validateData = registry.getDataValidator('merchant.verified');
    const incomplete = {
      merchantId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      userId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
      verifiedBy: '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b',
      verifiedAt: '2026-10-25T09:00:00Z',
    };

    expect(validateData(incomplete)).toBe(false);
  });

  it('rechaza un sobre sin eventId', () => {
    expect(registry.validateEnvelope({ eventType: 'merchant.verified', version: 1, producer: 'user-service', data: {} })).toBe(false);
  });

  it('no tiene validador para un eventType que no existe', () => {
    expect(registry.getDataValidator('esto.no_existe')).toBeUndefined();
  });

  it('valida account.deleted (lo que este servicio sí consume y maneja)', () => {
    const validateData = registry.getDataValidator('account.deleted');
    expect(validateData({ userId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f', deletedAt: '2026-12-01T10:00:00Z' })).toBe(true);
    expect(validateData({ userId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f' })).toBe(false); // falta deletedAt
  });

  it('sabe quién es el dueño real de cada eventType', () => {
    expect(registry.getExpectedProducer('merchant.verified')).toBe('user-service');
    expect(registry.getExpectedProducer('account.deleted')).toBe('auth-service');
    expect(registry.getExpectedProducer('event.published')).toBe('event-service');
    expect(registry.getExpectedProducer('esto.no_existe')).toBeUndefined();
  });

  it('sabe por qué exchange debió llegar cada eventType', () => {
    expect(registry.getExpectedExchange('merchant.verified')).toBe('festa.user');
    expect(registry.getExpectedExchange('account.deleted')).toBe('festa.auth');
    expect(registry.getExpectedExchange('event.published')).toBe('festa.event');
    expect(registry.getExpectedExchange('esto.no_existe')).toBeUndefined();
  });
});

if (!hasContracts) {
  console.warn(`[schemaRegistry.test] no se encontró ${contractsDir}; clona festa-infra como hermano de este repo o define FESTA_CONTRACTS_DIR`);
}
