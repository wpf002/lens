import { db } from "./client";

export async function queryReport(key: string) {
  return db.query(`SELECT * FROM reports WHERE key = '${key}'`);
}
