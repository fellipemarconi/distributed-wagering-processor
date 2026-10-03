const BASE_MS = 1_000;
const CAP_MS = 5 * 60_000;

/** Atraso antes da tentativa seguinte: 1s, 2s, 4s… com teto de 5 min. `attempts` = tentativas já feitas (≥ 1). */
// ponytail: sem jitter (domínio determinístico); adicionar no worker se publishers sincronizarem retries.
export function backoffDelayMs(attempts: number): number {
  // Expoente limitado: 2 ** 1000 viraria Infinity à toa, o teto é atingido bem antes.
  const exponent = Math.min(Math.max(attempts, 1) - 1, 30);
  return Math.min(BASE_MS * 2 ** exponent, CAP_MS);
}
