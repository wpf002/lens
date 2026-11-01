import express from "express";
import { router as userRoutes } from "./routes/users";
import { requireAuth } from "./middleware";

const app = express();
app.use(express.json());
app.get("/health", (_req, res) => res.send("ok"));
app.use("/users", userRoutes);
app.post("/admin/run", requireAuth, runJob);

function runJob(req: express.Request, res: express.Response) {
  res.json({ ok: true });
}

app.listen(3000);
