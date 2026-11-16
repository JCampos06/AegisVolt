/**
 * Tarifas en COP por kWh según la potencia del conector. Los montos se manejan
 * como enteros (pesos) para evitar errores de redondeo con decimales.
 *
 * ENABLE_DYNAMIC_SURGE_PRICING = true  -> tarifa x1.5 (simula la hora pico)
 */
export const TARIFFS = [
  { tier: 'AC', maxPowerKw: 22, ratePerKwh: 1100 },
  { tier: 'DC_FAST', maxPowerKw: 149, ratePerKwh: 1500 },
  { tier: 'ULTRA', maxPowerKw: Number.POSITIVE_INFINITY, ratePerKwh: 2100 },
] as const;

export const SURGE_MULTIPLIER = 1.5;

export interface Quote {
  kwh: number;
  powerKw: number;
  tier: (typeof TARIFFS)[number]['tier'];
  ratePerKwh: number;
  surgeMultiplier: number;
  amount: number;
  currency: 'COP';
}

export function quote(kwh: number, powerKw: number, surge: boolean): Quote {
  if (!(kwh > 0) || !(powerKw > 0)) throw new RangeError('kwh y powerKw deben ser positivos');
  const tariff = TARIFFS.find((t) => powerKw <= t.maxPowerKw)!;
  const surgeMultiplier = surge ? SURGE_MULTIPLIER : 1;
  return {
    kwh,
    powerKw,
    tier: tariff.tier,
    ratePerKwh: tariff.ratePerKwh,
    surgeMultiplier,
    amount: Math.round(kwh * tariff.ratePerKwh * surgeMultiplier),
    currency: 'COP',
  };
}
