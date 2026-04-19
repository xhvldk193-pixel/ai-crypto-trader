import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import crypto from "node:crypto";
import type { RequestHandler } from "express";
import { pool } from "@workspace/db";

const PgSession = connectPgSimple(session);

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be set");
}
const OWNER_PASSWORD = process.env.OWNER_PASSWORD;
if (!OWNER_PASSWORD) {
  throw new Error("OWNER_PASSWORD must be set to enable authentication");
}

const isProduction = process.env.NODE_ENV === "production";

// Pre-create the session table at startup. We can't rely on
// connect-pg-simple's createTableIfMissing because esbuild bundling
// breaks the relative path it uses to read its bundled table.sql.
void (async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "user_sessions" (
        "sid" varchar NOT NULL COLLATE "default",
        "sess" json NOT NULL,
        "expire" timestamp(6) NOT NULL,
        CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("sid")
      ) WITH (OIDS=FALSE);
      CREATE INDEX IF NOT EXISTS "IDX_user_sessions_expire" ON "user_sessions" ("expire");
    `);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Failed to ensure user_sessions table exists:", err);
  }
})();

declare module "express-session" {
  interface SessionData {
    authed?: boolean;
    loggedInAt?: number;
  }
}

export const sessionMiddleware: RequestHandler = session({
  store: new PgSession({
    pool,
    tableName: "user_sessions",
    createTableIfMissing: false,
  }),
  name: "ct.sid",
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  proxy: true,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    // "strict" is appropriate here: the API is only ever called from
    // our own SPA on the same origin, never from external sites or
    // top-level navigations, so we get the strongest CSRF protection.
    sameSite: "strict",
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
  },
});

export function verifyOwnerPassword(submitted: string): boolean {
  if (typeof submitted !== "string" || submitted.length === 0) return false;
  const a = Buffer.from(submitted);
  const b = Buffer.from(OWNER_PASSWORD!);
  if (a.length !== b.length) {
    // Still do a constant-time compare against same-length buffer to avoid leaking length differences
    crypto.timingSafeEqual(a, Buffer.alloc(a.length));
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

export const requireAuth: RequestHandler = (req, res, next) => {
  if (req.session?.authed) {
    return next();
  }
  res.status(401).json({ error: "Unauthorized", code: "AUTH_REQUIRED" });
};
