# Setup: AWS account, deploy, load your data, GitHub, Claude Desktop

You do the account steps yourself (sign-up, MFA, billing agreements). Use a **personal** email and payment method. Order: AWS account -> CLI login -> deploy from your laptop -> load data -> Claude Desktop -> (optionally) GitHub + CI.

## 1. AWS account (about 30 minutes)
1. Sign up at https://aws.amazon.com with a personal email. Choose the free plan if offered (check current credit terms on the sign-up page).
2. **Secure root:** create no root access keys and don't use root. If the account has a root password, enable **MFA** on it; if it has none (check with `aws iam generate-credential-report`, then `aws iam get-credential-report`; the `<root_account>` row shows `password_enabled=false`), there is nothing to protect. Console sign-in is then through an assumed role.
3. **Budget alert:** Billing -> Budgets -> monthly cost budget of $10, alerts at 50% and 100%.
4. **Sign-in method:** newer "project" accounts don't offer IAM Identity Center without upgrading the plan ("not available to your project"). Skip it and use `aws login` (step 6). If your account does offer Identity Center, you can use it instead with `aws configure sso`.
5. Install **Node.js 22+**, **AWS CLI v2 (2.32 or newer, required for `aws login`)**, **Git**.
6. Log in:
   ```bash
   aws login --profile arcadia            # opens the browser; the profile name is only a local label
   aws configure set region us-east-2 --profile arcadia
   export AWS_PROFILE=arcadia AWS_REGION=us-east-2
   aws sts get-caller-identity
   ```
7. **Bedrock:** console -> Amazon Bedrock (us-east-2) -> confirm access to **Amazon Titan Text Embeddings V2**. (Claude is not called from AWS in this design; Claude Desktop is your chat client.)

## 2. Deploy the infrastructure (from your laptop first)
```bash
cd infra && npm ci
npx cdk bootstrap          # one time per account/region
npx cdk diff               # expect: data bucket, vector bucket + index, Glue db + 2 tables, Athena workgroup, IAM policy
npx cdk deploy
```
Copy the `EnvHint` output and run it:
```bash
export AWS_REGION=us-east-2 DATA_BUCKET=... VECTOR_BUCKET=hoa-brain-<account-id> VECTOR_INDEX=hoa-docs ATHENA_DATABASE=hoa_brain ATHENA_WORKGROUP=hoa-brain
```
Then, from the project root: `npm install && npm run selftest` (offline).

## 3. Load your documents
1. Put files in `inbox/docs/<type>/` where `<type>` is `bylaws`, `ccrs`, `rules`, `contract`, `minutes`, or `other`. PDF, .docx, .txt and .md are supported.
2. **Name files so dates are parseable**, e.g. `2024-03-12 Board Minutes.pdf`, `2023 Landscaping Contract.pdf`. A `YYYY-MM-DD` or `YYYY` in the file name becomes the year/date filter ("minutes from 2024").
3. **Handwritten or annotated documents (the CornerStone contract):** copy `data/docs-config.example.json` to `inbox/docs-config.json` and key it on part of the file name. Flagged documents always show a verify warning and can be viewed page by page. See README, "Documents with handwritten notes".
4. **Privacy:** copy `data/redaction-terms.example.txt` to `inbox/redaction-terms.txt` and list the names, addresses and unit numbers to remove. Then:
   ```bash
   npm run ingest -- --dry-run     # review every sample line; check the redaction counts
   npm run ingest                  # embeds and stores (cost is a fraction of a cent per hundred pages)
   ```
   Scanned PDFs are skipped with a message; OCR them first.

## 4. Load the budget tracker (Google Sheet)
1. In Google Sheets, for each tab: **File -> Download -> Comma-separated values (.csv)**. Save the transactions tab as `inbox/finance/transactions.csv` and the annual budget tab as `inbox/finance/budget.csv`.
   - Transactions need at least: date, category, amount. Helpful: vendor, memo/description, a type column (expense/income), a fund column (operating/reserve).
   - Budget needs: fiscal year, category, budgeted amount (fund optional).
