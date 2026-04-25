import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import marketRouter from "./market";
import divergenceRouter from "./divergence";
import aiRouter from "./ai";
import portfolioRouter from "./portfolio";
import tradeRouter from "./trade";
import botRouter from "./bot";
import backtestRouter from "./backtest";
import listingRouter from "./listing";           // ✅ 추가
import { requireAuth } from "../lib/auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/auth", authRouter);

router.use(requireAuth);
router.use("/market", marketRouter);
router.use("/divergence", divergenceRouter);
router.use("/ai", aiRouter);
router.use("/portfolio", portfolioRouter);
router.use("/trade", tradeRouter);
router.use("/bot", botRouter);
router.use("/backtest", backtestRouter);
router.use("/listing", listingRouter);           // ✅ 추가

export default router;
