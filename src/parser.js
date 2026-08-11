/**
 * parser.js
 * Rule-based extraction engine for Hindi voter records.
 *
 * Parses the raw text of one voter box using regex patterns for Hindi field labels.
 * Returns a structured record in the same schema as claudeExtractor.js so the
 * orchestrator can use either engine interchangeably.
 *
 * Field labels commonly seen in Hindi electoral rolls:
 *   क्रमांक / क्र.सं.         → Serial No (within page)
 *   मतदाता पहचान पत्र क्र.    → EPIC / Voter ID
 *   नाम                       → Name
 *   पिता का नाम / पति का नाम / माता का नाम → Relation Name
 *   रिश्ता                    → Relation Type
 *   मकान नं. / गृह क्रमांक    → House No
 *   आयु                       → Age
 *   लिंग                      → Gender
 */

'use strict';

const { cleanText, safeParseInt } = require('./utils');

// ─── Field patterns ────────────────────────────────────────────────────────────
// Each pattern tries to capture the VALUE after the label.
// We use multiline mode and allow for optional spaces/colons after the label.

const PATTERNS = {
  // Serial number: e.g.  "1" at top of box, or "क्र.सं. : 42"
  serialNo: [
    /(?:क्र\.?सं\.?|क्रमांक)\s*[:\-]?\s*(\d+)/u,
    /^(\d+)$/m,                                         // bare number alone on a line
  ],

  // EPIC number: e.g. "ABC1234567" or "मतदाता पहचान पत्र क्र. : ABC1234567"
  voterId: [
    /(?:मतदाता\s*पहचान\s*पत्र\s*(?:क्र\.?|नं\.?|क्रमांक))\s*[:\-]?\s*([A-Z0-9]{5,12})/ui,
    /(?:EPIC|Voter\s*ID|मतदाता\s*पहचान)\s*[:\-]?\s*([A-Z0-9]{5,12})/ui,
    /\b([A-Z]{3}\d{7})\b/,                              // bare EPIC pattern (3 letters + 7 digits)
    /\b([A-Z]{2,4}\d{5,9})\b/,                          // broader EPIC pattern
  ],

  // Name: line immediately after "नाम" label
  name: [
    /(?:^|\n)\s*नाम\s*[:\-]?\s*(.+?)(?:\n|$)/mu,
    /(?:^|\n)\s*Name\s*[:\-]?\s*(.+?)(?:\n|$)/miu,
  ],

  // Relation Type: "पिता", "पति", "माता" etc.
  relationType: [
    /(?:रिश्ता|संबंध)\s*[:\-]?\s*(.+?)(?:\n|$)/mu,
    /(पिता|पति|माता|Mother|Father|Husband)/mu,
  ],

  // Relation Name: value after "पिता का नाम" / "पति का नाम" / "माता का नाम"
  relationName: [
    /(?:पिता\s*का\s*नाम|पति\s*का\s*नाम|माता\s*का\s*नाम)\s*[:\-]?\s*(.+?)(?:\n|$)/mu,
    /(?:Father'?s?\s*Name|Husband'?s?\s*Name|Mother'?s?\s*Name)\s*[:\-]?\s*(.+?)(?:\n|$)/miu,
  ],

  // House Number
  houseNo: [
    /(?:मकान\s*(?:नं\.?|नंबर|क्रमांक)|गृह\s*(?:क्रमांक|नं\.?))\s*[:\-]?\s*(.+?)(?:\n|$)/mu,
    /(?:House\s*(?:No\.?|Number))\s*[:\-]?\s*(.+?)(?:\n|$)/miu,
  ],

  // Age
  age: [
    /(?:आयु|उम्र)\s*[:\-]?\s*(\d{1,3})/mu,
    /(?:Age)\s*[:\-]?\s*(\d{1,3})/miu,
  ],

  // Gender
  gender: [
    /(?:लिंग)\s*[:\-]?\s*(.+?)(?:\n|$)/mu,
    /(?:Gender|Sex)\s*[:\-]?\s*(.+?)(?:\n|$)/miu,
    /(पुरुष|महिला|अन्य|Male|Female|Other|M|F)/miu,
  ],
};

// ─── Gender normalisation ──────────────────────────────────────────────────────

const GENDER_MAP = {
  'पुरुष': 'पुरुष',
  'male':  'पुरुष',
  'm':     'पुरुष',
  'महिला': 'महिला',
  'female':'महिला',
  'f':     'महिला',
  'अन्य': 'अन्य',
  'other': 'अन्य',
};

function normaliseGender(raw) {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  return GENDER_MAP[key] || raw.trim();
}

// ─── Core extraction ──────────────────────────────────────────────────────────

/**
 * Extract voter fields from the raw text of one box using regex rules.
 *
 * @param {string} rawText   Raw box text (possibly multi-line Hindi)
 * @param {number} pageNo
 * @param {number} boxNo
 * @returns {Object}  Voter record in the standard schema
 */
function extractRecord(rawText, pageNo, boxNo) {
  const text = cleanText(rawText);

  const serialNo     = matchFirst(text, PATTERNS.serialNo);
  const voterId      = matchFirst(text, PATTERNS.voterId);
  const name         = matchFirst(text, PATTERNS.name);
  const relationType = matchFirst(text, PATTERNS.relationType);
  const relationName = matchFirst(text, PATTERNS.relationName);
  const houseNoRaw   = matchFirst(text, PATTERNS.houseNo);
  const ageRaw       = matchFirst(text, PATTERNS.age);
  const genderRaw    = matchFirst(text, PATTERNS.gender);

  // Assess confidence: if both voterId and name are missing → low confidence
  const hasCore  = !!(voterId || name);
  const confidence = hasCore ? 'high' : 'low';

  return {
    serialNo:     serialNo   ? serialNo.trim()   : null,
    voterId:      voterId    ? voterId.trim()     : null,
    name:         name       ? name.trim()        : null,
    relationType: relationType ? relationType.trim() : null,
    relationName: relationName ? relationName.trim() : null,
    houseNo:      houseNoRaw  ? houseNoRaw.trim()   : null,
    age:          ageRaw      ? safeParseInt(ageRaw) : null,
    gender:       normaliseGender(genderRaw),
    pageNo,
    boxNo,
    confidence,
    rawText: text,
  };
}

/**
 * Process a batch of boxes (used by orchestrator — same interface as Claude extractor).
 *
 * @param {Array<{pageNo, boxNo, rawText}>} boxes
 * @returns {Array<Object>}  One record per box, in the same order
 */
function extractBatch(boxes) {
  return boxes.map(box => extractRecord(box.rawText, box.pageNo, box.boxNo));
}

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Try each pattern in order; return the first captured group match, or null.
 * @param {string}   text
 * @param {RegExp[]} patterns
 * @returns {string|null}
 */
function matchFirst(text, patterns) {
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m && m[1] !== undefined) {
      return m[1];
    }
  }
  return null;
}

module.exports = {
  extractRecord,
  extractBatch,
};
