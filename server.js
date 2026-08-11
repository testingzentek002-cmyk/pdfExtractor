/**
 * server.js
 * Local Express web server for the Voter PDF → Excel Extraction Agent.
 *
 * Endpoints:
 *   GET  /              → Serve the web UI
 *   POST /upload        → Accept PDF upload, start extraction, stream progress via SSE
 *   GET  /progress/:id  → SSE stream for real-time progress updates
 *   GET  /download/:id  → Download generated Excel file
 *   GET  /status/:id    → JSON status of a run
 */

'use strict';

require('dotenv').config();

const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const { EventEmitter } = require('events');
const { handleUpload } = require('@vercel/blob/client');
const { del } = require('@vercel/blob');

// Vercel's serverless functions reject request bodies over 4.5 MB before our
// code ever runs. When a Blob store is attached (BLOB_READ_WRITE_TOKEN set),
// the browser uploads the PDF directly to Blob storage instead, bypassing
// that limit — the server only ever receives the resulting blob URL.
const useBlobUploads = !!process.env.BLOB_READ_WRITE_TOKEN;

// ─── Patch logger to emit events for the web UI ──────────────────────────────
// We override the singleton logger to broadcast via SSE
const baseLogger = require('./src/logger');

// Global job registry
// NOTE: on Vercel this Map only survives for the lifetime of one serverless
// instance — a /progress or /download request may land on a different
// instance than /upload and find no job. Fine for a single-instance/dev
// deploy; not reliable for production traffic.
const jobs = new Map(); // jobId → { status, progress, outputPath, error, emitter, stats }

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
// the platform's 4.5 MB serverless request-body limit) or straight to /upload.
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

// ─── POST /upload ─────────────────────────────────────────────────────────────
app.post('/upload', (req, res, next) => {
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

  const jobId      = `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const pdfBase    = path.basename(originalName, '.pdf').replace(/[^a-zA-Z0-9\-_]/g, '_');
  const outputExcel = path.join(outputDir, `${pdfBase}_${Date.now()}_extracted.xlsx`);
  const useClaude  = process.env.USE_CLAUDE === 'true';

  const emitter = new EventEmitter();
  jobs.set(jobId, {
    status: 'queued',
    progress: [],
    outputPath: outputExcel,
    inputName: originalName,
    error: null,
    emitter,
    stats: null,
  });

  res.json({ jobId });

  // Run extraction asynchronously
  setImmediate(() => runExtractionJob(jobId, inputPdf, outputExcel, useClaude, blobUrl));
});

// ─── GET /progress/:id  (Server-Sent Events) ──────────────────────────────────
app.get('/progress/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  // Replay buffered messages
  job.progress.forEach(msg => send(msg));

  // If already done, close immediately
  if (job.status === 'done' || job.status === 'error') {
    send({ type: 'close', status: job.status, stats: job.stats, error: job.error });
    return res.end();
  }

  // Live messages
  job.emitter.on('message', (msg) => {
    send(msg);
    if (msg.type === 'close') res.end();
  });

  req.on('close', () => job.emitter.removeAllListeners('message'));
});

// ─── GET /download/:id ────────────────────────────────────────────────────────
app.get('/download/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'done') return res.status(400).json({ error: 'Job not complete yet' });
  if (!fs.existsSync(job.outputPath)) return res.status(404).json({ error: 'Output file not found' });

  const filename = path.basename(job.outputPath);
  res.download(job.outputPath, filename);
});

// ─── GET /status/:id ─────────────────────────────────────────────────────────
app.get('/status/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ status: job.status, stats: job.stats, error: job.error, inputName: job.inputName });
});

// ─── Extraction runner ────────────────────────────────────────────────────────

async function runExtractionJob(jobId, inputPdf, outputExcel, useClaude, blobUrl) {
  const job = jobs.get(jobId);

  function emit(msg) {
    job.progress.push(msg);
    job.emitter.emit('message', msg);
  }

  try {
    job.status = 'running';
    emit({ type: 'start', message: `Starting extraction…`, inputName: job.inputName });

    // ── Dependency validation ─────────────────────────────────────────────
    emit({ type: 'check', message: 'Running dependency checks…' });

    const { validateDependencies } = require('./src/validator');
    // Temporarily redirect logger checkResult to SSE
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

    await saveWorkbook(workbook, outputExcel);

    const stats = { totalBoxes, written, flagged, partial };
    job.status  = 'done';
    job.stats   = stats;

    emit({ type: 'done', stats, message: `Done! ${written} records written. ${flagged} flagged for review.` });
    emit({ type: 'close', status: 'done', stats });

  } catch (err) {
    job.status = 'error';
    job.error  = err.message;
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
