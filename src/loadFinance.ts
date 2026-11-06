// Usage: npm run load:finance [-- --dry-run]
// Reads your Google Sheet CSV exports, validates/normalizes them, and writes clean CSVs to S3 for Athena.
//   inbox/finance/transactions.csv   inbox/finance/budget.csv      (names/headers configurable in data/finance-mapping.json)
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { s3 } from "./aws.js";
import { cfg, S3 } from "./config.js";
import { writeJson } from "./catalog.js";
import {
  BUDGET_COLUMNS,
  TXN_COLUMNS,
  normalizeBudget,
  normalizeTransactions,
  type FinanceMapping,
  type Reject,
} from "./financeData.js";

const dryRun = process.argv.includes("--dry-run");
const root = fileURLToPath(new URL("../", import.meta.url));
const mapping: FinanceMapping = JSON.parse(await readFile(join(root, "data/finance-mapping.json"), "utf8"));
const termsPath = join(root, "inbox/redaction-terms.txt");
const terms = existsSync(termsPath) ? (await readFile(termsPath, "utf8")).split(/\r?\n/).filter(Boolean) : [];

function readCsv(file: string) {
  const p = join(root, file);
  if (!existsSync(p)) throw new Error(`Missing ${file}. In Google Sheets: File > Download > Comma-separated values (.csv) for each tab.`);
  const text = readFileSync(p, "utf8");
  const records: Record<string, string>[] = parse(text, { columns: true, bom: true, skip_empty_lines: true, trim: true, relax_column_count: true });
  const headers = text.split(/\r?\n/)[0].replace(/^\uFEFF/, "").split(",").map((x) => x.replace(/^"|"$/g, "").trim());
  return { records, headers: records.length ? Object.keys(records[0]) : headers };
}

function report(name: string, ok: number, rejects: Reject[]) {
  console.log(`${name}: ${ok} row(s) accepted, ${rejects.length} rejected`);
  rejects.slice(0, 10).forEach((r) => console.log(`   line ${r.line}: ${r.reason}`));
  if (rejects.length > 10) console.log(`   ... and ${rejects.length - 10} more`);
}

const tx = readCsv(mapping.transactions.file);
const txn = normalizeTransactions(tx.records, tx.headers, mapping, terms);
if (txn.missing.length) throw new Error(`transactions: could not find columns for ${txn.missing.join(", ")}. Sheet headers: ${tx.headers.join(" | ")}. Add aliases in data/finance-mapping.json.`);
const bd = readCsv(mapping.budget.file);
const bud = normalizeBudget(bd.records, bd.headers, mapping);
if (bud.missing.length) throw new Error(`budget: could not find columns for ${bud.missing.join(", ")}. Sheet headers: ${bd.headers.join(" | ")}. Add aliases in data/finance-mapping.json.`);

report("transactions", txn.rows.length, txn.rejects);
report("budget", bud.rows.length, bud.rejects);

const uniq = (xs: string[]) => [...new Set(xs)].sort((a, b) => a.localeCompare(b));
const years = uniq([...txn.rows.map((r) => r.fiscal_year), ...bud.rows.map((r) => r.fiscal_year)]);
const dates = txn.rows.map((r) => r.txn_date).sort();
const meta = {
  loaded_at: new Date().toISOString(),
  source_files: [mapping.transactions.file, mapping.budget.file],
  transactions: { rows: txn.rows.length, rejected: txn.rejects.length, first_date: dates[0], last_date: dates[dates.length - 1] },
  budget: { rows: bud.rows.length, rejected: bud.rejects.length },
  fiscal_years: years,
  categories: uniq([...txn.rows.map((r) => r.category), ...bud.rows.map((r) => r.category)]),
  funds: uniq([...txn.rows.map((r) => r.fund), ...bud.rows.map((r) => r.fund)]),
  vendors: uniq(txn.rows.map((r) => r.vendor).filter(Boolean)),
};
console.log(`\nfiscal years: ${years.join(", ")}; ${meta.categories.length} categories; ${meta.funds.length} fund(s): ${meta.funds.join(", ")}; ${meta.vendors.length} vendors`);
console.log(`transaction dates: ${meta.transactions.first_date} to ${meta.transactions.last_date}`);

if (dryRun) {
  console.log("\n(dry run: nothing uploaded)");
  process.exit(0);
}
if (txn.rejects.length || bud.rejects.length) console.warn("\nNote: rejected rows are NOT loaded. Fix the sheet or mapping and re-run if they matter.");

const csv = (rows: object[], cols: readonly string[]) => stringify(rows, { header: false, columns: cols as string[] });
await s3.send(new PutObjectCommand({ Bucket: cfg.dataBucket, Key: `${S3.transactions}transactions.csv`, Body: csv(txn.rows, TXN_COLUMNS), ContentType: "text/csv" }));
await s3.send(new PutObjectCommand({ Bucket: cfg.dataBucket, Key: `${S3.budget}budget.csv`, Body: csv(bud.rows, BUDGET_COLUMNS), ContentType: "text/csv" }));
await writeJson(S3.financeMeta, meta);
console.log("\nUploaded. Athena tables read these files directly; no further steps.");
