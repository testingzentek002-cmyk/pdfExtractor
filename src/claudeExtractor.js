/**
 * claudeExtractor.js
 * Claude API extraction engine — STUB for v1.
 *
 * This module is ONLY called when USE_CLAUDE=true in .env.
 * In v1, USE_CLAUDE defaults to false and the rule-based parser (parser.js) is used.
 *
 * To activate:
 *   1. Set USE_CLAUDE=true in your .env file
 *   2. Set ANTHROPIC_API_KEY=your_key in your .env file
 *   3. Run npm install @anthropic-ai/sdk
 *
 * This module implements EXACTLY the same interface as parser.js:
 *   extractBatch(boxes) → Array<record>
 * So the orchestrator needs zero changes when switching engines.
 */

'use strict';

const { buildBatchPrompt } = require('./utils');
const logger               = require('./logger');

// ─── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a precise data extraction assistant. You will receive raw text from voter list PDF boxes (Hindi/Regional language electoral rolls). Extract structured voter record data from each box.

RULES (non-negotiable):
1. Return a JSON array with EXACTLY the same number of elements as input boxes — no more, no less.
2. Preserve all text EXACTLY as printed — no spelling correction, no case normalization.
3. If a field is missing or unreadable, return null for that field — never fabricate a value.
4. Set "confidence" to "high" if you extracted name and voterId clearly, otherwise "low".
5. Do NOT include any prose, markdown fences, or explanation — return ONLY the JSON array.

Output schema for each record:
{
  "serialNo":     string | null,
  "voterId":      string | null,
  "name":         string | null,
  "relationType": string | null,
  "relationName": string | null,
  "houseNo":      string | null,
  "age":          number | null,
  "gender":       string | null,
  "confidence":   "high" | "low"
}`;

// ─── Main export ───────────────────────────────────────────────────────────────

/**
 * Send a batch of boxes to Claude API and return extracted records.
 * Validates that the returned array length === expectedCount.
 *
 * @param {Array<{pageNo, boxNo, rawText}>} boxes
 * @param {number} [maxRetries=1]
 * @returns {Promise<Array<Object>>}
 */
async function extractBatch(boxes, maxRetries = 1) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set. Check your .env file.');
  }

  const expectedCount = boxes.length;
  const batchText     = buildBatchPrompt(boxes);
  const model         = process.env.CLAUDE_MODEL || 'claude-3-5-sonnet-20241022';

  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      logger.verbose(`  Claude call: batch of ${expectedCount} boxes (attempt ${attempt + 1})`);

      // Lazy-load Anthropic SDK so it doesn't crash if not installed
      let Anthropic;
      try {
        ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
      } catch (_) {
        Anthropic = require('@anthropic-ai/sdk');
      }

      const client   = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const message  = await client.messages.create({
        model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Extract voter records from the following ${expectedCount} boxes:\n\n${batchText}`,
          },
        ],
      });

      const rawContent = message.content[0]?.text || '';
      const records    = parseClaudeResponse(rawContent, expectedCount);

      if (records === null) {
        attempt++;
        logger.warn(`  Claude batch response invalid on attempt ${attempt}. ${attempt <= maxRetries ? 'Retrying...' : 'Flagging all as NEEDS_REVIEW.'}`);
        continue;
      }

      // Attach page/box traceability (Claude returns records in order but without coords)
      records.forEach((rec, i) => {
        rec.pageNo  = boxes[i].pageNo;
        rec.boxNo   = boxes[i].boxNo;
        rec.rawText = boxes[i].rawText;
      });

      return records;

    } catch (err) {
      attempt++;
      if (attempt > maxRetries) {
        logger.error(`  Claude API error after ${maxRetries + 1} attempt(s): ${err.message}`);
        throw err;
      }
      logger.warn(`  Claude API error on attempt ${attempt}: ${err.message}. Retrying...`);
    }
  }

  // All retries exhausted — return NEEDS_REVIEW stubs for all boxes
  return boxes.map(box => needsReviewStub(box));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse Claude's JSON response; return array or null if invalid.
 */
function parseClaudeResponse(text, expectedCount) {
  try {
    // Strip any accidental markdown fences
    const cleaned = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
    const parsed  = JSON.parse(cleaned);

    if (!Array.isArray(parsed)) return null;
    if (parsed.length !== expectedCount) return null;

    return parsed;
  } catch (_) {
    return null;
  }
}

/**
 * Produce a NEEDS_REVIEW stub record for a box that Claude could not process.
 */
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

module.exports = {
  extractBatch,
};
