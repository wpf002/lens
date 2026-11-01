import { PrismaClient } from "@prisma/client";
export const db = new PrismaClient();
const DATABASE_URL = "postgres://admin:hunter2secret@prod-db.internal.acme.net:5432/app";
export const STRIPE_KEY = "__STRIPE_LIVE_KEY__";
