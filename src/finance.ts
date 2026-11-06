// Deterministic financial tools. Fixed, parameterized SQL against Athena. The model never writes SQL and never does arithmetic.
import { GetQueryExecutionCommand, GetQueryResultsCommand, StartQueryExecutionCommand } from "@aws-sdk/client-athena";
import { athena } from "./aws.js";
import { cfg, S3 } from "./config.js";
import { readJson } from "./catalog.js";

export interface FinanceMeta {
  loaded_at: string;
  source_files: string[];
  transactions: { rows: number; rejected: number; first_date?: string; last_date?: string };
  budget: { rows: number; rejected: number };
  fiscal_years: string[];
  categories: string[];
  funds: string[];
  vendors: string[];
}

let metaCache: { at: number; value?: FinanceMeta } | undefined;
export async function getMeta(): Promise<FinanceMeta | undefined> {
  if (!metaCache || Date.now() - metaCache.at > 60_000)
    metaCache = { at: Date.now(), value: await readJson<FinanceMeta>(S3.financeMeta) };
  return metaCache.value;
}

// ---------- input validation / escaping (pure, tested offline) ----------
export const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;
export function checkYear(y: unknown): string {
  const s = String(y);
  if (!/^\d{4}$/.test(s)) throw new Error(`fiscal_year must be a 4-digit year, got "${s}"`);
  return s;
}
export function checkDate(d: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`dates must be YYYY-MM-DD, got "${d}"`);
  return d;
}

export type Resolved = { value?: string; candidates: string[] };
/** Match free text ("landscaping") to a real value from the data ("Landscaping & Grounds"). Exact > unique substring > unique token overlap. */
export function resolveName(input: string, known: string[]): Resolved {
  const n = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const q = n(input);
  const exact = known.filter((k) => n(k) === q);
  if (exact.length === 1) return { value: exact[0], candidates: [] };
  const sub = known.filter((k) => n(k).includes(q) || q.includes(n(k)));
  if (sub.length === 1) return { value: sub[0], candidates: [] };
  if (sub.length > 1) return { candidates: sub.slice(0, 8) };
  const toks = q.split(" ").filter((t) => t.length > 2);
  const overlap = known.filter((k) => toks.some((t) => n(k).split(" ").includes(t)));
  if (overlap.length === 1) return { value: overlap[0], candidates: [] };
  return { candidates: overlap.slice(0, 8) };
}

// ---------- SQL builders (pure) ----------
const AMT = "CAST(amount AS DECIMAL(14,2))";
export interface TxnFilter {
  fiscal_year?: string;
  category?: string;
  vendor?: string;
  fund?: string;
  kind?: "expense" | "income";
  start_date?: string;
  end_date?: string;
  min_amount?: number;
}
export function txnWhere(f: TxnFilter): string {
  const c: string[] = [];
  if (f.fiscal_year) c.push(`fiscal_year = ${sqlString(checkYear(f.fiscal_year))}`);
  if (f.category) c.push(`category = ${sqlString(f.category)}`);
  if (f.vendor) c.push(`vendor = ${sqlString(f.vendor)}`);
  if (f.fund) c.push(`fund = ${sqlString(f.fund)}`);
  if (f.kind) c.push(`kind = ${sqlString(f.kind)}`);
  if (f.start_date) c.push(`txn_date >= ${sqlString(checkDate(f.start_date))}`);
  if (f.end_date) c.push(`txn_date <= ${sqlString(checkDate(f.end_date))}`);
  if (f.min_amount !== undefined) {
    if (!Number.isFinite(f.min_amount)) throw new Error("min_amount must be a number");
    c.push(`${AMT} >= ${f.min_amount}`);
  }
  return c.length ? `WHERE ${c.join(" AND ")}` : "";
}

