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
// ✅ 최소 32자 강제 — 짧은 시크릿은 세션 위조에 취약
// 생성: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
if (SESSION_SECRET.length < 32) {
  throw new Error(
    `SESSION_SECRET must be at least 32 characters (got ${SESSION_SECRET.length}). ` +
    `Run: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
  );
}

// ─────────────────────────────────────────────────────
// 비밀번호 검증 — scrypt 해시 우선, 평문은 하위호환 경고
// ─────────────────────────────────────────────────────
//
// OWNER_PASSWORD_HASH 형식: "scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>"
//   예: "scrypt$16384$8$1$<32바이트 salt hex>$<64바이트 hash hex>"
//
// 해시 생성: `node scripts/hash-password.mjs <비밀번호>` 로 생성해서
// Railway/Replit Secrets 에 OWNER_PASSWORD_HASH 로 등록.
//
// 평문 OWNER_PASSWORD 는 기존 배포와의 호환을 위해 계속 지원하되
// 서버 기동 시 경고를 찍는다. 가능하면 해시로 전환 권장.

const OWNER_PASSWORD_HASH = process.env.OWNER_PASSWORD_HASH;
const OWNER_PASSWORD = process.env.OWNER_PASSWORD;

if (!OWNER_PASSWORD_HASH && !OWNER_PASSWORD) {
  throw new Error(
    "Either OWNER_PASSWORD_HASH (preferred) or OWNER_PASSWORD must be set to enable authentication",
  );
}
if (!OWNER_PASSWORD_HASH && OWNER_PASSWORD) {
  // eslint-disable-next-line no-console
  console.warn(
    "⚠️  OWNER_PASSWORD is set in plaintext. Generate a hash with scripts/hash-password.mjs " +
    "and store it in OWNER_PASSWORD_HASH instead.",
  );
}

interface ParsedScryptHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parseScryptHash(serialized: string): ParsedScryptHash | null {
  const parts = serialized.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  try {
    const salt = Buffer.from(parts[4], "hex");
    const hash = Buffer.from(parts[5], "hex");
    if (salt.length === 0 || hash.length === 0) return null;
    return { N, r, p, salt, hash };
  } catch {
    return null;
  }
}

function scryptVerify(submitted: string, serialized: string): boolean {
  const parsed = parseScryptHash(serialized);
  if (!parsed) return false;
  const { N, r, p, salt, hash } = parsed;
  try {
    const derived = crypto.scryptSync(submitted, salt, hash.length, { N, r, p, maxmem: 128 * N * r * 2 });
    if (derived.length !== hash.length) return false;
    return crypto.timingSafeEqual(derived, hash);
  } catch {
    return false;
  }
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
    pending2fa?: {
      codeHash: string;
      expiresAt: number;
      attempts: number;
    };
  }
}

export const TWO_FA_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const TWO_FA_MAX_ATTEMPTS = 5;

export function generate2faCode(): string {
  // 6-digit code, zero-padded. crypto.randomInt is unbiased.
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function hash2faCode(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

export function verify2faCode(submitted: string, expectedHash: string): boolean {
  if (!/^\d{6}$/.test(submitted)) return false;
  const a = Buffer.from(hash2faCode(submitted), "hex");
  const b = Buffer.from(expectedHash, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
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

  // 1순위: scrypt 해시
  if (OWNER_PASSWORD_HASH) {
    return scryptVerify(submitted, OWNER_PASSWORD_HASH);
  }

  // 2순위: 평문 비교 (하위호환)
  if (OWNER_PASSWORD) {
    const a = Buffer.from(submitted);
    const b = Buffer.from(OWNER_PASSWORD);
    if (a.length !== b.length) {
      // Still do a constant-time compare against same-length buffer to avoid leaking length differences
      crypto.timingSafeEqual(a, Buffer.alloc(a.length));
      return false;
    }
    return crypto.timingSafeEqual(a, b);
  }

  return false;
}

export const requireAuth: RequestHandler = (req, res, next) => {
  if (req.session?.authed) {
    return next();
  }
  res.status(401).json({ error: "Unauthorized", code: "AUTH_REQUIRED" });
};