2. Edit `data/finance-mapping.json` so the alias lists include your sheet's header names. Set `amount_sign` if you have no type column, and `fiscal_year_start_month` if your fiscal year isn't the calendar year.
3. Validate, then load:
   ```bash
   npm run load:finance -- --dry-run   # shows accepted/rejected rows with line numbers, years, categories, vendors
   npm run load:finance
   ```
   Re-run after each sheet update (it replaces the snapshot). Claude always reports the "data as of" date.

## 5. Connect Claude Desktop
```bash
npm run build
```
Add to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`; Windows: `%APPDATA%\Claude\`), then restart Claude Desktop:
```json
{
  "mcpServers": {
    "hoa-brain": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/hoa-brain/build/server.js"],
      "env": {
        "AWS_PROFILE": "arcadia",
        "AWS_REGION": "us-east-2",
        "DATA_BUCKET": "<from cdk output>",
        "VECTOR_BUCKET": "hoa-brain-<account-id>"
      }
    }
  }
}
```
Run `aws login --profile arcadia` whenever your session expires. **Use a personal Claude account** for this data (see README, Privacy). Try: "What documents do you have?" then "How much have we spent against the landscaping budget this year?"

## 6. GitHub and automated deploys (optional, after everything works)
1. New **private** repo `hoa-brain` on github.com (no README/.gitignore). Enable 2FA on your account.
2. Push:
   ```bash
   git init -b main && git add . && git status   # confirm inbox/ contents, node_modules/, build/, cdk.out/ are NOT listed
   git commit -m "HOA Brain" && git remote add origin https://github.com/<you>/hoa-brain.git && git push -u origin main
   ```
3. **OIDC bootstrap** (one time, your admin profile):
   ```bash
   aws cloudformation deploy --template-file infra/bootstrap/github-oidc.yaml --stack-name hoa-brain-github-oidc \
     --capabilities CAPABILITY_NAMED_IAM --parameter-overrides GitHubOrg=<your-github-username> GitHubRepo=hoa-brain
   aws cloudformation describe-stacks --stack-name hoa-brain-github-oidc --query "Stacks[0].Outputs"
   ```
   (Add `CreateOidcProvider=false` if the account already has the GitHub provider.)
4. Repo **Settings -> Secrets and variables -> Actions -> Variables**: add `AWS_ROLE_ARN` = the RoleArn output.
5. **Settings -> Environments**: create `aws-demo`, add yourself as **Required reviewer**.
6. **Actions -> infra -> Run workflow** -> `deploy` (or `destroy`). PRs touching `infra/` run `cdk diff` automatically.

CI manages infrastructure only. Documents and finance data are loaded from your laptop and never touch GitHub.

## 7. Updating and teardown
- New or changed documents: add to `inbox/docs/...`, `npm run ingest`. New sheet data: re-export CSVs, `npm run load:finance`.
- Stop all costs and delete your data in AWS: Actions -> `destroy`, or `cd infra && npx cdk destroy`.

## Troubleshooting
| Symptom | Likely cause |
|---|---|
| `Missing required env var DATA_BUCKET` | Export the variables from the CDK `EnvHint` output (and set them in the Claude Desktop config) |
| `could not find columns for ...` | Add your header names to `data/finance-mapping.json` |
| Many rows rejected | Check the line-numbered reasons: date formats, "$" or text in amount cells, unknown type values |
| Athena `TABLE_NOT_FOUND` | Stack not deployed in this region, or `load:finance` not yet run |
| Athena `bytes scanned` cutoff error | Workgroup cap is 100 MB per query; raise `bytesScannedCutoffPerQuery` in the stack if your data is larger |
| `AccessDeniedException` | Your identity needs the `hoa-brain-runtime` policy (admins already have it) |
| Tools fail after a while in Claude Desktop | Login session expired: `aws login --profile arcadia` |
| Document skipped as "scanned" | PDF has no text layer; OCR it first |
| Workflow: not authorized to AssumeRoleWithWebIdentity | Org/repo mismatch in the OIDC parameters, or the job isn't using the `aws-demo` environment |
