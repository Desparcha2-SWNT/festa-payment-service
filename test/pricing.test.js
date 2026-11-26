// Modelo oficial (Excel): sin comisión por boleta. El comprador paga el precio de la boleta.
import { describe, expect, it } from 'vitest';
import { priceOrder, wompiCostCents } from '../src/orders/pricing.js';

const officialFees = { wompiPercent: 2.65, wompiFixedCents: 70_000, ivaPercent: 19 };
const fees = { wompiPercent: 2.99, wompiFixedCents: 0, ivaPercent: 19 };

describe('priceOrder', () => {
  it('total = subtotal (2 x $25.000, sin comisión)', () => {
    const p = priceOrder(2_500_000, 2, officialFees);
    expect(p).toMatchObject({ unitPriceCents: 2_500_000, quantity: 2, subtotalCents: 5_000_000, totalCents: 5_000_000 });
  });

  it('no agrega ningún cargo al precio de la boleta', () => {
    const p = priceOrder(1_000_000, 3);
    expect(p.totalCents).toBe(p.subtotalCents);
  });
});

describe('comisión de Wompi a cargo del comercio', () => {
  it('boleta de $50.000: comisión $2.410 (2,65 % + $700 + IVA) y neto $47.590,25', () => {
    const p = priceOrder(5_000_000, 1, officialFees);
    expect(p.gatewayFeeCents).toBe(Math.ceil((5_000_000 * 0.0265 + 70_000) * 1.19));
    expect(p.gatewayFeeCents).toBe(240_975);
    expect(p.merchantNetCents).toBe(4_759_025);
    expect(p.totalCents).toBe(5_000_000);
  });

  it('en una boleta barata el neto nunca es negativo', () => {
    const p = priceOrder(100, 1, officialFees);
    expect(p.merchantNetCents).toBe(0);
  });
});

describe('costo de Wompi (referencia de costos)', () => {
  it('aplica porcentaje + IVA', () => {
    expect(wompiCostCents(1_000_000, fees)).toBe(Math.ceil(1_000_000 * 0.0299 * 1.19));
  });
});
