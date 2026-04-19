import { Router, type IRouter } from "express";
import healthRouter from "./health";
import marketRouter from "./market";
import divergenceRouter from "./divergence";
import aiRouter from "./ai";
import portfolioRouter from "./portfolio";
import tradeRouter from "./trade";
import botRouter from "./bot";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/market", marketRouter);
router.use("/divergence", divergenceRouter);
router.use("/ai", aiRouter);
router.use("/portfolio", portfolioRouter);
router.use("/trade", tradeRouter);
router.use("/bot", botRouter);

export default router;
