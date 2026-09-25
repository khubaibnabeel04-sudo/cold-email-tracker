const { google } = require('googleapis');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

// ─── Configuration ─────────────────────────────────────────────────────────
const SHEET_ID = process.env.GOOGLE_SHEET_ID || 'YOUR_GOOGLE_SHEET_ID_HERE';

// Sheet names in the Leads Master spreadsheet
// These must match the EXACT sheet names in the Google Sheet
const SHEETS = {
  OLD_LEADS_APP: '1. Old Leads (App)',
  NEW_LEADS_APP: '2. New Leads (App)',
  SENT: 'Sent',
  NO_REPLY: 'No Reply',
  NEEDS_EMAIL: '5. Needs Email',
  NEW_LEADS_REASON: 'new_leads_reason',
  OLD_LEADS_REASON: 'old_leads_reason',
};

// Sentinel written to the "videotitle" cell when reasoning genuinely could not
// find a qualifying video for a channel — distinguishes "analyzed, nothing
// found" from "not analyzed yet" (empty), so the row isn't re-analyzed on the
// next run and isn't mistaken for a real title ready to transfer.
const NO_VIDEO_FOUND = 'no';

// Column definitions for each reasoning sheet (simplified)
const REASON_COLUMNS = [
  'channel_email',
  'channel_name',
  'channelId',
  'channelurl',
  'videotitle',
  'transferred'
];

// Expected headers for Needs Email sheet
const NEEDS_EMAIL_HEADERS = [
  'channel_email', 'channel_name', 'channelId', 'channelurl',
  'subscribers', 'country', 'total_views', 'has_business_email', 'status'
];

// Columns from No Reply sheet (0-indexed)
const NO_REPLY_COLUMNS = {
  CHANNEL_NAME: 0,
  EMAIL: 1,
  CHANNEL_ID: 2,
  VIEWS: 3,
  OBSERVATION: 4,
};

// ─── Auth ───────────────────────────────────────────────────────────────────
let sheetsClient = null;

async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;

  const keyPath = path.join(__dirname, 'keys', 'google-service-account.json');
  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

// ─── Retry / rate-limit helpers ────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRateLimitError(err) {
  const code = err?.code || err?.response?.status;
  const message = (err?.message || '').toLowerCase();
  return code === 429 || message.includes('quota') || message.includes('rate limit');
}

/**
 * Retry a Sheets API call with exponential backoff, but only for
 * rate-limit/quota errors — other errors fail immediately.
 */
async function withRetry(fn, { retries = 4, baseDelayMs = 1000 } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimitError(err) || attempt >= retries) throw err;
      await sleep(baseDelayMs * Math.pow(2, attempt));
      attempt++;
    }
  }
}

/**
 * Build a lowercased Set of every email already present in the app's own
 * state (data.json) — newLeads, oldLeads, and staleLeads all count as
 * "already in my app", since a stale lead is still a lead we've handled.
 * Used to keep duplicates out of the reasoning sheets in the first place.
 */
