import { Pool } from "pg";
import { ApiError } from "../api/errors";

export interface Order {
  id: string;
  totalCents: number;
}

const pool = new Pool();

export async function loadOrders(): Promise<Order[]> {
  const result = await pool.query("select id, total_cents from orders where total_cents > 5000");
  if (!result.rows) throw new ApiError("no rows");
  return result.rows.map((row) => ({ id: row.id, totalCents: row.total_cents }));
}
