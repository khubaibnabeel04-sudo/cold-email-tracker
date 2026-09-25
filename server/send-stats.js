/**
 * Computes month-by-month send history (Initial / FU1 / FU2 / ...) by reading
 * each connected Gmail account's actual Sent folder and matching messages to
 * leads currently tracked in the app (by recipient address), then classifying
 * each message's stage by its position within its own Gmail thread.
 *
 * This does NOT rely on lead.lastContactDate (only reflects a lead's most recent
 * touch) or lead.threadId (can go stale if a lead was re-contacted on a fresh
 * thread) — both undercount history. Reading straight from Gmail is the only way
 * to recover the real per-stage, per-month picture, including the actual leads
 * behind each count.
 *
 * Caching: a month is "final" once it's no longer the current calendar month —
 * Gmail history for a closed month never changes, so it's computed once and
 * never re-queried. Only the current month is re-fetched on every recompute.
 * Stage numbering (Initial/FU1/FU2..) depends on how many sent messages a thread
 * already had in prior finalized months, so we carry a running per-thread count
 * (threadProgress) forward instead of recomputing history each time.
 */
const { google } = require('googleapis');
const db = require('./db');

const jobs = new Map();

function getStatus(jobId) {
  return jobs.get(jobId) || null;
}

function setStatus(jobId, data) {
  const existing = jobs.get(jobId) || { jobId, status: 'running', startedAt: new Date().toISOString(), total: 0, done: 0, error: null };
  const updated = { ...existing, ...data };
  jobs.set(jobId, updated);
  for (const [id, status] of jobs.entries()) {
    if (status.status === 'completed' || status.status === 'error') {
      const age = Date.now() - new Date(status.startedAt).getTime();
      if (age > 3600000) jobs.delete(id);
    }
  }
  return updated;
}

function extractHeader(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function extractEmail(headerVal) {
  const m = (headerVal || '').match(/<([^>]+)>/);
  return (m ? m[1] : headerVal || '').trim().toLowerCase();
}

async function pMap(items, concurrency, fn) {
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  }
  await Promise.all(new Array(Math.min(concurrency, items.length)).fill(0).map(worker));
}

async function refreshAccountToken(acc, clientId, clientSecret) {
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  let accessToken = acc.accessToken;
  if (acc.refreshToken) {
    try {
      oauth2Client.setCredentials({ refresh_token: acc.refreshToken });
      const { credentials } = await oauth2Client.refreshAccessToken();
      accessToken = credentials.access_token;
    } catch (e) {
      console.error(`[SendStats] Refresh failed for ${acc.email}: ${e.message}`);
    }
  }
  oauth2Client.setCredentials({ access_token: accessToken });
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

function monthKeyOf(year, monthIdx0) {
  return `${year}-${String(monthIdx0 + 1).padStart(2, '0')}`;
}

function generateMonthKeys(startDate, endDate) {
  const keys = [];
  let y = startDate.getUTCFullYear();
  let m = startDate.getUTCMonth();
  const endY = endDate.getUTCFullYear();
  const endM = endDate.getUTCMonth();
  while (y < endY || (y === endY && m <= endM)) {
    keys.push(monthKeyOf(y, m));
    m++;
    if (m > 11) { m = 0; y++; }
  }
  return keys;
}

function fmtDate(d) {
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
}

function threadKey(account, threadId) {
  return account + '::' + threadId;
}

/**
 * Fetch every Sent message across all accounts for one calendar month, and
 * return only those addressed to a lead currently tracked in the app.
 */
async function fetchMonthMatches(monthKey, gmailByAccount, leadByEmail, onProgress) {
  const [y, m] = monthKey.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1));
  const q = `in:sent after:${fmtDate(start)} before:${fmtDate(end)}`;

  const idJobs = [];
  for (const [accountEmail, gmail] of Object.entries(gmailByAccount)) {
    let pageToken;
    do {
      const res = await gmail.users.messages.list({ userId: 'me', q, maxResults: 500, pageToken });
      (res.data.messages || []).forEach((msg) => idJobs.push({ account: accountEmail, id: msg.id }));
      pageToken = res.data.nextPageToken;
    } while (pageToken);
  }

  const matched = [];
  let done = 0;
  await pMap(idJobs, 12, async (job) => {
    const gmail = gmailByAccount[job.account];
    try {
      const res = await gmail.users.messages.get({
        userId: 'me',
        id: job.id,
        format: 'metadata',
        metadataHeaders: ['To'],
      });
      const to = extractEmail(extractHeader(res.data.payload.headers, 'To'));
      const lead = leadByEmail.get(to);
      if (lead) {
        matched.push({
          account: job.account,
          threadId: res.data.threadId,
          internalDate: Number(res.data.internalDate),
          to,
          leadId: lead.id,
          name: lead.name || lead.customData?.channelName || to,
          channelName: lead.customData?.channelName || '',
          page: lead.page,
        });
      }
    } catch (e) {
      // skip unreadable message
    }
    done++;
    if (onProgress) onProgress(done, idJobs.length);
  });

  return { matched, scanned: idJobs.length };
}

/**
 * Classify matched messages for one month into stages, given the running
 * per-thread count of sent messages already accounted for in prior finalized
 * months. Returns the stage buckets plus how much each thread advanced this
 * month (so the caller can fold it into threadProgress once finalized).
 */
