// Documents that need a human eye (e.g. a contract with handwritten notes that text extraction cannot read).
//  - inbox/docs-config.json flags them at ingest time (see data/docs-config.example.json)
//  - search results from flagged documents always carry a verify warning (or withhold text in "pointer-only" mode)
//  - view_document_page renders the ORIGINAL page as an image so you (and Claude's vision) can read the handwriting
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocumentProxy, renderPageAsImage } from "unpdf";
import { readJson, type CatalogEntry } from "./catalog.js";
import { S3 } from "./config.js";

export const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const sourcesPath = join(projectRoot, "inbox/.sources.json");

export type VerifyMode = "warn" | "pointer-only";
export interface DocFlag {
  title?: string;
  verify?: string; // why a human must check (shown to the user)
  mode?: VerifyMode;
}

export async function loadDocFlags(): Promise<Record<string, DocFlag>> {
  const p = join(projectRoot, "inbox/docs-config.json");
  if (!existsSync(p)) return {};
  return (JSON.parse(await readFile(p, "utf8")).files ?? {}) as Record<string, DocFlag>;
}

/** Keys in docs-config.json are case-insensitive substrings of the file name. */
export function matchFlag(fileName: string, flags: Record<string, DocFlag>): DocFlag | undefined {
  const f = fileName.toLowerCase();
  for (const [key, flag] of Object.entries(flags)) if (!key.startsWith("_") && f.includes(key.toLowerCase())) return flag;
  return undefined;
}

// ---- local registry: doc_id -> original file (stays on your laptop; never uploaded) ----
export async function readSources(): Promise<Record<string, string>> {
  return existsSync(sourcesPath) ? JSON.parse(await readFile(sourcesPath, "utf8")) : {};
}
export async function writeSources(add: Record<string, string>): Promise<void> {
  await writeFile(sourcesPath, JSON.stringify({ ...(await readSources()), ...add }, null, 2));
}

// ---- catalog lookup (cached) ----
let cat: { at: number; map: Map<string, CatalogEntry> } | undefined;
export async function getCatalogMap(): Promise<Map<string, CatalogEntry>> {
  if (!cat || Date.now() - cat.at > 60_000) {
    const list = (await readJson<CatalogEntry[]>(S3.catalog)) ?? [];
    cat = { at: Date.now(), map: new Map(list.map((e) => [e.doc_id, e])) };
  }
  return cat.map;
}

// ---- page rendering ----
export async function renderPdfPage(path: string, page: number, scale = 1.5): Promise<{ png: Buffer; numPages: number }> {
  const pdf = await getDocumentProxy(new Uint8Array(await readFile(path)));
  if (page < 1 || page > pdf.numPages) throw new Error(`Page ${page} is out of range (document has ${pdf.numPages} pages).`);
  const img = await renderPageAsImage(pdf, page, { canvasImport: () => import("@napi-rs/canvas"), scale });
  return { png: Buffer.from(img), numPages: pdf.numPages };
}
