const { google } = require('googleapis');
const path = require('path');
const { NO_VIDEO_FOUND } = require('./google-sheets');

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || 'YOUR_YOUTUBE_API_KEY_HERE';
const SHEET_ID = process.env.GOOGLE_SHEET_ID || 'YOUR_GOOGLE_SHEET_ID_HERE';

const SHEETS = { NEW_LEADS_REASON: 'new_leads_reason', OLD_LEADS_REASON: 'old_leads_reason' };

const COL = {
  CHANNEL_EMAIL: 0,      // A - channel_email
  CHANNEL_NAME: 1,       // B - channel_name
  CHANNEL_ID: 2,         // C - channelId (resolved channel ID gets written here)
  CHANNEL_URL: 3,        // D - channelurl
  VIDEO_TITLE: 4,        // E - videotitle (high-performing video title written here)
  TRANSFERRED: 5         // F - transferred
};
const TOTAL_COLUMNS = 6;

const OUTLIER_MULTIPLIER = 1.5;
const MIN_DURATION_SECONDS = 120;      // ignore Shorts / clips under 2 min
const ROW_BATCH_SIZE = 15;             // parallel channel-analysis rows

// Same windows as the n8n workflow
const WINDOWS = [
  { name: '3_months', minDays: 0,   maxDays: 90 },
  { name: '5_months', minDays: 91,  maxDays: 150 },
  { name: '2_years',  minDays: 151, maxDays: 730 }
];

// Set to true when YouTube reports quotaExceeded — aborts the run cleanly.
let quotaExceeded = false;

// ---------------------------------------------------------------------------
// Google Sheets helpers
// ---------------------------------------------------------------------------
let sheetsClient = null;

async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, 'keys', 'google-service-account.json'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

function colLetter(colIndex) {
  let n = colIndex;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

async function readSheet(sheetName) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "'" + sheetName + "'!A:ZZ",
    valueRenderOption: 'FORMATTED_VALUE'
  });
  return res.data.values || [];
}

// Write many individual cells in ONE api call (avoids 60-writes/min quota).
// Uses RAW so values land exactly as given — "10,000" stays "10,000".
async function batchUpdateCells(sheetName, cellUpdates) {
  if (!cellUpdates || cellUpdates.length === 0) return;
  const sheets = await getSheetsClient();
  const data = cellUpdates.map(function (u) {
    const letter = typeof u.col === 'number' ? colLetter(u.col) : u.col;
    return { range: "'" + sheetName + "'!" + letter + u.row, values: [[u.val]] };
  });
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    resource: { valueInputOption: 'RAW', data: data }
  });
}

