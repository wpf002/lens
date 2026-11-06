import { loadOrders } from "../db/orders";

export async function OrderList() {
  const orders = await loadOrders();
  return <ul style={{ width: orders.length * 48 }}>{orders.map((order) => <li key={order.id}>{order.id}</li>)}</ul>;
}
