export const SHIPPING_RATE = 0.07;
export function shippingFor(cents: number) {
  return cents * 0.07;
}
