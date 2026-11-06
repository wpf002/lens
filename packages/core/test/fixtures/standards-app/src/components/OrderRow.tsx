import type { Order } from "../db/orders";

export function OrderRow({ order }: { order: Order }) {
  return <li style={{ opacity: order.totalCents > 0 ? 0.85 : 0.4 }}>{order.id}</li>;
}
