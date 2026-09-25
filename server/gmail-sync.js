/**
 * Server-side Gmail sync engine.
 * Uses googleapis (Node.js Gmail client) instead of browser gapi.
 * All Gmail API calls happen on the server — zero impact on the browser UI.
 */
const { google } = require('googleapis');
const db = require('./db');

// ============================================================
// In-memory sync status tracker
// ============================================================
const syncProgress = new Map();

function getSyncStatus(syncId) {
  return syncProgress.get(syncId) || null;
}

function setSyncStatus(syncId, data) {
  const existing = syncProgress.get(syncId) || { syncId, status: 'running', startedAt: new Date().toISOString(), logs: [], total: 0, done: 0, currentLead: '', error: null };
  const updated = { ...existing, ...data, logs: data.logs || existing.logs || [] };
  syncProgress.set(syncId, updated);
  // Clean up old syncs after 1 hour
  for (const [id, status] of syncProgress.entries()) {
    if (status.status === 'completed' || status.status === 'error') {
      const age = Date.now() - new Date(status.startedAt).getTime();
      if (age > 3600000) syncProgress.delete(id);
    }
  }
  return updated;
}

function log(syncId, msg) {
  const entry = syncProgress.get(syncId);
  if (!entry) return;
  const timestamped = `[${new Date().toLocaleTimeString()}] ${msg}`;
  entry.logs.push(timestamped);
  // Keep max 500 logs in memory
  if (entry.logs.length > 500) entry.logs.splice(0, entry.logs.length - 500);
  console.log(`[Sync ${syncId.substring(0, 8)}] ${msg}`);
}

// ============================================================
// Token & Gmail API helpers
// ============================================================

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Leads now sync concurrently, and many share the same connected account. If
// two concurrent leads both see an expired token for the same account, they
// must not each fire their own refresh request — they should await the same
// in-flight refresh. Keyed by account.email.
const inFlightRefreshes = new Map();

/**
 * Ensure we have a valid access token for an account.
 * Uses the refresh token to get a new one if expired.
 */
async function ensureValidToken(account, clientId, clientSecret) {
  const isExpired = !account.expiresAt || (account.expiresAt - Date.now() < 5 * 60 * 1000);

  if (!isExpired) {
    return account.accessToken;
  }

  if (!account.refreshToken) {
    throw new Error(`Account ${account.email} has no refresh token — cannot refresh server-side. Use "Re-login" button in the Accounts page.`);
  }

  const existingRefresh = inFlightRefreshes.get(account.email);
  if (existingRefresh) {
    return existingRefresh;
  }

  const refreshPromise = (async () => {
    // Refresh the token
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: account.refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
      }),
    });

    const data = await res.json();
    if (data.error) {
      throw new Error(`Token refresh failed for ${account.email}: ${data.error} ${data.error_description || ''}`);
    }

    // Update the account with the new access token (in-memory for this sync run)
    account.accessToken = data.access_token;
    account.expiresAt = Date.now() + (data.expires_in * 1000);

    console.log(`[Sync] Refreshed token for ${account.email}`);
    return data.access_token;
  })();

  inFlightRefreshes.set(account.email, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    inFlightRefreshes.delete(account.email);
  }
}

/**
 * Create a Gmail API client for a given account.
 */
function createGmailClient(accessToken) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.gmail({ version: 'v1', auth });
}

/**
 * Create a Gmail draft with a raw HTML body (inline CSS preserved as-is).
 * Mirrors the n8n Gmail node with resource:"draft", emailType:"html" —
 * no wrapping div, no escaping, the pasted HTML is used verbatim as the body.
 */
async function createHtmlDraft(account, clientId, clientSecret, subject, html) {
  const accessToken = await ensureValidToken(account, clientId, clientSecret);
  const gmail = createGmailClient(accessToken);

  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
  const mime = [
    `Subject: ${encodedSubject}`,
    'Content-Type: text/html; charset=utf-8',
    'MIME-Version: 1.0',
    '',
    html,
  ].join('\r\n');

  const raw = Buffer.from(mime, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const res = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw } },
  });
  return res.data.id;
}

/**
 * Search Gmail threads for a lead after the cutoff date.
 */
