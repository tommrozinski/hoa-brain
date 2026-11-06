#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DOC_TYPES, S3, cfg } from "./config.js";
import { search } from "./vectors.js";
import { readJson, type CatalogEntry } from "./catalog.js";
import { getCatalogMap, projectRoot, readSources, renderPdfPage } from "./verify.js";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  asOf, getMeta, money, resolveName, runQuery, sqlBudgetVsActual, sqlTransactionTotals, sqlTransactions,
  sqlVendorSpend, textTable, toCents, type FinanceMeta, type TxnFilter,
} from "./finance.js";
import { log } from "./log.js";

const INSTRUCTIONS = `HOA assistant for one household's HOA documents and budget data.
- For dollar amounts, budgets, spending, vendors or transactions: ALWAYS use the finance tools. Never estimate or compute money from document text, and never do the arithmetic yourself; report what the tool returns and state the "data as of" date.
- For rules, bylaws, CC&Rs, contracts and meeting minutes: use search_documents, quote or closely paraphrase the passages, and cite the document title, section and page.
- If search results look weakly related (high distance) or silent on the question, say the documents may not cover it. Do not fill gaps from general knowledge without labeling it as such.
- Questions that mix both (e.g. "does spending match what the bylaws require?") need both kinds of tool.
- Some documents are flagged "VERIFY" (for example a contract with handwritten notes that text extraction cannot read). For those, never state terms as definitive: say the original has handwritten annotations, give the page numbers, and call view_document_page so the user can see the actual page and so you can read it; if you read handwriting from the image, state clearly that it is your reading and the user should confirm it on the image.
- You provide information, not legal or financial advice. Suggest checking the source document or asking the board/manager for anything consequential.`;

const server = new McpServer({ name: "hoa-brain", version: "0.1.0" }, { instructions: INSTRUCTIONS });

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (name: string, e: any) => {
  log(`${name} error`, e);
  return { isError: true, content: [{ type: "text" as const, text: `${name} failed: ${e?.message ?? e}` }] };
};
const needMeta = async (): Promise<FinanceMeta> => {
  const m = await getMeta();
  if (!m) throw new Error("No finance data has been loaded yet. Run `npm run load:finance` first.");
  return m;
};
const pick = (label: string, input: string | undefined, known: string[]): { value?: string; msg?: string } => {
  if (!input) return {};
  const r = resolveName(input, known);
  if (r.value) return { value: r.value };
  return { msg: `I couldn't match ${label} "${input}" to the data. ${r.candidates.length ? "Did you mean one of: " + r.candidates.join("; ") + "?" : "Use list_finance_options to see valid values."}` };
};

// ---------------- Documents (S3 Vectors) ----------------
server.registerTool(
  "search_documents",
  {
    title: "Search HOA documents",
    description:
      "Semantic search over the HOA's bylaws, CC&Rs, rules, contracts and meeting minutes. Returns the most relevant passages with document title, section, page, date and a distance score (lower = closer). Use filters when the question names a document type or year (e.g. minutes from 2024).",
    inputSchema: {
      query: z.string().min(3).describe("The question or topic, in natural language"),
      doc_type: z.enum(DOC_TYPES).optional().describe("Restrict to one document type"),
      year: z.number().int().min(1990).max(2100).optional().describe("Only documents from this year"),
      from_year: z.number().int().min(1990).max(2100).optional(),
      to_year: z.number().int().min(1990).max(2100).optional(),
      top_k: z.number().int().min(1).max(10).default(cfg.topK),
    },
  },
  async ({ query, doc_type, year, from_year, to_year, top_k }) => {
    try {
      const hits = await search(query, { doc_type, year, from_year, to_year }, top_k);
      if (!hits.length) return text("No matching passages. The documents may not cover this, or the filters are too narrow.");
      const best = Math.min(...hits.map((h) => h.distance));
      const catalog = await getCatalogMap();
      const verifyPages = new Map<string, { note: string; pages: Set<number>; title: string; mode: string }>();
      const body = hits
        .map((h, i) => {
          const entry = catalog.get(h.doc_id);
          const head = `#${i + 1} | ${h.doc_title}${h.section ? ` | ${h.section}` : ""} | p. ${h.page} | ${h.doc_type}${h.doc_date ? ` | ${h.doc_date}` : h.year ? ` | ${h.year}` : ""} | distance ${h.distance.toFixed(3)}`;
          if (!h.verify) return `${head}\n${h.text}`;
          const mode = entry?.verify_mode ?? "warn";
          const note = entry?.verify ?? "A human must verify this document against the original.";
          const v = verifyPages.get(h.doc_id) ?? { note, pages: new Set<number>(), title: h.doc_title, mode };
          v.pages.add(h.page);
          verifyPages.set(h.doc_id, v);
          return mode === "pointer-only"
            ? `${head}\n[VERIFY] Text withheld: this document requires manual verification. Look at the original page ${h.page}.`
            : `${head}\n[VERIFY: printed text only, handwritten notes NOT captured]\n${h.text}`;
        })
        .join("\n\n---\n\n");
      const verifyBlock = [...verifyPages.entries()]
        .map(([id, v]) => `VERIFY MANUALLY: "${v.title}" (doc_id ${id}), pages ${[...v.pages].sort((a, b) => a - b).join(", ")}. ${v.note} Do not treat the text above as final. Call view_document_page with doc_id "${id}" and each page to see the original.`)
        .join("\n");
      const note = (best > cfg.maxDistance ? `\n\n[note] Best distance ${best.toFixed(3)} exceeds ${cfg.maxDistance}: these passages may not actually answer the question.` : "") + (verifyBlock ? `\n\n${verifyBlock}` : "");
      return text(body + note);
    } catch (e) {
      return fail("search_documents", e);
    }
  }
);

