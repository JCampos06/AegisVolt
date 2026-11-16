/**
 * Telemetría simulada de una sesión de carga: rampa de potencia hasta ~90% de
 * la nominal y energía acumulada. AC (<= 22 kW) a 230 V, DC a 400 V.
 */
export interface TelemetryPoint {
  ts: string;
  kw: number;
  kwh: number;
  voltage: number;
}

const RAMP = [0.35, 0.7, 0.9, 0.9, 0.88];

export function simulateTelemetry(powerKw: number, kwhTarget: number, start: Date, intervalSec = 60): TelemetryPoint[] {
  const voltage = powerKw <= 22 ? 230 : 400;
  let kwh = 0;
  return RAMP.map((factor, i) => {
    const kw = round(powerKw * factor, 1);
    kwh = Math.min(kwhTarget, round(kwh + (kw * intervalSec) / 3600, 3));
    return { ts: new Date(start.getTime() + i * intervalSec * 1000).toISOString(), kw, kwh, voltage };
  });
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