export function sqlBudgetVsActual(p: { fiscal_year: string; category?: string; fund?: string }): string {
  const fy = sqlString(checkYear(p.fiscal_year));
  const bw = [`fiscal_year = ${fy}`, p.category && `category = ${sqlString(p.category)}`, p.fund && `fund = ${sqlString(p.fund)}`].filter(Boolean).join(" AND ");
  const tw = [`fiscal_year = ${fy}`, `kind = 'expense'`, p.category && `category = ${sqlString(p.category)}`, p.fund && `fund = ${sqlString(p.fund)}`].filter(Boolean).join(" AND ");
  return `WITH b AS (
  SELECT category, fund, SUM(CAST(budgeted_amount AS DECIMAL(14,2))) AS budgeted FROM budget WHERE ${bw} GROUP BY category, fund
), t AS (
  SELECT category, fund, SUM(${AMT}) AS actual FROM transactions WHERE ${tw} GROUP BY category, fund
)
SELECT COALESCE(b.category, t.category) AS category, COALESCE(b.fund, t.fund) AS fund,
       COALESCE(b.budgeted, CAST(0 AS DECIMAL(14,2))) AS budgeted, COALESCE(t.actual, CAST(0 AS DECIMAL(14,2))) AS actual
FROM b FULL OUTER JOIN t ON b.category = t.category AND b.fund = t.fund
ORDER BY 1, 2`;
}

export function sqlVendorSpend(p: { vendor: string; fiscal_year?: string }): string {
  return `SELECT fiscal_year, category, COUNT(*) AS payments, SUM(${AMT}) AS total FROM transactions ${txnWhere({ vendor: p.vendor, fiscal_year: p.fiscal_year, kind: "expense" })} GROUP BY fiscal_year, category ORDER BY fiscal_year, category`;
}

export function sqlTransactions(f: TxnFilter, limit: number): string {
  const lim = Math.min(Math.max(Math.trunc(limit), 1), 100);
  return `SELECT txn_date, vendor, category, fund, kind, description, amount FROM transactions ${txnWhere(f)} ORDER BY txn_date DESC, txn_id LIMIT ${lim}`;
}
export function sqlTransactionTotals(f: TxnFilter): string {
  return `SELECT kind, COUNT(*) AS n, SUM(${AMT}) AS total FROM transactions ${txnWhere(f)} GROUP BY kind ORDER BY kind`;
}

// ---------- money helpers (integer cents; no float drift) ----------
export const toCents = (s: string | undefined) => Math.round(Number(s ?? "0") * 100);
export const money = (cents: number) =>
  (cents < 0 ? "-" : "") + "$" + (Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function textTable(headers: string[], rows: string[][]): string {
  const w = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]) => r.map((c, i) => (c ?? "").padEnd(w[i])).join("  ");
  return [line(headers), w.map((n) => "-".repeat(n)).join("  "), ...rows.map(line)].join("\n");
}

// ---------- Athena runner ----------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export interface QueryResult {
  columns: string[];
  rows: string[][];
  scannedBytes: number;
}
export async function runQuery(sql: string, timeoutMs = 60_000): Promise<QueryResult> {
  const { QueryExecutionId: id } = await athena.send(
    new StartQueryExecutionCommand({
      QueryString: sql,
      WorkGroup: cfg.athenaWorkgroup,
      QueryExecutionContext: { Database: cfg.athenaDatabase },
    })
  );
  if (!id) throw new Error("Athena did not return a query id");
  const t0 = Date.now();
  for (let delay = 400; ; delay = Math.min(delay * 1.5, 2000)) {
    const { QueryExecution: q } = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId: id }));
    const state = q?.Status?.State;
    if (state === "SUCCEEDED") {
      const res = await athena.send(new GetQueryResultsCommand({ QueryExecutionId: id, MaxResults: 1000 }));
      const all = (res.ResultSet?.Rows ?? []).map((r) => (r.Data ?? []).map((d) => d.VarCharValue ?? ""));
      return { columns: all[0] ?? [], rows: all.slice(1), scannedBytes: Number(q?.Statistics?.DataScannedInBytes ?? 0) };
    }
    if (state === "FAILED" || state === "CANCELLED") {
      const why = q?.Status?.StateChangeReason ?? "unknown reason";
      const hint = /TABLE_NOT_FOUND|does not exist/i.test(why) ? " (Has the stack been deployed and `npm run load:finance` been run?)" : "";
      throw new Error(`Athena query ${state}: ${why}${hint}`);
    }
    if (Date.now() - t0 > timeoutMs) throw new Error("Athena query timed out");
    await sleep(delay);
  }
}

export const asOf = (m: FinanceMeta) => `Data as of ${m.loaded_at.slice(0, 10)} (loaded from ${m.source_files.join(", ")}).`;
