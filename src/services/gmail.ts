import { Account, Lead, LeadStatus, AppSettings, FollowUpConfig, needsFollowUpStatus, followUpSentStatus } from '../types';

declare var gapi: any;
declare var google: any;

// Fallback Client ID (used if user hasn't configured their own in Settings)
const FALLBACK_CLIENT_ID = '991176199664-5heo317g319qu49vkdfeeqfr53gcrese.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.email openid';
const AUTH_SERVER = 'http://localhost:3006';
const REDIRECT_URI = 'http://localhost:3005';

let gapiInited = false;
let gisInited = false;
let gapiLoading = false;
let gisLoading = false;

/**
 * RFC 2047 encoded-word for the Subject header. Email headers are ASCII-only;
 * putting raw UTF-8 text (e.g. curly quotes from a video title) straight into
 * "Subject: ..." leaves Gmail's parser to guess the byte encoding, which
 * mangles it into mojibake ("â€™" etc). Base64-wrapping it in =?UTF-8?B?...?=
 * removes the guesswork. Plain-ASCII subjects are left as-is.
 */
function encodeSubjectHeader(subject: string): string {
  if (!/[^\x00-\x7F]/.test(subject)) return subject;
  const b64 = btoa(unescape(encodeURIComponent(subject)));
  return `=?UTF-8?B?${b64}?=`;
}

/**
 * Dynamically inject the Google API client script if it's not already present.
 * This handles cases where adblockers or network issues prevent the script
 * from loading via the static <script> tag in index.html.
 */
function injectGapiScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof gapi !== 'undefined') { resolve(); return; }
    if (document.querySelector('script[src*="apis.google.com/js/api.js"]')) {
      // Script tag exists but not loaded yet — wait for it
      const check = setInterval(() => {
        if (typeof gapi !== 'undefined') {
          clearInterval(check);
          resolve();
        }
      }, 100);
      setTimeout(() => { clearInterval(check); reject('GAPI script tag present but not loaded'); }, 15000);
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://apis.google.com/js/api.js';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject('Failed to load GAPI script from Google CDN');
    document.head.appendChild(script);
  });
}

/**
 * Dynamically inject the Google Identity Services script if not present.
 */
function injectGisScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof google !== 'undefined' && google.accounts) { resolve(); return; }
    if (document.querySelector('script[src*="accounts.google.com/gsi/client"]')) {
      const check = setInterval(() => {
        if (typeof google !== 'undefined' && google.accounts) {
          clearInterval(check);
          resolve();
        }
      }, 100);
      setTimeout(() => { clearInterval(check); reject('GIS script tag present but not loaded'); }, 15000);
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject('Failed to load GIS script from Google CDN');
    document.head.appendChild(script);
  });
}

export function initGapi(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (gapiInited) {
      // Double-check that gmail API is actually loaded
      if (typeof gapi !== 'undefined' && gapi.client && gapi.client.gmail) {
        resolve();
        return;
      }
      // gmail API was lost — reset flag and re-initialize
      console.warn('[Gmail] gapiInited=true but gapi.client.gmail missing, re-initializing...');
      gapiInited = false;
    }
    if (gapiLoading) {
      // Already being initialized — wait for it
      const check = setInterval(() => {
        if (gapiInited) { clearInterval(check); resolve(); }
      }, 100);
      setTimeout(() => { clearInterval(check); reject('GAPI init wait timeout'); }, 15000);
      return;
    }
    gapiLoading = true;

    async function doInit() {
      try {
        await injectGapiScript();
        // Now gapi should be defined — load the client library
        await new Promise<void>((resolve2, reject2) => {
          gapi.load('client', {
            callback: () => resolve2(),
            onerror: () => reject2('gapi.load client failed'),
            ontimeout: () => reject2('gapi.load client timed out'),
            timeout: 15000,
          });
        });
        await gapi.client.init({
          discoveryDocs: ['https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest'],
        });
        // Explicitly load the gmail API — gapi.client.init({discoveryDocs}) sometimes
        // doesn't register gapi.client.gmail in certain environments (adblockers, CSP, etc.)
        if (!gapi.client.gmail) {
          await new Promise<void>((resolve2, reject2) => {
            gapi.client.load('gmail', 'v1', {
              callback: () => resolve2(),
              onerror: () => reject2('gapi.client.load gmail v1 failed'),
              ontimeout: () => reject2('gapi.client.load gmail v1 timed out'),
              timeout: 15000,
            });
          });
        }
        gapiInited = true;
        gapiLoading = false;
        resolve();
      } catch (err) {
        gapiLoading = false;
        reject(err instanceof Error ? err.message : String(err));
      }
    }

    doInit();
  });
}