function classifyMonth(matched, threadProgress) {
  const byThread = {};
  matched.forEach((m) => {
    const key = threadKey(m.account, m.threadId);
    if (!byThread[key]) byThread[key] = [];
    byThread[key].push(m);
  });

  const stages = {};
  const threadIncrements = {};

  Object.entries(byThread).forEach(([key, msgs]) => {
    msgs.sort((a, b) => a.internalDate - b.internalDate);
    const startIdx = threadProgress[key] || 0;
    msgs.forEach((m, i) => {
      const globalIdx = startIdx + i;
      const stageName = globalIdx === 0 ? 'Initial' : `FU${globalIdx}`;
      if (!stages[stageName]) stages[stageName] = [];
      stages[stageName].push({
        leadId: m.leadId,
        name: m.name,
        channelName: m.channelName,
        email: m.to,
        page: m.page,
        date: new Date(m.internalDate).toISOString(),
      });
    });
    threadIncrements[key] = msgs.length;
  });

  return { stages, threadIncrements };
}

function stripInternal(sendStats) {
  if (!sendStats) return sendStats;
  const monthly = {};
  for (const [k, v] of Object.entries(sendStats.monthly || {})) {
    monthly[k] = { computedAt: v.computedAt, final: v.final, stages: v.stages };
  }
  return {
    computedAt: sendStats.computedAt,
    rangeStart: sendStats.rangeStart,
    rangeEnd: sendStats.rangeEnd,
    monthly,
  };
}

async function runComputation(jobId) {
  try {
    const state = db.read();
    if (!state) {
      setStatus(jobId, { status: 'error', error: 'No state found in database' });
      return;
    }

    const { clientId, clientSecret } = state.settings || {};
    if (!clientId || !clientSecret) {
      setStatus(jobId, { status: 'error', error: 'Gmail clientId/clientSecret not configured in Settings' });
      return;
    }

    const accounts = state.accounts || [];
    if (accounts.length === 0) {
      setStatus(jobId, { status: 'error', error: 'No Gmail accounts connected' });
      return;
    }

    const allLeads = [...(state.newLeads || []), ...(state.oldLeads || []), ...(state.staleLeads || [])];
    const leadByEmail = new Map();
    allLeads.forEach((l) => {
      const e = (l.email || '').trim().toLowerCase();
      if (e && !leadByEmail.has(e)) leadByEmail.set(e, l);
    });

    const cutoff = state.settings.dateCutoff ? new Date(state.settings.dateCutoff) : new Date(Date.UTC(2025, 10, 1));
    const startMonth = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth(), 1));
    const now = new Date();
    const monthKeys = generateMonthKeys(startMonth, now);
    const currentMonthKey = monthKeys[monthKeys.length - 1];

    const existing = state.sendStats || { monthly: {}, threadProgress: {} };
    const monthly = { ...existing.monthly };
    const threadProgress = { ...(existing.threadProgress || {}) };

    // Finalize any previously-"current" month that has since rolled over —
    // its Gmail history is now closed and can be folded into threadProgress
    // without re-querying anything.
    for (const [mKey, entry] of Object.entries(monthly)) {
      if (entry && entry.final === false && mKey !== currentMonthKey) {
        if (entry._threadIncrements) {
          Object.entries(entry._threadIncrements).forEach(([key, count]) => {
            threadProgress[key] = (threadProgress[key] || 0) + count;
          });
        }
        monthly[mKey] = { ...entry, final: true };
      }
    }

    const monthsToCompute = monthKeys.filter((m) => m === currentMonthKey || !monthly[m] || !monthly[m].final);

    setStatus(jobId, {
      status: 'running',
      phase: 'connecting',
      total: monthsToCompute.length,
      done: 0,
      monthsToCompute,
      currentMonth: monthsToCompute[0],
      monthProgress: { done: 0, total: 0 },
    });

    const gmailByAccount = {};
    for (const acc of accounts) {
      gmailByAccount[acc.email] = await refreshAccountToken(acc, clientId, clientSecret);
    }

    let monthsDone = 0;
    for (const mKey of monthsToCompute) {
      setStatus(jobId, { phase: 'fetching', currentMonth: mKey, monthProgress: { done: 0, total: 0 } });

      const { matched, scanned } = await fetchMonthMatches(mKey, gmailByAccount, leadByEmail, (done, total) => {
        setStatus(jobId, { monthProgress: { done, total } });
      });

      const { stages, threadIncrements } = classifyMonth(matched, threadProgress);
      const isFinal = mKey !== currentMonthKey;

      monthly[mKey] = {
        computedAt: new Date().toISOString(),
        final: isFinal,
        stages,
        scanned,
        _threadIncrements: threadIncrements,
      };

      if (isFinal) {
        Object.entries(threadIncrements).forEach(([key, count]) => {
          threadProgress[key] = (threadProgress[key] || 0) + count;
        });
      }

      monthsDone++;
      setStatus(jobId, { done: monthsDone });
    }

    const finalSendStats = {
      computedAt: new Date().toISOString(),
      rangeStart: monthKeys[0],
      rangeEnd: currentMonthKey,
      monthly,
      threadProgress,
    };

    const freshState = db.read();
    freshState.sendStats = finalSendStats;
    db.write(freshState);

    setStatus(jobId, { status: 'completed', done: monthsToCompute.length, result: stripInternal(finalSendStats) });
  } catch (err) {
    console.error('[SendStats] Unhandled error:', err);
    setStatus(jobId, { status: 'error', error: err.message || String(err) });
  }
}

function startComputation() {
  const jobId = Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
  setStatus(jobId, { status: 'starting', total: 0, done: 0, error: null });
  runComputation(jobId).catch((err) => {
    console.error('[SendStats] Background job crashed:', err);
    setStatus(jobId, { status: 'error', error: err.message || String(err) });
  });
  return jobId;
}

function getCached() {
  const state = db.read();
  return stripInternal((state && state.sendStats) || null);
}

module.exports = { startComputation, getStatus, getCached };