server.registerTool(
  "list_documents",
  { title: "List ingested documents", description: "Shows which HOA documents are in the library (type, date, size). Use to answer 'what do you have?' or to check coverage before searching.", inputSchema: {} },
  async () => {
    try {
      const cat = await readJson<CatalogEntry[]>(S3.catalog);
      if (!cat?.length) return text("The library is empty. Run `npm run ingest`.");
      return text(textTable(["type", "title", "date", "pages", "chunks", "verify"], cat.map((c) => [c.doc_type, c.doc_title, c.doc_date ?? String(c.year ?? ""), String(c.pages), String(c.chunks), c.verify ? "YES" : ""])) + (cat.some((c) => c.verify) ? "\n\nVERIFY = flagged: check the original page (view_document_page)." : ""));
    } catch (e) {
      return fail("list_documents", e);
    }
  }
);


server.registerTool(
  "view_document_page",
  {
    title: "View an original document page",
    description:
      "Shows the ORIGINAL page of a PDF as an image (works on this computer only; the originals are not stored in AWS). Use it for documents flagged VERIFY (e.g. handwritten notes), and whenever the user wants to see the source. Get doc_id and page from search_documents or list_documents results.",
    inputSchema: { doc_id: z.string().min(3), page: z.number().int().min(1) },
  },
  async ({ doc_id, page }) => {
    try {
      const src = (await readSources())[doc_id];
      if (!src) return text(`No local original is registered for "${doc_id}". Use list_documents to see valid doc_ids, or re-run ingest on this computer.`);
      const path = isAbsolute(src) ? src : join(projectRoot, src);
      if (!existsSync(path)) return text(`The original file is no longer at ${path}. Put it back there, or re-run ingest.`);
      if (!path.toLowerCase().endsWith(".pdf")) return text("Page images are only available for PDFs. Open this Word/text file directly (or save it as a PDF and re-ingest).");
      const { png, numPages } = await renderPdfPage(path, page);
      const entry = (await getCatalogMap()).get(doc_id);
      return {
        content: [
          { type: "text" as const, text: `${entry?.doc_title ?? doc_id}, page ${page} of ${numPages}.${entry?.verify ? ` VERIFY: ${entry.verify} Read any handwriting from the image, state that it is your reading, and ask the user to confirm it on the image.` : ""}` },
          { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
        ],
      };
    } catch (e) {
      return fail("view_document_page", e);
    }
  }
);

// ---------------- Finance (Athena, deterministic) ----------------
server.registerTool(
  "list_finance_options",
  { title: "List finance categories, funds, vendors, years", description: "Valid fiscal years, categories, funds and vendors in the budget data, plus when the data was last loaded. Call this when unsure how something is named.", inputSchema: {} },
  async () => {
    try {
      const m = await needMeta();
      return text(
        `${asOf(m)}\nFiscal years: ${m.fiscal_years.join(", ")}\nTransactions: ${m.transactions.rows} (${m.transactions.first_date} to ${m.transactions.last_date})\nFunds: ${m.funds.join(", ")}\nCategories (${m.categories.length}): ${m.categories.join("; ")}\nVendors (${m.vendors.length}): ${m.vendors.slice(0, 80).join("; ")}${m.vendors.length > 80 ? "; ..." : ""}`
      );
    } catch (e) {
      return fail("list_finance_options", e);
    }
  }
);

server.registerTool(
  "budget_vs_actual",
  {
    title: "Budget vs actual",
    description: "Budgeted vs actual spending (expenses) for a fiscal year, by category and fund, with remaining amount and percent used. Optionally narrow to one category or fund. Amounts are computed by the server, not estimated.",
    inputSchema: { fiscal_year: z.number().int().min(2000).max(2100), category: z.string().optional(), fund: z.string().optional() },
  },
  async ({ fiscal_year, category, fund }) => {
    try {
      const m = await needMeta();
      const c = pick("category", category, m.categories);
      const f = pick("fund", fund, m.funds);
      if (c.msg || f.msg) return text(c.msg ?? f.msg!);
      const r = await runQuery(sqlBudgetVsActual({ fiscal_year: String(fiscal_year), category: c.value, fund: f.value }));
      if (!r.rows.length) return text(`No budget or expense rows for fiscal year ${fiscal_year}${c.value ? `, category ${c.value}` : ""}. Available years: ${m.fiscal_years.join(", ")}.\n${asOf(m)}`);
      let tb = 0, ta = 0;
      const rows = r.rows.map(([cat, fd, b, a]) => {
        const bc = toCents(b), ac = toCents(a);
        tb += bc; ta += ac;
        return [cat, fd, money(bc), money(ac), money(bc - ac), bc ? `${((ac / bc) * 100).toFixed(1)}%` : "n/a"];
      });
      rows.push(["TOTAL", "", money(tb), money(ta), money(tb - ta), tb ? `${((ta / tb) * 100).toFixed(1)}%` : "n/a"]);
      return text(`Fiscal year ${fiscal_year}: budget vs actual (expenses)\n${textTable(["category", "fund", "budgeted", "actual", "remaining", "used"], rows)}\n\n${asOf(m)}\n[trace] tool=budget_vs_actual athena_scanned_bytes=${r.scannedBytes}`);
    } catch (e) {
      return fail("budget_vs_actual", e);
    }
  }
);

server.registerTool(
  "vendor_spend",
  {
    title: "Spending with a vendor",
    description: "Total paid to a vendor (expenses), by fiscal year and category, with payment counts. Vendor names are matched to the data ('landscap' finds 'GreenScape Landscaping').",
    inputSchema: { vendor: z.string().min(2), fiscal_year: z.number().int().min(2000).max(2100).optional() },
  },
  async ({ vendor, fiscal_year }) => {
    try {
      const m = await needMeta();
      const v = pick("vendor", vendor, m.vendors);
      if (v.msg) return text(v.msg);
      const r = await runQuery(sqlVendorSpend({ vendor: v.value!, fiscal_year: fiscal_year ? String(fiscal_year) : undefined }));
      if (!r.rows.length) return text(`No expense payments to ${v.value}${fiscal_year ? ` in ${fiscal_year}` : ""}.\n${asOf(m)}`);
      let total = 0, n = 0;
      const rows = r.rows.map(([fy, cat, cnt, t]) => {
        total += toCents(t); n += Number(cnt);
        return [fy, cat, cnt, money(toCents(t))];
      });
      rows.push(["TOTAL", "", String(n), money(total)]);
      return text(`Payments to ${v.value}\n${textTable(["fiscal year", "category", "payments", "total"], rows)}\n\n${asOf(m)}\n[trace] tool=vendor_spend athena_scanned_bytes=${r.scannedBytes}`);
    } catch (e) {
      return fail("vendor_spend", e);
    }
  }
);

server.registerTool(
  "list_transactions",
  {
    title: "List transactions",
    description: "Individual transactions matching filters (newest first, up to 100) plus exact totals for ALL matches. Filters: fiscal_year, category, vendor, fund, kind (expense|income), start_date/end_date (YYYY-MM-DD), min_amount.",
    inputSchema: {
      fiscal_year: z.number().int().min(2000).max(2100).optional(),
      category: z.string().optional(), vendor: z.string().optional(), fund: z.string().optional(),
      kind: z.enum(["expense", "income"]).optional(),
      start_date: z.string().optional(), end_date: z.string().optional(),
      min_amount: z.number().optional(),
      limit: z.number().int().min(1).max(100).default(25),
    },
  },
  async (a) => {
    try {
      const m = await needMeta();
      const c = pick("category", a.category, m.categories), v = pick("vendor", a.vendor, m.vendors), f = pick("fund", a.fund, m.funds);
      if (c.msg || v.msg || f.msg) return text((c.msg ?? v.msg ?? f.msg)!);
      const filter: TxnFilter = { fiscal_year: a.fiscal_year ? String(a.fiscal_year) : undefined, category: c.value, vendor: v.value, fund: f.value, kind: a.kind, start_date: a.start_date, end_date: a.end_date, min_amount: a.min_amount };
      const [rows, totals] = await Promise.all([runQuery(sqlTransactions(filter, a.limit)), runQuery(sqlTransactionTotals(filter))]);
      if (!rows.rows.length) return text(`No transactions match those filters.\n${asOf(m)}`);
      const sums = totals.rows.map(([k, n, t]) => `${k}: ${n} transaction(s), ${money(toCents(t))}`).join("; ");
      const body = textTable(["date", "vendor", "category", "fund", "type", "amount", "description"], rows.rows.map(([d, vn, cat, fd, k, amt, desc]) => [d, vn, cat, fd, k, money(toCents(amt)), desc.slice(0, 60)]));
      return text(`${body}\n\nTotals for ALL matches: ${sums}\nShowing up to ${a.limit} newest.\n${asOf(m)}\n[trace] tool=list_transactions athena_scanned_bytes=${rows.scannedBytes + totals.scannedBytes}`);
    } catch (e) {
      return fail("list_transactions", e);
    }
  }
);

await server.connect(new StdioServerTransport());
log(`hoa-brain MCP server running (region=${cfg.region}, index=${cfg.indexName}, athena=${cfg.athenaWorkgroup}/${cfg.athenaDatabase})`);
