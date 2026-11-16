import { config } from '../config.js';

/**
 * Precio de una orden. Modelo oficial (Excel): suscripción Festa Pro con cupo de IA y overage; no hay
 * comisión por boleta. El comprador paga el precio de la boleta: total = subtotal.
 * Todo en centavos COP enteros.
 */
export function priceOrder(unitPriceCents, quantity) {
  const subtotalCents = unitPriceCents * quantity;
  return {
    unitPriceCents,
    quantity,
    subtotalCents,
    totalCents: subtotalCents,
  };
}

/** Lo que cobra Wompi por cobrar `totalCents` (porcentaje + fijo, ambos con IVA). */
export function wompiCostCents(totalCents, fees = config.fees) {
  const iva = 1 + fees.ivaPercent / 100;
  return Math.ceil(((totalCents * fees.wompiPercent) / 100 + fees.wompiFixedCents) * iva);
}
