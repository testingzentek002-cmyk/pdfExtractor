/**
 * validator.js
 * L — Link layer: pre-flight dependency checks and batch-result validation.
 *
 * All checks are logged as PASS/FAIL before any extraction begins.
 * If any critical check fails, the pipeline stops immediately.
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const logger = require('./logger');

// ─── Pre-flight checks ────────────────────────────────────────────────────────

/**
 * Validate all required dependencies before the pipeline starts.
 * Logs each check; throws an error if any critical check fails.
 *
 * @param {Object}  opts
 * @param {string}  opts.inputPdf     Absolute path to input PDF
 * @param {string}  opts.outputExcel  Absolute path for output Excel
 * @param {boolean} opts.useClaud     Whether Claude API will be used
 * @throws {Error}  If any critical check fails
 */
async function validateDependencies(opts) {
  const { inputPdf, outputExcel, useClaude } = opts;
  console.log('\n── Dependency Checks (L — Link) ──────────────────────────────');

  let allPassed = true;

  // 1. Input PDF exists and is readable
  const pdfOk = checkFile(inputPdf);
  logger.checkResult('Input PDF exists and is readable', pdfOk,
    pdfOk ? inputPdf : `Not found: ${inputPdf}`);
  if (!pdfOk) allPassed = false;

  // 2. Output directory is writable
  const outDir   = path.dirname(outputExcel);
  const outDirOk = checkDirWritable(outDir);
  logger.checkResult('Output directory is writable', outDirOk,
    outDirOk ? outDir : `Cannot write to: ${outDir}`);
  if (!outDirOk) allPassed = false;

  // 3. pdfjs-dist can be imported
  let pdfLibOk = false;
  try {
    require('pdfjs-dist/legacy/build/pdf.js');
    pdfLibOk = true;
  } catch (e) {
    // fallback — try default entry
    try {
      require('pdfjs-dist');
      pdfLibOk = true;
    } catch (_) {
      pdfLibOk = false;
    }
  }
  logger.checkResult('PDF library (pdfjs-dist) importable', pdfLibOk,
    pdfLibOk ? 'ok' : 'Run: npm install');
  if (!pdfLibOk) allPassed = false;

  // 4. exceljs can be imported
  let excelLibOk = false;
  try {
    require('exceljs');
    excelLibOk = true;
  } catch (_) {
    excelLibOk = false;
  }
  logger.checkResult('Excel library (exceljs) importable', excelLibOk,
    excelLibOk ? 'ok' : 'Run: npm install');
  if (!excelLibOk) allPassed = false;

  // 5. Claude API key (only if USE_CLAUDE=true)
  if (useClaude) {
    const apiKey   = process.env.ANTHROPIC_API_KEY || '';
    const claudeOk = apiKey.length > 10 && apiKey !== 'your_anthropic_api_key_here';
    logger.checkResult('Claude API key present in env', claudeOk,
      claudeOk ? 'key found' : 'Set ANTHROPIC_API_KEY in .env');
    if (!claudeOk) allPassed = false;
  } else {
    logger.checkResult('Claude API (skipped — using rule-based parser)', true,
      'USE_CLAUDE=false');
  }

  // 6. PDF has a text layer (quick heuristic — not an empty page stream)
  if (pdfOk) {
    const textLayerOk = await checkPdfHasText(inputPdf);
    logger.checkResult('PDF has selectable text layer', textLayerOk,
      textLayerOk ? 'text items found' : 'PDF may be scanned — OCR not supported in v1');
    if (!textLayerOk) allPassed = false;
  }

  console.log('──────────────────────────────────────────────────────────────\n');

  if (!allPassed) {
    throw new Error('One or more dependency checks failed. Fix the issues above and re-run.');
  }
}

// ─── Batch-result validation ───────────────────────────────────────────────────

/**
 * Validate the result returned by the extractor for one batch.
 * Per the BLAST spec: array length MUST equal expectedCount.
 * If it doesn't, the whole batch must be retried / flagged.
 *
 * @param {Array}  result         Parsed extraction result
 * @param {number} expectedCount  Number of boxes sent in this batch
 * @returns {{ valid: boolean, reason: string }}
 */
function validateBatchResult(result, expectedCount) {
  if (!Array.isArray(result)) {
    return { valid: false, reason: 'Result is not an array' };
  }
  if (result.length !== expectedCount) {
    return {
      valid: false,
      reason: `Got ${result.length} records but expected ${expectedCount}`,
    };
  }
  for (let i = 0; i < result.length; i++) {
    const rec = result[i];
    if (typeof rec !== 'object' || rec === null) {
      return { valid: false, reason: `Record ${i} is not an object` };
    }
  }
  return { valid: true, reason: '' };
}

// ─── Record field validation ──────────────────────────────────────────────────

/**
 * Classify a single extracted record's completeness.
 *
 * @param {Object} record
 * @returns {'OK'|'PARTIAL'|'NEEDS_REVIEW'}
 */
function classifyRecord(record) {
  // If extractor flagged low confidence → always NEEDS_REVIEW
  if (record.confidence === 'low') return 'NEEDS_REVIEW';

  // Required fields for a meaningful record
  const required = ['voterId', 'name'];
  const missing  = required.filter(f => !record[f]);

  // Optional but important fields
  const important = ['age', 'gender', 'houseNo'];
  const partialMissing = important.filter(f => !record[f]);

  if (missing.length > 0)           return 'NEEDS_REVIEW';
  if (partialMissing.length >= 2)   return 'PARTIAL';
  return 'OK';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function checkFile(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function checkDirWritable(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    fs.accessSync(dirPath, fs.constants.W_OK);
    return true;
  } catch (_) {
    return false;
  }
}

async function checkPdfHasText(pdfPath) {
  try {
    let pdfjsLib;
    try {
      pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
    } catch (_) {
      pdfjsLib = require('pdfjs-dist');
    }

    const data      = new Uint8Array(fs.readFileSync(pdfPath));
    const loadTask  = pdfjsLib.getDocument({ data, verbosity: 0 });
    const pdfDoc    = await loadTask.promise;
    const page      = await pdfDoc.getPage(1);
    const textContent = await page.getTextContent();
    pdfDoc.destroy();
    return textContent.items && textContent.items.length > 0;
  } catch (_) {
    return false;
  }
}

module.exports = {
  validateDependencies,
  validateBatchResult,
  classifyRecord,
};