// ---------------------------------------------------------------------------
// YouTube API helper with quota detection
// ---------------------------------------------------------------------------
async function ytFetch(url) {
  try {
    const res = await fetch(url);
    if (res.status === 403) {
      let body = null;
      try { body = await res.json(); } catch (e) {}
      const reason = body && body.error && body.error.errors && body.error.errors[0]
        ? body.error.errors[0].reason : '';
      if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded' || reason === 'rateLimitExceeded') {
        quotaExceeded = true;
      }
      return null;
    }
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Channel resolution: URL first (exact & cheap), name search LAST resort
// NOTE: search costs 100 quota units per call; channels lookups cost 1.
// ---------------------------------------------------------------------------
function parseChannelUrl(rawUrl) {
  if (!rawUrl || rawUrl.trim() === '') return null;
  let u = rawUrl.trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try {
    const parsed = new URL(u);
    if (!/(^|\.)youtube\.com$/i.test(parsed.hostname) && !/(^|\.)youtu\.be$/i.test(parsed.hostname)) return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return null;
    if (parts[0].toLowerCase() === 'channel' && parts[1]) return { type: 'id', value: parts[1] };
    if (parts[0].startsWith('@')) return { type: 'handle', value: parts[0] };
    if (parts[0].toLowerCase() === 'user' && parts[1]) return { type: 'username', value: parts[1] };
    if (parts[0].toLowerCase() === 'c' && parts[1]) return { type: 'custom', value: parts[1] };
    return { type: 'custom', value: parts[0] }; // legacy vanity URL
  } catch (e) {
    return null;
  }
}

async function lookupChannel(paramName, paramValue) {
  const data = await ytFetch(
    'https://www.googleapis.com/youtube/v3/channels?part=snippet&' +
    paramName + '=' + encodeURIComponent(paramValue) + '&key=' + YOUTUBE_API_KEY
  );
  if (!data || !data.items || data.items.length === 0) return null;
  return { channelId: data.items[0].id, channelTitle: data.items[0].snippet.title };
}

async function searchChannel(channelName) {
  if (!channelName || channelName.trim() === '') return null;
  const data = await ytFetch(
    'https://www.googleapis.com/youtube/v3/search?part=snippet&q=' +
    encodeURIComponent(channelName) + '&type=channel&maxResults=1&key=' + YOUTUBE_API_KEY
  );
  if (!data || !data.items || data.items.length === 0) return null;
  return { channelId: data.items[0].id.channelId, channelTitle: data.items[0].snippet.title };
}

async function resolveChannel(channelUrl, channelName) {
  const parsed = parseChannelUrl(channelUrl);
  if (parsed) {
    if (parsed.type === 'id') {
      return { channelId: parsed.value, channelTitle: '' }; // zero api calls
    }
    if (parsed.type === 'handle') {
      const found = await lookupChannel('forHandle', parsed.value); // 1 unit
      if (found) return found;
    }
    if (parsed.type === 'username') {
      const found = await lookupChannel('forUsername', parsed.value); // 1 unit
      if (found) return found;
    }
    if (parsed.type === 'custom') {
      const found = await searchChannel(parsed.value); // 100 units
      if (found) return found;
    }
  }
  if (quotaExceeded) return null;
  return await searchChannel(channelName); // 100 units — last resort only
}

// ---------------------------------------------------------------------------
// Videos
// ---------------------------------------------------------------------------
function uploadsPlaylistFromChannelId(channelId) {
  // uploads playlist = channel ID with "UC" swapped for "UU" (zero api calls)
  if (channelId && channelId.startsWith('UC')) return 'UU' + channelId.slice(2);
  return null;
}

async function getUploadsPlaylistId(channelId) {
  const derived = uploadsPlaylistFromChannelId(channelId);
  if (derived) return derived;
  const data = await ytFetch(
    'https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=' +
    channelId + '&key=' + YOUTUBE_API_KEY
  );
  if (!data || !data.items || data.items.length === 0) return null;
  return data.items[0].contentDetails.relatedPlaylists.uploads;
}

const MAX_PLAYLIST_PAGES = 100;        // safety cap: 100 pages x 50 = 5,000 videos

// "Return All" — exact equivalent of the n8n "Get many playlist items" node
// with returnAll: true. Pages through the ENTIRE uploads playlist, 50 items
// per page (1 quota unit each). Video stats are then fetched in batches of
// 50 IDs per call, so cost stays low: a 500-video channel = 10 + 10 = 20 units.
async function getPlaylistItems(playlistId) {
  const all = [];
  let pageToken = '';

  for (let page = 0; page < MAX_PLAYLIST_PAGES; page++) {
    const data = await ytFetch(
      'https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=' +
      playlistId + '&maxResults=50' +
      (pageToken ? '&pageToken=' + pageToken : '') +
      '&key=' + YOUTUBE_API_KEY
    );
    if (!data || !data.items || data.items.length === 0) break;

    for (let i = 0; i < data.items.length; i++) {
      const item = data.items[i];
      all.push({
        videoId: item.snippet.resourceId.videoId,
        title: item.snippet.title,
        publishedAt: item.snippet.publishedAt
      });
    }

    pageToken = data.nextPageToken;
    if (!pageToken) break; // reached the end of the playlist
  }
  return all;
}

async function getVideoStats(videoIds) {
  if (videoIds.length === 0) return {};
  const data = await ytFetch(
    'https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails&id=' +
    videoIds.join(',') + '&key=' + YOUTUBE_API_KEY
  );
  if (!data || !data.items) return {};
  const map = {};
  for (let i = 0; i < data.items.length; i++) {
    const item = data.items[i];
    const views = parseInt(
      item.statistics && item.statistics.viewCount ? item.statistics.viewCount : '0', 10
    );
    const dur = item.contentDetails && item.contentDetails.duration ? item.contentDetails.duration : 'PT0S';
    const match = dur.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    let secs = 0;
    if (match) {
      secs = parseInt(match[1] || '0', 10) * 3600 +
             parseInt(match[2] || '0', 10) * 60 +
             parseInt(match[3] || '0', 10);
    }
    map[item.id] = { views: views, durationSeconds: secs };
  }
  return map;
}

// ---------------------------------------------------------------------------
// Outlier analysis — EXACT port of the n8n workflow code node:
//  - a window only counts if it has at least 3 videos
//  - only the TOP video of each window is tested against 1.5x window average
//  - winner = highest raw views among the per-window winners
//  - if no winner: found=false (row skipped, nothing written — no fallback)
//  - recent videos = the 2 most recently published videos (winner NOT excluded)
//  - NO duration/shorts filter (the workflow didn't have one)
// ---------------------------------------------------------------------------
const fmt = function (n) { return Number(n).toLocaleString('en-US'); };

function analyzeVideos(videos, now) {
  const MS_PER_DAY = 1000 * 60 * 60 * 24;

  // Shorts filter: ignore videos under 120s (as in the workflow)
  const longform = videos.filter(function (v) {
    return Number(v.durationSeconds || 0) >= MIN_DURATION_SECONDS;
  });
  if (longform.length === 0) return { found: false, mainVideo: null, recentVideos: [] };

  // Pre-calc basic data (same as workflow)
  const vids = longform.map(function (v) {
    return {
      videoId: v.videoId,
      title: v.title,
      publishedAt: v.publishedAt,
      views: Number(v.views || 0),
      daysSince: (now.getTime() - new Date(v.publishedAt).getTime()) / MS_PER_DAY
    };
  });

  // Search logic: at most ONE potential winner per window
  const potentialWinners = [];
  for (let wi = 0; wi < WINDOWS.length; wi++) {
    const win = WINDOWS[wi];
    const windowVideos = vids.filter(function (v) {
      return v.daysSince >= win.minDays && v.daysSince <= win.maxDays;
    });

    if (windowVideos.length < 3) continue; // exact workflow rule

    let totalViews = 0;
    for (let j = 0; j < windowVideos.length; j++) totalViews += windowVideos[j].views;
    const avgViews = totalViews / windowVideos.length;

    const topVideo = windowVideos.slice().sort(function (a, b) { return b.views - a.views; })[0];

    if (topVideo.views >= avgViews * OUTLIER_MULTIPLIER) {
      potentialWinners.push({
        title: topVideo.title,
        views: topVideo.views,
        avgInWindow: Math.round(avgViews),
        videoId: topVideo.videoId,
        window: win.name
      });
    }
  }

  // Selection: highest raw views wins (exact workflow rule)
  const winner = potentialWinners.sort(function (a, b) { return b.views - a.views; })[0];

  if (!winner) {
    return { found: false, mainVideo: null, recentVideos: [] };
  }

  // Recent videos: 2 most recently published, winner NOT excluded
  const recentVideos = vids.slice()
    .sort(function (a, b) { return a.daysSince - b.daysSince; })
    .slice(0, 2)
    .map(function (v) { return { videoId: v.videoId, title: v.title, views: v.views }; });

  return { found: true, mainVideo: winner, recentVideos: recentVideos };
}

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------
function truncateTranscript(text) {
  if (!text || text.length <= TRANSCRIPT_MAX_CHARS) return text;
  let cut = text.slice(0, TRANSCRIPT_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > TRANSCRIPT_MAX_CHARS * 0.9) cut = cut.slice(0, lastSpace);
  return cut.trim();
}

async function fetchTranscript(videoId) {
  if (!videoId) return null;
  try {
    const res = await fetch('https://kome.ai/api/transcript', {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
        'Referer': 'https://kome.ai/',
        'content-type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'Origin': 'https://kome.ai'
      },
      body: JSON.stringify({
        video_id: 'https://www.youtube.com/watch?v=' + videoId,
        format: true,
        source: 'tool'
      })
    });
    if (!res.ok) {
      await res.text().catch(function () {});
      return null;
    }
    const data = await res.json();
    const transcript = data.transcript || data.text || data.data || '';
    const cleaned = transcript ? transcript.toString().trim() : '';
    return truncateTranscript(cleaned);
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-row channel analysis (used by the batched Phase 1)
// ---------------------------------------------------------------------------
async function processRow(item, log) {
  const rowNumber = item.index + 2;
  const name =
    (item.row[COL.CHANNEL_NAME] || '').toString().trim() ||
    (item.row[COL.CHANNEL_EMAIL] || '').toString().trim() ||
    '(unknown)';

  // Resolve channel ID: check columns C and D (both may hold UC...)
  const rawChannelId = (item.row[COL.CHANNEL_URL] || '').toString().trim() ||
                       (item.row[COL.CHANNEL_ID] || '').toString().trim();

  let channelId = null;
  if (rawChannelId && rawChannelId.startsWith('UC')) {
    channelId = rawChannelId;
    log('    -> channel ID from sheet: ' + channelId);
  } else {
    const urlCandidateC = (item.row[COL.CHANNEL_URL] || '').toString().trim();
    const urlCandidateD = (item.row[COL.CHANNEL_ID] || '').toString().trim();
    const channelUrl = parseChannelUrl(urlCandidateC) ? urlCandidateC
                     : parseChannelUrl(urlCandidateD) ? urlCandidateD
                     : urlCandidateC;
    const channel = await resolveChannel(channelUrl, name);
    if (quotaExceeded) return { rowNumber: rowNumber, status: 'quota' };
    if (!channel) {
      return {
        rowNumber: rowNumber,
        status: 'no-channel',
        name: name,
        updates: [{ col: COL.VIDEO_TITLE, row: rowNumber, val: NO_VIDEO_FOUND }]
      };
    }
    channelId = channel.channelId;
    log('    -> resolved channel ID: ' + channelId);
  }

  const playlistId = await getUploadsPlaylistId(channelId);
  if (!playlistId) {
    return {
      rowNumber: rowNumber,
      status: 'no-playlist',
      name: name,
      updates: [
        { col: COL.CHANNEL_ID, row: rowNumber, val: channelId },
        { col: COL.VIDEO_TITLE, row: rowNumber, val: NO_VIDEO_FOUND }
      ]
    };
  }

  const items = await getPlaylistItems(playlistId); // paginates to cover full 2-year window
  if (quotaExceeded) return { rowNumber: rowNumber, status: 'quota' };
  if (items.length === 0) {
    return {
      rowNumber: rowNumber,
      status: 'no-videos',
      name: name,
      updates: [
        { col: COL.CHANNEL_ID, row: rowNumber, val: channelId },
        { col: COL.VIDEO_TITLE, row: rowNumber, val: NO_VIDEO_FOUND }
      ]
    };
  }
  log('    -> got ' + items.length + ' videos');

  const ids = items.map(function (v) { return v.videoId; });
  const statsMap = {};
  for (let s = 0; s < ids.length; s += 50) {
    Object.assign(statsMap, await getVideoStats(ids.slice(s, s + 50)));
  }
  if (quotaExceeded) return { rowNumber: rowNumber, status: 'quota' };

  const videos = [];
  for (let vi = 0; vi < items.length; vi++) {
    const st = statsMap[items[vi].videoId];
    if (st) {
      videos.push({
        videoId: items[vi].videoId,
        title: items[vi].title,
        publishedAt: items[vi].publishedAt,
        views: st.views,
        durationSeconds: st.durationSeconds
      });
    }
  }

  const result = analyzeVideos(videos, new Date());

  if (!result.found) {
    // No outlier across the last 2 years — mark "no" so this row isn't
    // re-analyzed next run and doesn't look transfer-ready.
    return {
      rowNumber: rowNumber,
      status: 'no-outlier',
      name: name,
      updates: [
        { col: COL.CHANNEL_ID, row: rowNumber, val: channelId },
        { col: COL.VIDEO_TITLE, row: rowNumber, val: NO_VIDEO_FOUND }
      ]
    };
  }

  const updates = [{ col: COL.CHANNEL_ID, row: rowNumber, val: channelId }];
  updates.push({ col: COL.VIDEO_TITLE, row: rowNumber, val: result.mainVideo.title });
  log('    -> main [' + result.mainVideo.window + ']: ' + result.mainVideo.title +
      ' (' + fmt(result.mainVideo.views) + ' views, window avg ' + fmt(result.mainVideo.avgInWindow) + ')');

  return {
    rowNumber: rowNumber,
    status: 'ok',
    name: name,
    updates: updates.filter(function (u) { return u.val; })
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
async function startReasoning(sheetName, options) {
  if (!options) options = {};
  const onProgress = options.onProgress;
  const log = function (msg) {
    console.log('[Reasoning]', msg);
    if (onProgress) onProgress(msg);
  };

  quotaExceeded = false;
  log('Starting reasoning for sheet: ' + sheetName);

  // ---------- PHASE 1: channel/video analysis, batches of ROW_BATCH_SIZE ----------
  const data = await readSheet(sheetName);
  if (data.length < 2) {
    log('No data rows found.');
    return { processed: 0, updated: 0, errors: 0, transcripts: 0 };
  }

  const headers = data[0] || [];
  const rows = data.slice(1);
  log('Read ' + rows.length + ' data rows.');

  // Find "transferred" column index dynamically from headers
  const transferredColIdx = headers.findIndex(function (h) {
    return h && h.toString().toLowerCase() === 'transferred';
  });

  const toProcess = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    while (row.length < TOTAL_COLUMNS) row.push('');

    const videoTitle = (row[COL.VIDEO_TITLE] || '').toString().trim();
    const transferred = transferredColIdx >= 0 && transferredColIdx < row.length
      ? (row[transferredColIdx] || '').toString().trim().toLowerCase()
      : '';

    // Only process rows without a video title AND not already transferred
    if (videoTitle === '' && transferred !== 'yes') {
      toProcess.push({ index: i, row: row });
    }
  }
  log('Found ' + toProcess.length + ' rows needing analysis. Processing ' + ROW_BATCH_SIZE + ' at a time.');

  let updated = 0;
  let errors = 0;

  for (let start = 0; start < toProcess.length; start += ROW_BATCH_SIZE) {
    if (quotaExceeded) break;
    const batch = toProcess.slice(start, start + ROW_BATCH_SIZE);
    log('Batch ' + (Math.floor(start / ROW_BATCH_SIZE) + 1) + '/' +
        Math.ceil(toProcess.length / ROW_BATCH_SIZE) + ' (rows ' +
        batch.map(function (b) { return b.index + 2; }).join(', ') + ')');

    const t0 = Date.now();
    const results = await Promise.all(batch.map(function (item) {
      return processRow(item, log).catch(function (e) {
        return { rowNumber: item.index + 2, status: 'error', error: e.message };
      });
    }));
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    const allUpdates = [];
    let okCount = 0;
    for (let r = 0; r < results.length; r++) {
      const res = results[r];
      // Any status (ok, or a definitive "nothing found") may carry cell
      // updates — collect them all so the row is written once and doesn't
      // get re-picked-up by toProcess on the next run.
      if (res.updates && res.updates.length > 0) {
        allUpdates.push.apply(allUpdates, res.updates);
      }
      if (res.status === 'ok') {
        updated++;
        okCount++;
        log('  Row ' + res.rowNumber + ' (' + res.name + '): ok');
      } else if (res.status === 'error') {
        errors++;
        log('  Row ' + res.rowNumber + ': ERROR - ' + res.error);
      } else if (res.status === 'quota') {
        log('  Row ' + res.rowNumber + ': YouTube quota exceeded.');
      } else if (res.status === 'no-outlier') {
        log('  Row ' + res.rowNumber + ' (' + res.name + '): no outlier found across the last 2 years, marked "no"');
      } else if (res.status === 'no-channel' || res.status === 'no-playlist' || res.status === 'no-videos') {
        log('  Row ' + res.rowNumber + ' (' + (res.name || '?') + '): ' + res.status + ', marked "no"');
      } else {
        log('  Row ' + res.rowNumber + ' (' + (res.name || '?') + '): skipped (' + res.status + ')');
      }
    }
    if (allUpdates.length > 0) {
      try {
        log('    writing ' + allUpdates.length + ' cells to sheet...');
        await batchUpdateCells(sheetName, allUpdates);
      } catch (e) {
        errors++;
        log('    Sheets write ERROR: ' + e.message);
      }
    }
    log('  batch done in ' + elapsed + 's - ' + okCount + '/' + batch.length + ' rows ok');

    if (quotaExceeded) {
      log('*** YouTube API quota exhausted. Stopping analysis. ***');
      log('*** Already-written rows are saved. Re-run tomorrow (or with a new key) to continue. ***');
      break;
    }
  }

  log('Done: ' + updated + ' rows updated, ' + errors + ' errors.' +
      (quotaExceeded ? ' (stopped early: YouTube quota exhausted)' : ''));
  return { processed: toProcess.length, updated: updated, errors: errors, transcripts: 0, quotaExceeded: quotaExceeded };
}

module.exports = {
  SHEETS: SHEETS,
  startReasoning: startReasoning,
  resolveChannel: resolveChannel,
  searchChannel: searchChannel,
  getUploadsPlaylistId: getUploadsPlaylistId,
  getPlaylistItems: getPlaylistItems,
  getVideoStats: getVideoStats,
  analyzeVideos: analyzeVideos
};