function getAppEmailSet() {
  const data = db.read();
  if (!data) return new Set();

  const all = [
    ...(data.newLeads || []),
    ...(data.oldLeads || []),
    ...(data.staleLeads || []),
  ];

  const emails = new Set();
  for (const lead of all) {
    const email = lead && lead.email ? lead.email.toString().trim().toLowerCase() : '';
    if (email) emails.add(email);
  }
  return emails;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Read all rows from a sheet. Returns array of arrays (first row = headers).
 * Sheet names with special characters need to be quoted with single quotes.
 */
async function readSheet(sheetName) {
  const sheets = await getSheetsClient();

  // Try with quoted name first, then unquoted as fallback
  const range = `'${sheetName}'`;

  let res;
  try {
    res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range,
      valueRenderOption: 'FORMATTED_VALUE',
    });
  } catch (err) {
    // If range parsing fails, try using A:ZZ suffix (works for all sheet names)
    try {
      res = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `'${sheetName}'!A:ZZ`,
        valueRenderOption: 'FORMATTED_VALUE',
      });
    } catch (err2) {
      // Last resort: try with just the sheet name unquoted (works for simple names)
      res = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${sheetName}!A:ZZ`,
        valueRenderOption: 'FORMATTED_VALUE',
      });
    }
  }

  return res.data.values || [];
}

/**
 * Append rows to a sheet.
 *
 * Deliberately does NOT use the Sheets API's values.append (table
 * auto-detection): if the sheet ever has a blank-row gap in the middle
 * (e.g. from a manual edit or a filter), append's table detection stops at
 * that gap and inserts new rows there instead of at the true bottom —
 * shifting existing rows down and scrambling which row is which. Instead,
 * we read the sheet to find the real last row and write there explicitly.
 */
async function appendRows(sheetName, rows) {
  if (rows.length === 0) return;
  const sheets = await getSheetsClient();

  const existing = await readSheet(sheetName);
  const startRow = existing.length + 1; // 1-indexed, first empty row

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `'${sheetName}'!A${startRow}`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: rows },
  });
}

/**
 * Clear a range of rows in a sheet (deletes values, shifts rows up).
 * Uses batchUpdate with deleteDimension request.
 */
async function deleteRows(sheetName, startRowIndex, endRowIndex) {
  const sheets = await getSheetsClient();

  // First, get the sheet ID (numeric) for the given sheet name
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
  });

  const sheet = spreadsheet.data.sheets.find(
    s => s.properties.title === sheetName
  );
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found`);

  const sheetId = sheet.properties.sheetId;

  // Delete the rows (shift rows up)
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    resource: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId,
            dimension: 'ROWS',
            startIndex: startRowIndex,
            endIndex: endRowIndex,
          },
        },
      }],
    },
  });
}

/**
 * Update specific cells in a sheet (e.g., set a status column).
 */
async function updateCells(sheetName, cellRange, values) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `'${sheetName}'!${cellRange}`,
    valueInputOption: 'USER_ENTERED',
    resource: { values },
  });
}

/**
 * Ensure a sheet exists. Creates it if missing.
 */
async function ensureSheet(sheetName) {
  const sheets = await getSheetsClient();
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
  });

  const exists = spreadsheet.data.sheets.some(
    s => s.properties.title === sheetName
  );
  if (exists) return;

  // Create the sheet
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    resource: {
      requests: [{
        addSheet: {
          properties: { title: sheetName },
        },
      }],
    },
  });

  // If it's a reasoning sheet, write the header row
  if (sheetName === SHEETS.NEW_LEADS_REASON || sheetName === SHEETS.OLD_LEADS_REASON) {
    await appendRows(sheetName, [REASON_COLUMNS]);
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Get the status of all sheets (counts).
 */
async function getSummary() {
  const allSheets = {};
  for (const [key, name] of Object.entries(SHEETS)) {
    try {
      const data = await readSheet(name);
      // Subtract 1 for header row
      const count = Math.max(0, data.length - 1);
      allSheets[key] = { name, count, headers: data[0] || [] };
    } catch (err) {
      allSheets[key] = { name, count: -1, error: err.message };
    }
  }
  return allSheets;
}

/**
 * Get accepted leads from Needs Email sheet.
 * Returns rows where status column === 'Accepted'.
 * Handles both sheets with headers and without.
 */
async function getAcceptedNeedsEmail() {
  const data = await readSheet(SHEETS.NEEDS_EMAIL);
  if (data.length === 0) return { headers: NEEDS_EMAIL_HEADERS, rows: [], totalRows: 0 };

  // Check if first row is a header row (contains known column names)
  const firstRow = data[0] || [];
  const hasHeaders = firstRow.some(h =>
    typeof h === 'string' && ['channel_email', 'channel_name', 'channelid', 'channel url'].includes(h.toLowerCase().replace(/\s/g, ''))
  );

  let headers;
  let rows;
  let hasRealHeaders = false;

  if (hasHeaders) {
    headers = data[0];
    rows = data.slice(1);
    hasRealHeaders = true;
  } else {
    // No headers — use fixed column indices
    headers = NEEDS_EMAIL_HEADERS;
    rows = data;
  }

  // Find the status column index
  const statusIdx = headers.findIndex(
    h => h && h.toString().toLowerCase().replace(/[\s_-]/g, '') === 'status'
  );

  const accepted = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (statusIdx >= 0 && statusIdx < row.length) {
      const statusVal = (row[statusIdx] || '').toString().trim().toLowerCase();
      if (statusVal === 'accepted' || statusVal === 'Accepted') {
        accepted.push({
          rowIndex: i + 2, // 1-indexed + 1 for header (even if no header, consistent)
          data: row,
          headers,
          _hasRealHeaders: hasRealHeaders,
        });
      }
    }
  }

  return { headers, rows: accepted, totalRows: data.length };
}

