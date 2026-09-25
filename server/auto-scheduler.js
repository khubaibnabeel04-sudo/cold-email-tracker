/**
 * Gmail Draft AUTO-Scheduler
 *
 * Fully automated version of the manual schedule workflow:
 *   1. Builds a send-time plan PER ACCOUNT: first draft at 10:00 PM tonight,
 *      each following draft 30-60 minutes later (1-2 random gaps stretched to
 *      61-90 min).
 *   2. Opens every Chrome profile AT THE SAME TIME and drives them in parallel.
 *   3. Opens every draft (new compose OR inline follow-up reply), clicks the
 *      arrow next to Send -> "Schedule send" -> "Pick date & time", fills the
 *      planned time and confirms.
 *   4. Verifies each step visually appeared (waits + retries up to 3 times),
 *      saves a screenshot to server/auto-schedule-shots/ when something fails.
 *
 * State is polled by the frontend via GET /api/auto-schedule/status.
 *
 * ── Why the windows are parked off-screen ──────────────────────────────────
 * Windows stops producing frames for a MINIMIZED window. Chrome then throttles
 * requestAnimationFrame from ~60 Hz to ~6 Hz, and every Playwright click (which
 * waits for a stable bounding box across rAF frames) slows to a crawl.
 * Measured on this machine with 8 parallel instances:
 *
 *     off-screen (not minimized) : rAF 59.9 Hz, click median   99 ms
 *     minimized                  : rAF  6.3 Hz, click median 1824 ms
 *
 * No Chrome flag fixes this — Playwright already passes
 * --disable-background-timer-throttling, --disable-backgrounding-occluded-windows
 * and --disable-renderer-backgrounding, and adding
 * --disable-features=CalculateNativeWinOcclusion changes nothing, because the
 * throttling comes from the window manager rather than from Chrome.
 *
 * So instead the windows are launched far off-screen — invisible to the user
 * but still composited at full speed — and window-guard.ps1 un-minimizes any
 * window that gets minimized (Win+D, taskbar click, ...) without stealing focus.
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const SHOTS_DIR = path.join(__dirname, 'auto-schedule-shots');
const GUARD_SCRIPT = path.join(__dirname, 'window-guard.ps1');

/** How many Chrome profiles to drive at once. Each one costs roughly 400-700 MB. */
const DEFAULT_CONCURRENCY = 8;

/**
 * Playwright's own --disable-features list (v1.60). It has to be repeated here:
 * Chrome honours only the LAST --disable-features switch and Playwright appends
 * our args after its own, so passing a bare flag would silently drop all of these.
 */
const PW_DISABLED_FEATURES = [
  'AvoidUnnecessaryBeforeUnloadCheckSync', 'BoundaryEventDispatchTracksNodeRemoval',
  'DestroyProfileOnBrowserClose', 'DialMediaRouteProvider', 'GlobalMediaControls',
  'HttpsUpgrades', 'LensOverlay', 'MediaRouter', 'PaintHolding',
  'ThirdPartyStoragePartitioning', 'Translate', 'AutoDeElevate', 'RenderDocument',
  'OptimizationHints', 'msForceBrowserSignIn', 'msEdgeUpdateLaunchServicesPreferredVersion',
];

/** Belt-and-braces: these did not change the measurements, but they cost nothing. */
const EXTRA_DISABLED_FEATURES = [
  'CalculateNativeWinOcclusion', // Windows occlusion detection
  'IntensiveWakeUpThrottling',   // 1-tick-per-minute timers after 5 min hidden
];

const OFFSCREEN_POS = '-32000,-32000';

function chromeArgs(hidden) {
  const args = [
    '--disable-blink-features=AutomationControlled',
    `--disable-features=${[...PW_DISABLED_FEATURES, ...EXTRA_DISABLED_FEATURES].join(',')}`,
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-hang-monitor',
    '--window-size=1280,800',
  ];
  if (hidden) args.push(`--window-position=${OFFSCREEN_POS}`);
  return args;
}

// ── Run state (one run at a time) ─────────────────────────────────────────
let run = null;                       // status object exposed to the frontend
let activeContexts = new Map();       // email -> BrowserContext
let guard = null;                     // { stop() } for window-guard.ps1

