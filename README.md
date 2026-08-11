# Voter PDF → Excel Extraction Agent

A Node.js CLI tool that extracts voter records from Hindi electoral roll PDFs and writes them to a fixed Excel file with **zero data loss**.

---

## Features

- **Text-based PDF support** — direct text extraction (no OCR needed)
- **Hindi / Devanagari Unicode** — all text preserved exactly as printed
- **Zero data loss guarantee** — box count must equal row count (hard stop if mismatch)
- **Idempotent runs** — re-running on the same PDF won't duplicate rows
- **Visual Excel output** — header frozen, colour-coded rows (🟡 NEEDS_REVIEW, 🍑 PARTIAL, 🟢 OK)
- **Hidden audit sheet** — raw box text preserved for re-derivation
- **JSON run log** — per-box audit trail in `logs/`
- **Claude API ready** — rule-based parser active in v1; switch to Claude with one env variable

---

## Setup

### 1. Install dependencies

```bash
cd c:\Users\ravindra.singh\VoterDetailExtrector
npm install
```

### 2. Configure environment (optional)

```bash
copy .env.example .env
```

Edit `.env` if you want to activate Claude API later:
```
ANTHROPIC_API_KEY=your_key_here
USE_CLAUDE=false
```

### 3. Create output folder (auto-created if missing)

```bash
mkdir output
```

---

## Usage

### Basic run

```bash
node src/index.js --input path\to\voters.pdf
```

Output is saved automatically to `output\voters_extracted.xlsx`.

### Full options

```bash
node src/index.js --input voters.pdf --output result.xlsx --verbose
```

| Flag | Description |
|------|-------------|
| `-i, --input <path>`  | **Required.** Path to voter-list PDF |
| `-o, --output <path>` | Output Excel path (default: `output/<name>_extracted.xlsx`) |
| `-v, --verbose`       | Show per-box progress in console |
| `--use-claude`        | Use Claude API (needs `ANTHROPIC_API_KEY` in `.env`) |

---

## Output

### Excel file (`Voter Data` sheet)

| Column | Description |
|--------|-------------|
| S.No | Sequential row number |
| Voter ID | EPIC number |
| Name | Voter's name (Hindi) |
| Relation Type | पिता / पति / माता |
| Relation Name | Name of relation |
| House No | House/door number |
| Age | Age (numeric) |
| Gender | पुरुष / महिला / अन्य |
| Page No | Source PDF page |
| Box No | Source box position on that page |
| Extraction Status | `OK` / `PARTIAL` / `NEEDS_REVIEW` |

**Row colours:**
- 🟡 **Yellow** — `NEEDS_REVIEW`: critical fields missing or low confidence
- 🍑 **Peach** — `PARTIAL`: some optional fields missing
- 🟢 **Light green** — `OK`: all key fields extracted

### Raw Text sheet (`Raw Text`, hidden)

Stores the raw extracted text for every box — used to re-audit any parsing errors without re-reading the PDF.

### Run log (`logs/run-<timestamp>.json`)

Per-box audit trail: page, box, status, confidence, Voter ID. Includes final stats and reconciliation result.

---

## Activating Claude API (future)

1. Get an API key from [console.anthropic.com](https://console.anthropic.com)
2. Set in `.env`:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   USE_CLAUDE=true
   ```
3. Install the SDK:
   ```bash
   npm install @anthropic-ai/sdk
   ```
4. Run normally — the orchestrator automatically routes to Claude.

No other code changes needed.

---

## Project Structure

```
VoterDetailExtrector/
├── src/
│   ├── index.js           CLI entry point
│   ├── orchestrator.js    Main pipeline controller
│   ├── pdfReader.js       PDF loading + box detection
│   ├── parser.js          Rule-based Hindi field extractor
│   ├── claudeExtractor.js Claude API extractor (stub, activates via .env)
│   ├── excelWriter.js     Excel template creator + row writer
│   ├── validator.js       Pre-flight checks + batch validation
│   ├── logger.js          Console + JSON audit logger
│   └── utils.js           Shared utilities
├── output/                Generated Excel files (auto-created)
├── logs/                  Run audit logs (auto-created)
├── .env.example           Environment variable template
├── package.json
└── README.md
```

---

## Tuning Box Detection

If your PDF layout is unusual (different column count, different box spacing), you can adjust constants in `src/pdfReader.js`:

```js
const GAP_THRESHOLD = 15;  // Y-gap in points between boxes (rows)
const COL_GAP = 80;        // X-gap in points between columns
```

Increase `GAP_THRESHOLD` if boxes are being merged; decrease it if a single box is being split.

---

## License

MIT — Internal use by Ravindra Singh.
