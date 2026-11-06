// Pure functions: turn a Google Sheet CSV export into clean, typed rows. No AWS here, so it is easy to test.
import { redact } from "./redact.js";

export interface TableMapping {
  file: string;
  columns: Record<string, string[]>; // canonical column -> acceptable header names (case-insensitive)
  default_fund?: string;
  // transactions only:
  amount_sign?: "expenses_positive" | "expenses_negative"; // used when there is no "kind" column
  kind_values?: { expense: string[]; income: string[] };
}
export interface FinanceMapping {
  transactions: TableMapping;
  budget: TableMapping;
  fiscal_year_start_month?: number; // 1 = calendar year. If >1, FY is named for the calendar year in which it ENDS.
}

export interface TxnRow {
  txn_id: string;
  txn_date: string;
  fiscal_year: string;
  category: string;
  vendor: string;
  description: string;
  amount: string; // always positive, 2 decimals
  kind: "expense" | "income";
  fund: string;
}
export interface BudgetRow {
  fiscal_year: string;
  category: string;
  fund: string;
  budgeted_amount: string;
}
export interface Reject {
  line: number;
  reason: string;
}

export const TXN_COLUMNS = ["txn_id", "txn_date", "fiscal_year", "category", "vendor", "description", "amount", "kind", "fund"] as const;
export const BUDGET_COLUMNS = ["fiscal_year", "category", "fund", "budgeted_amount"] as const;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Map each canonical column to the actual header found in the sheet. */
export function resolveHeaders(headers: string[], aliases: Record<string, string[]>) {
  const byNorm = new Map(headers.map((h) => [norm(h), h]));
  const map: Record<string, string> = {};
  for (const [canon, names] of Object.entries(aliases)) {
    for (const n of [canon, ...names]) {
      const h = byNorm.get(norm(n));
      if (h) {
        map[canon] = h;
        break;
      }
    }
  }
  return map;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function parseDate(raw: string): string | undefined {
  const s = raw.trim();
  let y: number, m: number, d: number;
  let r: RegExpExecArray | null;
  if ((r = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) [y, m, d] = [+r[1], +r[2], +r[3]];
  else if ((r = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s))) {
    [m, d] = [+r[1], +r[2]];
    y = r[3].length === 2 ? 2000 + +r[3] : +r[3];
  } else if ((r = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s))) {
    m = MONTHS.indexOf(r[1].toLowerCase()) + 1;
    [d, y] = [+r[2], +r[3]];
  } else return undefined;
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1990 && y <= 2100)) return undefined;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function parseAmount(raw: string): number | undefined {
  let s = raw.trim();
  if (!s || s === "-") return undefined;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[$,\s]/g, "");
  if (s.startsWith("-")) {
    neg = !neg;
    s = s.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return undefined;
  const n = Number(s);
  return neg ? -n : n;
}

export const fiscalYearOf = (iso: string, startMonth = 1): string => {
  const y = +iso.slice(0, 4);
  const m = +iso.slice(5, 7);
  return String(startMonth > 1 && m >= startMonth ? y + 1 : y);
};

const clean = (s: string) => s.replace(/"/g, "'").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();

export function normalizeTransactions(
  rows: Record<string, string>[],
  headers: string[],
  mapping: FinanceMapping,
  terms: string[] = []
): { rows: TxnRow[]; rejects: Reject[]; missing: string[] } {
  const t = mapping.transactions;
  const h = resolveHeaders(headers, t.columns);
  const missing = ["txn_date", "category", "amount"].filter((c) => !h[c]);
  if (missing.length) return { rows: [], rejects: [], missing };

  const kindOf = (v: string): "expense" | "income" | undefined => {
    const x = v.trim().toLowerCase();
    if (t.kind_values?.expense.map((e) => e.toLowerCase()).includes(x)) return "expense";
    if (t.kind_values?.income.map((e) => e.toLowerCase()).includes(x)) return "income";
    return undefined;
  };

  const out: TxnRow[] = [];
  const rejects: Reject[] = [];
  rows.forEach((r, i) => {
    const line = i + 2; // header is line 1
    const date = parseDate(r[h.txn_date] ?? "");
    const amt = parseAmount(r[h.amount] ?? "");
    const category = clean(r[h.category] ?? "");
    if (!date) return void rejects.push({ line, reason: `unparseable date "${r[h.txn_date] ?? ""}"` });
    if (amt === undefined) return void rejects.push({ line, reason: `unparseable amount "${r[h.amount] ?? ""}"` });
    if (!category) return void rejects.push({ line, reason: "empty category" });

    let kind: "expense" | "income";
    if (h.kind) {
      const k = kindOf(r[h.kind] ?? "");
      if (!k) return void rejects.push({ line, reason: `unknown type "${r[h.kind] ?? ""}" (add it to kind_values)` });
      kind = k;
    } else {
      const expensesPositive = (t.amount_sign ?? "expenses_positive") === "expenses_positive";
      kind = amt >= 0 === expensesPositive ? "expense" : "income";
    }
    const fund = clean(h.fund ? (r[h.fund] ?? "") : "") || t.default_fund || "operating";
    out.push({
      txn_id: `T${String(out.length + 1).padStart(6, "0")}`,
      txn_date: date,
      fiscal_year: fiscalYearOf(date, mapping.fiscal_year_start_month),
      category,
      vendor: redact(clean(h.vendor ? (r[h.vendor] ?? "") : ""), terms).text,
      description: redact(clean(h.description ? (r[h.description] ?? "") : ""), terms).text,
      amount: Math.abs(amt).toFixed(2),
      kind,
      fund,
    });
  });
  return { rows: out, rejects, missing: [] };
}

export function normalizeBudget(
  rows: Record<string, string>[],
  headers: string[],
  mapping: FinanceMapping
): { rows: BudgetRow[]; rejects: Reject[]; missing: string[] } {
  const t = mapping.budget;
  const h = resolveHeaders(headers, t.columns);
  const missing = ["fiscal_year", "category", "budgeted_amount"].filter((c) => !h[c]);
  if (missing.length) return { rows: [], rejects: [], missing };
  const out: BudgetRow[] = [];
  const rejects: Reject[] = [];
  rows.forEach((r, i) => {
    const line = i + 2;
    const fy = /(\d{4})/.exec(r[h.fiscal_year] ?? "")?.[1];
    const amt = parseAmount(r[h.budgeted_amount] ?? "");
    const category = clean(r[h.category] ?? "");
    if (!fy) return void rejects.push({ line, reason: `no 4-digit year in "${r[h.fiscal_year] ?? ""}"` });
    if (amt === undefined) return void rejects.push({ line, reason: `unparseable amount "${r[h.budgeted_amount] ?? ""}"` });
    if (!category) return void rejects.push({ line, reason: "empty category" });
    out.push({
      fiscal_year: fy,
      category,
      fund: clean(h.fund ? (r[h.fund] ?? "") : "") || t.default_fund || "operating",
      budgeted_amount: Math.abs(amt).toFixed(2),
    });
  });
  return { rows: out, rejects, missing: [] };
}