function newRun(accounts, opts) {
  return {
    running: true,
    cancelled: false,
    done: false,
    error: null,
    startedAt: new Date().toISOString(),
    parallel: opts.concurrency,
    hidden: opts.hidden,
    accounts: accounts.map(a => ({
      email: a.email,
      profileDir: a.profileDir,
      expected: a.draftCount,
      scheduled: 0,
      failed: 0,
      status: 'pending', // pending | active | done | error | skipped
      plan: [],          // ISO strings — this account's own send times
      nextTimeIdx: 0,
    })),
    // Kept for backwards compatibility with the old sequential UI. In parallel
    // mode there is no single "current" account, so this stays -1 and the plan
    // mirrors the first account's schedule.
    currentAccountIdx: -1,
    plan: [],
    nextTimeIdx: 0,
    logs: [],
  };
}

/** `tag` labels which account a line came from — essential once 8 run at once. */
function log(msg, tag) {
  const prefix = tag ? `${tag} │ ` : '';
  const line = `[${new Date().toLocaleTimeString()}] ${prefix}${msg}`;
  console.log(`[AutoSchedule] ${prefix}${msg}`);
  if (run) {
    run.logs.push(line);
    if (run.logs.length > 4000) run.logs.splice(0, run.logs.length - 4000);
  }
}

/** Short label for an account, e.g. "jane.doe@gmail.com" -> "jane.doe". */
function tagFor(acc) {
  return String(acc.email || '').split('@')[0];
}

// ── Time plan ─────────────────────────────────────────────────────────────

/**
 * Generate `count` send times starting at 10:00 PM today.
 * Gaps: uniform 30-60 min, with 1-2 random gaps stretched to 61-90 min.
 * If it's already past 10 PM, start ~10 minutes from now instead.
 */
