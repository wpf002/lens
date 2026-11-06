import { Router } from "express";
import { loadReport, renderReport, archiveReport } from "../services/reportService";

export const router = Router();

router.get("/reports/:reportId", async (req, res) => {
  res.json(await loadReport(req.params.reportId));
});

router.post("/reports/render", async (req, res) => {
  const { title } = req.body;
  res.send(await renderReport(title));
});

router.post("/reports/archive", async (req, res) => {
  res.send(await archiveReport(Number(req.body.reportId)));
});
