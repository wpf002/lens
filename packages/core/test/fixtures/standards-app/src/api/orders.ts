import { loadOrders } from "../db/orders";
import { orderDiscount } from "../services/pricing";

export async function listOrders() {
  const orders = await loadOrders();
  return orders.map((order) => ({ ...order, discount: orderDiscount(order.totalCents, 1) }));
}
