/**
 * excelWriter.js
 * Creates and writes the fixed Excel output file using exceljs.
 *
 * Output structure:
 *   Sheet 1 "Voter Data"   — main output, one row per voter, styled
 *   Sheet 2 "Raw Text"     — hidden reference sheet with raw box text
 *
 * Column order (locked):
 *   S.No | Part No | Assembly Constituency | Section No & Name | Serial No |
 *   EPIC ID | Voter Name | Relation Type | Relation Name | House No | Age |
 *   Gender | Photo Status | Page No | Box No | Extraction Status
 */

'use strict';

const ExcelJS = require('exceljs');
const logger  = require('./logger');

// ─── Column definitions ───────────────────────────────────────────────────────

const COLUMNS = [
  { header: 'S.No',                   key: 'sNo',                  width: 8  },
  { header: 'Part No',                key: 'partNo',               width: 10 },
  { header: 'Assembly Constituency',  key: 'assemblyConstituency', width: 34 },
  { header: 'Section No & Name',      key: 'sectionNoAndName',     width: 28 },
  { header: 'Serial No',              key: 'serialNo',             width: 10 },
  { header: 'EPIC ID',                key: 'epicId',               width: 16 },
  { header: 'Voter Name',             key: 'voterName',            width: 30 },
  { header: 'Relation Type',          key: 'relationType',         width: 14 },
  { header: 'Relation Name',          key: 'relationName',         width: 30 },
  { header: 'House No',               key: 'houseNo',              width: 14 },
  { header: 'Age',                    key: 'age',                  width: 8  },
  { header: 'Gender',                 key: 'gender',               width: 12 },
  { header: 'Photo Status',           key: 'photoStatus',          width: 14 },
  { header: 'Page No',                key: 'pageNo',               width: 10 },
  { header: 'Box No',                 key: 'boxNo',                width: 10 },
  { header: 'Extraction Status',      key: 'extractionStatus',     width: 20 },
];

// ─── Colours & styles ─────────────────────────────────────────────────────────

const HEADER_FILL = {
  type:    'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF1E3A5F' },   // deep navy
};
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };

const ROW_FILL_NEEDS_REVIEW = {
  type:    'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFFFD700' },   // gold/yellow
};
const ROW_FILL_PARTIAL = {
  type:    'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFFFEBCD' },   // light peach
};
const ROW_FILL_OK = {
  type:    'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFF0F8F0' },   // very light green
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a new workbook with the fixed template (both sheets).
 * @returns {{ workbook: ExcelJS.Workbook, mainSheet: Worksheet, rawSheet: Worksheet }}
 */
function createTemplate() {
  const workbook  = new ExcelJS.Workbook();

  workbook.creator  = 'VoterDetailExtractor';
  workbook.created  = new Date();
  workbook.modified = new Date();

  // ── Sheet 1: Voter Data ──────────────────────────────────────────────────
  const mainSheet = workbook.addWorksheet('Voter Data', {
    views: [{ state: 'frozen', ySplit: 1 }],  // freeze header row
  });

  mainSheet.columns = COLUMNS;

  // Style header row
  const headerRow = mainSheet.getRow(1);
  headerRow.eachCell(cell => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = {
      bottom: { style: 'medium', color: { argb: 'FFFFFFFF' } },
    };
  });
  headerRow.height = 22;
  headerRow.commit();

  // Auto-filter on header row
  mainSheet.autoFilter = {
    from: { row: 1, column: 1 },
    to:   { row: 1, column: COLUMNS.length },
  };

  // ── Sheet 2: Raw Text (reference / audit) ───────────────────────────────
  const rawSheet = workbook.addWorksheet('Raw Text', {
    state: 'veryHidden',  // hidden from normal view
  });
  rawSheet.columns = [
    { header: 'S.No',     key: 'sNo',     width: 8  },
    { header: 'Page No',  key: 'pageNo',  width: 10 },
    { header: 'Box No',   key: 'boxNo',   width: 10 },
    { header: 'EPIC ID',  key: 'epicId',  width: 16 },
    { header: 'Raw Text', key: 'rawText', width: 80 },
  ];

  const rawHeader = rawSheet.getRow(1);
  rawHeader.eachCell(cell => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
  });
  rawHeader.commit();

  return { workbook, mainSheet, rawSheet };
}

/**
 * Write one voter record to the main sheet.
 *
 * @param {ExcelJS.Worksheet} worksheet
 * @param {Object}            record       Extracted voter data
 * @param {number}            rowIndex     1-indexed row (2+ since row 1 is header)
 * @param {'OK'|'PARTIAL'|'NEEDS_REVIEW'} status
 */
function writeRow(worksheet, record, rowIndex, status) {
  const row = worksheet.getRow(rowIndex);

  row.getCell('sNo').value                  = rowIndex - 1;   // sequential S.No
  row.getCell('partNo').value               = record.part_no              ?? '';
  row.getCell('assemblyConstituency').value = record.assembly_constituency || '';
  row.getCell('sectionNoAndName').value     = record.section_no_and_name   || '';
  row.getCell('serialNo').value             = record.serial_no            ?? '';
  row.getCell('epicId').value               = record.epic_id              || '';
  row.getCell('voterName').value            = record.voter_name           || '';
  row.getCell('relationType').value         = record.relation_type        || '';
  row.getCell('relationName').value         = record.relation_name        || '';
  row.getCell('houseNo').value              = record.house_no             || '';
  row.getCell('age').value                  = record.age                  ?? '';
  row.getCell('gender').value               = record.gender               || '';
  row.getCell('photoStatus').value          = record.photo_status         || '';
  row.getCell('pageNo').value               = record.pageNo;
  row.getCell('boxNo').value                = record.boxNo;
  row.getCell('extractionStatus').value     = status;

  // Apply row colour by status
  const fill = status === 'NEEDS_REVIEW' ? ROW_FILL_NEEDS_REVIEW
             : status === 'PARTIAL'      ? ROW_FILL_PARTIAL
             :                            ROW_FILL_OK;

  row.eachCell(cell => {
    cell.fill      = fill;
    cell.alignment = { vertical: 'middle', wrapText: true };
    cell.font      = { size: 10 };
  });

  // Bold the status cell for NEEDS_REVIEW
  if (status === 'NEEDS_REVIEW') {
    row.getCell('extractionStatus').font = { bold: true, size: 10, color: { argb: 'FF8B0000' } };
  }

  row.height = 18;
  row.commit();
}

/**
 * Write one raw-text entry to the reference sheet.
 *
 * @param {ExcelJS.Worksheet} rawSheet
 * @param {Object}            record
 * @param {number}            rowIndex
 */
function writeRawRow(rawSheet, record, rowIndex) {
  const row = rawSheet.getRow(rowIndex);
  row.getCell('sNo').value     = rowIndex - 1;
  row.getCell('pageNo').value  = record.pageNo;
  row.getCell('boxNo').value   = record.boxNo;
  row.getCell('epicId').value  = record.epic_id || '';
  row.getCell('rawText').value = record.rawText || '';
  row.getCell('rawText').alignment = { wrapText: true, vertical: 'top' };
  row.commit();
}

/**
 * Save the workbook to disk.
 * @param {ExcelJS.Workbook} workbook
 * @param {string}           outputPath  Absolute path
 */
async function saveWorkbook(workbook, outputPath) {
  await workbook.xlsx.writeFile(outputPath);
  logger.info(`Excel saved: ${outputPath}`);
}

module.exports = {
  createTemplate,
  writeRow,
  writeRawRow,
  saveWorkbook,
  COLUMNS,
};