function generatePlan(count, tag) {
  const now = new Date();
  let start = new Date(now);
  start.setHours(22, 0, 0, 0);
  if (now.getTime() >= start.getTime() - 5 * 60000) {
    // Already 10 PM (or within 5 min of it) — start a bit after now
    start = new Date(now.getTime() + 10 * 60000);
    start.setSeconds(0, 0);
    log(`⚠ It's already past 10 PM — starting the plan at ${fmtTime(start)} instead.`, tag);
  }

  const times = [new Date(start)];
  if (count > 1) {
    const gaps = [];
    for (let i = 0; i < count - 1; i++) {
      gaps.push(30 + Math.floor(Math.random() * 31)); // 30-60 min
    }
    // Stretch 1-2 random gaps past the 60-minute mark (61-90 min)
    const numLong = Math.min(gaps.length, 1 + Math.floor(Math.random() * 2));
    const longIdxs = new Set();
    while (longIdxs.size < numLong) {
      longIdxs.add(Math.floor(Math.random() * gaps.length));
    }
    for (const i of longIdxs) gaps[i] = 61 + Math.floor(Math.random() * 30);

    for (const g of gaps) {
      times.push(new Date(times[times.length - 1].getTime() + g * 60000));
    }
  }

  // Warn if the plan spills past 7 AM tomorrow
  const sevenAm = new Date(start);
  sevenAm.setDate(sevenAm.getDate() + (start.getHours() >= 22 ? 1 : 0));
  sevenAm.setHours(7, 0, 0, 0);
  const overflow = times.filter(t => t.getTime() > sevenAm.getTime()).length;
  if (overflow > 0) {
    log(`⚠ ${overflow} draft(s) fall after 7 AM — too many drafts for the 10 PM-7 AM window. They will still be scheduled in sequence.`, tag);
  }
  return times;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtDate(d) {
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function fmtTime(d) {
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`;
}

// ── Window guard ──────────────────────────────────────────────────────────

/**
 * Start window-guard.ps1, which keeps our Chrome windows un-minimized (and
 * therefore composited at full speed) for the duration of the run. Failure is
 * never fatal — the run still works, it just loses minimize protection.
 */
function startWindowGuard(profileDirs) {
  if (process.platform !== 'win32') return null;
  if (!fs.existsSync(GUARD_SCRIPT)) {
    log(`⚠ window-guard.ps1 not found — minimizing a window will slow that account down.`);
    return null;
  }

  const sentinel = path.join(__dirname, `.window-guard-${process.pid}.alive`);
  // The dirs go through a file, not an argument: an array passed via spawn()
  // arrives as one already-quoted string and would bind as a single element.
  const listFile = path.join(__dirname, `.window-guard-${process.pid}.dirs`);
  try {
    fs.writeFileSync(sentinel, String(Date.now()));
    fs.writeFileSync(listFile, profileDirs.join('\n'), 'utf8');
  } catch (err) {
    log(`⚠ Could not start the window guard: ${err.message}`);
    return null;
  }

  const dropSentinel = () => { try { fs.rmSync(sentinel, { force: true }); } catch {} };
  const dropListFile = () => { try { fs.rmSync(listFile, { force: true }); } catch {} };

  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', GUARD_SCRIPT,
    '-Sentinel', sentinel, '-ProfileList', listFile];

  let child;
  try {
    child = spawn('powershell.exe', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (err) {
    log(`⚠ Could not start the window guard: ${err.message}`);
    dropSentinel();
    dropListFile();
    return null;
  }

  // PowerShell needs ~700 ms to boot and read the list. Removing it any earlier
  // (e.g. from a run that ends almost immediately) would leave the guard
  // running but protecting nothing, so its lifetime follows the child process.
  child.on('exit', dropListFile);

  child.stdout.on('data', d => {
    const t = String(d).trim();
    if (t) log(`🛡 ${t}`);
  });
  child.stderr.on('data', d => {
    const t = String(d).trim();
    if (t) log(`🛡 guard error: ${t.split('\n')[0]}`);
  });
  child.on('error', err => log(`🛡 guard failed: ${err.message}`));

  log(`🛡 Window guard running — minimizing a Chrome window will not slow it down.`);

  return {
    stop() {
      // The guard polls the sentinel, so deleting it is the clean shutdown.
      dropSentinel();
      setTimeout(() => {
        try { child.kill(); } catch {}
        dropListFile(); // backstop in case 'exit' never fires
      }, 2500);
    },
  };
}

// ── Playwright helpers ────────────────────────────────────────────────────

async function shot(page, name, tag) {
  try {
    if (!fs.existsSync(SHOTS_DIR)) fs.mkdirSync(SHOTS_DIR, { recursive: true });
    // Include the account tag — 8 accounts failing at once would otherwise
    // race for the same millisecond-based filename.
    const file = path.join(SHOTS_DIR, `${Date.now()}_${tag || 'run'}_${name}.png`);
    await page.screenshot({ path: file });
    log(`   📸 Screenshot saved: ${path.basename(file)}`, tag);
  } catch {}
}

/** Wait for the drafts list and return the number of VISIBLE draft rows.
 *  (Gmail keeps old list views hidden in the DOM, so counting all tr.zA
 *  rows overcounts — only visible rows are real drafts.) */
async function waitForDraftsList(page, tag) {
  const rows = page.locator('tr.zA').locator('visible=true');
  const empty = page.getByText(/no saved drafts|don't have any saved/i);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await Promise.race([
        rows.first().waitFor({ state: 'visible', timeout: 20000 }),
        empty.first().waitFor({ state: 'visible', timeout: 20000 }),
      ]);
      // Let the list settle so the count is stable
      await page.waitForTimeout(1500);
      return await rows.count();
    } catch {
      // Neither rows nor the empty-state text appeared — check the visible
      // count directly before burning a reload
      const visible = await rows.count().catch(() => 0);
      if (visible === 0) return 0;
      log(`   …drafts list not visible yet (attempt ${attempt + 1}/3), reloading…`, tag);
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(3000);
    }
  }
  return await rows.count().catch(() => 0);
}

/** Find the visible "More send options" arrow next to a Send button. */
function sendArrow(page) {
  return page
    .locator('[aria-label="More send options"], [data-tooltip="More send options"]')
    .locator('visible=true')
    .first();
}

/**
 * Open the first draft in the drafts list and wait until a compose surface
 * with a Send button is visible. Detects initial vs follow-up drafts.
 * Returns true when the draft is open and ready.
 */
async function openFirstDraft(page, tag) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (run.cancelled) return false;
    try {
      const row = page.locator('tr.zA').locator('visible=true').first();
      await row.waitFor({ state: 'visible', timeout: 10000 });
      // Click the subject cell (safest spot — avoids checkbox/star)
      const subject = row.locator('.bog').first();
      if (await subject.count()) await subject.click();
      else await row.click();

      // Figure out what opened: a standalone compose dialog (initial send)
      // or a conversation thread (follow-up). A compose dialog shows up
      // almost instantly — if it isn't there quickly, this is a follow-up
      // thread and we scroll down IMMEDIATELY (the inline reply's Send
      // button only renders near the bottom of the thread).
      const composeDialog = page
        .locator('div[role="dialog"]')
        .locator('visible=true')
        .filter({ has: page.locator('[aria-label="More send options"], [data-tooltip="More send options"]') })
        .first();
      let isFollowUp = false;
      try {
        await composeDialog.waitFor({ state: 'visible', timeout: 2500 });
      } catch {
        isFollowUp = true;
      }

      if (isFollowUp) {
        log(`   ↧ Follow-up thread — scrolling to the inline reply…`, tag);
        await page.mouse.move(640, 400).catch(() => {});
        await page.mouse.wheel(0, 5000).catch(() => {});
        await page.keyboard.press('End').catch(() => {});
        await page.waitForTimeout(800);
        await page.mouse.wheel(0, 5000).catch(() => {});
      }

      await sendArrow(page).waitFor({ state: 'visible', timeout: 8000 });
      await sendArrow(page).scrollIntoViewIfNeeded().catch(() => {});
      log(`   ✉ Draft opened — ${isFollowUp ? 'follow-up (inline reply)' : 'initial send (new compose)'}`, tag);
      return true;
    } catch {
      log(`   …draft didn't open (attempt ${attempt}/3), retrying…`, tag);
      await page.keyboard.press('Escape').catch(() => {});
      await page.goto('https://mail.google.com/mail/u/0/#drafts', { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(3000);
    }
  }
  await shot(page, 'open-draft-failed', tag);
  return false;
}

/**
 * With a draft open, click the Send arrow -> Schedule send -> Pick date & time,
 * fill in the planned time, confirm, and verify it was scheduled.
 */
async function scheduleOpenDraft(page, when, tag) {
  // Step 1: open the "Schedule send" menu item via the arrow next to Send
  const menuItem = page
    .getByRole('menuitem', { name: /schedule send/i })
    .or(page.getByText(/^schedule send$/i))
    .locator('visible=true')
    .first();
  let menuOpen = false;
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (run.cancelled) return false;
    try {
      // If the compose surface disappeared (e.g. got closed), reopen the draft
      if (!(await sendArrow(page).isVisible().catch(() => false))) {
        log(`   …compose window is not open — reopening the draft…`, tag);
        const reopened = await openFirstDraft(page, tag);
        if (!reopened) continue;
      }
      await sendArrow(page).click();
      await menuItem.waitFor({ state: 'visible', timeout: 6000 });
      menuOpen = true;
      break;
    } catch {
      log(`   …"Schedule send" menu didn't appear (attempt ${attempt}/4), retrying…`, tag);
      // Close a stray menu ONLY if one is actually open — a blind Escape
      // here would close the compose window itself
      const openMenus = await page.locator('[role="menu"]').locator('visible=true').count().catch(() => 0);
      if (openMenus > 0) await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(2000);
    }
  }
  if (!menuOpen) {
    await shot(page, 'schedule-menu-failed', tag);
    return false;
  }
  await menuItem.click();

  // Step 2: the "Schedule send" dialog with preset times -> click "Pick date & time"
  const pickBtn = page.getByText(/pick date\s*(&|and)\s*time/i).locator('visible=true').first();
  let pickerOpen = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (run.cancelled) return false;
    try {
      await pickBtn.waitFor({ state: 'visible', timeout: 6000 });
      pickerOpen = true;
      break;
    } catch {
      log(`   …schedule dialog didn't appear (attempt ${attempt}/3), reopening menu…`, tag);
      // Only Escape if a menu is actually open (blind Escape closes compose)
      const openMenus = await page.locator('[role="menu"]').locator('visible=true').count().catch(() => 0);
      if (openMenus > 0) await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(1500);
      try {
        await sendArrow(page).click();
        await menuItem.waitFor({ state: 'visible', timeout: 5000 });
        await menuItem.click();
      } catch {}
    }
  }
  if (!pickerOpen) {
    await shot(page, 'schedule-dialog-failed', tag);
    return false;
  }
  await pickBtn.click();

  // Step 3: fill the "Pick date & time" modal.
  // NOTE: this modal is NOT a role="dialog" element — it's a Gmail overlay
  // identified by its data attributes (data-min-seconds-from-now etc.).
  const dateStr = fmtDate(when);
  const timeStr = fmtTime(when);
  try {
    const picker = page
      .locator('div[data-min-seconds-from-now], div[jscontroller="fgJzdd"]')
      .locator('visible=true')
      .first();
    await picker.waitFor({ state: 'visible', timeout: 10000 });

    // The modal has exactly two text inputs: date on top, time below
    const inputs = picker.locator('input').locator('visible=true');
    await inputs.first().waitFor({ state: 'visible', timeout: 5000 });
    const dateInput = inputs.nth(0);
    const timeInput = inputs.nth(1);

    // Date — type and commit with Tab (Escape would close the whole modal,
    // Enter could trigger the modal's default button too early)
    await dateInput.click();
    await page.keyboard.press('Control+a');
    await dateInput.type(dateStr, { delay: 40 });
    await page.keyboard.press('Tab');
    await page.waitForTimeout(400);

    // Time — type and commit with Tab (closes the suggestion dropdown)
    await timeInput.click();
    await page.keyboard.press('Control+a');
    await timeInput.type(timeStr, { delay: 40 });
    await page.keyboard.press('Tab');
    await page.waitForTimeout(400);

    // Sanity-check what actually ended up in the fields
    const dateVal = await dateInput.inputValue().catch(() => '');
    const timeVal = await timeInput.inputValue().catch(() => '');
    log(`   Picker filled — date: "${dateVal}", time: "${timeVal}"`, tag);
    if (!timeVal.toUpperCase().includes(timeStr.slice(-2))) {
      // AM/PM mismatch — retry the time field once
      await timeInput.click();
      await page.keyboard.press('Control+a');
      await timeInput.type(timeStr, { delay: 60 });
      await page.keyboard.press('Tab');
      await page.waitForTimeout(400);
    }

    // Confirm with the blue "Schedule send" button (inside the modal if
    // possible, otherwise the visible one anywhere on the page)
    let confirm = picker.getByRole('button', { name: /schedule send/i }).first();
    if (!(await confirm.count())) {
      confirm = page.getByRole('button', { name: /schedule send/i }).locator('visible=true').last();
    }
    await confirm.click({ timeout: 10000 });
  } catch (err) {
    log(`   ✗ Failed filling date/time picker: ${String(err.message).split('\n')[0]}`, tag);
    await shot(page, 'picker-fill-failed', tag);
    await page.keyboard.press('Escape').catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  }

  // Step 4: verify — Gmail shows a "Send scheduled for …" toast and closes compose
  try {
    await page.getByText(/send scheduled/i).first().waitFor({ state: 'visible', timeout: 10000 });
    return true;
  } catch {
    // Fallback verification: the compose surface (send arrow) should be gone
    try {
      await sendArrow(page).waitFor({ state: 'hidden', timeout: 5000 });
      return true;
    } catch {
      log(`   ✗ Could not confirm the draft was scheduled.`, tag);
      await shot(page, 'verify-failed', tag);
      await page.keyboard.press('Escape').catch(() => {});
      return false;
    }
  }
}