async function searchThreads(gmail, query, maxResults = 10) {
  const res = await gmail.users.threads.list({
    userId: 'me',
    q: query,
    maxResults,
  }, { timeout: 30000 });
  return res.data.threads || [];
}

/**
 * Get full thread details including all messages.
 */
async function getThread(gmail, threadId) {
  const res = await gmail.users.threads.get({
    userId: 'me',
    id: threadId,
  }, { timeout: 30000 });
  return res.data;
}

// ============================================================
// Lead analysis (mirrors src/services/gmail.ts analyzeLead)
// ============================================================

/**
 * Search + inspect all matching threads for one account. Returns an array of
 * thread candidates (empty if nothing relevant found or an error occurred).
 * Runs independently per account so callers can fire these off in parallel.
 */
async function analyzeAccountForLead(account, lead, cutoffTime, settings, syncId) {
  const results = [];
  try {
    log(syncId, `  -> Searching connected account: ${account.email}`);

    const token = await ensureValidToken(account, settings.clientId, settings.clientSecret);
    const gmail = createGmailClient(token);

    // Build query: from OR to the lead email, after cutoff date
    const query = `(from:${lead.email} OR to:${lead.email}) after:${settings.dateCutoff.replace(/-/g, '/')}`;
    const threads = await searchThreads(gmail, query);

    if (threads.length > 0) {
      log(syncId, `  -> Found ${threads.length} threads in ${account.email}. Inspecting messages...`);
    }

    for (const thread of threads) {
      const threadData = await getThread(gmail, thread.id);
      const messages = threadData.messages || [];

      let mySentCount = 0;
      let leadReplied = false;
      let hasDraft = false;
      let lastMessageTime = 0;
      let latestMessageFromMe = 0;
      let firstReplyTime = 0;

      for (const message of messages) {
        const internalDate = parseInt(message.internalDate || '0');
        if (internalDate < cutoffTime) continue;

        const headers = message.payload?.headers || [];
        const from = headers.find(h => h.name === 'From')?.value || '';
        const isDraft = message.labelIds?.includes('DRAFT') || false;

        if (isDraft) {
          hasDraft = true;
        }

        // Check if this message is from the lead (not from the account)
        const isFromMe = from.includes(account.email);
        if (!isFromMe && !isDraft) {
          leadReplied = true;
          lastMessageTime = Math.max(lastMessageTime, internalDate);
          // Track only the EARLIEST reply from the lead — later replies (or my
          // own follow-ups) should never bump this back to the top of the sort.
          firstReplyTime = firstReplyTime === 0 ? internalDate : Math.min(firstReplyTime, internalDate);
          // Keep scanning remaining messages so lastMessageTime reflects the
          // true latest activity in this thread, not just the reply itself.
          continue;
        }

        if (isFromMe && !isDraft) {
          mySentCount++;
          latestMessageFromMe = Math.max(latestMessageFromMe, internalDate);
        }

        lastMessageTime = Math.max(lastMessageTime, internalDate);
      }

      if (!leadReplied && !hasDraft && mySentCount === 0) {
        // Nothing relevant happened in this thread after the cutoff — skip it.
        continue;
      }

      // Guard: never return a date before year 2000 (Jan 1 2000 = 946684800000 ms)
      // This prevents 1970 dates when messages have no valid internalDate.
      const MIN_VALID_DATE_MS = 946684800000;
      const validLastMessageTime = lastMessageTime > MIN_VALID_DATE_MS ? lastMessageTime : undefined;
      const validLatestFromMe = latestMessageFromMe > MIN_VALID_DATE_MS ? latestMessageFromMe : undefined;
      const validFirstReplyTime = firstReplyTime > MIN_VALID_DATE_MS ? firstReplyTime : undefined;

      log(syncId, `  -> [${account.email}] thread ${thread.id}: replied=${leadReplied} draft=${hasDraft} sent=${mySentCount}`);

      results.push({
        account,
        threadId: thread.id,
        leadReplied,
        hasDraft,
        mySentCount,
        lastMessageTime,
        validLastMessageTime,
        validLatestFromMe,
        validFirstReplyTime,
      });
    }
  } catch (err) {
    console.error(`[Sync] Error analyzing ${lead.email} with ${account.email}:`, err);
    log(syncId, `  -> Error analyzing through ${account.email}: ${err.message || err}`);
  }
  return results;
}