/**
 * Move accepted leads from Needs Email → new_leads_reason.
 * Maps columns appropriately.
 */
async function moveAcceptedToReasoning() {
  await ensureSheet(SHEETS.NEW_LEADS_REASON);

  const { headers, rows: accepted, totalRows } = await getAcceptedNeedsEmail();
  if (accepted.length === 0) return { moved: 0 };

  // Normalize helper: lowercase, strip spaces/underscores/dashes
  const norm = (s) => String(s).toLowerCase().replace(/[\s_-]/g, '');

  // Leads already in the app (data.json) must never be pushed into the
  // reasoning sheet — they're marked "Duplicate" in Needs Email instead of
  // "Moved" so they don't linger as "Accepted" and get reconsidered again.
  const appEmails = getAppEmailSet();

  // Build reasoning rows from accepted data
  const reasonRows = [];
  const toMark = [];
  for (const item of accepted) {
    const r = item.data;
    const h = item.headers;

    const getCol = (...names) => {
      for (const name of names) {
        const normalized = norm(name);
        const idx = h.findIndex(hh => hh && norm(hh) === normalized);
        if (idx >= 0 && idx < r.length && r[idx]) return r[idx].toString();
      }
      return '';
    };

    // Map Needs Email columns → reasoning columns (by column index if no headers)
    // When the sheet has no headers, columns are at fixed positions:
    // 0:channel_name, 1:channelId, 2:channelurl, 3:subscribers, 4:country, 5:total_views, 6:has_business_email
    const useIndexFallback = h === NEEDS_EMAIL_HEADERS && !item._hasRealHeaders;

    const email = (useIndexFallback ? (r[0] || '') : getCol('channel_email', 'Channel Email')).toString().trim();

    if (email && appEmails.has(email.toLowerCase())) {
      toMark.push({ item, status: 'Duplicate' });
      continue;
    }

    const row = [
      email,                                                                       // channel_email
      useIndexFallback ? (r[0] || '') : getCol('channel_name', 'Channel Name'),    // channel_name
      useIndexFallback ? (r[1] || '') : getCol('channelId', 'Channel ID'),         // channelId
      useIndexFallback ? (r[2] || '') : getCol('channelurl', 'Channel URL'),       // channelurl
      '',  // videotitle (will be filled by reasoning)
      '',  // transferred (starts empty)
    ];
    reasonRows.push(row);
    toMark.push({ item, status: 'Moved' });
  }

  // Append to new_leads_reason sheet (only the genuinely new ones)
  if (reasonRows.length > 0) {
    await appendRows(SHEETS.NEW_LEADS_REASON, reasonRows);
  }

  // Mark every accepted row in Needs Email so none of them get picked up
  // again: "Moved" for ones sent to reasoning, "Duplicate" for ones already
  // in the app.
  const statusIdx = headers.findIndex(
    h => h && h.toString().toLowerCase() === 'status'
  );
  if (statusIdx >= 0) {
    const colLetter = String.fromCharCode(65 + statusIdx); // A, B, C...
    // Mark rows one at a time (not all at once) with a small delay + retry,
    // so we don't blow through the Sheets API rate limit.
    for (const { item, status } of toMark) {
      await withRetry(() => updateCells(
        SHEETS.NEEDS_EMAIL,
        `${colLetter}${item.rowIndex}`,
        [[status]]
      ));
      await sleep(300);
    }
  }

  return { moved: reasonRows.length, skippedDuplicates: toMark.length - reasonRows.length };
}

/**
 * Get rows from new_leads_reason that have videotitle filled in AND haven't been transferred yet.
 */
