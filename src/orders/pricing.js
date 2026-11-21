import { config } from '../config.js';

/**
 * Precio de una orden. Modelo oficial (Excel): suscripción Festa Pro con cupo de IA y overage; no hay
 * comisión por boleta. El comprador paga el precio de la boleta: total = subtotal.
 * Decisión del equipo (2026-11-21): la comisión de Wompi la paga el comercio, así que a este se le
 * liquida subtotal - gatewayFeeCents (nunca menos de 0). Todo en centavos COP enteros.
 */
export function priceOrder(unitPriceCents, quantity, fees = config.fees) {
  const subtotalCents = unitPriceCents * quantity;
  const gatewayFeeCents = wompiCostCents(subtotalCents, fees);
  return {
    unitPriceCents,
    quantity,
    subtotalCents,
    totalCents: subtotalCents,
    gatewayFeeCents,
    merchantNetCents: Math.max(subtotalCents - gatewayFeeCents, 0),
  };
}

/** Lo que cobra Wompi por cobrar `totalCents` (porcentaje + fijo, ambos con IVA). */
export function wompiCostCents(totalCents, fees = config.fees) {
  const iva = 1 + fees.ivaPercent / 100;
  return Math.ceil(((totalCents * fees.wompiPercent) / 100 + fees.wompiFixedCents) * iva);
}