/** Process every draft in one account. Safe to run concurrently with others:
 *  all mutable state lives on `acc` or in locals, never on `run`. */
async function processAccount(acc) {
  const tag = tagFor(acc);
  log(`🚀 Opening Chrome (profile: ${acc.profileDir})`, tag);

  if (!fs.existsSync(acc.profileDir)) {
    throw new Error(`Profile directory not found: ${acc.profileDir}`);
  }

  const ctx = await chromium.launchPersistentContext(acc.profileDir, {
    headless: false,
    channel: 'chrome',
    args: chromeArgs(run.hidden),
    viewport: { width: 1280, height: 800 },
  });
  activeContexts.set(acc.email, ctx);

  try {
    const page = await ctx.newPage();
    await page.goto('https://mail.google.com/mail/u/0/#drafts', { waitUntil: 'domcontentloaded' });

    let count = await waitForDraftsList(page, tag);
    log(`   ${count} draft(s) visible in Gmail Drafts.`, tag);

    let consecutiveFailures = 0;
    let safety = 0;
    while (count > 0 && !run.cancelled && safety++ < 200) {
      // More real drafts than the scan expected? Extend this account's plan
      // with additional random 30-60 min gaps instead of reusing the last slot.
      while (acc.nextTimeIdx >= acc.plan.length) {
        const last = new Date(acc.plan[acc.plan.length - 1]);
        const gap = 30 + Math.floor(Math.random() * 31);
        acc.plan.push(new Date(last.getTime() + gap * 60000).toISOString());
        log(`   🕒 Plan extended: +${gap} min → ${fmtTime(new Date(acc.plan[acc.plan.length - 1]))}`, tag);
      }
      const when = new Date(acc.plan[acc.nextTimeIdx]);
      log(`Draft ${acc.scheduled + acc.failed + 1} — target time: ${fmtDate(when)} ${fmtTime(when)}`, tag);

      const opened = await openFirstDraft(page, tag);
      let ok = false;
      if (opened) ok = await scheduleOpenDraft(page, when, tag);

      if (ok) {
        acc.scheduled++;
        acc.nextTimeIdx++;
        consecutiveFailures = 0;
        log(`   ✅ Scheduled for ${fmtTime(when)} (${acc.scheduled} done in this account).`, tag);
      } else {
        acc.failed++;
        consecutiveFailures++;
        log(`   ✗ Failed on this draft (${consecutiveFailures} consecutive failure(s)).`, tag);
        if (consecutiveFailures >= 3) {
          log(`   ⛔ 3 consecutive failures — skipping the rest of this account.`, tag);
          break;
        }
      }

      // Refresh the drafts list and re-count
      await page.goto('https://mail.google.com/mail/u/0/#drafts', { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(2500);
      const newCount = await waitForDraftsList(page, tag);
      if (ok && newCount >= count) {
        // Scheduled draft should have left the Drafts folder; reload to be sure
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForTimeout(3000);
        count = await waitForDraftsList(page, tag);
      } else {
        count = newCount;
      }
    }

    log(`Account finished: ${acc.scheduled} scheduled, ${acc.failed} failed, ${count} draft(s) left.`, tag);
  } finally {
    try { await ctx.close(); } catch {}
    activeContexts.delete(acc.email);
  }
}

// ── Run orchestration ─────────────────────────────────────────────────────

/** Run `fn` over `items` with at most `limit` in flight at once. */
async function runPool(items, limit, fn) {
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

async function executeRun() {
  const totalDrafts = run.accounts.reduce((s, a) => s + (a.expected || 0), 0);
  log(`═══════════════════════════════════════`);
  log(`🤖 Automated scheduling started`);
  log(`Accounts: ${run.accounts.length}, drafts expected: ${totalDrafts}`);
  log(`Running ${Math.min(run.parallel, run.accounts.length)} Chrome instance(s) IN PARALLEL.`);
  log(`Each account gets its OWN 10 PM → 7 AM plan.`);
  if (run.hidden) {
    log(`Chrome windows are parked off-screen on purpose — they run at full speed`);
    log(`and stay out of your way. You can keep using your laptop normally.`);
  }
  log(`═══════════════════════════════════════`);

  // Build every account's plan up front so the UI can show all of them.
  for (const acc of run.accounts) {
    const tag = tagFor(acc);
    const times = generatePlan(Math.max(acc.expected || 0, 1), tag);
    acc.plan = times.map(t => t.toISOString());
    acc.nextTimeIdx = 0;
    log(`🕙 Send-time plan (${times.length} slot(s)): ` +
      times.map(t => fmtTime(t)).join(' → '), tag);
  }
  // Mirror the first account's plan for the legacy top-level field.
  run.plan = run.accounts.length ? run.accounts[0].plan : [];

  guard = startWindowGuard(run.accounts.map(a => a.profileDir));

  try {
    await runPool(run.accounts, run.parallel, async (acc) => {
      if (run.cancelled) { acc.status = 'skipped'; return; }
      acc.status = 'active';
      try {
        await processAccount(acc);
        acc.status = run.cancelled
          ? 'skipped'
          : (acc.failed > 0 && acc.scheduled === 0 ? 'error' : 'done');
      } catch (err) {
        // One account blowing up must never take down the other seven.
        acc.status = 'error';
        log(`❌ ${err.message}`, tagFor(acc));
        const ctx = activeContexts.get(acc.email);
        if (ctx) {
          try { await ctx.close(); } catch {}
          activeContexts.delete(acc.email);
        }
      }
    });
  } finally {
    if (guard) { guard.stop(); guard = null; }
  }

  run.currentAccountIdx = -1;
  run.running = false;
  run.done = true;
  const totalScheduled = run.accounts.reduce((s, a) => s + a.scheduled, 0);
  const totalFailed = run.accounts.reduce((s, a) => s + a.failed, 0);
  log(`═══════════════════════════════════════`);
  log(run.cancelled ? `⏹ Run cancelled.` : `✅ All accounts processed!`);
  log(`   ${totalScheduled} draft(s) scheduled, ${totalFailed} failed.`);
  log(`═══════════════════════════════════════`);
}

/**
 * Start a new automated run.
 *   accounts = [{ email, profileDir, draftCount }]
 *   opts.concurrency — how many Chrome instances at once (default 8)
 *   opts.hidden      — park windows off-screen (default true)
 */
function start(accounts, opts = {}) {
  if (run && run.running) {
    throw new Error('An automated scheduling run is already in progress');
  }
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error('No accounts provided');
  }

  const concurrency = Math.max(1, Math.min(
    Number(opts.concurrency) || DEFAULT_CONCURRENCY,
    accounts.length
  ));
  const hidden = opts.hidden !== false;

  run = newRun(accounts, { concurrency, hidden });
  activeContexts = new Map();

  executeRun().catch(err => {
    log(`❌ Fatal error: ${err.message}`);
    run.error = err.message;
    run.running = false;
    run.done = true;
    if (guard) { guard.stop(); guard = null; }
  });
  return getStatus();
}

function getStatus() {
  if (!run) return { running: false, done: false, logs: [], accounts: [], plan: [] };
  return run;
}

async function cancel() {
  if (!run || !run.running) return getStatus();
  run.cancelled = true;
  log('⏹ Cancel requested — closing all Chrome instances…');
  const ctxs = [...activeContexts.values()];
  activeContexts.clear();
  await Promise.all(ctxs.map(c => c.close().catch(() => {})));
  if (guard) { guard.stop(); guard = null; }
  return getStatus();
}

/** Kill any leftover chrome.exe processes launched from these profile dirs.
 *  Identified by --user-data-dir in the command line, same technique as
 *  window-guard.ps1, so the user's own Chrome is never touched. Belt-and-
 *  braces backstop for when context.close() hangs instead of exiting. */
function killChromeByProfileDirs(dirs) {
  if (process.platform !== 'win32' || !dirs || dirs.length === 0) return;
  const list = dirs.map(d => `'${String(d).replace(/'/g, "''")}'`).join(',');
  const script =
    `$dirs = @(${list}); ` +
    `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ForEach-Object { ` +
    `  $cl = $_.CommandLine; if (-not $cl) { return }; ` +
    `  foreach ($d in $dirs) { if ($cl.IndexOf($d, [StringComparison]::OrdinalIgnoreCase) -ge 0) { ` +
    `    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; break ` +
    `  } } }`;
  try {
    spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { stdio: 'ignore', windowsHide: true });
  } catch {}
}

/**
 * Hard reset: unconditionally clears the "a run is already in progress" state
 * so a new run can be started, even if the previous run is wedged (a Chrome
 * window not responding, context.close() hanging, etc). Unlike cancel(), this
 * never waits indefinitely — it gives the graceful shutdown a few seconds,
 * then force-kills any leftover Chrome processes and marks the run over
 * regardless of what Playwright reports.
 */
async function forceStop() {
  const activeRun = run;
  if (!activeRun) return getStatus();

  activeRun.cancelled = true;
  log('⛔ Force stop requested — closing everything and resetting run state…');

  const ctxs = [...activeContexts.values()];
  activeContexts.clear();
  await Promise.race([
    Promise.all(ctxs.map(c => c.close().catch(() => {}))),
    new Promise(resolve => setTimeout(resolve, 3000)),
  ]);

  if (guard) { guard.stop(); guard = null; }
  killChromeByProfileDirs((activeRun.accounts || []).map(a => a.profileDir));

  // Mark the existing run object done in place (rather than nulling `run`)
  // so the background executeRun() loop, if still unwinding, never derefs a
  // null run.
  activeRun.running = false;
  activeRun.done = true;
  log('⛔ Force-stopped — ready to start a new run.');
  return getStatus();
}

module.exports = { start, getStatus, cancel, forceStop };
