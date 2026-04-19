import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
  TWO_FA_CODE_TTL_MS,
  TWO_FA_MAX_ATTEMPTS,
  generate2faCode,
  hash2faCode,
  verify2faCode,
  verifyOwnerPassword,
} from "../lib/auth";
import { sendOwnerMessage, telegramConfigured } from "../lib/telegram";

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please try again later." },
});

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many verification attempts. Please try again later." },
});

router.post("/login", loginLimiter, async (req, res) => {
  const password: unknown = req.body?.password;
  if (typeof password !== "string" || !verifyOwnerPassword(password)) {
    req.log.warn({ ip: req.ip }, "Failed login attempt");
    res.status(401).json({ error: "Invalid password", authed: false });
    return;
  }

  if (!telegramConfigured) {
    req.log.error("Telegram not configured; cannot complete 2FA login");
    res.status(503).json({ error: "Two-factor authentication is not configured on the server" });
    return;
  }

  // Password is correct → issue a 6-digit Telegram code as the second factor.
  const code = generate2faCode();
  req.session.authed = false;
  req.session.pending2fa = {
    codeHash: hash2faCode(code),
    expiresAt: Date.now() + TWO_FA_CODE_TTL_MS,
    attempts: 0,
  };

  try {
    await sendOwnerMessage(
      `🔐 트레이딩 봇 로그인 코드: ${code}\n\n5분 안에 입력하세요. 본인이 시도한 게 아니라면 비밀번호를 즉시 변경하세요.`,
    );
  } catch (err) {
    req.log.error({ err }, "Failed to send Telegram 2FA code");
    delete req.session.pending2fa;
    res.status(502).json({ error: "Failed to send verification code via Telegram" });
    return;
  }

  req.session.save((err) => {
    if (err) {
      req.log.error({ err }, "Session save failed during 2FA challenge");
      res.status(500).json({ error: "Login failed" });
      return;
    }
    res.json({ authed: false, needs2fa: true });
  });
});

router.post("/verify-2fa", verifyLimiter, (req, res) => {
  const code: unknown = req.body?.code;
  const pending = req.session.pending2fa;

  if (!pending) {
    res.status(400).json({ error: "No pending verification. Please log in again.", code: "NO_CHALLENGE" });
    return;
  }

  if (Date.now() > pending.expiresAt) {
    delete req.session.pending2fa;
    req.session.save(() => {
      res.status(400).json({ error: "Verification code expired. Please log in again.", code: "EXPIRED" });
    });
    return;
  }

  if (pending.attempts >= TWO_FA_MAX_ATTEMPTS) {
    delete req.session.pending2fa;
    req.session.save(() => {
      res.status(429).json({ error: "Too many wrong attempts. Please log in again.", code: "TOO_MANY_ATTEMPTS" });
    });
    return;
  }

  pending.attempts += 1;

  if (typeof code !== "string" || !verify2faCode(code, pending.codeHash)) {
    req.session.pending2fa = pending;
    req.session.save(() => {
      res.status(401).json({
        error: "Invalid verification code",
        authed: false,
        attemptsRemaining: TWO_FA_MAX_ATTEMPTS - pending.attempts,
      });
    });
    return;
  }

  // Code correct → regenerate session and mark fully authenticated.
  req.session.regenerate((err) => {
    if (err) {
      req.log.error({ err }, "Session regenerate failed after 2FA");
      res.status(500).json({ error: "Login failed" });
      return;
    }
    req.session.authed = true;
    req.session.loggedInAt = Date.now();
    req.session.save((err2) => {
      if (err2) {
        req.log.error({ err: err2 }, "Session save failed after 2FA");
        res.status(500).json({ error: "Login failed" });
        return;
      }
      res.json({ authed: true });
    });
  });
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("ct.sid");
    res.json({ authed: false });
  });
});

router.get("/me", (req, res) => {
  const pending = req.session?.pending2fa;
  const needs2fa = !!(pending && Date.now() < pending.expiresAt && pending.attempts < TWO_FA_MAX_ATTEMPTS);
  res.json({
    authed: !!req.session?.authed,
    needs2fa,
    loggedInAt: req.session?.loggedInAt ?? null,
  });
});

export default router;