export function initGis(): Promise<void> {
  return new Promise((resolve) => {
    if (gisInited) { resolve(); return; }
    if (gisLoading) {
      const check = setInterval(() => {
        if (gisInited) { clearInterval(check); resolve(); }
      }, 100);
      return;
    }
    gisLoading = true;

    injectGisScript()
      .then(() => {
        gisInited = true;
        gisLoading = false;
        resolve();
      })
      .catch(() => {
        gisLoading = false;
        // Don't reject — GIS is a fallback; gapi can work without it
        console.warn('[Gmail] Failed to load GIS script, falling back to gapi-only mode');
        resolve();
      });
  });
}

/**
 * Re-authenticate an existing account (forces a fresh OAuth consent + code exchange).
 * Preserves the original account ID so the store replaces rather than duplicates it.
 */
export async function reLoginAccount(
  account: Account,
  settings: AppSettings
): Promise<Account> {
  await initGapi();
  await initGis();

  const clientId = settings.clientId || FALLBACK_CLIENT_ID;
  const clientSecret = settings.clientSecret;

  if (!clientSecret) {
    // Fall back to token flow (session-only)
    return new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPES,
        prompt: 'select_account consent',
        callback: async (tokenResponse: any) => {
          if (tokenResponse.error) {
            reject(new Error(tokenResponse.error));
            return;
          }
          gapi.client.setToken({ access_token: tokenResponse.access_token });
          const profile = await gapi.client.gmail.users.getProfile({ userId: 'me' });
          const freshEmail = profile.result.emailAddress!;

          const updated: Account = {
            ...account,
            email: freshEmail,
            accessToken: tokenResponse.access_token,
            refreshToken: account.refreshToken, // keep old refresh token (won't have one in token flow)
            expiresAt: Date.now() + (tokenResponse.expires_in * 1000),
          };
          resolve(updated);
        },
      });
      client.requestAccessToken({ prompt: 'select_account' });
    });
  }

  // Authorization Code flow with offline access (gets new refresh token)
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initCodeClient({
      client_id: clientId,
      scope: SCOPES,
      ux_mode: 'popup',
      redirect_uri: REDIRECT_URI,
      prompt: 'select_account consent',
      access_type: 'offline',
      callback: async (response: any) => {
        if (response.error) {
          reject(new Error(response.error));
          return;
        }

        try {
          const exchangeRes = await fetch(`${AUTH_SERVER}/auth/exchange`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              code: response.code,
              clientId,
              clientSecret,
              redirectUri: REDIRECT_URI,
            }),
          });

          const data = await exchangeRes.json();
          if (!exchangeRes.ok) {
            reject(new Error(data.error || 'Token exchange failed'));
            return;
          }

          gapi.client.setToken({ access_token: data.accessToken });

          const updated: Account = {
            ...account,
            email: data.email,
            accessToken: data.accessToken,
            refreshToken: data.refreshToken || account.refreshToken,
            expiresAt: Date.now() + (data.expiresIn * 1000),
          };

          console.log(`Account re-connected: ${data.email} (fresh refresh token: ${data.refreshToken ? 'YES' : 'NO'})`);
          resolve(updated);
        } catch (err) {
          reject(err);
        }
      },
    });
    client.requestCode();
  });
}

/**
 * Login using Authorization Code flow with offline access.
 * This gets a PERMANENT refresh token that survives browser restarts / laptop reboots.
 * Requires: clientId + clientSecret configured in Settings, and the auth server running on port 3006.
 */