async function analyzeLead(lead, accounts, settings, syncId) {
  log(syncId, `  Analyzing: ${lead.email}`);

  const cutoffTime = new Date(settings.dateCutoff).getTime();
  const followUps = settings.followUps || [];

  // Check every connected account in parallel instead of one at a time — each
  // account is an independent Gmail mailbox with its own quota, so this is safe
  // and cuts per-lead wait time down to the slowest single account instead of
  // the sum of all of them. We still wait for ALL accounts to report back before
  // deciding anything — only the most recent thread activity across ALL of them
  // should decide the status.
  const perAccountResults = await Promise.all(
    accounts.map(account => analyzeAccountForLead(account, lead, cutoffTime, settings, syncId))
  );
  const candidates = perAccountResults.flat();

  if (candidates.length === 0) {
    log(syncId, `  -> No interaction history discovered after cutoff date.`);
    // Preserve existing status if the lead already had one — don't reset to 'new'
    // when we simply couldn't find the thread (e.g., reply came from a different email).
    const existingStatus = lead.status || 'new';
    if (existingStatus !== 'new') {
      log(syncId, `  -> Keeping existing status: ${existingStatus} (no new thread data found, reply may have come from different email).`);
    } else {
      log(syncId, `  -> No prior history. Status: new.`);
    }
    return {
      status: existingStatus,
      lastAnalyzed: new Date().toISOString(),
    };
  }

  // Pick the thread with the most recent activity across ALL accounts.
  candidates.sort((a, b) => b.lastMessageTime - a.lastMessageTime);
  const winner = candidates[0];
  log(syncId, `  -> Most recent activity: thread ${winner.threadId} on account ${winner.account.email}.`);

  if (winner.leadReplied) {
    log(syncId, `  -> Found reply from lead in thread ${winner.threadId}. Status: replied.`);
    return {
      status: 'replied',
      threadId: winner.threadId,
      sentFromAccount: winner.account.email,
      lastContactDate: winner.validLastMessageTime ? new Date(winner.validLastMessageTime).toISOString() : undefined,
      firstReplyDate: winner.validFirstReplyTime ? new Date(winner.validFirstReplyTime).toISOString() : undefined,
      lastAnalyzed: new Date().toISOString(),
    };
  }

  if (winner.hasDraft) {
    log(syncId, `  -> Found active draft in thread ${winner.threadId}. Status: draft.`);
    return {
      status: 'draft',
      threadId: winner.threadId,
      sentFromAccount: winner.account.email,
      lastAnalyzed: new Date().toISOString(),
    };
  }

  // winner.mySentCount > 0
  const daysSinceSent = winner.validLatestFromMe
    ? Math.floor((Date.now() - winner.validLatestFromMe) / (1000 * 60 * 60 * 24))
    : Infinity;
  let status;

  log(syncId, `  -> Found ${winner.mySentCount} sent outbound email(s).${winner.validLatestFromMe ? ` Last contacted ${daysSinceSent} day(s) ago.` : ''}`);

  const fuIndex = winner.mySentCount - 1;

  if (daysSinceSent >= (followUps[fuIndex]?.delayDays || Infinity)) {
    status = `needs_fu${winner.mySentCount}`;
    if (winner.validLatestFromMe) log(syncId, `  -> Elapsed days (${daysSinceSent}) >= FU${winner.mySentCount} delay. Promoting to: ${status}.`);
    else log(syncId, `  -> No valid last contact date. Promoting to: ${status}.`);
  } else {
    status = winner.mySentCount === 1 ? 'initial_sent' : `fu${winner.mySentCount - 1}_sent`;
    log(syncId, `  -> Keeping at: ${status}.`);
  }

  return {
    status,
    threadId: winner.threadId,
    sentFromAccount: winner.account.email,
    lastContactDate: winner.validLatestFromMe ? new Date(winner.validLatestFromMe).toISOString() : undefined,
    lastAnalyzed: new Date().toISOString(),
  };
}

// ============================================================
// Concurrency pool
// ============================================================

