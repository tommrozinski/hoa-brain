# HOA Brain

An MCP server that lets Claude answer everyday questions about **your HOA**:

- **Documents** (bylaws, CC&Rs, rules, contracts, meeting minutes) -> semantic search over **Amazon S3 Vectors**, with citations to document, Article/Section and page.
- **Budget tracker** (your Google Sheet) -> loaded to S3 and queried with **Amazon Athena** through fixed, parameterized tools. Dollar figures come from SQL, never from the model.

Everything is serverless and idle-cost-free. Nothing about your data goes in git.

```
Claude Desktop --MCP (stdio, on your laptop)--> hoa-brain server
   search_documents / list_documents  --> Titan embedding (Bedrock) --> S3 Vectors (filter by doc type / year)
   budget_vs_actual / vendor_spend /
   list_transactions / list_finance_options --> Athena (workgroup with a 100 MB scan cap) --> CSVs in S3
```

Design choices worth knowing:
- **No server-side chat model.** Claude Desktop does the routing (it picks the right tool from the descriptions) and writes the answer. Only Titan embeddings are called in Bedrock, so cost stays tiny.
- **Deterministic money.** Finance tools use fixed SQL, validated inputs and integer-cent math. Category and vendor names are matched to values actually in your data. Every answer includes a "data as of" date.
- **Structure-aware chunking.** Bylaws/CC&Rs are split at Article/Section headings, so citations read "Article VI, Section 3".
- **Privacy first.** Redaction runs before anything is embedded or stored; originals are NOT uploaded unless you ask.

## Layout
| Path | What |
|---|---|
| `inbox/docs/<type>/` | Your documents (gitignored). `<type>` = bylaws, ccrs, rules, contract, minutes, other. PDF, Word (.docx), .txt, .md |
| `inbox/finance/` | Your Google Sheet CSV exports: `transactions.csv`, `budget.csv` (gitignored) |
| `inbox/docs-config.json` | Flags documents that need human verification, such as the CornerStone contract with handwritten notes (see `data/docs-config.example.json`) |
| `inbox/redaction-terms.txt` | Optional names/addresses/units to redact (gitignored; see `data/redaction-terms.example.txt`) |
| `data/finance-mapping.json` | Maps your sheet's headers to the canonical columns; edit to match your sheet |
| `src/ingest.ts` | Documents: extract -> redact -> chunk -> embed -> S3 Vectors |
| `src/loadFinance.ts` | Sheet CSVs: validate -> normalize -> redact -> S3 (for Athena) |
| `src/server.ts` | The MCP server and its seven tools |
| `infra/` | AWS CDK app + one-time GitHub OIDC bootstrap |
| `.github/workflows/infra.yml` | `cdk diff` on PRs; manual deploy/destroy with an approval gate |
| `docs/SETUP.md` | Step by step: AWS account, deploy, load data, GitHub, Claude Desktop |
| `docs/USAGE.md` | Sample questions, how to check answers, privacy checklist |

## Tools Claude sees
| Tool | Use |
|---|---|
| `search_documents` | Rules, bylaws, contracts, minutes. Filters: doc_type, year, from_year/to_year |
| `list_documents` | What is in the library (documents needing manual verification are marked) |
| `view_document_page` | Shows the ORIGINAL PDF page as an image (local to your laptop). For handwritten notes and any "let me see the source" |
| `budget_vs_actual` | Budget vs spending for a fiscal year by category/fund, with remaining and % used |
| `vendor_spend` | Total paid to a vendor by year and category |
| `list_transactions` | Individual transactions with filters, plus exact totals for all matches |
| `list_finance_options` | Valid years, categories, funds, vendors, and data freshness |

