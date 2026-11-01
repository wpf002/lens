/**
 * Browser-side layout runner: ELK runs inside a Web Worker created from an
 * inlined copy of elk-worker.min.js (so the single-file build needs no extra
 * assets). If workers are blocked, falls back to a small main-thread layered layout.
 */
import ELK from "elkjs/lib/elk-api.js";
import elkWorkerSource from "elkjs/lib/elk-worker.min.js?raw";
import type { Positions } from "../types";
import { computeLayout, fallbackElk, type ElkLike, type LayoutRequest } from "./layout";

let elk: ElkLike | null = null;
let workerBroken = false;

function getElk(): ElkLike {
  if (workerBroken) return fallbackElk;
  if (elk) return elk;
  try {
    const url = URL.createObjectURL(new Blob([elkWorkerSource], { type: "text/javascript" }));
    const inst = new ELK({
      workerFactory: () => {
        const w = new Worker(url);
        w.addEventListener("error", () => {
          workerBroken = true;
        });
        return w;
      },
    });
    elk = inst as unknown as ElkLike;
  } catch {
    workerBroken = true;
    return fallbackElk;
  }
  return elk;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("layout timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export async function runLayout(req: LayoutRequest): Promise<Positions> {
  try {
    return await withTimeout(computeLayout(req, getElk()), 20_000);
  } catch (err) {
    console.warn("[lens] ELK layout failed, using fallback layout:", err);
    workerBroken = true;
    return computeLayout(req, fallbackElk);
  }
}
