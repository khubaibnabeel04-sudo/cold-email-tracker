const path = require('path');
// Load .env from the project root before any module reads process.env (Node >= 20.12)
try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* no .env — rely on real env vars */ }

const express = require('express');
const cors = require('cors');
const db = require('./db');
const scheduler = require('./scheduler');
const autoScheduler = require('./auto-scheduler');
const sheets = require('./google-sheets');
const reasoning = require('./reasoning');
const gmailSync = require('./gmail-sync');
const sendStats = require('./send-stats');
const youtubeData = require('./youtube-data');
const ideasStore = require('./ideas-store');
const aiFollowup = require('./ai-followup');
const app = express();

app.use(cors());

// Log all incoming requests with timestamp
app.use((req, res, next) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${req.method} ${req.originalUrl}`);
  next();
});

app.use(express.json({ limit: '50mb' }));

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

// ============================================================
// DATABASE API ENDPOINTS
// ============================================================

// GET /api/state — Load the full app state from the server database
app.get('/api/state', (req, res) => {
  try {
    const data = db.read();
    if (data) {
      console.log(`[DB] State loaded (${Object.keys(data).length} keys)`);
      return res.json(data);
    }
    // First time: return default state (which also writes it to disk)
    const defaultData = db.getDefaultState();
    db.write(defaultData);
    console.log('[DB] First launch — initialized with default state');
    return res.json(defaultData);
  } catch (err) {
    console.error('[DB] Error loading state:', err);
    return res.status(500).json({ error: 'Failed to load state', details: err.message });
  }
});

// POST /api/state — Save the full app state to the server database
app.post('/api/state', (req, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      console.warn('[DB] Received invalid state payload (not an object)');
      return res.status(400).json({ error: 'Invalid state payload' });
    }
    const newCount = body.newLeads?.length || 0;
    const oldCount = body.oldLeads?.length || 0;
    const totalIncoming = newCount + oldCount;

    // GUARD 1: prevent frontend from wiping server data with empty state
    const currentData = db.read();
    if (currentData) {
      const currentTotal = (currentData.newLeads?.length || 0) + (currentData.oldLeads?.length || 0);
      const currentHasAccounts = (currentData.accounts?.length || 0) > 0;
      const incomingHasAccounts = (body.accounts?.length || 0) > 0;
      if (currentTotal > 0 && totalIncoming === 0 && !incomingHasAccounts) {
        console.warn(`[DB] REJECTED save: server has ${currentTotal} leads, incoming has 0 (likely stale frontend state). Preserving server data.`);
        return res.json({ ok: true, savedAt: new Date().toISOString(), note: 'server data preserved (incoming was empty)' });
      }
    }

    const bodySize = JSON.stringify(body).length;
    console.log(`[DB] Saving state: ${newCount} new leads, ${oldCount} old leads, size: ${(bodySize / 1024).toFixed(2)} KB`);
    db.write(body);
    console.log('[DB] State successfully saved to data.json');
    res.json({ ok: true, savedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[DB] Error saving state:', err);
    return res.status(500).json({ error: 'Failed to save state', details: err.message });
  }
});

// POST /api/state/reset — Reset all data to factory defaults
app.post('/api/state/reset', (req, res) => {
  try {
    const defaultData = db.getDefaultState();
    db.write(defaultData);
    console.log('[DB] State has been reset to defaults');
    res.json(defaultData);
  } catch (err) {
    console.error('[DB] Error resetting state:', err);
    return res.status(500).json({ error: 'Failed to reset state', details: err.message });
  }
});

// ============================================================
// AUTH ENDPOINTS
// ============================================================

// Exchange authorization code for tokens (including refresh_token)
app.post('/auth/exchange', async (req, res) => {
  const { code, clientId, clientSecret, redirectUri } = req.body;

  if (!code || !clientId || !clientSecret || !redirectUri) {
    return res.status(400).json({ error: 'Missing required fields: code, clientId, clientSecret, redirectUri' });
  }

  try {
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    const tokenData = await tokenRes.json();

    if (tokenData.error) {
      console.error('Token exchange error:', tokenData);
      return res.status(400).json({ error: tokenData.error, description: tokenData.error_description });
    }

    // Get user email - try Gmail Profile API first (works with Gmail scopes)
    let email = null;
    try {
      const profileRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      if (profileRes.ok) {
        const profileData = await profileRes.json();
        email = profileData.emailAddress;
        console.log(`[AUTH] Successfully retrieved email from Gmail Profile API: ${email}`);
      } else {
        const errText = await profileRes.text();
        console.warn(`[AUTH] Gmail Profile API returned status ${profileRes.status}: ${errText}`);
      }
    } catch (err) {
      console.error('[AUTH] Failed to fetch Gmail profile:', err);
    }

    // Fallback: Google UserInfo endpoint (requires userinfo.email scope)
    if (!email) {
      try {
        const userRes = await fetch(GOOGLE_USERINFO_URL, {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        if (userRes.ok) {
          const userInfo = await userRes.json();
          email = userInfo.email;
          console.log(`[AUTH] Successfully retrieved email from UserInfo API: ${email}`);
        } else {
          const errText = await userRes.text();
          console.warn(`[AUTH] UserInfo API returned status ${userRes.status}: ${errText}`);
        }
      } catch (err) {
        console.error('[AUTH] Failed to fetch Google UserInfo:', err);
      }
    }

    if (!email) {
      console.error('[AUTH] Could not resolve email address from token exchange');
      email = 'unidentified';
    }

    console.log(`[AUTH] Got refresh_token: ${tokenData.refresh_token ? 'YES' : 'NO'}`);

    res.json({
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresIn: tokenData.expires_in,
      email: email,
    });
  } catch (err) {
    console.error('Exchange error:', err);
    res.status(500).json({ error: 'Token exchange failed', details: err.message });
  }
});

// Refresh an expired access token using a stored refresh_token
app.post('/auth/refresh', async (req, res) => {
  const { refreshToken, clientId, clientSecret } = req.body;

  if (!refreshToken || !clientId || !clientSecret) {
    return res.status(400).json({ error: 'Missing required fields: refreshToken, clientId, clientSecret' });
  }

  try {
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
      }),
    });

    const tokenData = await tokenRes.json();

    if (tokenData.error) {
      console.error('Refresh error:', tokenData);
      return res.status(400).json({ error: tokenData.error, description: tokenData.error_description });
    }

    console.log(`[AUTH] Successfully refreshed access token (expires in ${tokenData.expires_in}s)`);

    res.json({
      accessToken: tokenData.access_token,
      expiresIn: tokenData.expires_in,
    });
  } catch (err) {
    console.error('Refresh error:', err);
    res.status(500).json({ error: 'Token refresh failed', details: err.message });
  }
});

// ============================================================
// CLIENT LOGGING ENDPOINT — Frontend can send debug logs here
// ============================================================

// POST /api/log — Receive client-side logs (from sendBeacon which sends text/plain)
app.post('/api/log', express.text({ type: '*/*' }), (req, res) => {
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { level, message, data } = body;
    const ts = new Date().toISOString();
    const prefix = level === 'error' ? '[CLIENT ERROR]' : level === 'warn' ? '[CLIENT WARN]' : '[CLIENT LOG]';
    console.log(`${prefix} [${ts}] ${message}`, data ? JSON.stringify(data).substring(0, 300) : '');
  } catch (parseErr) {
    console.log(`[CLIENT LOG] [${new Date().toISOString()}] (raw) ${String(req.body).substring(0, 200)}`);
  }
  res.json({ ok: true });
});

// ============================================================
// BROWSER ENDPOINTS — Manual schedule workflow
// ============================================================

// POST /api/browser/open — Open Chrome with a saved profile at Gmail Drafts
// The user will manually schedule the drafts themselves.
app.post('/api/browser/open', async (req, res) => {
  const { email, profileDir } = req.body;

  if (!profileDir) {
    return res.status(400).json({ error: 'Missing profileDir' });
  }

  try {
    const result = await scheduler.openBrowser({ email, profileDir });
    if (result) {
      console.log(`[Browser] Opened Chrome for ${email}`);
      res.json({ ok: true, message: `Chrome opened for ${email}` });
    } else {
      res.status(500).json({ error: 'Failed to open browser' });
    }
  } catch (err) {
    console.error('[Browser] Error opening:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/browser/close — Close the currently open Chrome browser
app.post('/api/browser/close', async (req, res) => {
  try {
    await scheduler.closeBrowser();
    console.log('[Browser] Closed');
    res.json({ ok: true, message: 'Browser closed' });
  } catch (err) {
    console.error('[Browser] Error closing:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// AUTO-SCHEDULE ENDPOINTS — Fully automated schedule-send
// ============================================================

// POST /api/auto-schedule/start — Start the automated scheduling run
// Body: { accounts: [{ email, profileDir, draftCount }], concurrency?, hidden? }
//   concurrency — Chrome instances driven at once (default 8 = all accounts)
//   hidden      — park the windows off-screen so they can't be throttled
//                 by being minimized (default true)
app.post('/api/auto-schedule/start', (req, res) => {
  try {
    const { accounts, concurrency, hidden } = req.body || {};
    const status = autoScheduler.start(accounts, { concurrency, hidden });
    res.json(status);
  } catch (err) {
    console.error('[AutoSchedule] Error starting:', err);
    res.status(400).json({ error: err.message });
  }
});

// GET /api/auto-schedule/status — Poll progress/logs of the current run
app.get('/api/auto-schedule/status', (req, res) => {
  res.json(autoScheduler.getStatus());
});

// POST /api/auto-schedule/cancel — Cancel the current run
app.post('/api/auto-schedule/cancel', async (req, res) => {
  try {
    const status = await autoScheduler.cancel();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auto-schedule/force-stop — Hard reset: clears "already in
// progress" state even if the previous run is wedged, so a new one can start.
app.post('/api/auto-schedule/force-stop', async (req, res) => {
  try {
    const status = await autoScheduler.forceStop();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GOOGLE SHEETS ENDPOINTS — Lead Pipeline Management
// ============================================================

// GET /api/sheets/summary — Get overview of all sheets
app.get('/api/sheets/summary', async (req, res) => {
  try {
    const summary = await sheets.getSummary();
    res.json(summary);
  } catch (err) {
    console.error('[Sheets] Error getting summary:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sheets/needs-email/accepted — Get accepted leads from Needs Email
app.get('/api/sheets/needs-email/accepted', async (req, res) => {
  try {
    const result = await sheets.getAcceptedNeedsEmail();
    res.json(result);
  } catch (err) {
    console.error('[Sheets] Error getting accepted:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sheets/move-to-reasoning — Move accepted Needs Email → new_leads_reason
app.post('/api/sheets/move-to-reasoning', async (req, res) => {
  try {
    const result = await sheets.moveAcceptedToReasoning();
    res.json(result);
  } catch (err) {
    console.error('[Sheets] Error moving to reasoning:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sheets/move-from-no-reply — Move N rows from No Reply → old_leads_reason
app.post('/api/sheets/move-from-no-reply', async (req, res) => {
  try {
    const count = req.body?.count || 50;
    const result = await sheets.moveNoReplyToReasoning(count);
    res.json(result);
  } catch (err) {
    console.error('[Sheets] Error moving from No Reply:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sheets/reasoned/new — Get reasoned new leads ready for transfer
app.get('/api/sheets/reasoned/new', async (req, res) => {
  try {
    const result = await sheets.getReasonedNewLeads();
    res.json(result);
  } catch (err) {
    console.error('[Sheets] Error getting reasoned new leads:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sheets/reasoned/old — Get reasoned old leads ready for transfer
app.get('/api/sheets/reasoned/old', async (req, res) => {
  try {
    const result = await sheets.getReasonedOldLeads();
    res.json(result);
  } catch (err) {
    console.error('[Sheets] Error getting reasoned old leads:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sheets/transfer-to-app — Transfer reasoned leads to the app state
app.post('/api/sheets/transfer-to-app', async (req, res) => {
  try {
    const { leads, page } = req.body;
    // leads is an array of objects with { rowIndex, email, name, customData }
    // page is 'new' or 'old'
    if (!leads || !Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ error: 'No leads provided' });
    }
    if (page !== 'new' && page !== 'old') {
      return res.status(400).json({ error: 'Page must be "new" or "old"' });
    }

    const sheetName = page === 'new'
      ? sheets.SHEETS.NEW_LEADS_REASON
      : sheets.SHEETS.OLD_LEADS_REASON;

    const appSheetName = page === 'new'
      ? sheets.SHEETS.NEW_LEADS_APP
      : sheets.SHEETS.OLD_LEADS_APP;

    // Server-side safety net: even though the client already filters out
    // leads whose email is already in the app, re-check here against
    // data.json directly in case the client's in-memory state was stale.
    const appEmails = sheets.getAppEmailSet();

    // One-time setup for the whole batch: find where to start appending in
    // the app sheet, and which column marks "transferred" in the reasoning
    // sheet. Doing this once (instead of re-reading both sheets before
    // every single lead) roughly halves the API calls per lead, which
    // matters a lot for staying under the Sheets rate limit on a big batch.
    let nextAppRow = (await sheets.getSheetRowCount(appSheetName)) + 1;
    const transferredCol = await sheets.getOrCreateTransferredColumnLetter(sheetName);

    // Transfer leads ONE AT A TIME (not all at once). For each lead we first
    // write it to the APP master sheet, and only mark it "transferred" in the
    // reasoning sheet once that write actually succeeded — so a mid-batch
    // rate limit can't leave a lead marked as moved when it never arrived.
    // Columns: Channel Name, Email, Channel ID, Channel URL, Views, Observation, Last Video, Video Title, Status, Lead Type
    const transferredLeads = [];
    const failedLeads = [];
    const skippedDuplicates = [];

    for (const lead of leads) {
      const normalizedEmail = (lead.email || '').toString().trim().toLowerCase();

      if (normalizedEmail && appEmails.has(normalizedEmail)) {
        // Already in the app — don't add it again, just mark the reasoning
        // row so it stops showing up as ready to transfer.
        try {
          await sheets.withRetry(() => sheets.setTransferredCell(sheetName, transferredCol, lead.rowIndex));
        } catch (err) {
          console.error(`[Sheets] Failed to mark duplicate row transferred for ${lead.email}:`, err.message);
        }
        skippedDuplicates.push({ id: lead.id, email: lead.email });
        await sheets.sleep(350);
        continue;
      }
      if (normalizedEmail) appEmails.add(normalizedEmail);

      const cd = lead.customData || {};
      const appRow = [
        cd.channelName || lead.name || '',
        lead.email,
        cd.channelId || '',
        cd.channelUrl || '',
        cd.views || '',
        '',   // Observation
        '',   // Last Video
        cd.videoTitle || '',
        'new',   // Status
        page,    // Lead Type
      ];

      try {
        await sheets.withRetry(() => sheets.writeRowAt(appSheetName, nextAppRow, appRow));
        // Advance the row counter as soon as the write itself succeeds —
        // if the "mark transferred" call below fails, the row is still
        // sitting at nextAppRow in the app sheet, so the next lead must
        // not be written on top of it.
        nextAppRow++;
        await sheets.withRetry(() => sheets.setTransferredCell(sheetName, transferredCol, lead.rowIndex));

        transferredLeads.push({
          id: lead.id,
          email: lead.email,
          name: lead.name || lead.email,
          page,
          status: 'new',
          customData: {
            // CamelCase (for app UI)
            channelName: lead.customData?.channelName || '',
            channelId: lead.customData?.channelId || '',
            channelUrl: lead.customData?.channelUrl || '',
            videoTitle: lead.customData?.videoTitle || '',
            // Raw header names (for template substitutions)
            channel_email: lead.customData?.channel_email || lead.customData?.channelName || '',
            channel_name: lead.customData?.channel_name || lead.customData?.channelName || '',
            channelurl: lead.customData?.channelurl || lead.customData?.channelUrl || '',
            videotitle: lead.customData?.videotitle || lead.customData?.videoTitle || '',
          },
          createdAt: lead.createdAt || new Date().toISOString(),
        });
      } catch (err) {
        console.error(`[Sheets] Failed to transfer lead ${lead.email}:`, err.message);
        failedLeads.push({ id: lead.id, email: lead.email, error: err.message });
      }

      // Small pause between leads to stay under the Sheets API rate limit
      await sheets.sleep(350);
    }

    res.json({
      transferred: transferredLeads.length,
      leads: transferredLeads,
      failed: failedLeads,
      skippedDuplicates,
    });
  } catch (err) {
    console.error('[Sheets] Error transferring to app:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sheets/refresh — Force-refresh cached data (re-reads all sheets)
app.post('/api/sheets/refresh', async (req, res) => {
  try {
    // Re-read all sheet data (no caching at the moment, but this endpoint
    // exists for future cache-busting and logging)
    const summary = await sheets.getSummary();
    console.log('[Sheets] Manual refresh completed');
    res.json({ refreshed: true, summary });
  } catch (err) {
    console.error('[Sheets] Error refreshing:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sheets/start-reasoning — Run reasoning workflow on a reasoning sheet
app.post('/api/sheets/start-reasoning', async (req, res) => {
  try {
    const { page } = req.body; // 'new' or 'old'
    if (!page || (page !== 'new' && page !== 'old')) {
      return res.status(400).json({ error: 'page must be "new" or "old"' });
    }

    const sheetName = page === 'new'
      ? sheets.SHEETS.NEW_LEADS_REASON
      : sheets.SHEETS.OLD_LEADS_REASON;

    console.log(`[Reasoning] Starting reasoning for "${sheetName}" (page=${page})`);

    // Run reasoning in background, collect logs
    const logs = [];
    const result = await reasoning.startReasoning(sheetName, {
      onProgress: (msg) => {
        console.log(`[Reasoning] ${msg}`);
        logs.push(msg);
      },
    });

    console.log(`[Reasoning] Complete:`, result);
    res.json({ ...result, logs });
  } catch (err) {
    console.error('[Reasoning] Error:', err);
    res.status(500).json({ error: err.message, logs: [] });
  }
});

// ============================================================
// GMAIL SYNC ENDPOINTS — Server-side email sync (no browser gapi needed)
// ============================================================

// POST /api/sync/start — Start a background sync of all leads
app.post('/api/sync/start', (req, res) => {
  try {
    const force = req.body?.force === true;
    const syncId = gmailSync.startSync(force);
    console.log(`[Sync] Started ${force ? 'FORCE ' : ''}sync: ${syncId}`);
    res.json({ syncId, status: 'started' });
  } catch (err) {
    console.error('[Sync] Error starting sync:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sync/status/:syncId — Poll sync progress
app.get('/api/sync/status/:syncId', (req, res) => {
  const status = gmailSync.getSyncStatus(req.params.syncId);
  if (!status) {
    return res.status(404).json({ error: 'Sync not found' });
  }
  res.json(status);
});

// ============================================================
// SEND STATS ENDPOINTS — Month-by-month sent email breakdown
// ============================================================

// GET /api/send-stats — Return the last cached computation (if any)
app.get('/api/send-stats', (req, res) => {
  try {
    const cached = sendStats.getCached();
    res.json({ cached });
  } catch (err) {
    console.error('[SendStats] Error reading cached stats:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/send-stats/compute — Start a background recomputation
app.post('/api/send-stats/compute', (req, res) => {
  try {
    const jobId = sendStats.startComputation();
    console.log(`[SendStats] Started computation: ${jobId}`);
    res.json({ jobId, status: 'started' });
  } catch (err) {
    console.error('[SendStats] Error starting computation:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/send-stats/status/:jobId — Poll computation progress
app.get('/api/send-stats/status/:jobId', (req, res) => {
  const status = sendStats.getStatus(req.params.jobId);
  if (!status) {
    return res.status(404).json({ error: 'Job not found' });
  }
  res.json(status);
});

// ============================================================
// YOUTUBE DATA COLLECTION ENDPOINTS
// ============================================================

// POST /api/youtube/channel-data — Run the full channel pipeline.
// Streams NDJSON: {type:'log'} progress lines, then {type:'result'} or {type:'error'}.
app.post('/api/youtube/channel-data', async (req, res) => {
  const { channelId, videoType } = req.body || {};
  if (!channelId || typeof channelId !== 'string' || !channelId.trim()) {
    return res.status(400).json({ error: 'channelId is required' });
  }
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  const send = (obj) => res.write(JSON.stringify(obj) + '\n');
  try {
    console.log(`[YouTube] Collecting data for channel ${channelId.trim()} (${videoType || 'long'})...`);
    const result = await youtubeData.collectChannelData(
      channelId.trim(),
      videoType || 'long',
      (message) => {
        console.log(`[YouTube] ${message}`);
        send({ type: 'log', message });
      }
    );
    console.log(`[YouTube] Done — ${result.videos.length} videos`);
    send({ type: 'result', ...result });
  } catch (err) {
    console.error('[YouTube] Channel data collection failed:', err);
    send({ type: 'error', error: err.message });
  }
  res.end();
});

// POST /api/youtube/transcript — Fetch transcript for one video
app.post('/api/youtube/transcript', async (req, res) => {
  const { videoId } = req.body || {};
  if (!videoId || typeof videoId !== 'string' || !videoId.trim()) {
    return res.status(400).json({ error: 'videoId is required' });
  }
  try {
    const transcript = await youtubeData.getTranscript(videoId.trim());
    res.json({ videoId: videoId.trim(), transcript });
  } catch (err) {
    console.error(`[YouTube] Transcript failed for ${videoId}:`, err.message);
    res.status(500).json({ error: err.message, videoId: videoId.trim() });
  }
});

// POST /api/youtube/transcript-local — Fetch transcript for one video via
// yt-dlp (local, no third-party transcript service)
app.post('/api/youtube/transcript-local', async (req, res) => {
  const { videoId } = req.body || {};
  if (!videoId || typeof videoId !== 'string' || !videoId.trim()) {
    return res.status(400).json({ error: 'videoId is required' });
  }
  try {
    const transcript = await youtubeData.getTranscriptLocal(videoId.trim());
    res.json({ videoId: videoId.trim(), transcript });
  } catch (err) {
    console.error(`[YouTube] Local transcript failed for ${videoId}:`, err.message);
    res.status(500).json({ error: err.message, videoId: videoId.trim() });
  }
});

// ============================================================
// YOUTUBE IDEAS SEARCH ENDPOINTS — search.list based topic search,
// with a separate persisted "top channels" container
// ============================================================

// POST /api/youtube/search-ideas — top 20 recent (<=4mo) videos for a topic.
// Also upserts the channels behind those videos into the persisted channels
// store, which is never affected by "new search" clearing the video list.
app.post('/api/youtube/search-ideas', async (req, res) => {
  const { query } = req.body || {};
  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: 'query is required' });
  }
  try {
    console.log(`[Ideas] Searching for "${query.trim()}"...`);
    const result = await youtubeData.searchIdeas(query.trim(), (message) => {
      console.log(`[Ideas] ${message}`);
    });
    const channels = ideasStore.upsertChannels(result.channels, query.trim());
    console.log(`[Ideas] Done — ${result.videos.length} videos, channel store now has ${channels.length} channel(s)`);
    res.json({ videos: result.videos, channels });
  } catch (err) {
    console.error('[Ideas] Search failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ideas/channels — full persisted "top channels" list
app.get('/api/ideas/channels', (req, res) => {
  try {
    res.json({ channels: ideasStore.readChannels() });
  } catch (err) {
    console.error('[Ideas] Error reading channels:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/ideas/channels/:channelId — remove one saved channel
app.delete('/api/ideas/channels/:channelId', (req, res) => {
  try {
    const channels = ideasStore.removeChannel(req.params.channelId);
    res.json({ channels });
  } catch (err) {
    console.error('[Ideas] Error removing channel:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ideas/channels/clear — wipe the saved channels list
app.post('/api/ideas/channels/clear', (req, res) => {
  try {
    const channels = ideasStore.clearAll();
    res.json({ channels });
  } catch (err) {
    console.error('[Ideas] Error clearing channels:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ai/generate-followup — Groq-powered MOF follow-up email generation.
// Stateless proxy: the client gathers thread messages (gapi) and channel/video
// data and sends it all here; this route just calls Groq and returns {subject, body}.
app.post('/api/ai/generate-followup', async (req, res) => {
  const ctx = req.body || {};
  if (!ctx.angle || typeof ctx.angle !== 'string') {
    return res.status(400).json({ error: 'angle is required' });
  }
  try {
    const result = await aiFollowup.generateFollowUpEmail(ctx);
    res.json(result);
  } catch (err) {
    console.error('[AI Followup] Generation failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/gmail/create-draft — Create a Gmail draft with raw HTML body
app.post('/api/gmail/create-draft', async (req, res) => {
  const { email, subject, html } = req.body || {};
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'email is required' });
  }
  if (!subject || typeof subject !== 'string' || !subject.trim()) {
    return res.status(400).json({ error: 'subject is required' });
  }
  if (!html || typeof html !== 'string' || !html.trim()) {
    return res.status(400).json({ error: 'html is required' });
  }
  try {
    const state = db.read() || {};
    const account = (state.accounts || []).find(a => a.email === email);
    if (!account) {
      return res.status(404).json({ error: `Account ${email} not found` });
    }
    const settings = state.settings || {};
    const draftId = await gmailSync.createHtmlDraft(
      account,
      settings.clientId,
      settings.clientSecret,
      subject.trim(),
      html
    );
    // Persist any refreshed token back to disk
    db.write(state);
    console.log(`[Gmail] Draft created for ${email}: ${draftId}`);
    res.json({ draftId });
  } catch (err) {
    console.error('[Gmail] Create draft failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// AUTO-REFRESH CRON — Re-sync Google Sheet data every 5 hours
// ============================================================
const AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 60 * 1000; // 5 hours

setInterval(async () => {
  try {
    console.log(`[Cron] Auto-refreshing Google Sheet data...`);
    const summary = await sheets.getSummary();
    console.log(`[Cron] Auto-refresh complete. ${Object.keys(summary).length} sheets synced.`);
  } catch (err) {
    console.error(`[Cron] Auto-refresh failed:`, err);
  }
}, AUTO_REFRESH_INTERVAL_MS);

// Also run once shortly after startup (after 30 seconds)
setTimeout(async () => {
  try {
    console.log(`[Cron] Initial Google Sheet sync...`);
    await sheets.ensureSheet(sheets.SHEETS.NEW_LEADS_REASON);
    await sheets.ensureSheet(sheets.SHEETS.OLD_LEADS_REASON);
    const summary = await sheets.getSummary();
    console.log(`[Cron] Initial sync complete. Sheets ready.`);
    console.log(`[Cron] Next auto-refresh in 5 hours.`);
  } catch (err) {
    console.error(`[Cron] Initial sync failed:`, err);
  }
}, 30000);

const PORT = 3006;
app.listen(PORT, () => {
  console.log(`\n=== Lead Tracker Server running on http://localhost:${PORT} ===`);
  console.log(`Database file: ${path.join(__dirname, 'data.json')}`);
  console.log(`Google Sheet ID: ${sheets.SHEET_ID || '(using env SHEET_ID)'}`);
  console.log(`Endpoints:`);
  console.log(`  GET  /api/state              - Load full app state`);
  console.log(`  POST /api/state              - Save full app state`);
  console.log(`  POST /api/state/reset        - Reset to default state`);
  console.log(`  POST /auth/exchange          - Exchange auth code for tokens`);
  console.log(`  POST /auth/refresh           - Refresh expired access token`);
  console.log(`  POST /api/browser/open       - Open Chrome at Gmail Drafts`);
  console.log(`  POST /api/browser/close      - Close Chrome`);
  console.log(`  POST /api/auto-schedule/start  - Start automated schedule-send`);
  console.log(`  GET  /api/auto-schedule/status - Poll automated run progress`);
  console.log(`  POST /api/auto-schedule/cancel - Cancel automated run`);
  console.log(`  POST /api/auto-schedule/force-stop - Hard reset a stuck automation run`);
  console.log(`  --- Google Sheets Pipeline ---`);
  console.log(`  GET  /api/sheets/summary          - Sheet overview stats`);
  console.log(`  GET  /api/sheets/needs-email/accepted - Accepted leads`);
  console.log(`  POST /api/sheets/move-to-reasoning     - Move accepted to reasoning`);
  console.log(`  POST /api/sheets/move-from-no-reply    - Move 50 from No Reply`);
  console.log(`  GET  /api/sheets/reasoned/new          - Reasoned new leads`);
  console.log(`  GET  /api/sheets/reasoned/old          - Reasoned old leads`);
  console.log(`  POST /api/sheets/transfer-to-app       - Transfer to app`);
  console.log(`  POST /api/sheets/refresh               - Manual refresh`);
  console.log(`  POST /api/sheets/start-reasoning       - Run reasoning (YouTube analysis + transcripts)`);
  console.log(`  --- Gmail Sync ---`);
  console.log(`  POST /api/sync/start                 - Start server-side email sync`);
  console.log(`  GET  /api/sync/status/:syncId        - Poll sync progress`);
  console.log(`  --- Send Stats ---`);
  console.log(`  GET  /api/send-stats                 - Get cached monthly send stats`);
  console.log(`  POST /api/send-stats/compute         - Recompute monthly send stats`);
  console.log(`  GET  /api/send-stats/status/:jobId   - Poll computation progress`);
  console.log(`  --- AI Follow-ups ---`);
  console.log(`  POST /api/ai/generate-followup        - Groq-generated MOF follow-up email\n`);
});
