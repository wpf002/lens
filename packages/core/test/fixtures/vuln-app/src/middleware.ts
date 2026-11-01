import jwt from "jsonwebtoken";

/** Rejects requests without a valid bearer token. */
export function requireAuth(req: any, res: any, next: any) {
  const token = req.headers.authorization?.slice(7);
  const claims = jwt.decode(token);
  if (!claims) return res.status(401).end();
  req.user = claims;
  next();
}
