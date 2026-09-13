import { Router, type IRouter } from "express";
import healthRouter from "./health";
import receiptRouter from "./receipt";

const router: IRouter = Router();

router.use(healthRouter);
router.use(receiptRouter);

export default router;
