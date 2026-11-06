// Offline self-test (no AWS, no real data). Uses small synthetic strings. Run: npm run selftest
import assert from "node:assert/strict";
import { chunkPages } from "../src/chunk.js";
import { redact } from "../src/redact.js";
import { normalizeBudget, normalizeTransactions, parseAmount, parseDate, fiscalYearOf, resolveHeaders, type FinanceMapping } from "../src/financeData.js";
import { resolveName, sqlBudgetVsActual, sqlString, sqlTransactions, sqlVendorSpend, txnWhere, toCents, money, checkYear } from "../src/finance.js";
import { buildFilter } from "../src/vectors.js";
import { matchFlag } from "../src/verify.js";

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log("ok  ", name); };

t("chunker tags Article/Section and pages", () => {
  const filler = (s: string) => (s + " ").repeat(120);
  const pages = [
    `ARTICLE I\nName and Purpose\nSection 1. Name. ${filler("The association is a nonprofit.")}`,
    `ARTICLE VI\nAssessments\nSection 3. Special Assessments. ${filler("Special assessments require a vote of the members.")}`,
  ];
  const chunks = chunkPages(pages, 600, 60);
  assert.ok(chunks.length >= 4);
  assert.equal(chunks[0].section, "Article I, Section 1");
  const special = chunks.find((c) => c.text.includes("Special assessments require"))!;
  assert.equal(special.section, "Article VI, Section 3");
  assert.equal(special.page, 2);
  assert.ok(special.text.startsWith("[Article VI, Section 3]"));
});

t("redaction: patterns and custom terms", () => {
  const r = redact("Call Jane Doe at (555) 123-4567 or jane@example.com. Acct 123456789012. SSN 123-45-6789. Unit 12 Elm Court.", ["Jane Doe", "Elm Court"]);
  assert.ok(!/555|example|123456789012|123-45-6789|Jane|Elm Court/.test(r.text), r.text);
  assert.ok(r.text.includes("Unit 12"));
  assert.equal(r.counts.email, 1);
});

t("dates and amounts", () => {
  assert.equal(parseDate("3/7/2024"), "2024-03-07");
  assert.equal(parseDate("2024-03-07"), "2024-03-07");
  assert.equal(parseDate("Mar 7, 2024"), "2024-03-07");
  assert.equal(parseDate("13/45/2024"), undefined);
  assert.equal(parseAmount("$1,234.50"), 1234.5);
  assert.equal(parseAmount("(250.00)"), -250);
  assert.equal(parseAmount("-$40"), -40);
  assert.equal(parseAmount("abc"), undefined);
  assert.equal(fiscalYearOf("2024-09-15", 7), "2025");
  assert.equal(fiscalYearOf("2024-03-15", 7), "2024");
  assert.equal(fiscalYearOf("2024-12-31", 1), "2024");
});

const mapping: FinanceMapping = {
  fiscal_year_start_month: 1,
  transactions: {
    file: "x", columns: { txn_date: ["Date"], category: ["Category"], vendor: ["Payee"], description: ["Memo"], amount: ["Amount"], kind: ["Type"], fund: ["Fund"] },
    kind_values: { expense: ["expense", "check"], income: ["income", "deposit"] }, default_fund: "operating",
  },
  budget: { file: "y", columns: { fiscal_year: ["Year"], category: ["Category"], fund: ["Fund"], budgeted_amount: ["Budget"] }, default_fund: "operating" },
};

t("transactions normalization with a type column", () => {
  const headers = ["date", "CATEGORY", "payee", "memo", "Amount", "type"];
  const rows = [
    { date: "1/15/2024", CATEGORY: "Landscaping", payee: "Green Co", memo: 'Mow "weekly"', Amount: "$1,500.00", type: "Check" },
    { date: "2/01/2024", CATEGORY: "Assessments", payee: "", memo: "Dues", Amount: "20,000", type: "Deposit" },
    { date: "bad", CATEGORY: "X", payee: "", memo: "", Amount: "1", type: "Check" },
    { date: "3/1/2024", CATEGORY: "X", payee: "", memo: "", Amount: "1", type: "Mystery" },
  ];
  const r = normalizeTransactions(rows, headers, mapping);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rejects.length, 2);
  assert.equal(r.rows[0].kind, "expense");
  assert.equal(r.rows[0].amount, "1500.00");
  assert.ok(!r.rows[0].description.includes('"'));
  assert.equal(r.rows[1].kind, "income");
  assert.equal(r.rows[0].fund, "operating");
});