async function getReasonedNewLeads() {
  await ensureSheet(SHEETS.NEW_LEADS_REASON);
  const data = await readSheet(SHEETS.NEW_LEADS_REASON);

  if (data.length < 2) return { headers: REASON_COLUMNS, rows: [], totalRows: 0, pendingRows: 0 };

  const headers = data[0];
  const rows = data.slice(1);

  const videoTitleIdx = headers.findIndex(
    h => h && h.toString().toLowerCase() === 'videotitle'
  );
  const transferredIdx = headers.findIndex(
    h => h && h.toString().toLowerCase() === 'transferred'
  );

  const ready = [];
  let pendingRows = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const videoTitleVal = videoTitleIdx >= 0 && videoTitleIdx < row.length
      ? (row[videoTitleIdx] || '').toString().trim()
      : '';
    const transferredVal = transferredIdx >= 0 && transferredIdx < row.length
      ? (row[transferredIdx] || '').toString().trim().toLowerCase()
      : '';

    // Matches reasoning.js's own "needs analysis" rule exactly, so the UI
    // count always agrees with what "Start Reasoning" will actually process.
    if (videoTitleVal === '' && transferredVal !== 'yes') {
      pendingRows++;
    }

    if (videoTitleVal !== '' && videoTitleVal.toLowerCase() !== NO_VIDEO_FOUND && transferredVal !== 'yes') {
      ready.push({
        rowIndex: i + 2, // 1-indexed + header
        data: row,
        headers,
      });
    }
  }

  return { headers, rows: ready, totalRows: rows.length, pendingRows };
}

/**
 * Get rows from old_leads_reason that have videotitle filled in AND haven't been transferred.
 */
async function getReasonedOldLeads() {
  await ensureSheet(SHEETS.OLD_LEADS_REASON);
  const data = await readSheet(SHEETS.OLD_LEADS_REASON);

  if (data.length < 2) return { headers: REASON_COLUMNS, rows: [], totalRows: 0, pendingRows: 0 };

  const headers = data[0];
  const rows = data.slice(1);

  const videoTitleIdx = headers.findIndex(
    h => h && h.toString().toLowerCase() === 'videotitle'
  );
  const transferredIdx = headers.findIndex(
    h => h && h.toString().toLowerCase() === 'transferred'
  );

  const ready = [];
  let pendingRows = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const videoTitleVal = videoTitleIdx >= 0 && videoTitleIdx < row.length
      ? (row[videoTitleIdx] || '').toString().trim()
      : '';
    const transferredVal = transferredIdx >= 0 && transferredIdx < row.length
      ? (row[transferredIdx] || '').toString().trim().toLowerCase()
      : '';

    if (videoTitleVal === '' && transferredVal !== 'yes') {
      pendingRows++;
    }

    if (videoTitleVal !== '' && videoTitleVal.toLowerCase() !== NO_VIDEO_FOUND && transferredVal !== 'yes') {
      ready.push({
        rowIndex: i + 2,
        data: row,
        headers,
      });
    }
  }

  return { headers, rows: ready, totalRows: rows.length, pendingRows };
}

/**
 * Find (or create) the 'transferred' column and return its letter.
 * Does one read — callers doing this per-row in a loop should call it once
 * up front and reuse the result instead of re-reading the whole sheet for
 * every row (that's what used to make batch transfers slow and prone to
 * hitting the rate limit).
 */
async function getOrCreateTransferredColumnLetter(sheetName) {
  const data = await readSheet(sheetName);
  const headers = data[0] || [];

  const transferredIdx = headers.findIndex(
    h => h && h.toString().toLowerCase() === 'transferred'
  );
  if (transferredIdx >= 0) {
    return String.fromCharCode(65 + transferredIdx);
  }

  const newColLetter = String.fromCharCode(65 + headers.length);
  await updateCells(sheetName, `${newColLetter}1`, [['transferred']]);
  return newColLetter;
}

/**
 * Set the 'transferred' cell for one row, given an already-known column
 * letter (see getOrCreateTransferredColumnLetter). No read involved.
 */
async function setTransferredCell(sheetName, colLetter, rowIndex) {
  await updateCells(sheetName, `${colLetter}${rowIndex}`, [['yes']]);
}

/**
 * Mark a reasoning row as transferred (sets 'transferred' column to 'yes').
 * Convenience wrapper for one-off calls; batch callers should use
 * getOrCreateTransferredColumnLetter + setTransferredCell instead so they
 * don't re-read the whole sheet for every row.
 */
async function markReasoningRowTransferred(sheetName, rowIndex) {
  const colLetter = await getOrCreateTransferredColumnLetter(sheetName);
  await setTransferredCell(sheetName, colLetter, rowIndex);
}

