import express, { type Express, type Request, type Response, type NextFunction } from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { sessionMiddleware } from "./lib/auth";
import path from "path";
import { fileURLToPath } from "url";
import streamRouter from "./routes/stream";

const app: Express = express();

// Trust the Replit proxy so secure cookies and rate-limit IP detection work behind TLS termination
app.set("trust proxy", 1);

app.use(
  helmet({
    contentSecurityPolicy: false, // disabled for dev preview iframe; re-enable per app
    crossOriginEmbedderPolicy: false,
  }),
);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// Frontend and API are served from the same origin via the Replit proxy.
// We deliberately do NOT enable CORS — any browser making a cross-origin
// request will be blocked by the same-origin policy, which removes the
// primary CSRF vector for our cookie-authenticated session.

// Defense-in-depth: explicitly reject any cross-origin request that does
// reach us, regardless of method, before it can trigger any handler.
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (!origin) return next(); // same-origin or non-browser request
  const host = req.headers.host;
  try {
    const originHost = new URL(origin).host;
    if (host && originHost === host) return next();
  } catch {
    // invalid origin header
  }
  res.status(403).json({ error: "Cross-origin requests are not allowed" });
});

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.use(sessionMiddleware);

app.use("/api", router);
app.use("/stream", streamRouter);

// In production, serve the built frontend static files and fall back to index.html for SPA routing
if (process.env.NODE_ENV === "production") {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const publicDir = path.resolve(__dirname, "../public");

  app.use(express.static(publicDir));

  app.get("/{*splat}", (req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(publicDir, "index.html"));
  });
}

export default app;
