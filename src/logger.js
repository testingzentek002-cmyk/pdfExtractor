/**
 * logger.js
 * Structured run-log writer and console reporter.
 * Every box processed produces an audit entry; at end of run a summary is written.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();

class Logger {
  constructor() {
    this.auditEntries  = [];
    this.runStartTime  = new Date();
    this.logFilePath   = null;
    this._ensureLogsDir();
  }

  _ensureLogsDir() {
    const logsDir = path.resolve(process.cwd(), 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    const ts = this.runStartTime.toISOString().replace(/[:.]/g, '-');
    this.logFilePath = path.join(logsDir, `run-${ts}.json`);
  }

  // ─── Console helpers ─────────────────────────────────────────────────────────

  info(msg) {
    if (LOG_LEVEL !== 'silent') {
      console.log(`[INFO]  ${new Date().toISOString()}  ${msg}`);
    }
  }

  verbose(msg) {
    if (LOG_LEVEL === 'verbose') {
      console.log(`[VERB]  ${new Date().toISOString()}  ${msg}`);
    }
  }

  warn(msg) {
    if (LOG_LEVEL !== 'silent') {
      console.warn(`[WARN]  ${new Date().toISOString()}  ${msg}`);
    }
  }

  error(msg) {
    console.error(`[ERR]   ${new Date().toISOString()}  ${msg}`);
  }

  // ─── Audit trail ─────────────────────────────────────────────────────────────

  /**
   * Log the result of processing one voter box.
   * @param {Object} entry
   * @param {number} entry.pageNo
   * @param {number} entry.boxNo
   * @param {'OK'|'PARTIAL'|'NEEDS_REVIEW'} entry.status
   * @param {string} [entry.confidence]   'high' | 'low'
   * @param {string} [entry.notes]        freeform problem description
   */
  logAudit(entry) {
    const record = {
      timestamp:  new Date().toISOString(),
      pageNo:     entry.pageNo,
      boxNo:      entry.boxNo,
      status:     entry.status,
      confidence: entry.confidence || 'high',
      notes:      entry.notes      || '',
    };
    this.auditEntries.push(record);
    this.verbose(`  Box ${entry.boxNo} (p.${entry.pageNo}) → ${entry.status}`);
  }

  // ─── Validation checklist ─────────────────────────────────────────────────────

  /**
   * Print a dependency-check result (L — Link layer).
   * @param {string}  label   What was checked
   * @param {boolean} passed  true = pass, false = fail
   * @param {string}  [note]  Extra detail
   */
  checkResult(label, passed, note = '') {
    const mark   = passed ? '✅ PASS' : '❌ FAIL';
    const detail = note ? `  (${note})` : '';
    console.log(`  ${mark}  ${label}${detail}`);
  }

  // ─── Summary ──────────────────────────────────────────────────────────────────

  /**
   * Compute and print final run summary, then write the JSON audit log.
   * @param {Object} stats
   * @param {number} stats.totalBoxes
   * @param {number} stats.written
   * @param {number} stats.flagged     NEEDS_REVIEW count
   * @param {number} stats.partial     PARTIAL count
   */
  writeSummary(stats) {
    const elapsedSec = ((Date.now() - this.runStartTime.getTime()) / 1000).toFixed(1);

    console.log('\n' + '═'.repeat(60));
    console.log('  RUN SUMMARY');
    console.log('═'.repeat(60));
    console.log(`  Total boxes detected : ${stats.totalBoxes}`);
    console.log(`  Rows written to Excel: ${stats.written}`);
    console.log(`  PARTIAL records      : ${stats.partial}`);
    console.log(`  NEEDS_REVIEW flagged : ${stats.flagged}`);
    console.log(`  Elapsed time         : ${elapsedSec}s`);
    if (stats.totalBoxes !== stats.written) {
      console.error(`\n  ⛔ COUNT MISMATCH — boxes detected (${stats.totalBoxes}) ≠ rows written (${stats.written})`);
      console.error('     Audit log preserved for investigation.');
    } else {
      console.log('\n  ✅ Reconciliation OK — box count matches row count');
    }
    console.log('═'.repeat(60));
    console.log(`  Audit log: ${this.logFilePath}\n`);

    // Write JSON audit log
    const payload = {
      runStartTime: this.runStartTime.toISOString(),
      runEndTime:   new Date().toISOString(),
      elapsedSec:   parseFloat(elapsedSec),
      stats,
      auditEntries: this.auditEntries,
    };
    fs.writeFileSync(this.logFilePath, JSON.stringify(payload, null, 2), 'utf8');
  }
}

module.exports = new Logger(); // Singleton — share across all modules
