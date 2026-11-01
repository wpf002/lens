import { Router } from "express";
import { exec } from "child_process";
import { findUser, searchUsers } from "@/services/userService";

export const router = Router();

router.get("/:id", async (req, res) => {
  const u = await findUser(req.params.id);
  res.json(u);
});

router.post("/search", async (req, res) => {
  res.json(await searchUsers(req.body.q));
});

router.post("/export", (req, res) => {
  exec(`tar czf /tmp/out.tgz ${req.body.dir}`, () => res.send("done"));
});

router.get("/go", (req, res) => res.redirect(req.query.next as string));
