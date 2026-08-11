/**
 * server.js
 * Local Express web server for the Voter PDF → Excel Extraction Agent.
 *
 * Endpoints:
 *   GET  /              → Serve the web UI
 *   POST /extract       → Accept a PDF (multipart or a Blob URL), run extraction,
 *                          and stream newline-delimited JSON progress events back
 *                          on the same response, ending with a download URL.
 *   GET  /download/:id  → Local-dev only: download the generated Excel file
 *                          (used when no Blob store is configured).
 *
 * The whole upload → extract → result lifecycle happens inside a single HTTP
 * request. Vercel serverless functions are stateless across invocations and
 * may serve consecutive requests from different instances, so anything split
 * across separate requests (e.g. an upload endpoint handing off a jobId to a
 * separate /progress poll) can 404 when a later request lands on an instance
 * that never saw the job. Keeping everything on one connection sidesteps that
 * entirely — no cross-request state is needed to report progress. The final
 * Excel file is likewise handed off via a Blob URL rather than a follow-up
 * download request against local disk.
 */

'use strict';

require('dotenv').config();

const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const { handleUpload } = require('@vercel/blob/client');
const { put, del } = require('@vercel/blob');

// Vercel's serverless functions reject request bodies over 4.5 MB before our
// code ever runs. When a Blob store is attached (BLOB_READ_WRITE_TOKEN set),
// the browser uploads the PDF directly to Blob storage instead, bypassing
// that limit — the server only ever receives the resulting blob URL. The
// finished Excel file is likewise returned via Blob so /download never needs
// to be reachable from a different serverless instance.
const useBlobUploads = !!process.env.BLOB_READ_WRITE_TOKEN;

// ─── Patch logger to emit events for the web UI ──────────────────────────────
const baseLogger = require('./src/logger');

// Local-dev-only download registry (single process, so no cross-instance risk).
// Only used when useBlobUploads is false.
const localDownloads = new Map(); // token → absolute file path

