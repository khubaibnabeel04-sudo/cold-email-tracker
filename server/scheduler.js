/**
 * Gmail Draft Scheduler — Manual mode
 *
 * Instead of auto-scheduling via Playwright, this simply:
 *   1. Opens Chrome with the saved profile and navigates to Gmail Drafts
 *   2. Lets the user MANUALLY schedule each draft
 *   3. Closes Chrome when the user clicks "Done"
 *
 * Works with the DraftSchedulerPage frontend flow:
 *   Scan → Show drafts → Open browser (profile by profile) → User schedules → Next
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

// ── Active browser context (only one at a time) ──────────────────────────
let activeContext = null;

/**
 * Open Chrome with a saved profile at Gmail Drafts.
 * Closes any previously opened browser first.
 */
async function openBrowser({ email, profileDir }) {
  // Close any previously open browser
  if (activeContext) {
    try { await activeContext.close(); } catch {}
    activeContext = null;
  }

  // Verify the profile directory exists
  if (!fs.existsSync(profileDir)) {
    throw new Error(`Profile directory not found: ${profileDir}`);
  }

  // Launch Chrome with the saved profile
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 800 },
  });

  const page = await ctx.newPage();

  // Navigate directly to Gmail Drafts
  await page.goto('https://mail.google.com/mail/u/0/#drafts', {
    waitUntil: 'domcontentloaded',
  });

  activeContext = ctx;
  return true;
}

/**
 * Close the currently open Chrome browser.
 */
async function closeBrowser() {
  if (activeContext) {
    try { await activeContext.close(); } catch {}
    activeContext = null;
  }
  return true;
}

module.exports = { openBrowser, closeBrowser };
