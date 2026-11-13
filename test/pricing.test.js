// RN2: comisión que paga el comprador y que debe cubrir el costo de Wompi.
import { describe, expect, it } from 'vitest';
import { commissionCoversWompi, priceOrder, wompiCostCents } from '../src/orders/pricing.js';

const fees = { wompiPercent: 2.99, wompiFixedCents: 0, ivaPercent: 19, commissionPercent: 8, commissionFixedCents: 0 };

describe('priceOrder', () => {
  it('reproduce el ejemplo del contrato order.approved (2 x $25.000 con 8%)', () => {
    expect(priceOrder(2_500_000, 2, fees)).toEqual({
      unitPriceCents: 2_500_000,
      quantity: 2,
      subtotalCents: 5_000_000,
      commissionCents: 400_000,
      totalCents: 5_400_000,
    });
  });

  it('suma la comisión fija por boleta', () => {
    const p = priceOrder(1_000_000, 3, { ...fees, commissionFixedCents: 50_000 });
    expect(p.commissionCents).toBe(3 * (80_000 + 50_000));
    expect(p.totalCents).toBe(p.subtotalCents + p.commissionCents);
  });

  it('siempre da centavos enteros', () => {
    const p = priceOrder(333_333, 1, { ...fees, commissionPercent: 7.5 });
    expect(Number.isInteger(p.commissionCents)).toBe(true);
  });
});

describe('costo de Wompi', () => {
  it('aplica porcentaje + IVA', () => {
    expect(wompiCostCents(1_000_000, fees)).toBe(Math.ceil(1_000_000 * 0.0299 * 1.19));
  });

  it('8% cubre 2,99% + IVA', () => {
    expect(commissionCoversWompi(1_000_000, fees)).toBe(true);
  });

  it('3% no alcanza a cubrir 2,99% + IVA', () => {
    expect(commissionCoversWompi(1_000_000, { ...fees, commissionPercent: 3 })).toBe(false);
  });
});