// How many leads to analyze at once. Each lead only hits Gmail's per-user
// quota for the account(s) it searches, so this is safe well beyond 15 — kept
// conservative here since most leads now search just 1 account (see
// accountsForLead below), not all of them.
const SYNC_CONCURRENCY = 15;

/**
 * Runs `worker` over `items` with at most `limit` in flight at once.
 * Each of the `limit` runners pulls the next unclaimed index off a shared
 * counter — since JS is single-threaded, the increment itself never races.
 */
async function runWithConcurrency(items, limit, worker) {
  let nextIndex = 0;
  async function runner() {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      await worker(items[current], current);
    }
  }
  const runners = Array.from({ length: Math.min(limit, items.length) }, runner);
  await Promise.all(runners);
}

// ============================================================
// Main sync orchestrator
// ============================================================

async function runSync(syncId, force = false) {
  try {
    const fullState = db.read();
    if (!fullState) {
      setSyncStatus(syncId, { status: 'error', error: 'No state found in database' });
      return;
    }

    const accounts = fullState.accounts || [];
    const allLeads = [...(fullState.newLeads || []), ...(fullState.oldLeads || [])];
    const settings = fullState.settings || {};

    if (accounts.length === 0) {
      setSyncStatus(syncId, { status: 'error', error: 'No Gmail accounts connected' });
      return;
    }

    const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;
    const leadsToSync = allLeads.filter(lead => {
      if (force) return true;
      if (!lead.lastAnalyzed) return true;
      return new Date(lead.lastAnalyzed).getTime() < twentyFourHoursAgo;
    });

    const total = leadsToSync.length;
    setSyncStatus(syncId, {
      status: 'running',
      total,
      done: 0,
      currentLead: '',
      error: null,
      logs: [`[${new Date().toLocaleTimeString()}] === Starting Sync Pipeline ${force ? '(FORCE MODE)' : ''} ===`],
    });

    log(syncId, `Total leads: ${allLeads.length} | To sync: ${total}${total < allLeads.length ? ` | Skipped (synced <24h ago): ${allLeads.length - total}` : ''}`);
    log(syncId, `Delays: ${(settings.followUps || []).map((fu, i) => `FU${i + 1} = ${fu.delayDays}d`).join(', ')}`);

    const staleLeads = [...(fullState.staleLeads || [])];

    // Completed-count is tracked separately from the loop index since leads
    // now finish out of order under concurrency.
    let doneCount = 0;

    async function processLead(lead, i) {
      setSyncStatus(syncId, { currentLead: lead.email });
      log(syncId, `[${i + 1}/${total}] scanning: ${lead.email}...`);

      try {
        // Mark this lead as having been through the sync pipeline at least once. Legacy
        // leads saved before this flag existed are treated as already-synced (true).
        const wasSyncedBefore = lead.syncedOnce !== undefined ? lead.syncedOnce : true;

        // Once we know which account a lead's thread lives in, only search that
        // account on subsequent syncs instead of every connected account — cuts
        // API calls roughly N-fold where N is the number of connected accounts.
        // First-time leads (or ones whose known account got disconnected) still
        // get the full fan-out search.
        let accountsForLead = accounts;
        if (wasSyncedBefore && lead.sentFromAccount) {
          const knownAccount = accounts.find(a => a.email === lead.sentFromAccount);
          if (knownAccount) {
            accountsForLead = [knownAccount];
            log(syncId, `  -> Already synced; checking only known account: ${knownAccount.email}`);
          }
        }

        // Per-lead timeout: 60s
        const updates = await Promise.race([
          analyzeLead(lead, accountsForLead, settings, syncId),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Lead analysis timed out (>60s)')), 60000)),
        ]);

        updates.syncedOnce = true;

        let movedToStale = false;

        // Highest-priority rule: lead has exhausted the follow-up sequence (sitting at the
        // final fuN_sent status, e.g. fu2_sent) and has gone dark (no contact/reply) for
        // 60+ days → sweep it into Stale Leads instead of resetting/keeping it in place.
        const lastFuStatus = `fu${(settings.followUps || []).length || 1}_sent`;
        const fu2ResultStatus = updates.status || lead.status;
        const fu2IsActiveConversation = fu2ResultStatus === 'replied' || fu2ResultStatus === 'draft';
        if (
          wasSyncedBefore &&
          !fu2IsActiveConversation &&
          fu2ResultStatus === lastFuStatus &&
          updates.lastContactDate &&
          (lead.page === 'new' || lead.page === 'old')
        ) {
          const fu2DaysSince = (Date.now() - new Date(updates.lastContactDate).getTime()) / (1000 * 60 * 60 * 24);
          if (fu2DaysSince > 60) {
            log(syncId, `  -> Lead at ${lastFuStatus}, no contact/reply for ${Math.floor(fu2DaysSince)} day(s) (> 60 days). Moving to Stale Leads.`);
            const mergedLead = { ...lead, ...updates };
            staleLeads.push({
              ...mergedLead,
              page: 'stale',
              status: 'new',
              customData: {
                ...mergedLead.customData,
                '_movedFromPage': lead.page,
                '_originalStatus': fu2ResultStatus,
                '_movedAt': new Date().toISOString(),
              },
            });
            movedToStale = true;
          }
        }

        const sourceLeads = lead.page === 'new' ? fullState.newLeads : fullState.oldLeads;

        if (movedToStale) {
          // Remove from its source array since it now lives in staleLeads.
          const staleIdx = sourceLeads.findIndex(l => l.id === lead.id);
          if (staleIdx !== -1) sourceLeads.splice(staleIdx, 1);
        } else {
          // For old leads > 60 days without contact, reset to new.
          // IMPORTANT: Skip this if lead has replied or has a draft — active conversations.
          const statusBeforeReset = updates.status || lead.status;
          if (lead.page === 'old' && updates.lastContactDate && statusBeforeReset !== 'replied' && statusBeforeReset !== 'draft') {
            const daysSince = (Date.now() - new Date(updates.lastContactDate).getTime()) / (1000 * 60 * 60 * 24);
            if (daysSince > 60) {
              log(syncId, `  -> Old Lead last contacted ${Math.floor(daysSince)} day(s) ago (> 60 days). Resetting to new.`);
              updates.status = 'new';
              updates.threadId = undefined;
              updates.sentFromAccount = undefined;
              updates.lastContactDate = undefined;
            } else {
              log(syncId, `  -> Old Lead last contacted ${Math.floor(daysSince)} day(s) ago (< 60 days). Keeping: ${updates.status}.`);
            }
          } else if (lead.page === 'old' && !updates.lastContactDate && updates.status === 'new') {
            log(syncId, `  -> Old Lead was never contacted. Treating as: new.`);
          }

          // Apply updates to the lead in its array
          const idx = sourceLeads.findIndex(l => l.id === lead.id);
          if (idx !== -1) {
            sourceLeads[idx] = { ...sourceLeads[idx], ...updates };
          }
        }
      } catch (err) {
        console.error(`[Sync] Error for ${lead.email}:`, err);
        log(syncId, `  -> Error syncing lead: ${err.message || err}`);
      }
      log(syncId, '');

      doneCount++;
      setSyncStatus(syncId, { done: doneCount });
    }

    await runWithConcurrency(leadsToSync, SYNC_CONCURRENCY, processLead);

    // Save everything back
    fullState.staleLeads = staleLeads;
    db.write(fullState);

    log(syncId, `=== Sync Pipeline Completed! (${total} scanned) ===`);
    setSyncStatus(syncId, {
      status: 'completed',
      done: total,
      currentLead: '',
      error: null,
    });
  } catch (syncError) {
    console.error('[Sync] Unhandled error:', syncError);
    log(syncId, `UNHANDLED SYNC ERROR: ${syncError.message || syncError}`);
    setSyncStatus(syncId, { status: 'error', error: syncError.message || String(syncError) });
  }
}

function startSync(force = false) {
  const syncId = Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
  setSyncStatus(syncId, { status: 'starting', total: 0, done: 0, currentLead: '', error: null, logs: [] });
  // Run in background — don't await
  runSync(syncId, force).catch(err => {
    console.error('[Sync] Background sync crashed:', err);
    setSyncStatus(syncId, { status: 'error', error: err.message || String(err) });
  });
  return syncId;
}

module.exports = { startSync, getSyncStatus, createHtmlDraft };
