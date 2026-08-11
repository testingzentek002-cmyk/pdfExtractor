# Voter Data PDF → Excel Extraction Agent
### B.L.A.S.T. Specification

---

## B — Blueprint

### Singular Desired Outcome
Given a voter-list PDF (electoral roll format — grid of "boxes," each box representing one voter record), extract **every** voter record with **zero data loss** and write it into a **fixed Excel template**, with each field mapped to its correct column.

### Source of Truth
- Input: One or more voter-list PDFs. Each page contains a grid of boxes (e.g. 2–3 columns × N rows per page). Each box contains fields such as:
  - Serial No. (box number, often top-left of the box)
  - Voter ID / EPIC number
  - Name
  - Relation Name (Father's/Husband's/Mother's name — labelled "Relation Type" + "Relation Name")
  - House Number
  - Age
  - Gender
  - (Optional) Photo present/absent flag
- These PDFs are frequently **bilingual** (regional language + English). Confirm with Ravindra which language(s) appear and whether both must be captured, or only one.
- Confirm whether PDFs are digitally generated (selectable text) or scanned/flattened images — this changes the extraction layer entirely (text parsing vs. OCR).

### Payload (Output Contract)
- One fixed Excel template (`.xlsx`), one row per voter, columns in a locked order, e.g.:
  `S.No | Voter ID | Name | Relation Type | Relation Name | House No | Age | Gender | Page No | Box No | Extraction Status`
- `Page No` + `Box No` are mandatory **traceability columns** — every row must be traceable back to its exact source location in the PDF. This is non-negotiable for a "no data loss" guarantee: it's how mismatches get audited.
- `Extraction Status` column flags: `OK`, `PARTIAL` (some field missing/unclear), or `NEEDS_REVIEW` (Claude was not confident).

### Behavioral Rules (non-negotiable)
1. **No silent guessing.** If a field is unreadable, blank, or ambiguous, the agent writes `NEEDS_REVIEW` in the status column and leaves the field empty or marks `[UNCLEAR]` — it never fabricates a plausible-looking value.
2. **Count reconciliation.** Total boxes detected in the PDF must equal total rows written to Excel. If PDF metadata/footer states a voter count for that page, cross-check against it. Mismatch = hard stop + report, not a silent skip.
3. **Idempotent runs.** Re-running the agent on the same PDF must not duplicate rows (checked via Voter ID or Page+Box composite key).
4. **Raw text preserved.** Store the raw extracted text block for each box (in a hidden/reference sheet) alongside the parsed fields, so any parsing bug can be re-derived from source without re-reading the PDF.
5. **No data transformation beyond formatting.** Names, IDs etc. are copied exactly as printed — no auto-correction of spelling, no case normalization unless explicitly requested.

### Open items to confirm with Ravindra before Architect phase
- [ ] Language(s) in the PDF — single script or bilingual capture required?
- [ ] Are PDFs text-based or scanned images?
- [ ] Approx. volume — how many PDFs / voters per run? (affects batching + Claude API cost/rate-limit strategy)
- [ ] Exact fixed Excel template — does one already exist, or should this spec finalize the column list above?

---

## L — Link

Before any extraction logic runs, the agent validates all dependencies and fails loudly if any are missing.

### Tools/APIs to validate on startup
- **Claude API key** — present, valid, correct model access (test with a trivial ping call).
- **PDF parsing library** — confirm it can open and read the target PDF(s) without error (e.g. `pdf-parse`, `pdfjs-dist`, or `pdf2json` for Node.js). If PDFs turn out to be scanned images, this layer must instead validate an OCR path (e.g. render pages to images + vision-capable Claude call).
- **Excel writing library** — confirm `exceljs` (recommended for Node.js — supports templates, styling, formulas) is installed and can open the fixed template file without corrupting formatting.
- **File system access** — confirm read access to input PDF folder and write access to output Excel folder.

### Validation checklist (agent must log pass/fail for each before proceeding)
```
[ ] Claude API reachable, key valid
[ ] Input PDF(s) exist and are readable
[ ] PDF text layer present OR OCR fallback confirmed
[ ] Excel template exists at expected path, opens cleanly
[ ] Output directory writable
```
If any check fails, the agent stops and reports exactly which check failed — it does not proceed with partial capability.

---

## A — Architect

3-layer architecture, Node.js/JavaScript, Claude API as the extraction brain.

### Layer 1 — Technical SOP (the fixed rulebook, not up to the LLM's discretion)
This is deterministic code, not a prompt:
1. Load PDF → split into pages.
2. For each page, split into boxes. If layout is fixed/predictable (same grid every page), do this with **coordinate-based extraction** (pdf.js gives you bounding boxes) rather than relying on Claude to parse a huge PDF at once. This is far more reliable for "no data loss."
3. For each box, extract raw text.
4. Group boxes into **batches of 9** (in page/box reading order, never crossing a page boundary mid-batch — see note below). Send each batch's raw text to Claude in a single call with a strict extraction prompt (Layer 2), asking for an array of exactly N records back, where N = number of boxes sent.
5. Validate the returned JSON: confirm the array length matches the number of boxes sent in that batch (this is the check that catches silent drops within a batch). Then validate each record's fields/types against the schema.
6. Write validated rows to Excel via `exceljs`, into the correct template columns.
7. Log every box processed (page no, box no, status) to a run log — this is the audit trail.

> Why batches of 9 rather than 1-at-a-time or a whole PDF in one shot: sending the whole PDF in one call risks the model losing track partway through a long document and silently dropping records — unacceptable given the zero-data-loss requirement. Sending exactly 1 box per call is the safest possible unit but multiplies API calls (and cost/time) by the total voter count. Batches of 9 are a middle ground: each call is still small enough that the model won't lose track, and the strict "return exactly N records for N boxes" check in step 5 catches drops within a batch immediately — so batching doesn't weaken the zero-loss guarantee, it just changes how big a "verifiable unit" is. If a 9-box batch ever comes back short, the whole batch is retried (not assumed partially correct).
>
> **Batch boundary rule:** batches should not span across boxes with inconsistent formatting (e.g. don't mix a partially-cut-off box at the bottom of a page with a full box from the next page) — keeping batches aligned to clean box boundaries avoids ambiguity in the prompt.

### Layer 2 — Navigation (the extraction prompt / decision logic)
The Claude API call per batch (9 boxes) should:
- Receive the raw text of 9 boxes, each clearly delimited/labeled (e.g. `--- BOX 1 (page 3, box 4) ---`, `--- BOX 2 (page 3, box 5) ---`, ...) so the model can't merge or misattribute fields across boxes.
- Be instructed to return a **strict JSON array of exactly 9 objects**, in the same order as the input boxes — no prose, no markdown fences.
- Be instructed explicitly: if a field within a box is missing or unreadable, return `null` for that field rather than guessing.
- Include a `confidence` field per record (`high` / `low`) so the pipeline can flag `low` confidence rows as `NEEDS_REVIEW` automatically.
- The pipeline code (not the model) is responsible for checking `array.length === 9`; if it doesn't match, the entire batch is discarded and retried once before being flagged `NEEDS_REVIEW` for all 9 boxes in that batch.

### Layer 3 — Tools (external actions the agent can take)
- `readPdfPage(pageNum)` — returns raw layout/text for a page.
- `extractBoxText(pageNum, boxCoords)` — returns raw text for one box.
- `buildBatch(boxList)` — groups up to 9 boxes (respecting the boundary rule above) into one labeled prompt payload.
- `callClaudeExtractBatch(batchText, expectedCount)` — sends the batch to Claude API, returns parsed JSON array, validates length against `expectedCount`.
- `writeExcelRow(rowData, rowIndex)` — writes into the fixed template.
- `logAudit(entry)` — appends to the run log (for reconciliation later).

---

## S — Stylize

Since this is an internal QA/data tool (not a customer-facing UI), keep this lightweight unless Ravindra wants a front end:
- **Minimum viable:** CLI tool — run with `node extract.js --input voters.pdf --output result.xlsx`, prints progress and a final summary (`X boxes found, Y written, Z flagged for review`).
- **Excel output styling:** header row bold/frozen, `NEEDS_REVIEW` rows highlighted (e.g. yellow fill) so Ravindra can visually scan for issues immediately without reading the status column.
- **Optional later:** a simple local web UI (drag-and-drop PDF, progress bar, download Excel) — only if this becomes a recurring multi-user tool. Not needed for v1.

---

## T — Trigger

- **v1:** Manual run via CLI — Ravindra runs it per PDF/batch as needed. No automation yet, since accuracy needs to be proven first on real data.
- **Post-validation:** Once a batch of runs shows consistent 100% reconciliation (box count = row count, low NEEDS_REVIEW rate), consider:
  - Watch-folder trigger (drop PDF in a folder → auto-run).
  - Scheduled batch run if voter list PDFs arrive periodically.
- **Do not automate before manual validation.** Given the "no data loss" requirement, the first several runs should be spot-checked by Ravindra against the source PDF before this is trusted to run unattended.

---

## Next Step
Before writing any code, confirm the four open items in the Blueprint section (language, text vs. scanned, volume, template columns) — they change Layer 1 of the Architect section significantly (especially OCR vs. direct text extraction).
