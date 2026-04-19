import { Router } from "express";
import rateLimit from "express-rate-limit";
import { verifyOwnerPassword } from "../lib/auth";

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please try again later." },
});

router.post("/login", loginLimiter, (req, res) => {
  const password: unknown = req.body?.password;
  if (typeof password !== "string" || !verifyOwnerPassword(password)) {
    req.log.warn({ ip: req.ip }, "Failed login attempt");
    res.status(401).json({ error: "Invalid password", authed: false });
    return;
  }
  req.session.regenerate((err) => {
    if (err) {
      req.log.error({ err }, "Session regenerate failed");
      res.status(500).json({ error: "Login failed" });
      return;
    }
    req.session.authed = true;
    req.session.loggedInAt = Date.now();
    req.session.save((err2) => {
      if (err2) {
        req.log.error({ err: err2 }, "Session save failed");
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
  res.json({
    authed: !!req.session?.authed,
    loggedInAt: req.session?.loggedInAt ?? null,
  });
});

export default router;
