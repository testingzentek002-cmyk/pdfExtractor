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

const SYSTEM_PROMPT = `You are a data extraction engine for Indian electoral roll (voter list) PDFs. You will receive raw text from individual voter record boxes (Hindi/Devanagari electoral rolls).

Extract ALL voter records given. Do not skip, merge, or summarize any record, even if a box's text looks cut off or incomplete.

For EACH voter box, extract these fields:

1. serial_no      -> क्रम संख्या (boxed number)
2. epic_id        -> ID code printed top-right of box
3. voter_name     -> निर्वाचक का नाम
4. relation_type  -> "Father" / "Husband" / "Mother" (translate the label only, not the name — from पिता/पति/माता)
5. relation_name  -> name following पिता/पति/माता का नाम (keep in Devanagari, do not translate the name itself)
6. house_no       -> मकान संख्या
7. age            -> उम्र (integer)
8. gender         -> पुरुष / महिला / अन्य
9. photo_status   -> "Available" / "Not Available" based on फोटो उपलब्ध text

STRICT RULES (non-negotiable):
- Return a JSON array with EXACTLY the same number of elements as input boxes — no more, no less. Under-counting or over-counting is a critical failure.
- Preserve all Hindi/Devanagari text EXACTLY as printed — no spelling correction, no translation of names.
- If a field is illegible or missing, output null — never guess or fabricate a value.
- No markdown, no explanations, no code fences — return ONLY the raw JSON array.

Output schema for each record:
{
  "serial_no":     number | null,
  "epic_id":       string | null,
  "voter_name":    string | null,
  "relation_type": string | null,
  "relation_name": string | null,
  "house_no":      string | null,
  "age":           number | null,
  "gender":        string | null,
  "photo_status":  string | null
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
    serial_no:     null,
    epic_id:       null,
    voter_name:    null,
    relation_type: null,
    relation_name: null,
    house_no:      null,
    age:           null,
    gender:        null,
    photo_status:  null,
    pageNo:        box.pageNo,
    boxNo:         box.boxNo,
    rawText:       box.rawText,
  };
}

module.exports = {
  extractBatch,
};