## Configuration (environment variables)
| Var | Default | Notes |
|---|---|---|
| `AWS_REGION` | `us-east-2` | Must support S3 Vectors |
| `DATA_BUCKET` | (required) | CDK output |
| `VECTOR_BUCKET` | (required) | CDK output |
| `VECTOR_INDEX` | `hoa-docs` | |
| `ATHENA_DATABASE` / `ATHENA_WORKGROUP` | `hoa_brain` / `hoa-brain` | |
| `EMBED_MODEL_ID` | `amazon.titan-embed-text-v2:0` | 1024 dims; must match the index |
| `MAX_DISTANCE` | `0.6` | Adds a "may not be covered" note to weak results. Calibrate with `npm run eval` |

The `npm run` commands read these from your shell, so `export` them (the CDK `EnvHint` output prints the line).

## Quick start (after AWS is set up; see docs/SETUP.md)
```bash
npm install
npm run selftest                          # offline checks, no AWS needed
# put files in inbox/docs/<type>/ and inbox/finance/*.csv, then:
npm run ingest -- --dry-run               # shows chunks, sections, and redaction counts. READ THE SAMPLES.
npm run load:finance -- --dry-run         # shows accepted/rejected rows and what it detected
npm run ingest && npm run load:finance    # writes to your AWS account
npm run eval                              # retrieval check on your own questions (edit eval/doc-queries.json)
npm run build                             # then add build/server.js to Claude Desktop
```

## Documents with handwritten notes (e.g. the CornerStone contract)
Text extraction reads only the printed text, so handwritten edits (a changed fee, a struck clause, initials) are invisible to search. Flagged documents are handled three ways:
1. **Always warned.** Every search result from a flagged document is marked `VERIFY`, with the pages involved, and Claude is instructed not to state its terms as definitive.
2. **See the real page.** `view_document_page` renders the original PDF page as an image, so you can read the handwriting yourself and Claude can read it too. Claude's reading of handwriting can be wrong (digits especially), so it must say so and ask you to confirm on the image.
3. **Or pointer-only.** Set `"mode": "pointer-only"` and search returns just the document, section and pages with an instruction to check the original, with no extracted text at all.

Flag a document by copying `data/docs-config.example.json` to `inbox/docs-config.json` and keying on part of the file name (for example `cornerstone`), then re-run `npm run ingest`. Originals stay on your computer; only the page you ask to view is rendered and sent into your chat. Possible later upgrade: Amazon Textract can detect handwriting and mark which pages contain it, which would make flagging automatic and let handwritten text be searchable (still unverified).

## Privacy: where your data goes
- **Your laptop -> your AWS account:** redacted text chunks are sent to Bedrock for embedding and stored (text + vector) in your S3 Vectors index; normalized CSVs are stored in your private, encrypted S3 bucket. Originals are only uploaded with `--upload-originals`.
- **To Claude:** whatever a tool returns (passages, dollar figures) becomes part of your Claude conversation. **Use a personal Claude account for this**, not a work-managed one, because workplace accounts can be subject to admin visibility and retention policies.
- **Redaction** removes emails, phone numbers, SSN-like and long account-like numbers, plus any names/addresses you list. It is a safety net, not a guarantee: always review the `--dry-run` samples.
- **Teardown** (`cdk destroy`) deletes the vectors, CSVs and buckets in AWS.
- Disclose AI assistance if you share summaries or answers with the board or neighbors, and verify anything consequential against the source document. This is information, not legal or financial advice.

## Known limits
- Scanned PDFs (no text layer) are detected and skipped; run OCR first.
- Handwriting is never searchable text. It is only seen through `view_document_page`, so handwritten changes are not found by search.
- `view_document_page` works for PDFs on the computer where you ran `ingest`.
- Re-ingesting a document overwrites matching chunks but does not delete stale trailing chunks if the new version is shorter. To fully replace a document, change the file name or recreate the index.
- `load:finance` replaces the whole finance dataset each run (a snapshot, not a merge).
- All finance columns are text in Athena; queries cast amounts. Years and ISO dates compare as text.
- Not yet run against live AWS by the author: expect to tune `MAX_DISTANCE` and your sheet mapping on first use.