export async function loginAccount(settings: AppSettings): Promise<Account> {
  await initGapi();
  await initGis();

  const clientId = settings.clientId || FALLBACK_CLIENT_ID;
  const clientSecret = settings.clientSecret;

  // If no client secret configured, fall back to old implicit token flow (session-only)
  if (!clientSecret) {
    console.warn('No client secret configured. Using session-only token flow. Configure Client Secret in Settings for permanent tokens.');
    return loginAccountLegacy(clientId);
  }

  // Authorization Code flow with offline access
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initCodeClient({
      client_id: clientId,
      scope: SCOPES,
      ux_mode: 'popup',
      redirect_uri: REDIRECT_URI,
      prompt: 'select_account consent',
      access_type: 'offline',
      callback: async (response: any) => {
        if (response.error) {
          reject(new Error(response.error));
          return;
        }

        try {
          // Exchange code for tokens via our backend server
          const exchangeRes = await fetch(`${AUTH_SERVER}/auth/exchange`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              code: response.code,
              clientId,
              clientSecret,
              redirectUri: REDIRECT_URI,
            }),
          });

          const data = await exchangeRes.json();
          if (!exchangeRes.ok) {
            reject(new Error(data.error || 'Token exchange failed'));
            return;
          }

          // Set token for GAPI
          gapi.client.setToken({ access_token: data.accessToken });

          const account: Account = {
            id: crypto.randomUUID(),
            email: data.email,
            accessToken: data.accessToken,
            refreshToken: data.refreshToken,
            expiresAt: Date.now() + (data.expiresIn * 1000),
            dailyLimit: 50,
            sentToday: 0,
            lastResetDate: new Date().toDateString()
          };

          console.log(`Account connected: ${data.email} (refresh token: ${data.refreshToken ? 'YES ✓ PERMANENT' : 'NO'})`);
          resolve(account);
        } catch (err) {
          reject(err);
        }
      },
    });
    client.requestCode();
  });
}

/**
 * Legacy login (session-only, no refresh token). Used when client secret is not configured.
 */
function loginAccountLegacy(clientId: string): Promise<Account> {
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      prompt: 'select_account',
      callback: async (tokenResponse: any) => {
        if (tokenResponse.error) {
          reject(tokenResponse.error);
          return;
        }
        gapi.client.setToken({ access_token: tokenResponse.access_token });
        const profile = await gapi.client.gmail.users.getProfile({ userId: 'me' });
        const email = profile.result.emailAddress!;

        const account: Account = {
          id: crypto.randomUUID(),
          email,
          accessToken: tokenResponse.access_token,
          expiresAt: Date.now() + (tokenResponse.expires_in * 1000),
          dailyLimit: 50,
          sentToday: 0,
          lastResetDate: new Date().toDateString()
        };
        resolve(account);
      },
    });
    client.requestAccessToken({ prompt: 'select_account' });
  });
}

/**
 * Ensures a valid access token for the given account.
 * If a refresh token is stored, uses it to get a new access token via the backend (works even after laptop reboot, no gapi needed).
 * If no refresh token, falls back to GIS silent re-auth (session-only, needs gapi+GIS loaded).
 *
 * IMPORTANT: Strategy 1 (backend refresh) does NOT require gapi to be loaded, so it works even
 * if the Google API scripts are blocked by adblockers or network issues.
 */
