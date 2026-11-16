// Modelo oficial (Excel): sin comisión por boleta. El comprador paga el precio de la boleta.
import { describe, expect, it } from 'vitest';
import { priceOrder, wompiCostCents } from '../src/orders/pricing.js';

const fees = { wompiPercent: 2.99, wompiFixedCents: 0, ivaPercent: 19 };

describe('priceOrder', () => {
  it('total = subtotal (2 x $25.000, sin comisión)', () => {
    expect(priceOrder(2_500_000, 2)).toEqual({
      unitPriceCents: 2_500_000,
      quantity: 2,
      subtotalCents: 5_000_000,
      totalCents: 5_000_000,
    });
  });

  it('no agrega ningún cargo al precio de la boleta', () => {
    const p = priceOrder(1_000_000, 3);
    expect(p.totalCents).toBe(p.subtotalCents);
  });
});

describe('costo de Wompi (referencia de costos)', () => {
  it('aplica porcentaje + IVA', () => {
    expect(wompiCostCents(1_000_000, fees)).toBe(Math.ceil(1_000_000 * 0.0299 * 1.19));
  });
});
