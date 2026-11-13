import { config } from '../config.js';

/**
 * Precio de una orden (RN2). La comisión de Festa la paga el comprador encima del precio de la
 * boleta: total = subtotal + comisión (ver contracts/events/payment/order.approved.schema.json).
 * Todo en centavos COP enteros, sin flotantes en el resultado.
 */
export function priceOrder(unitPriceCents, quantity, fees = config.fees) {
  const subtotalCents = unitPriceCents * quantity;
  const commissionPerTicket = Math.round((unitPriceCents * fees.commissionPercent) / 100) + fees.commissionFixedCents;
  const commissionCents = commissionPerTicket * quantity;
  return {
    unitPriceCents,
    quantity,
    subtotalCents,
    commissionCents,
    totalCents: subtotalCents + commissionCents,
  };
}

/** Lo que cobra Wompi por cobrar `totalCents` (porcentaje + fijo, ambos con IVA). */
export function wompiCostCents(totalCents, fees = config.fees) {
  const iva = 1 + fees.ivaPercent / 100;
  return Math.ceil(((totalCents * fees.wompiPercent) / 100 + fees.wompiFixedCents) * iva);
}

/**
 * RN2: "la comisión de Festa debe fijarse por encima de ese costo base para dejar margen real".
 * Devuelve false si con esta configuración Festa pierde plata en una boleta de `unitPriceCents`.
 */
export function commissionCoversWompi(unitPriceCents, fees = config.fees) {
  const { commissionCents, totalCents } = priceOrder(unitPriceCents, 1, fees);
  return commissionCents > wompiCostCents(totalCents, fees);
}
