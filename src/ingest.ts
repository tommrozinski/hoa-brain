// Usage: npm run ingest [-- --dir inbox/docs] [--only <file name fragment>] [--dry-run] [--no-redact] [--upload-originals]
// Layout:  inbox/docs/<doc_type>/<file>.pdf|docx|txt|md     doc_type = bylaws | ccrs | rules | contract | minutes | other
// Optional: inbox/redaction-terms.txt  (one name / address / unit per line; replaced with [REDACTED])
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { s3 } from "./aws.js";
import { cfg, DOC_TYPES, S3, type DocType } from "./config.js";
import { extractDoc, SUPPORTED } from "./extract.js";
import { redact } from "./redact.js";
import { chunkPages } from "./chunk.js";
import { embed } from "./embed.js";
import { putVectors, type VectorRecord } from "./vectors.js";
import { readJson, writeJson, type CatalogEntry } from "./catalog.js";
import { loadDocFlags, matchFlag, writeSources } from "./verify.js";

const args = process.argv.slice(2);
const val = (n: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
const root = fileURLToPath(new URL("../", import.meta.url));
const dir = val("dir") ?? join(root, "inbox/docs");
const only = val("only")?.toLowerCase();
const dryRun = args.includes("--dry-run");
const doRedact = !args.includes("--no-redact");
const uploadOriginals = args.includes("--upload-originals");

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
const cleanTitle = (f: string) => basename(f, extname(f)).replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
// New AWS accounts start with low Bedrock rate limits; embed one chunk at a time to stay under them.
const EMBED_CONCURRENCY = 1;

function parseDates(name: string): { doc_date?: string; year?: number } {
  const full = /(20\d{2}|19\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])/.exec(name);
  if (full) return { doc_date: `${full[1]}-${full[2]}-${full[3]}`, year: Number(full[1]) };
  const y = /(20\d{2}|19\d{2})/.exec(name);
  return y ? { year: Number(y[1]) } : {};
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

async function listFiles(): Promise<{ docType: DocType; path: string }[]> {
  if (!existsSync(dir)) throw new Error(`Folder not found: ${dir}\nCreate it and add files under <doc_type>/ subfolders (${DOC_TYPES.join(", ")}).`);
  const found: { docType: DocType; path: string }[] = [];
  for (const entry of await readdir(dir)) {
    const p = join(dir, entry);
    if (!(await stat(p)).isDirectory()) continue;
    if (!(DOC_TYPES as readonly string[]).includes(entry)) {
      console.warn(`SKIP folder "${entry}": not one of ${DOC_TYPES.join(", ")}`);
      continue;
    }
    for (const f of await readdir(p)) {
      if (SUPPORTED.includes(extname(f).toLowerCase()) && (!only || f.toLowerCase().includes(only)))
        found.push({ docType: entry as DocType, path: join(p, f) });
    }
  }
  return found;
}

const termsPath = join(root, "inbox/redaction-terms.txt");
const terms = doRedact && existsSync(termsPath) ? (await readFile(termsPath, "utf8")).split(/\r?\n/).filter(Boolean) : [];
console.log(`Redaction: ${doRedact ? `ON (built-in patterns + ${terms.length} custom term(s))` : "OFF"}`);

const flags = await loadDocFlags();
const localSources: Record<string, string> = {};
const files = await listFiles();
if (files.length === 0) console.log("No documents found.");
const catalogNew: CatalogEntry[] = [];
let totalChunks = 0,
  totalChars = 0;

for (const f of files) {
  const name = basename(f.path);
  const { pages, likelyScanned } = await extractDoc(f.path);
  if (likelyScanned) {
    console.error(`\nSKIP ${name}: almost no text layer (scanned?). OCR is not part of this build; run it through OCR first.`);
    continue;
  }
  let redactions: Record<string, number> = {};
  const safePages = doRedact
    ? pages.map((p) => {
        const r = redact(p, terms);
        for (const [k, v] of Object.entries(r.counts)) redactions[k] = (redactions[k] ?? 0) + v;
        return r.text;
      })
    : pages;

  const chunks = chunkPages(safePages, cfg.chunkChars, cfg.chunkOverlapChars);
  totalChunks += chunks.length;
  totalChars += chunks.reduce((s, c) => s + c.text.length, 0);
  const docId = `${f.docType}-${slug(basename(name, extname(name)))}`;
  const { doc_date, year } = parseDates(name);
  const flag = matchFlag(name, flags);
  const title = flag?.title ?? cleanTitle(name);
  if (flag?.verify) console.log(`   FLAGGED for manual verification (${flag.mode ?? "warn"}): ${flag.verify}`);

  console.log(`\n${docId}: ${pages.length} page(s) -> ${chunks.length} chunk(s); date=${doc_date ?? year ?? "n/a"}; redactions=${JSON.stringify(redactions)}`);
  for (const c of [...new Set([chunks[0], chunks[Math.floor(chunks.length / 2)]])].filter(Boolean))
    console.log(`   sample p.${c.page}${c.section ? ` [${c.section}]` : ""}: ${c.text.slice(0, 150).replace(/\s+/g, " ")}...`);
  if (dryRun) continue;

  if (uploadOriginals)
    await s3.send(new PutObjectCommand({ Bucket: cfg.dataBucket, Key: `${S3.originals}${f.docType}/${name}`, Body: await readFile(f.path) }));

  const records: VectorRecord[] = await pool(chunks, EMBED_CONCURRENCY, async (c) => ({
    key: `${docId}#p${c.page}#c${c.index}`,
    embedding: await embed(c.text),
    metadata: {
      doc_type: f.docType,
      doc_id: docId,
      doc_title: title,
      ...(year !== undefined ? { year } : {}),
      ...(doc_date ? { doc_date } : {}),
      page: c.page,
      section: c.section,
      ...(flag?.verify ? { verify: true } : {}),
      source_text: c.text,
    },
  }));
  await putVectors(records);
  catalogNew.push({ doc_id: docId, doc_title: title, doc_type: f.docType, doc_date, year, pages: pages.length, chunks: chunks.length, ingested_at: new Date().toISOString(), verify: flag?.verify, verify_mode: flag?.verify ? (flag.mode ?? "warn") : undefined });
  localSources[docId] = f.path.startsWith(root) ? f.path.slice(root.length) : f.path;
  console.log(`   stored ${records.length} vectors`);
}

if (!dryRun && catalogNew.length) {
  await writeSources(localSources); // local only: lets view_document_page show the original page
  const existing = (await readJson<CatalogEntry[]>(S3.catalog)) ?? [];
  const merged = new Map(existing.map((e) => [e.doc_id, e]));
  catalogNew.forEach((e) => merged.set(e.doc_id, e));
  await writeJson(S3.catalog, [...merged.values()].sort((a, b) => a.doc_id.localeCompare(b.doc_id)));
}
console.log(`\nDone. ${files.length} file(s), ${totalChunks} chunk(s), ~${Math.round(totalChars / 4).toLocaleString()} tokens${dryRun ? " (dry run: nothing written)" : " embedded"}.`);
