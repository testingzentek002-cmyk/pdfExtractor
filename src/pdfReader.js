/**
 * pdfReader.js
 * Layer 1 — Technical SOP: PDF loading, page reading, and box detection.
 *
 * Uses pdfjs-dist to extract text items WITH their bounding-box coordinates.
 * Box detection uses y-coordinate clustering + visual separator lines to split
 * each page into the individual voter record boxes.
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const url    = require('url');
const logger = require('./logger');
const { cleanText } = require('./utils');

// ─── PDF library init ─────────────────────────────────────────────────────────

async function getPdfjsLib() {
  // pdfjs-dist ships ESM-only from v4+ (no CommonJS build), so it must be
  // loaded via dynamic import() even from this CommonJS module.
  let lib, workerSrc;
  try {
    lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
  } catch (_) {
    lib = await import('pdfjs-dist');
    workerSrc = require.resolve('pdfjs-dist/build/pdf.worker.mjs');
  }
  // Node has no DOM Worker; point at the real worker file so pdfjs's
  // fake-worker fallback can load it instead of failing on an empty src.
  // Node's ESM loader requires a file:// URL for absolute Windows paths.
  lib.GlobalWorkerOptions.workerSrc = url.pathToFileURL(workerSrc).href;
  return lib;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Load a PDF document from disk.
 * @param {string} filePath  Absolute path to the PDF
 * @returns {Promise<Object>}  pdfjs document object
 */
async function loadPdf(filePath) {
  const pdfjsLib = await getPdfjsLib();
  const data     = new Uint8Array(fs.readFileSync(filePath));
  const doc      = await pdfjsLib.getDocument({ data, verbosity: 0 }).promise;
  logger.info(`PDF loaded: ${path.basename(filePath)} — ${doc.numPages} page(s)`);
  return doc;
}

/**
 * Read all text items from one PDF page, with bounding-box data.
 * @param {Object} doc      pdfjs document
 * @param {number} pageNum  1-indexed page number
 * @returns {Promise<Array<{str, x, y, w, h, fontName}>>}
 */
async function readPdfPage(doc, pageNum) {
  const page        = await doc.getPage(pageNum);
  const viewport    = page.getViewport({ scale: 1.0 });
  const textContent = await page.getTextContent({ normalizeWhitespace: false });

  const items = textContent.items.map(item => {
    // pdfjs transform: [scaleX, skewX, skewY, scaleY, translateX, translateY]
    const tx = item.transform;
    const x  = tx[4];
    const y  = viewport.height - tx[5]; // flip Y: pdfjs origin is bottom-left
    const w  = item.width;
    const h  = item.height || Math.abs(tx[3]);

    return {
      str:      cleanText(item.str),
      x:        Math.round(x),
      y:        Math.round(y),
      w:        Math.round(w),
      h:        Math.round(h),
      fontName: item.fontName || '',
    };
  }).filter(item => item.str.length > 0);

  page.cleanup();
  return items;
}

/**
 * Detect individual voter record boxes on a page.
 *
 * Strategy:
 *  1. Sort all text items by Y (top-to-bottom), then X (left-to-right).
 *  2. Identify large Y-gaps between consecutive items → these are box separators.
 *  3. Within each row band, identify X-column splits (for multi-column layouts).
 *  4. Each (row-band × column) cell = one voter box.
 *
 * @param {Array}  textItems   from readPdfPage()
 * @param {number} pageNum
 * @returns {Array<{pageNo, boxNo, items, rawText}>}
 */
function detectBoxes(textItems, pageNum) {
  if (!textItems || textItems.length === 0) return [];

  // ── Step 1: Detect horizontal separator bands (large Y-gaps) ─────────────
  const sorted   = [...textItems].sort((a, b) => a.y - b.y || a.x - b.x);
  const rowBands = splitByYGap(sorted);

  // ── Step 2: Within each row-band, split by X-column ──────────────────────
  const boxes = [];
  let   boxNo = 1;

  for (const band of rowBands) {
    const columns = splitByXColumn(band);
    for (const col of columns) {
      if (col.length === 0) continue;
      const rawText = col
        .sort((a, b) => a.y - b.y || a.x - b.x)
        .map(i => i.str)
        .join('\n');

      boxes.push({
        pageNo:  pageNum,
        boxNo:   boxNo++,
        items:   col,
        rawText: rawText.trim(),
      });
    }
  }

  logger.verbose(`  Page ${pageNum}: detected ${boxes.length} box(es)`);
  return boxes;
}

/**
 * Return the raw text string for a box (already computed during detection,
 * but exposed as a named function per the BLAST spec Tools list).
 *
 * @param {{rawText: string}} box
 * @returns {string}
 */
function extractBoxText(box) {
  return box.rawText;
}

// ─── Box-detection helpers ────────────────────────────────────────────────────

/**
 * Split text items into horizontal row-bands by detecting Y-gaps.
 * A gap >= GAP_THRESHOLD points is treated as a box separator.
 */
function splitByYGap(sortedItems) {
  const GAP_THRESHOLD = 15; // points — tune if needed for your PDFs
  const bands  = [];
  let   current = [sortedItems[0]];

  for (let i = 1; i < sortedItems.length; i++) {
    const prev = sortedItems[i - 1];
    const curr = sortedItems[i];
    const gap  = curr.y - prev.y;

    if (gap > GAP_THRESHOLD) {
      if (current.length > 0) bands.push(current);
      current = [curr];
    } else {
      current.push(curr);
    }
  }
  if (current.length > 0) bands.push(current);
  return bands;
}

/**
 * Split a row-band into columns by detecting X-gaps.
 * Electoral rolls typically have 2 or 3 columns of voter boxes.
 * A gap >= COL_GAP points between adjacent sorted X positions = new column.
 */
function splitByXColumn(bandItems) {
  const COL_GAP = 80; // points — tune for your layout

  // Sort items by X
  const sorted = [...bandItems].sort((a, b) => a.x - b.x);

  // Find unique X-starts and cluster them
  const xValues = sorted.map(i => i.x);
  const clusters = [];
  let   curr    = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].x - sorted[i - 1].x > COL_GAP) {
      clusters.push(curr);
      curr = [sorted[i]];
    } else {
      curr.push(sorted[i]);
    }
  }
  clusters.push(curr);

  // If only 1 cluster → whole band is one box (single-column page)
  return clusters;
}

module.exports = {
  loadPdf,
  readPdfPage,
  detectBoxes,
  extractBoxText,
};
