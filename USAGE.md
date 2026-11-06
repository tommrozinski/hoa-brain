# Using HOA Brain

## Questions that work well
**Documents (search_documents)**
- "What does our governing documents say about fences, sheds, and exterior paint colors?"
- "How are special assessments approved, and what vote is required?" (expect Article/Section citations)
- "What did the board decide about the pool in the 2024 minutes?" (year filter)
- "When does the landscaping contract renew, and what is the cancellation notice?"
- "Has the board discussed short-term rentals? Summarize by meeting date."
- "What's the late fee policy, and where is it written?"

**The contract with handwritten notes**
- "What are the termination terms in the CornerStone agreement?" Expect printed terms, a VERIFY warning, page numbers, and an offer to show the page.
- "Show me page 4 of the CornerStone agreement." Claude displays the original page; read the handwriting yourself.
- "Are there any handwritten changes to the fees?" Claude can look at the page image and tell you what it sees, but it is a reading, not a record. Confirm on the image.

**Money (finance tools, deterministic)**
- "How are we doing against budget for 2025? Which categories are over?"
- "How much have we paid GreenScape Landscaping, by year?"
- "List the five biggest expenses this year."
- "Show reserve fund spending for 2024."
- "What categories and vendors do you have data for?"

**Both together**
- "Does our spending on insurance match what the budget says, and what do the bylaws require for coverage?"
- "The minutes mention a paving project: what was approved and what has been spent on paving?"

## Habits that keep answers trustworthy
1. Ask Claude to **quote and cite**: document, Article/Section, page. Open the source for anything consequential (fines, votes, contracts).
2. Check the **"data as of"** date on every money answer; reload the sheet after updates.
3. If the answer says the documents may not cover it, believe it. The tool adds a note when matches are weak.
4. Money answers include a `[trace]` line with the tool used and Athena bytes scanned, so you can see it was a database query, not a guess.
5. For documents marked VERIFY, the printed text may be out of date. Trust the page image and the signed original over any summary.
6. Information only: for legal or financial decisions, confirm with the board, manager, or a professional.

## Checking quality
- Edit `eval/doc-queries.json` with 8-10 real questions and where the answer lives, then run `npm run eval`. You want the right document type in the top 3.
- Include 1-2 questions your documents do NOT answer. Set `MAX_DISTANCE` just below their best distance.
- Spot-check totals: pick one category, add it up in the sheet, compare with `budget_vs_actual`.

## Privacy checklist before each load
- [ ] `--dry-run` samples reviewed; no names/addresses/accounts visible
- [ ] `inbox/redaction-terms.txt` updated for new people/units
- [ ] Using a personal Claude account
- [ ] Nothing from `inbox/` committed (`git status`)
