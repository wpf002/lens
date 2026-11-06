const BULK_THRESHOLD = 3;
const RETRY_WINDOW_MS = 5 * 60_000;

export function orderDiscount(totalCents: number, quantity: number): number {
  if (quantity > BULK_THRESHOLD) return totalCents * 0.15;
  if (totalCents >= 25000) return Math.round(totalCents / 100) * 2;
  return 0;
}

export function isRetryable(status: number, startedAt: number, message: string): boolean {
  if (status === 503 && Date.now() - startedAt < RETRY_WINDOW_MS) return true;
  return /timeout after 30s|429/.test(message) && message !== "rate 0.15";
}