export async function ensureValidToken(
  account: Account,
  onAccountUpdated?: (updatedAcc: Account) => void,
  settings?: AppSettings
): Promise<string> {
  const isExpired = !account.expiresAt || (account.expiresAt - Date.now() < 5 * 60 * 1000);
  if (!isExpired) {
    // Token is still valid — ensure gapi is loaded AND the Gmail API is registered
    await trySetGapiToken(account.accessToken);
    return account.accessToken;
  }

  console.log(`Token for ${account.email} is expired. Refreshing...`);

  // ---- Strategy 1: Use refresh token via backend (PERMANENT, NO GAPI NEEDED) ----
  if (account.refreshToken && settings?.clientId && settings?.clientSecret) {
    try {
      const res = await fetch(`${AUTH_SERVER}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          refreshToken: account.refreshToken,
          clientId: settings.clientId,
          clientSecret: settings.clientSecret,
        }),
      });

      const data = await res.json();
      if (res.ok) {
        const updatedAccount: Account = {
          ...account,
          accessToken: data.accessToken,
          expiresAt: Date.now() + (data.expiresIn * 1000),
        };
        // Ensure gapi is loaded and token is set for downstream gapi calls
        await trySetGapiToken(data.accessToken);
        onAccountUpdated?.(updatedAccount);
        console.log(`Refreshed token for ${account.email} using refresh_token (PERMANENT)`);
        return data.accessToken;
      } else {
        console.error(`Refresh token failed for ${account.email}:`, data);
      }
    } catch (err) {
      console.error(`Backend refresh failed for ${account.email}:`, err);
    }
  }

  // ---- Strategy 2: Fallback to GIS silent re-auth (session-only, needs gapi+GIS) ----
  try {
    await initGapi();
    await initGis();
  } catch (err) {
    // If gapi/GIS can't load, we can't do silent auth — throw a clear error
    console.error(`Cannot load Google APIs for silent auth:`, err);
    throw new Error(`Token refresh failed for ${account.email}: GAPI/GIS not available (${err}). Use "Re-login" button to re-authenticate.`);
  }

  const clientId = settings?.clientId || FALLBACK_CLIENT_ID;
  const silentAuthPromise = new Promise<string>((resolve, reject) => {
    try {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPES,
        hint: account.email,
        prompt: '',
        callback: async (tokenResponse: any) => {
          if (tokenResponse.error) {
            console.error(`Silent refresh failed for ${account.email}:`, tokenResponse.error);
            reject(new Error(`Silent auth failed: ${tokenResponse.error}`));
            return;
          }
          const updatedAccount: Account = {
            ...account,
            accessToken: tokenResponse.access_token,
            expiresAt: Date.now() + (tokenResponse.expires_in * 1000),
          };
          trySetGapiToken(tokenResponse.access_token);
          onAccountUpdated?.(updatedAccount);
          console.log(`Refreshed token for ${account.email} using GIS silent auth (session-only)`);
          resolve(tokenResponse.access_token);
        },
      });
      client.requestAccessToken({ prompt: '' });
    } catch (err) {
      console.error(`Error refreshing token for ${account.email}:`, err);
      reject(err);
    }
  });

  // GIS's silent flow sometimes never calls back at all (blocked 3rd-party cookies,
  // no active Google session for that hint, etc.) — with no timeout, that leaves the
  // promise pending forever, which freezes any sequential "refresh all" loop on
  // whichever account hits this. Cap it so a stuck account fails fast instead of
  // blocking every account after it.
  return withTimeout(
    silentAuthPromise,
    20000,
    `GIS silent refresh for ${account.email}`
  );
}

/**
 * Try to ensure gapi is loaded and set the access token.
 * Returns true if successful, false if gapi is still unavailable.
 * This is fire-and-forget — downstream calls will handle gapi errors if it fails.
 */
async function trySetGapiToken(token: string): Promise<boolean> {
  try {
    // If gapi isn't loaded yet, or gmail API isn't registered, try to initialize
    if (typeof gapi === 'undefined' || !gapi.client || !gapi.client.gmail) {
      await initGapi();
    }
    gapi.client.setToken({ access_token: token });
    return true;
  } catch {
    return false;
  }
}

export async function setAccountToken(
  account: Account,
  onAccountUpdated?: (updatedAcc: Account) => void,
  settings?: AppSettings
) {
  await ensureValidToken(account, onAccountUpdated, settings);
}

/**
 * Wraps a gapi promise with a timeout. If the call doesn't resolve within ms,
 * it rejects so the caller can move on instead of hanging forever.
 */
function withTimeout<T = any>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`TIMEOUT [${label}] after ${ms}ms`)), ms);
    promise
      .then((val) => { clearTimeout(timer); resolve(val); })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });
}

interface ThreadCandidate {
  account: Account;
  threadId: string;
  leadReplied: boolean;
  hasDraft: boolean;
  mySentCount: number;
  lastMessageTime: number;
  validLastMessageTime?: number;
  validLatestFromMe?: number;
  validFirstReplyTime?: number;
}

export async function analyzeLead(
  lead: Lead,
  accounts: Account[],
  dateCutoff: string,
  followUps: FollowUpConfig[],
  logCallback?: (msg: string) => void,
  onAccountUpdated?: (updatedAcc: Account) => void,
  settings?: AppSettings
): Promise<Partial<Lead>> {
  const log = (msg: string) => logCallback?.(msg);
  log(`Analyzing: ${lead.email}`);

  const cutoffTime = new Date(dateCutoff).getTime();

  // Scan every connected account and every matching thread instead of stopping at
  // the first hit — a lead may have been contacted from any of the accounts, and
  // only the most recent thread activity across ALL of them should decide the status.
  const candidates: ThreadCandidate[] = [];

  for (const account of accounts) {
    try {
      log(`-> Searching connected account: ${account.email}`);
      await ensureValidToken(account, onAccountUpdated, settings);

      // Ensure gapi.client.gmail is initialized before API calls
      if (typeof gapi === 'undefined' || !gapi.client || !gapi.client.gmail) {
        await initGapi();
      }
      if (typeof gapi === 'undefined' || !gapi.client || !gapi.client.gmail) {
        log(`-> Gmail API not available for ${account.email}, skipping`);
        continue;
      }

      // Search threads with this lead after cutoff date
      const query = `(from:${lead.email} OR to:${lead.email}) after:${dateCutoff.replace(/-/g, '/')}`;
      const searchRes: any = await withTimeout(
        gapi.client.gmail.users.threads.list({
          userId: 'me',
          q: query,
          maxResults: 10
        }),
        30000,
        `threads.list for ${lead.email}`
      );

      const threads = searchRes?.result?.threads || [];
      if (threads.length > 0) {
        log(`-> Found ${threads.length} threads in ${account.email}. Inspecting messages...`);
      }

      for (const thread of threads) {
        const threadRes: any = await withTimeout(
          gapi.client.gmail.users.threads.get({
            userId: 'me',
            id: thread.id!
          }),
          30000,
          `threads.get for ${thread.id}`
        );

        const messages = threadRes.result.messages || [];
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
          const from = headers.find((h: any) => h.name === 'From')?.value || '';
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

          // Check if I sent this
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

        // Guard: never return a date before year 2000 (prevents 1970 epoch dates)
        const MIN_VALID_DATE_MS = 946684800000;
        const validLastMessageTime = lastMessageTime > MIN_VALID_DATE_MS ? lastMessageTime : undefined;
        const validLatestFromMe = latestMessageFromMe > MIN_VALID_DATE_MS ? latestMessageFromMe : undefined;
        const validFirstReplyTime = firstReplyTime > MIN_VALID_DATE_MS ? firstReplyTime : undefined;

        log(`   -> [${account.email}] thread ${thread.id}: replied=${leadReplied} draft=${hasDraft} sent=${mySentCount}`);

        candidates.push({
          account,
          threadId: thread.id!,
          leadReplied,
          hasDraft,
          mySentCount,
          lastMessageTime,
          validLastMessageTime,
          validLatestFromMe,
          validFirstReplyTime
        });
      }
    } catch (err) {
      console.error(`Error analyzing ${lead.email} with ${account.email}:`, err);
      log(`-> Error analyzing through ${account.email}: ${err}`);
    }
  }

  if (candidates.length === 0) {
    log(`-> No interaction history discovered after cutoff date.`);
    // Preserve existing status if the lead already had one — don't reset to 'new'
    // when we simply couldn't find the thread (e.g., reply came from a different email).
    const existingStatus = lead.status || 'new';
    if (existingStatus !== 'new') {
      log(`-> Keeping existing status: ${existingStatus} (no new thread data found).`);
    } else {
      log(`-> No prior history. Status: new.`);
    }
    return {
      status: existingStatus as LeadStatus,
      lastAnalyzed: new Date().toISOString()
    };
  }

  // Pick the thread with the most recent activity across ALL accounts.
  candidates.sort((a, b) => b.lastMessageTime - a.lastMessageTime);
  const winner = candidates[0];
  log(`-> Most recent activity: thread ${winner.threadId} on account ${winner.account.email}.`);

  if (winner.leadReplied) {
    log(`   -> Found reply from lead in thread ${winner.threadId}. Status: replied.`);
    return {
      status: 'replied' as LeadStatus,
      threadId: winner.threadId,
      sentFromAccount: winner.account.email,
      lastContactDate: winner.validLastMessageTime ? new Date(winner.validLastMessageTime).toISOString() : undefined,
      firstReplyDate: winner.validFirstReplyTime ? new Date(winner.validFirstReplyTime).toISOString() : undefined,
      lastAnalyzed: new Date().toISOString()
    };
  }

  if (winner.hasDraft) {
    log(`   -> Found active draft in thread ${winner.threadId}. Status: draft.`);
    return {
      status: 'draft' as LeadStatus,
      threadId: winner.threadId,
      sentFromAccount: winner.account.email,
      lastAnalyzed: new Date().toISOString()
    };
  }

  // winner.mySentCount > 0
  const daysSinceSent = winner.validLatestFromMe
    ? Math.floor((Date.now() - winner.validLatestFromMe) / (1000 * 60 * 60 * 24))
    : Infinity;
  let status: LeadStatus;

  log(`   -> Found ${winner.mySentCount} sent outbound email(s).${winner.validLatestFromMe ? ` Last contacted ${daysSinceSent} day(s) ago.` : ''}`);

  const fuIndex = winner.mySentCount - 1; // 0-based index into followUps array

  if (fuIndex < followUps.length && daysSinceSent >= followUps[fuIndex].delayDays) {
    status = needsFollowUpStatus(winner.mySentCount);
    log(`   -> Elapsed days (${daysSinceSent}) >= FU${winner.mySentCount} delay (${followUps[fuIndex].delayDays}). Promoting to: ${status}.`);
  } else if (fuIndex < followUps.length) {
    // Stay at the previous sent status
    if (winner.mySentCount === 1) {
      status = 'initial_sent';
      log(`   -> Elapsed days (${daysSinceSent}) < FU${winner.mySentCount} delay (${followUps[fuIndex].delayDays}). Keeping at: initial_sent.`);
    } else {
      status = followUpSentStatus(winner.mySentCount - 1);
      log(`   -> Keeping at: ${status}.`);
    }
  } else {
    // Past all configured follow-ups
    status = followUpSentStatus(followUps.length);
    log(`   -> Sequence finished (${winner.mySentCount} emails, ${followUps.length} follow-ups configured). Keeping at: ${status}.`);
  }

  return {
    status,
    threadId: winner.threadId,
    sentFromAccount: winner.account.email,
    lastContactDate: winner.validLatestFromMe ? new Date(winner.validLatestFromMe).toISOString() : undefined,
    lastAnalyzed: new Date().toISOString()
  };
}

/**
 * Find the single most recent Gmail thread with a given email address, scanning
 * ALL connected accounts with no date cutoff. Used for individually-added MOF leads,
 * whose conversation history may predate the app's normal sync date cutoff.
 */
export async function findLatestThreadForEmail(
  email: string,
  accounts: Account[],
  onAccountUpdated?: (updatedAcc: Account) => void,
  settings?: AppSettings
): Promise<{ account: Account; threadId: string; lastMessageTime: number } | null> {
  let best: { account: Account; threadId: string; lastMessageTime: number } | null = null;

  for (const account of accounts) {
    try {
      await ensureValidToken(account, onAccountUpdated, settings);

      if (typeof gapi === 'undefined' || !gapi.client || !gapi.client.gmail) {
        await initGapi();
      }
      if (typeof gapi === 'undefined' || !gapi.client || !gapi.client.gmail) {
        continue;
      }

      const query = `(from:${email} OR to:${email})`;
      const searchRes: any = await withTimeout(
        gapi.client.gmail.users.threads.list({
          userId: 'me',
          q: query,
          maxResults: 10
        }),
        30000,
        `threads.list for ${email}`
      );

      const threads = searchRes?.result?.threads || [];

      for (const thread of threads) {
        const threadRes: any = await withTimeout(
          gapi.client.gmail.users.threads.get({
            userId: 'me',
            id: thread.id!
          }),
          30000,
          `threads.get for ${thread.id}`
        );

        const messages = threadRes.result.messages || [];
        let lastMessageTime = 0;
        for (const message of messages) {
          const internalDate = parseInt(message.internalDate || '0');
          lastMessageTime = Math.max(lastMessageTime, internalDate);
        }

        if (lastMessageTime > 0 && (!best || lastMessageTime > best.lastMessageTime)) {
          best = { account, threadId: thread.id!, lastMessageTime };
        }
      }
    } catch (err) {
      console.error(`Error searching for latest thread with ${email} via ${account.email}:`, err);
    }
  }

  return best;
}

/**
 * Decode base64 (URL-safe or standard) to a readable string
 */
function decodeB64(data: string): string {
  try {
    // Convert URL-safe base64 to standard base64
    let str = data.replace(/-/g, '+').replace(/_/g, '/');
    // Pad with = if needed
    while (str.length % 4) str += '=';
    return decodeURIComponent(
      Array.from(atob(str), c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')
    );
  } catch {
    return '[Could not decode message]';
  }
}

/**
 * Extract body text from a Gmail message payload (handles multipart, text, and HTML)
 */
function extractBodyText(payload: any): string {
  if (!payload) return '';

  // If payload has parts, search through them for text/plain first, then text/html
  if (payload.parts && payload.parts.length > 0) {
    // Try text/plain first
    const textPart = payload.parts.find((p: any) => p.mimeType === 'text/plain');
    if (textPart?.body?.data) return decodeB64(textPart.body.data);

    // Fall back to text/html
    const htmlPart = payload.parts.find((p: any) => p.mimeType === 'text/html');
    if (htmlPart?.body?.data) {
      const html = decodeB64(htmlPart.body.data);
      // Strip HTML tags
      return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
    }

    // Recursively check nested parts
    for (const part of payload.parts) {
      const nested = extractBodyText(part);
      if (nested) return nested;
    }
    return '';
  }

  // Simple message with direct body data
  if (payload.body?.data) {
    if (payload.mimeType === 'text/html') {
      return decodeB64(payload.body.data).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
    }
    return decodeB64(payload.body.data);
  }

  return '';
}

export interface ThreadMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
  snippet: string;
}

/**
 * Fetch a full email thread from Gmail API and return parsed messages.
 */
export async function fetchThreadMessages(
  threadId: string,
  account: Account,
  onAccountUpdated?: (updatedAcc: Account) => void,
  settings?: AppSettings
): Promise<ThreadMessage[]> {
  try {
    await ensureValidToken(account, onAccountUpdated, settings);
    await ensureGapiGmail();

    const res = await gapi.client.gmail.users.threads.get({
      userId: 'me',
      id: threadId,
      format: 'full',
    });

    const messages = res.result.messages || [];
    return messages.map((msg: any) => {
      const headers = msg.payload?.headers || [];
      const getHeader = (name: string) =>
        headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

      return {
        id: msg.id,
        from: getHeader('From'),
        to: getHeader('To'),
        subject: getHeader('Subject'),
        date: getHeader('Date'),
        body: extractBodyText(msg.payload),
        snippet: msg.snippet || '',
      };
    });
  } catch (err) {
    console.error('Failed to fetch thread:', err);
    return [];
  }
}

/**
 * Ensure gapi.client.gmail is loaded before any Gmail API call.
 * Must be called after ensureValidToken but before using gapi.client.gmail.
 */
async function ensureGapiGmail(): Promise<void> {
  // trySetGapiToken swallows errors silently. Do an explicit check here.
  if (typeof gapi === 'undefined' || !gapi.client || !gapi.client.gmail) {
    await initGapi();
  }
  // After init, if gapi.client.gmail is STILL undefined, fail hard
  if (typeof gapi === 'undefined' || !gapi.client || !gapi.client.gmail) {
    throw new Error('Gmail API not available. Check that Google APIs can load (no adblocker) and re-authenticate.');
  }
}

export async function createDraft(
  account: Account,
  to: string,
  subject: string,
  body: string,
  threadId?: string,
  onAccountUpdated?: (updatedAcc: Account) => void,
  settings?: AppSettings
): Promise<string> {
  await ensureValidToken(account, onAccountUpdated, settings);
  await ensureGapiGmail();

  const htmlBody = body.replace(/\n/g, '<br>');

  const message = [
    'To: ' + to,
    'Subject: ' + encodeSubjectHeader(subject),
    'Content-Type: text/html; charset=utf-8',
    'MIME-Version: 1.0',
    '',
    '<div style="font-family: sans-serif; white-space: pre-wrap;">' + htmlBody + '</div>'
  ].join('\n');

  const encoded = btoa(unescape(encodeURIComponent(message))).replace(/\+/g, '-').replace(/\//g, '_');

  const draftBody: any = {
    message: {
      raw: encoded
    }
  };

  if (threadId) {
    draftBody.message.threadId = threadId;
  }

  const res = await gapi.client.gmail.users.drafts.create({
    userId: 'me',
    resource: draftBody
  });

  return res.result.id!;
}

/**
 * Extract recipient email from a draft's message headers.
 */
function extractRecipient(message: any): string {
  try {
    const headers = message.payload?.headers || [];
    const to = headers.find((h: any) => h.name.toLowerCase() === 'to')?.value || '';
    // Strip display name, keep just the email
    const match = to.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    return match ? match[0] : to;
  } catch { return ''; }
}

/**
 * Extract subject from a draft's message headers.
 */
function extractSubject(message: any): string {
  try {
    const headers = message.payload?.headers || [];
    return headers.find((h: any) => h.name.toLowerCase() === 'subject')?.value || '(No subject)';
  } catch { return '(No subject)'; }
}

/**
 * List all drafts for a connected Gmail account.
 */
export async function listDrafts(
  account: Account,
  onAccountUpdated?: (updatedAcc: Account) => void,
  settings?: AppSettings
): Promise<any[]> {
  await ensureValidToken(account, onAccountUpdated, settings);
  await ensureGapiGmail();
  const res = await gapi.client.gmail.users.drafts.list({
    userId: 'me',
    maxResults: 500,
  });
  return res.result.drafts || [];
}

/**
 * Get full draft details (including message headers) to check recipient & subject.
 */
export async function getDraftDetails(
  draftId: string,
  account: Account,
  onAccountUpdated?: (updatedAcc: Account) => void,
  settings?: AppSettings
): Promise<{ id: string; to: string; subject: string; message: any } | null> {
  try {
    await ensureValidToken(account, onAccountUpdated, settings);
    await ensureGapiGmail();
    const res = await gapi.client.gmail.users.drafts.get({
      userId: 'me',
      id: draftId,
      format: 'full',
    });
    const msg = res.result.message;
    return {
      id: draftId,
      to: extractRecipient(msg),
      subject: extractSubject(msg),
      message: msg,
    };
  } catch (err) {
    console.error('Failed to get draft details:', err);
    return null;
  }
}

/**
 * Send a draft via the Gmail API (immediately).
 * For scheduled sending, use the backend Playwright endpoint instead.
 */
export async function sendDraft(
  draftId: string,
  account: Account,
  onAccountUpdated?: (updatedAcc: Account) => void,
  settings?: AppSettings
): Promise<boolean> {
  try {
    await ensureValidToken(account, onAccountUpdated, settings);
    await ensureGapiGmail();
    await gapi.client.gmail.users.drafts.send({
      userId: 'me',
      resource: { id: draftId },
    });
    return true;
  } catch (err) {
    console.error('Failed to send draft:', err);
    return false;
  }
}

/**
 * Send an email DIRECTLY via the Gmail API (no draft).
 * This creates a message and sends it immediately.
 * If threadId is provided, it replies in-thread (for Phase 1 follow-ups).
 * Returns the sent message ID and thread ID on success, null on failure.
 * Also tracks daily send count on the account.
 */
export async function sendEmail(
  account: Account,
  to: string,
  subject: string,
  body: string,
  threadId?: string,
  onAccountUpdated?: (updatedAcc: Account) => void,
  settings?: AppSettings
): Promise<{ messageId: string; threadId: string } | null> {
  try {
    await ensureValidToken(account, onAccountUpdated, settings);
    await ensureGapiGmail();

    // Check daily limit
    if (account.sentToday >= account.dailyLimit) {
      console.error(`Daily limit reached for ${account.email} (${account.sentToday}/${account.dailyLimit})`);
      return null;
    }

    const htmlBody = body.replace(/\n/g, '<br>');

    const message = [
      'To: ' + to,
      'Subject: ' + encodeSubjectHeader(subject),
      'Content-Type: text/html; charset=utf-8',
      'MIME-Version: 1.0',
      '',
      '<div style="font-family: sans-serif; white-space: pre-wrap;">' + htmlBody + '</div>'
    ].join('\n');

    const encoded = btoa(unescape(encodeURIComponent(message))).replace(/\+/g, '-').replace(/\//g, '_');

    const request: any = {
      userId: 'me',
      resource: {
        raw: encoded,
      },
    };

    if (threadId) {
      request.resource.threadId = threadId;
    }

    const res = await gapi.client.gmail.users.messages.send(request);
    const sentMsg = res.result;

    // Update sent count
    if (onAccountUpdated) {
      const updated: Account = {
        ...account,
        sentToday: account.sentToday + 1,
      };
      onAccountUpdated(updated);
    }

    return {
      messageId: sentMsg.id!,
      threadId: sentMsg.threadId!,
    };
  } catch (err) {
    console.error('Failed to send email:', err);
    return null;
  }
}