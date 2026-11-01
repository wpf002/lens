/** Optional real embeddings (OpenAI, Voyage, Ollama). Keys come from env only. */
import type { GraphNode, KnowledgeGraph } from "./types.js";

export type EmbedProvider = "openai" | "voyage" | "ollama";

export interface EmbeddingStore {
  provider: EmbedProvider;
  model: string;
  dim: number;
  createdAt: string;
  /** node id → base64 Float32Array */
  vectors: Record<string, string>;
  /** node id → hash of the embedded text, to skip unchanged nodes next time */
  hashes: Record<string, string>;
}

const DEFAULT_MODEL: Record<EmbedProvider, string> = {
  openai: "text-embedding-3-small",
  voyage: "voyage-code-3",
  ollama: "nomic-embed-text",
};

export function embedText(n: GraphNode): string {
  return [`${n.kind} ${n.name}`, n.path ?? "", n.summary, n.tags.join(" "), n.signature ?? ""].filter(Boolean).join("\n").slice(0, 2000);
}

const EMBEDDABLE = new Set(["file", "function", "class", "endpoint", "concept", "domain", "flow", "step", "config", "service", "table", "schema", "document", "article", "topic", "entity"]);

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

export async function embedBatch(provider: EmbedProvider, model: string, texts: string[]): Promise<number[][]> {
  if (provider === "openai") {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY is not set");
    const r = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, input: texts }),
    });
    if (!r.ok) throw new Error(`OpenAI embeddings failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const j = (await r.json()) as { data: Array<{ embedding: number[] }> };
    return j.data.map((d) => d.embedding);
  }
  if (provider === "voyage") {
    const key = process.env.VOYAGE_API_KEY;
    if (!key) throw new Error("VOYAGE_API_KEY is not set");
    const r = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, input: texts, input_type: "document" }),
    });
    if (!r.ok) throw new Error(`Voyage embeddings failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const j = (await r.json()) as { data: Array<{ embedding: number[] }> };
    return j.data.map((d) => d.embedding);
  }
  const host = (process.env.OLLAMA_HOST ?? "http://localhost:11434").replace(/\/$/, "");
  const r = await fetch(`${host}/api/embed`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, input: texts }) });
  if (!r.ok) throw new Error(`Ollama embeddings failed: ${r.status}`);
  const j = (await r.json()) as { embeddings: number[][] };
  return j.embeddings;
}

const toB64 = (v: number[]) => Buffer.from(new Float32Array(v).buffer).toString("base64");
const fromB64 = (s: string) => new Float32Array(Buffer.from(s, "base64").buffer.slice(0));

export async function buildEmbeddings(
  g: KnowledgeGraph,
  opts: { provider: EmbedProvider; model?: string; previous?: EmbeddingStore | null; onProgress?: (done: number, total: number) => void },
): Promise<EmbeddingStore> {
  const model = opts.model ?? DEFAULT_MODEL[opts.provider];
  const prev = opts.previous && opts.previous.provider === opts.provider && opts.previous.model === model ? opts.previous : null;
  const store: EmbeddingStore = { provider: opts.provider, model, dim: prev?.dim ?? 0, createdAt: new Date().toISOString(), vectors: {}, hashes: {} };
  const todo: Array<{ id: string; text: string; h: string }> = [];
  for (const n of g.nodes) {
    if (!EMBEDDABLE.has(n.kind)) continue;
    const text = embedText(n);
    const h = hash(text);
    if (prev?.hashes[n.id] === h && prev.vectors[n.id]) {
      store.vectors[n.id] = prev.vectors[n.id]!;
      store.hashes[n.id] = h;
    } else todo.push({ id: n.id, text, h });
  }
  const B = 96;
  for (let i = 0; i < todo.length; i += B) {
    const chunk = todo.slice(i, i + B);
    const vecs = await embedBatch(opts.provider, model, chunk.map((c) => c.text));
    chunk.forEach((c, j) => {
      store.vectors[c.id] = toB64(vecs[j]!);
      store.hashes[c.id] = c.h;
      store.dim = vecs[j]!.length;
    });
    opts.onProgress?.(Math.min(i + B, todo.length), todo.length);
  }
  return store;
}

export class EmbeddingIndex {
  private ids: string[] = [];
  private mat: Float32Array[] = [];
  constructor(private store: EmbeddingStore) {
    for (const [id, b64] of Object.entries(store.vectors)) {
      const v = fromB64(b64);
      let n = 0;
      for (const x of v) n += x * x;
      n = Math.sqrt(n) || 1;
      for (let i = 0; i < v.length; i++) v[i]! /= n;
      this.ids.push(id);
      this.mat.push(v);
    }
  }
  get provider() {
    return this.store.provider;
  }
  get model() {
    return this.store.model;
  }
  async query(q: string, limit = 30): Promise<Array<{ id: string; score: number }>> {
    const [qv] = await embedBatch(this.store.provider, this.store.model, [q]);
    let n = 0;
    for (const x of qv!) n += x * x;
    n = Math.sqrt(n) || 1;
    const scores = this.mat.map((v, i) => {
      let dot = 0;
      for (let k = 0; k < v.length; k++) dot += v[k]! * qv![k]!;
      return { id: this.ids[i]!, score: dot / n };
    });
    return scores.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
