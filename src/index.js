/**
 * index.js
 * CLI entry point for the Voter PDF → Excel Extraction Agent.
 *
 * Usage:
 *   node src/index.js --input <path/to/voters.pdf> --output <path/to/result.xlsx>
 *   node src/index.js --input voters.pdf --output output/result.xlsx --verbose
 *   node src/index.js --input voters.pdf  (output defaults to output/voters_extracted.xlsx)
 *
 * Environment variables (configure in .env):
 *   USE_CLAUDE=false          Rule-based parser (default)
 *   USE_CLAUDE=true           Claude API (requires ANTHROPIC_API_KEY)
 *   ANTHROPIC_API_KEY=...     Your Anthropic key
 *   LOG_LEVEL=info|verbose    Logging verbosity
 */

'use strict';

// Load .env before anything else
require('dotenv').config();

const path      = require('path');
const { program } = require('commander');
const { validateDependencies } = require('./validator');
const orchestrator = require('./orchestrator');
const logger    = require('./logger');

// ─── CLI definition ───────────────────────────────────────────────────────────

program
  .name('voter-extractor')
  .description('Extract voter records from Hindi electoral roll PDFs into Excel')
  .version('1.0.0')

  .requiredOption(
    '-i, --input <path>',
    'Path to input voter-list PDF file'
  )
  .option(
    '-o, --output <path>',
    'Path for output Excel file (default: output/<pdfname>_extracted.xlsx)'
  )
  .option(
    '-v, --verbose',
    'Enable verbose logging (shows per-box progress)',
    false
  )
  .option(
    '--use-claude',
    'Use Claude API for extraction (requires ANTHROPIC_API_KEY in .env)',
    false
  );

program.parse(process.argv);
const opts = program.opts();

// ─── Resolve paths ────────────────────────────────────────────────────────────

const inputPdf = path.resolve(opts.input);

let outputExcel;
if (opts.output) {
  outputExcel = path.resolve(opts.output);
} else {
  const pdfBase = path.basename(inputPdf, '.pdf');
  outputExcel   = path.resolve(process.cwd(), 'output', `${pdfBase}_extracted.xlsx`);
}

const useClaude = opts.useClaude || process.env.USE_CLAUDE === 'true';

if (opts.verbose) process.env.LOG_LEVEL = 'verbose';

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║      Voter PDF → Excel Extraction Agent  v1.0           ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  Input  : ${inputPdf}`);
  console.log(`  Output : ${outputExcel}`);
  console.log(`  Engine : ${useClaude ? 'Claude API' : 'Rule-based parser (Hindi)'}`);
  console.log('');

  try {
    // ── L — Link: validate all dependencies ───────────────────────────────
    await validateDependencies({ inputPdf, outputExcel, useClaude });

    // ── A — Architect: run extraction pipeline ────────────────────────────
    const result = await orchestrator.run({
      inputPdf,
      outputExcel,
      useClaude,
      verbose: opts.verbose,
    });

    process.exit(0);

  } catch (err) {
    logger.error(`Fatal error: ${err.message}`);
    if (opts.verbose) console.error(err.stack);
    process.exit(1);
  }
}

main();
