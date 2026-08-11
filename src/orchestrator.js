/**
 * orchestrator.js
 * Main extraction pipeline — coordinates all layers per the BLAST spec.
 *
 * Flow:
 *   1. Load PDF
 *   2. For each page → detect voter boxes
 *   3. Group boxes into batches of 9 (never crossing page boundaries)
 *   4. Send each batch to extractor (rule-based or Claude)
 *   5. Validate returned records (length + schema)
 *   6. Classify each record (OK / PARTIAL / NEEDS_REVIEW)
 *   7. Write to Excel (main sheet + raw-text reference sheet)
 *   8. Log audit trail + final summary with reconciliation check
 */

'use strict';

const path      = require('path');
const logger    = require('./logger');
const { loadPdf, readPdfPage, detectBoxes } = require('./pdfReader');
const { validateBatchResult, classifyRecord }  = require('./validator');
const { createTemplate, writeRow, writeRawRow, saveWorkbook } = require('./excelWriter');
const { batchArray, dedupKey } = require('./utils');

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '9', 10);

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Run the full extraction pipeline.
 *
 * @param {Object}  opts
 * @param {string}  opts.inputPdf      Absolute path to input PDF
 * @param {string}  opts.outputExcel   Absolute path for output Excel
 * @param {boolean} opts.useClaude     true = Claude API, false = rule-based parser
 * @param {boolean} opts.verbose       Extra console output
 */
async function run(opts) {
  const { inputPdf, outputExcel, useClaude } = opts;

  if (opts.verbose) process.env.LOG_LEVEL = 'verbose';

  // ── Choose extractor engine ──────────────────────────────────────────────
  const extractor = useClaude
    ? require('./claudeExtractor')
    : require('./parser');

  logger.info(`Extraction engine: ${useClaude ? 'Claude API' : 'Rule-based parser'}`);

  // ── Load PDF ─────────────────────────────────────────────────────────────
  const pdfDoc   = await loadPdf(inputPdf);
  const numPages = pdfDoc.numPages;

  // ── Set up Excel workbook ─────────────────────────────────────────────────
  const { workbook, mainSheet, rawSheet } = createTemplate();

  // ── Dedup registry (Voter ID → first-seen row index) ────────────────────
  const seen     = new Map();   // key → excel row index where it was first written
  let   excelRow = 2;           // row 1 = header

  // ── Stats ─────────────────────────────────────────────────────────────────
  let totalBoxes = 0;
  let written    = 0;
  let flagged    = 0;   // NEEDS_REVIEW
  let partial    = 0;   // PARTIAL
  let duplicates = 0;

  // ── Process each page ─────────────────────────────────────────────────────
  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    logger.info(`Processing page ${pageNum} / ${numPages} …`);

    let textItems;
    try {
      textItems = await readPdfPage(pdfDoc, pageNum);
    } catch (err) {
      logger.error(`  Failed to read page ${pageNum}: ${err.message}`);
      continue;
    }

    const boxes = detectBoxes(textItems, pageNum);
    totalBoxes += boxes.length;
    logger.verbose(`  Page ${pageNum}: ${boxes.length} boxes detected`);

    if (boxes.length === 0) {
      logger.warn(`  Page ${pageNum}: no boxes detected — skipping`);
      continue;
    }

    // Batch boxes (never cross page boundary — each page's boxes are batched independently)
    const batches = batchArray(boxes, BATCH_SIZE);

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];
      logger.verbose(`  Batch ${batchIdx + 1}/${batches.length} (${batch.length} boxes)`);

      // ── Extract ──────────────────────────────────────────────────────────
      let records;
      try {
        records = await extractor.extractBatch(batch);
      } catch (err) {
        logger.error(`  Extractor error on batch ${batchIdx + 1}: ${err.message}`);
        // Fall back: mark all boxes in this batch as NEEDS_REVIEW
        records = batch.map(box => needsReviewStub(box));
      }

      // ── Validate batch length ─────────────────────────────────────────────
      const { valid, reason } = validateBatchResult(records, batch.length);
      if (!valid) {
        logger.warn(`  Batch ${batchIdx + 1} validation failed: ${reason}. Retrying once…`);

        // One retry
        try {
          records = await extractor.extractBatch(batch);
          const retry = validateBatchResult(records, batch.length);
          if (!retry.valid) {
            logger.warn(`  Retry also failed (${retry.reason}). Flagging all ${batch.length} boxes as NEEDS_REVIEW.`);
            records = batch.map(box => needsReviewStub(box));
          }
        } catch (_) {
          records = batch.map(box => needsReviewStub(box));
        }
      }

      // ── Write records ─────────────────────────────────────────────────────
      for (let i = 0; i < records.length; i++) {
        const rec    = records[i];
        const srcBox = batch[i];

        // Ensure traceability is always set (parser should set these, but guard anyway)
        rec.pageNo  = rec.pageNo  ?? srcBox.pageNo;
        rec.boxNo   = rec.boxNo   ?? srcBox.boxNo;
        rec.rawText = rec.rawText ?? srcBox.rawText;

        // Classify extraction quality
        const status = classifyRecord(rec);

        // Idempotency: check for duplicates
        const key = dedupKey(rec.voterId, rec.pageNo, rec.boxNo);
        if (seen.has(key)) {
          logger.warn(`  Duplicate detected (key: ${key}) — skipping row`);
          duplicates++;
          logger.logAudit({ pageNo: rec.pageNo, boxNo: rec.boxNo, status: 'DUPLICATE', notes: `Dup of row ${seen.get(key)}` });
          continue;
        }
        seen.set(key, excelRow);

        // Write to main sheet
        writeRow(mainSheet, rec, excelRow, status);

        // Write to raw-text reference sheet
        writeRawRow(rawSheet, rec, excelRow);

        // Update stats
        if (status === 'NEEDS_REVIEW') flagged++;
        else if (status === 'PARTIAL')  partial++;
        written++;

        logger.logAudit({
          pageNo:     rec.pageNo,
          boxNo:      rec.boxNo,
          status,
          confidence: rec.confidence,
          notes:      rec.voterId ? `EPIC: ${rec.voterId}` : 'No Voter ID found',
        });

        excelRow++;
      }
    }
  }

  // ── Save Excel ────────────────────────────────────────────────────────────
  await saveWorkbook(workbook, outputExcel);

  // ── Final reconciliation check & summary ──────────────────────────────────
  logger.writeSummary({ totalBoxes, written, flagged, partial });

  if (duplicates > 0) {
    logger.warn(`Idempotency: ${duplicates} duplicate record(s) were skipped.`);
  }

  return { totalBoxes, written, flagged, partial, duplicates };
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function needsReviewStub(box) {
  return {
    serialNo:     null,
    voterId:      null,
    name:         null,
    relationType: null,
    relationName: null,
    houseNo:      null,
    age:          null,
    gender:       null,
    confidence:   'low',
    pageNo:       box.pageNo,
    boxNo:        box.boxNo,
    rawText:      box.rawText,
  };
}

module.exports = { run };