// ─── Multer config — store uploads in /uploads ────────────────────────────────
// Vercel's serverless filesystem is read-only except for os.tmpdir().
const storageBaseDir = process.env.VERCEL ? os.tmpdir() : __dirname;
const uploadsDir = path.join(storageBaseDir, 'uploads');
const outputDir  = path.join(storageBaseDir, 'output');
[uploadsDir, outputDir].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename:    (req, file, cb) => {
    const ts   = Date.now();
    const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, `${ts}_${safe}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.originalname.endsWith('.pdf')) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are accepted'));
    }
  },
});

// ─── App ──────────────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── GET /api/upload-mode ──────────────────────────────────────────────────────
// Tells the client whether to upload the PDF directly to Vercel Blob (bypassing
// the platform's 4.5 MB serverless request-body limit) or straight to /extract.
app.get('/api/upload-mode', (req, res) => {
  res.json({ mode: useBlobUploads ? 'blob' : 'direct' });
});

// ─── POST /api/blob-upload ──────────────────────────────────────────────────────
// Authorizes the browser's direct-to-Blob upload (only reached when a Blob
// store is configured). The file itself never passes through this function.
app.post('/api/blob-upload', async (req, res) => {
  try {
    const jsonResponse = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => ({
        allowedContentTypes: ['application/pdf'],
        addRandomSuffix: true,
        maximumSizeInBytes: 100 * 1024 * 1024,
      }),
      onUploadCompleted: async () => {},
    });
    res.json(jsonResponse);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── POST /extract ─────────────────────────────────────────────────────────────
app.post('/extract', (req, res, next) => {
  // JSON body → the file already landed in Blob storage; skip multer entirely.
  if (req.is('application/json')) return next();
  upload.single('pdf')(req, res, next);
}, async (req, res) => {
  let inputPdf, originalName, blobUrl = null;

  if (req.file) {
    inputPdf     = req.file.path;
    originalName = req.file.originalname;
  } else if (req.body && req.body.blobUrl) {
    blobUrl = req.body.blobUrl;
    if (!/^https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\//.test(blobUrl)) {
      return res.status(400).json({ error: 'Invalid blob URL' });
    }
    originalName = req.body.filename || 'upload.pdf';
    try {
      const blobRes = await fetch(blobUrl);
      if (!blobRes.ok) throw new Error(`fetch failed with status ${blobRes.status}`);
      const buffer = Buffer.from(await blobRes.arrayBuffer());
      const safe   = originalName.replace(/[^a-zA-Z0-9.\-_]/g, '_');
      inputPdf     = path.join(uploadsDir, `${Date.now()}_${safe}`);
      fs.writeFileSync(inputPdf, buffer);
    } catch (err) {
      return res.status(400).json({ error: `Could not retrieve uploaded file: ${err.message}` });
    }
  } else {
    return res.status(400).json({ error: 'No PDF file provided' });
  }

  const useClaude = process.env.USE_CLAUDE === 'true';

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  const emit = (msg) => { res.write(JSON.stringify(msg) + '\n'); };

  await runExtraction({ inputPdf, originalName, useClaude, blobUrl, emit });

  res.end();
});

// ─── GET /download/:token ───────────────────────────────────────────────────────
// Local-dev fallback only (no Blob store configured). In Blob mode the client
// downloads straight from the blob URL returned in the 'done' event.
app.get('/download/:token', (req, res) => {
  const filePath = localDownloads.get(req.params.token);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  res.download(filePath, path.basename(filePath));
});

// ─── Extraction runner ────────────────────────────────────────────────────────

async function runExtraction({ inputPdf, originalName, useClaude, blobUrl, emit }) {
  try {
    emit({ type: 'start', message: `Starting extraction…`, inputName: originalName });

    const pdfBase     = path.basename(originalName, '.pdf').replace(/[^a-zA-Z0-9\-_]/g, '_');
    const outputExcel = path.join(outputDir, `${pdfBase}_${Date.now()}_extracted.xlsx`);

    // ── Dependency validation ─────────────────────────────────────────────
    emit({ type: 'check', message: 'Running dependency checks…' });

    const { validateDependencies } = require('./src/validator');
    // Temporarily redirect logger checkResult to the response stream
    const origCheck = baseLogger.checkResult.bind(baseLogger);
    baseLogger.checkResult = (label, passed, note) => {
      emit({ type: 'check_item', label, passed, note: note || '' });
      origCheck(label, passed, note);
    };

    await validateDependencies({ inputPdf, outputExcel, useClaude });
    baseLogger.checkResult = origCheck;

    // ── PDF loading ───────────────────────────────────────────────────────
    const { loadPdf, readPdfPage, detectBoxes } = require('./src/pdfReader');
    const pdfDoc   = await loadPdf(inputPdf);
    const numPages = pdfDoc.numPages;
    emit({ type: 'info', message: `PDF loaded: ${numPages} page(s)` });

    // ── Excel setup ───────────────────────────────────────────────────────
    const { createTemplate, writeRow, writeRawRow, saveWorkbook } = require('./src/excelWriter');
    const { workbook, mainSheet, rawSheet } = createTemplate();

    // ── Extractor ─────────────────────────────────────────────────────────
    const extractor = useClaude ? require('./src/claudeExtractor') : require('./src/parser');
    const { validateBatchResult, classifyRecord } = require('./src/validator');
    const { batchArray, dedupKey } = require('./src/utils');
    const { extractPageHeader } = require('./src/parser');
    const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '9', 10);

    const seen = new Map();
    let excelRow = 2, totalBoxes = 0, written = 0, flagged = 0, partial = 0;

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      emit({ type: 'page', message: `Processing page ${pageNum} of ${numPages}…`, pageNum, numPages });

      let textItems;
      try { textItems = await readPdfPage(pdfDoc, pageNum); }
      catch (err) { emit({ type: 'warn', message: `Page ${pageNum} read error: ${err.message}` }); continue; }

      const boxes = detectBoxes(textItems, pageNum);
      totalBoxes += boxes.length;
      emit({ type: 'boxes', message: `Page ${pageNum}: ${boxes.length} box(es) detected`, count: boxes.length });

      // Page-level header fields — extracted once per page, repeated onto every row.
      const pageText   = textItems.map(item => item.str).join('\n');
      const pageHeader = extractPageHeader(pageText);

      const batches = batchArray(boxes, BATCH_SIZE);

      for (let bi = 0; bi < batches.length; bi++) {
        const batch = batches[bi];
        let records;
        try {
          records = await extractor.extractBatch(batch);
        } catch (err) {
          records = batch.map(box => needsReviewStub(box, useClaude));
        }

        const { valid } = validateBatchResult(records, batch.length);
        if (!valid) {
          try { records = await extractor.extractBatch(batch); }
          catch (_) { records = batch.map(box => needsReviewStub(box, useClaude)); }
        }

        for (let i = 0; i < records.length; i++) {
          const srcBox = batch[i];
          const rec    = normalizeRecord(records[i], useClaude);
          rec.pageNo  = rec.pageNo  ?? srcBox.pageNo;
          rec.boxNo   = rec.boxNo   ?? srcBox.boxNo;
          rec.rawText = rec.rawText ?? srcBox.rawText;
          rec.part_no               = pageHeader.partNo;
          rec.assembly_constituency = pageHeader.assemblyConstituency;
          rec.section_no_and_name   = pageHeader.sectionNoAndName;

          const status = classifyRecord(rec);
          const key    = dedupKey(rec.epic_id, rec.pageNo, rec.boxNo);
          if (seen.has(key)) continue;
          seen.set(key, excelRow);

          writeRow(mainSheet, rec, excelRow, status);
          writeRawRow(rawSheet, rec, excelRow);

          if (status === 'NEEDS_REVIEW') flagged++;
          else if (status === 'PARTIAL') partial++;
          written++;
          excelRow++;
        }
      }

      // Per-page progress update
      emit({
        type:       'progress',
        pageNum,
        numPages,
        totalBoxes,
        written,
        flagged,
        partial,
        percent:    Math.round((pageNum / numPages) * 100),
      });
    }

    const stats = { totalBoxes, written, flagged, partial };

    // ── Deliver the output file ─────────────────────────────────────────────
    let downloadUrl;
    if (useBlobUploads) {
      const buffer  = await workbook.xlsx.writeBuffer();
      const outBlob = await put(`output/${path.basename(outputExcel)}`, buffer, {
        access: 'public',
        addRandomSuffix: true,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        token: process.env.BLOB_READ_WRITE_TOKEN,
      });
      downloadUrl = outBlob.url;
    } else {
      await saveWorkbook(workbook, outputExcel);
      const token = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      localDownloads.set(token, outputExcel);
      downloadUrl = `/download/${token}`;
    }

    emit({ type: 'done', stats, downloadUrl, message: `Done! ${written} records written. ${flagged} flagged for review.` });
    emit({ type: 'close', status: 'done', stats });

  } catch (err) {
    emit({ type: 'error', message: err.message });
    emit({ type: 'close', status: 'error', error: err.message });
  } finally {
    fs.unlink(inputPdf, () => {});
    if (blobUrl) del(blobUrl).catch(() => {});
  }
}

function needsReviewStub(box, useClaude) {
  if (useClaude) {
    return { serial_no: null, epic_id: null, voter_name: null, relation_type: null,
      relation_name: null, house_no: null, age: null, gender: null, photo_status: null,
      pageNo: box.pageNo, boxNo: box.boxNo, rawText: box.rawText };
  }
  return { serialNo: null, voterId: null, name: null, relationType: null,
    relationName: null, houseNo: null, age: null, gender: null,
    confidence: 'low', pageNo: box.pageNo, boxNo: box.boxNo, rawText: box.rawText };
}

function normalizeRecord(rec, useClaude) {
  if (useClaude) {
    return {
      part_no: null, assembly_constituency: null, section_no_and_name: null,
      serial_no: rec.serial_no ?? null, epic_id: rec.epic_id ?? null,
      voter_name: rec.voter_name ?? null, relation_type: rec.relation_type ?? null,
      relation_name: rec.relation_name ?? null, house_no: rec.house_no ?? null,
      age: rec.age ?? null, gender: rec.gender ?? null, photo_status: rec.photo_status ?? null,
      pageNo: rec.pageNo, boxNo: rec.boxNo, rawText: rec.rawText,
    };
  }
  return {
    part_no: null, assembly_constituency: null, section_no_and_name: null,
    serial_no: rec.serialNo ?? null, epic_id: rec.voterId ?? null,
    voter_name: rec.name ?? null, relation_type: rec.relationType ?? null,
    relation_name: rec.relationName ?? null, house_no: rec.houseNo ?? null,
    age: rec.age ?? null, gender: rec.gender ?? null, photo_status: null,
    pageNo: rec.pageNo, boxNo: rec.boxNo, rawText: rec.rawText,
  };
}

// ─── Start ────────────────────────────────────────────────────────────────────
// On Vercel, the platform imports `app` and invokes it per-request — it must
// not call app.listen() itself.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║      Voter PDF → Excel Extraction Agent  v1.0           ║');
    console.log('║                   Web Server                             ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log(`\n  🌐  Open in browser: http://localhost:${PORT}\n`);
  });
}

module.exports = app;
