import { db } from "../db/client";

export async function findUser(id: string) {
  return db.$queryRawUnsafe(`SELECT * FROM users WHERE id = ${id}`);
}

export async function searchUsers(q: string) {
  return runSearch(q);
}

function runSearch(q: string) {
  return db.$queryRaw`SELECT * FROM users WHERE name LIKE ${q}`;
}
