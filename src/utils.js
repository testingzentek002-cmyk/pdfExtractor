/**
 * utils.js
 * Shared utility functions used across the pipeline.
 */

'use strict';

/**
 * Split an array into chunks of at most `size` elements.
 * Chunks never span across a page boundary (enforced by the caller passing
 * pre-grouped per-page arrays, but the utility itself is generic).
 *
 * @param {Array}  arr
 * @param {number} size
 * @returns {Array[]}  array of chunk arrays
 */
function batchArray(arr, size) {
  const batches = [];
  for (let i = 0; i < arr.length; i += size) {
    batches.push(arr.slice(i, i + size));
  }
  return batches;
}

/**
 * Build the labeled prompt text that is sent to Claude (or logged for debugging).
 * Each box is prefixed with a delimiter so the model can't merge fields across boxes.
 *
 * @param {Array<{pageNo: number, boxNo: number, rawText: string}>} boxes
 * @returns {string}
 */
function buildBatchPrompt(boxes) {
  return boxes
    .map((box, idx) =>
      `--- BOX ${idx + 1} (page ${box.pageNo}, box ${box.boxNo}) ---\n${box.rawText}\n`
    )
    .join('\n');
}

/**
 * Clean raw text extracted from a PDF text item:
 * - Trim whitespace
 * - Collapse multiple spaces/newlines into single space
 * - Normalise Unicode (NFC form) — important for Devanagari text
 *
 * @param {string} text
 * @returns {string}
 */
function cleanText(text) {
  if (!text) return '';
  return text
    .normalize('NFC')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * Safely parse a string to integer. Returns null if parsing fails.
 * Used for Age, House No, etc.
 *
 * @param {string} str
 * @returns {number|null}
 */
function safeParseInt(str) {
  if (!str) return null;
  const cleaned = str.replace(/[^\d]/g, '');
  const val = parseInt(cleaned, 10);
  return isNaN(val) ? null : val;
}

/**
 * Generate a composite dedup key for a voter record.
 * Used for idempotency check: re-running must not duplicate rows.
 *
 * @param {string|null} voterId
 * @param {number}      pageNo
 * @param {number}      boxNo
 * @returns {string}
 */
function dedupKey(voterId, pageNo, boxNo) {
  if (voterId && voterId.trim()) {
    return `VOTERID:${voterId.trim().toUpperCase()}`;
  }
  return `PAGE:${pageNo}:BOX:${boxNo}`;
}

/**
 * Format a timestamp for use in file names (no colons or dots).
 * @returns {string}  e.g. "2026-08-04T09-43-00Z"
 */
function fileTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

module.exports = {
  batchArray,
  buildBatchPrompt,
  cleanText,
  safeParseInt,
  dedupKey,
  fileTimestamp,
};