/**
 * Get the current number of rows (including header) in a sheet — used to
 * compute where the next append should land without re-reading the whole
 * sheet before every single write in a batch loop.
 */
async function getSheetRowCount(sheetName) {
  const data = await readSheet(sheetName);
  return data.length;
}

/**
 * Write a single row at an explicit 1-indexed row number. No read involved
 * — callers appending many rows in a loop should track the next row number
 * themselves (starting from getSheetRowCount(sheetName) + 1) instead of
 * calling appendRows per row, which re-reads the whole sheet every time.
 */
async function writeRowAt(sheetName, rowNumber, row) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `'${sheetName}'!A${rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [row] },
  });
}

/**
 * Move 50 rows from No Reply to old_leads_reason.
 */
async function moveNoReplyToReasoning(count = 50) {
  await ensureSheet(SHEETS.OLD_LEADS_REASON);

  const data = await readSheet(SHEETS.NO_REPLY);
  if (data.length < 2) return { moved: 0 };

  const headers = data[0];
  const rows = data.slice(1);

  // Take up to `count` rows
  const toMove = rows.slice(0, Math.min(count, rows.length));
  if (toMove.length === 0) return { moved: 0 };

  // Leads already in the app (data.json) are skipped instead of being
  // pushed into old_leads_reason for re-processing.
  const appEmails = getAppEmailSet();

  // Map No Reply columns → reasoning columns
  const reasonRows = [];
  let skippedDuplicates = 0;
  for (const r of toMove) {
    const channelName = r[0] || '';
    const email = (r[1] || '').toString().trim();
    const channelId = r[2] || '';

    if (email && appEmails.has(email.toLowerCase())) {
      skippedDuplicates++;
      continue;
    }

    const row = [
      email,       // channel_email
      channelName, // channel_name
      channelId,   // channelId
      '',          // channelurl
      '',          // videotitle (will be filled by reasoning)
      '',          // transferred (starts empty)
    ];
    reasonRows.push(row);
  }

  // Append to old_leads_reason (only the genuinely new ones)
  if (reasonRows.length > 0) {
    await appendRows(SHEETS.OLD_LEADS_REASON, reasonRows);
  }

  // Delete all `toMove` rows from No Reply regardless (shift rows up):
  // duplicates are already handled by the app and don't need to sit here
  // taking up the next batch's count, and the rest have moved on.
  // Rows are 0-indexed, header is row 0, data starts at row 1
  await deleteRows(SHEETS.NO_REPLY, 1, 1 + toMove.length);

  return { moved: reasonRows.length, skippedDuplicates };
}

/**
 * Build a lead object from a reasoning row (for app transfer).
 * Only extracts the columns needed by the app.
 */
function buildLeadFromReasoningRow(row, headers, pageType) {
  const getVal = (name) => {
    const idx = headers.findIndex(h => h && h.toString().toLowerCase() === name.toLowerCase());
    return idx >= 0 && idx < row.length ? (row[idx] || '').toString().trim() : '';
  };

  const email = getVal('channel_email');
  const name = getVal('channel_name');
  const channelId = getVal('channelId');
  const channelUrl = getVal('channelurl');
  const videoTitle = getVal('videotitle');

  return {
    id: crypto.randomUUID(),
    email,
    name: name || email,
    page: pageType,
    status: 'new',
    customData: {
      channelName: name,
      channelId,
      channelUrl,
      videoTitle,
    },
    createdAt: new Date().toISOString(),
  };
}

module.exports = {
  SHEET_ID,
  SHEETS,
  REASON_COLUMNS,
  NO_VIDEO_FOUND,
  readSheet,
  appendRows,
  deleteRows,
  updateCells,
  ensureSheet,
  getSummary,
  getAcceptedNeedsEmail,
  moveAcceptedToReasoning,
  getReasonedNewLeads,
  getReasonedOldLeads,
  markReasoningRowTransferred,
  getOrCreateTransferredColumnLetter,
  setTransferredCell,
  getSheetRowCount,
  writeRowAt,
  moveNoReplyToReasoning,
  buildLeadFromReasoningRow,
  getAppEmailSet,
  sleep,
  isRateLimitError,
  withRetry,
};
