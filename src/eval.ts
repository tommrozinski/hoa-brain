// Retrieval check for YOUR documents. Usage: npm run eval
// Edit eval/doc-queries.json: put real questions about your documents and which doc_type should answer them.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { cfg } from "./config.js";
import { search } from "./vectors.js";

interface Case { query: string; expect_doc_type?: string; filters?: Record<string, unknown>; note?: string }
const cases: Case[] = JSON.parse(await readFile(fileURLToPath(new URL("../eval/doc-queries.json", import.meta.url)), "utf8")).cases;

const rows: string[][] = [["query", "best", "top-3 (title [section] @distance)", "type ok?"]];
for (const c of cases) {
  const hits = await search(c.query, (c.filters ?? {}) as any, cfg.topK);
  const best = hits.length ? Math.min(...hits.map((h) => h.distance)) : Infinity;
  const top = hits.slice(0, 3).map((h) => `${h.doc_title}${h.section ? ` [${h.section}]` : ""}@${h.distance.toFixed(2)}`).join("; ");
  const ok = c.expect_doc_type ? (hits.slice(0, 3).some((h) => h.doc_type === c.expect_doc_type) ? "yes" : "NO") : "-";
  rows.push([c.query.slice(0, 50), Number.isFinite(best) ? best.toFixed(3) : "n/a", top.slice(0, 110), ok]);
}
const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
rows.forEach((r, k) => {
  console.log(r.map((x, i) => x.padEnd(w[i])).join("  |  "));
  if (k === 0) console.log(w.map((n) => "-".repeat(n)).join("--+--"));
});
console.log(`\nDistance hint threshold: ${cfg.maxDistance}. Add one or two questions your documents do NOT answer and set MAX_DISTANCE just below their best distance.`);