t("transactions normalization by sign convention + missing columns", () => {
  const m2 = structuredClone(mapping);
  delete (m2.transactions.columns as any).kind;
  m2.transactions.amount_sign = "expenses_negative";
  const r = normalizeTransactions([{ date: "1/1/2024", CATEGORY: "Insurance", Amount: "(900.00)" }], ["date", "CATEGORY", "Amount"], m2);
  assert.equal(r.rows[0].kind, "expense");
  assert.equal(r.rows[0].amount, "900.00");
  const bad = normalizeTransactions([], ["foo", "bar"], mapping);
  assert.deepEqual(bad.missing, ["txn_date", "category", "amount"]);
});

t("budget normalization", () => {
  const r = normalizeBudget([{ Year: "FY2024", Category: "Insurance", Budget: "$12,000" }], ["Year", "Category", "Budget"], mapping);
  assert.equal(r.rows[0].fiscal_year, "2024");
  assert.equal(r.rows[0].budgeted_amount, "12000.00");
});

t("header alias resolution ignores case/punctuation", () => {
  assert.deepEqual(resolveHeaders(["Transaction Date", "AMOUNT"], { txn_date: ["transaction-date"], amount: ["Amount"] }), { txn_date: "Transaction Date", amount: "AMOUNT" });
});

t("name resolution", () => {
  const cats = ["Landscaping & Grounds", "Insurance", "Reserve Contribution", "Pool Maintenance", "Pool Repairs"];
  assert.equal(resolveName("landscaping", cats).value, "Landscaping & Grounds");
  assert.equal(resolveName("insurance", cats).value, "Insurance");
  assert.deepEqual(resolveName("pool", cats).candidates.sort(), ["Pool Maintenance", "Pool Repairs"]);
  assert.equal(resolveName("zzz", cats).value, undefined);
});

t("SQL escaping and validation", () => {
  assert.equal(sqlString("O'Brien & Sons"), "'O''Brien & Sons'");
  const sql = sqlVendorSpend({ vendor: "x'; DROP TABLE transactions; --", fiscal_year: "2024" });
  assert.ok(sql.includes("'x''; DROP TABLE transactions; --'"));
  assert.throws(() => checkYear("2024; DROP"));
  assert.throws(() => txnWhere({ start_date: "2024-01-01' OR 1=1" }));
  assert.throws(() => txnWhere({ min_amount: NaN }));
  assert.ok(sqlBudgetVsActual({ fiscal_year: "2024", category: "Insurance" }).includes("FULL OUTER JOIN"));
  assert.ok(sqlTransactions({}, 9999).endsWith("LIMIT 100"));
});

t("money math in integer cents", () => {
  assert.equal(toCents("0.1") + toCents("0.2"), 30);
  assert.equal(money(-123456), "-$1,234.56");
});

t("vector filters", () => {
  assert.equal(buildFilter({}), undefined);
  assert.deepEqual(buildFilter({ doc_type: "minutes" }), { doc_type: { $eq: "minutes" } });
  assert.deepEqual(buildFilter({ doc_type: "minutes", year: 2024 }), { $and: [{ doc_type: { $eq: "minutes" } }, { year: { $eq: 2024 } }] });
});

t("doc flags match by file-name substring, case-insensitively", () => {
  const flags = { _readme: {} as any, cornerstone: { verify: "handwritten", mode: "warn" as const } };
  assert.equal(matchFlag("2022 CornerStone Mgmt Agreement.pdf", flags)?.verify, "handwritten");
  assert.equal(matchFlag("Bylaws 2019.pdf", flags), undefined);
  assert.equal(matchFlag("_readme.pdf", flags), undefined);
});

console.log(`\n${n} test groups passed`);
