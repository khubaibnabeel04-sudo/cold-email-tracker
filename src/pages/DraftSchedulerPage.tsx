import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useStore } from '../store';
import { listDrafts, getDraftDetails } from '../services/gmail';
import {
  Send,
  Mail,
  Search,
  Clock,
  CheckCircle,
  XCircle,
  AlertCircle,
  Loader,
  FileText,
  User,
  RefreshCw,
  ExternalLink,
  ChevronRight,
  Globe,
  Zap,
} from 'lucide-react';

const API_BASE = 'http://localhost:3006';

// ─── TYPES ─────────────────────────────────────────────────────────────────

interface DraftItem {
  draftId: string;
  accountEmail: string;
  to: string;
  subject: string;
  status: 'pending' | 'sent' | 'skipped';
}

interface AccountDraftCount {
  email: string;
  total: number;
  valid: number;
  scanned: boolean;
}

type Phase = 'idle' | 'scanned' | 'scheduling' | 'auto' | 'done';

interface AutoAccountStatus {
  email: string;
  profileDir: string;
  expected: number;
  scheduled: number;
  failed: number;
  status: 'pending' | 'active' | 'done' | 'error' | 'skipped';
  /** This account's own send-time plan (each account restarts at 10 PM). */
  plan?: string[];
}

interface AutoRunStatus {
  running: boolean;
  cancelled: boolean;
  done: boolean;
  error: string | null;
  accounts: AutoAccountStatus[];
  /** Always -1 now that accounts run in parallel — kept for compatibility. */
  currentAccountIdx: number;
  plan: string[];
  logs: string[];
  /** How many Chrome instances are driven at once. */
  parallel?: number;
  /** Windows parked off-screen so minimizing can't throttle them. */
  hidden?: boolean;
}

// ─── COMPONENT ─────────────────────────────────────────────────────────────

export default function DraftSchedulerPage() {
  const { state, dispatch } = useStore();

  // ── State ─────────────────────────────────────────────────────────────
  const [drafts, setDrafts] = useState<DraftItem[]>([]);
  const [accountCounts, setAccountCounts] = useState<AccountDraftCount[]>([]);
  const [scanning, setScanning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [scheduling, setScheduling] = useState(false);
  const [managingRef, setManagingRef] = useState(false);

  // Manual workflow state
  const [accountsToProcess, setAccountsToProcess] = useState<string[]>([]);
  const [currentAccountIdx, setCurrentAccountIdx] = useState<number>(-1);
  const [completedAccounts, setCompletedAccounts] = useState<string[]>([]);
  const [browserOpen, setBrowserOpen] = useState(false);

  // Automated workflow state
  const [autoStatus, setAutoStatus] = useState<AutoRunStatus | null>(null);
  const autoPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoLogIdxRef = useRef(0);
  /** How many Chrome profiles to drive at once. Each one costs ~500-700 MB,
   *  so the default is deliberately below "all" — raise it if RAM allows. */
  const [concurrency, setConcurrency] = useState(4);
  /** Park Chrome off-screen (fast, invisible) vs. on-screen so you can watch. */
  const [watchWindows, setWatchWindows] = useState(false);

  const logRef = useRef<HTMLDivElement>(null);

  // Auto-scroll logs
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const addLog = useCallback((msg: string) => {
    setLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  }, []);

  // ── Draft mini report state ────────────────────────────────────────────
  const [draftAccountEmail, setDraftAccountEmail] = useState('');
  const [draftSubject, setDraftSubject] = useState('');
  const [draftHtml, setDraftHtml] = useState('');
  const [creatingDraft, setCreatingDraft] = useState(false);
  const [draftCreateResult, setDraftCreateResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (draftAccountEmail || state.accounts.length === 0) return;
    const preferred = state.accounts.find(a => a.email === process.env.REACT_APP_PREFERRED_SENDER);
    setDraftAccountEmail((preferred || state.accounts[0]).email);
  }, [state.accounts, draftAccountEmail]);

  const handleCreateMiniReportDraft = async () => {
    if (!draftAccountEmail || !draftSubject.trim() || !draftHtml.trim()) return;
    setCreatingDraft(true);
    setDraftCreateResult(null);
    try {
      const res = await fetch(`${API_BASE}/api/gmail/create-draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: draftAccountEmail, subject: draftSubject.trim(), html: draftHtml }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create draft');
      setDraftCreateResult({ ok: true, message: `Draft created in ${draftAccountEmail}` });
      setDraftSubject('');
      setDraftHtml('');
    } catch (err: any) {
      setDraftCreateResult({ ok: false, message: err.message || 'Failed to create draft' });
    } finally {
      setCreatingDraft(false);
    }
  };

  // ── SCAN: list drafts across all accounts ─────────────────────────────
  const handleScan = async () => {
    if (state.accounts.length === 0) {
      addLog('⚠ No accounts connected. Go to Accounts page first.');
      return;
    }

    setScanning(true);
    setPhase('scanned');
    setDrafts([]);
    setAccountCounts([]);
    setLogs([]);
    setScheduling(false);
    setManagingRef(false);
    setAccountsToProcess([]);
    setCurrentAccountIdx(-1);
    setCompletedAccounts([]);
    setBrowserOpen(false);
    addLog(`Scanning drafts across ${state.accounts.length} account(s)...`);

    const allDrafts: DraftItem[] = [];
    const counts: AccountDraftCount[] = [];

    for (const account of state.accounts) {
      addLog(`→ ${account.email}: listing drafts...`);
      try {
        const rawDrafts = await listDrafts(
          account,
          (updated) => dispatch({ type: 'UPDATE_ACCOUNT', payload: updated }),
          state.settings,
        );
        addLog(`  ${rawDrafts.length} draft(s) found. Checking recipients...`);

        let valid = 0;
        for (const raw of rawDrafts) {
          const details = await getDraftDetails(
            raw.id,
            account,
            (updated) => dispatch({ type: 'UPDATE_ACCOUNT', payload: updated }),
            state.settings,
          );
          if (details && details.to) {
            valid++;
            allDrafts.push({
              draftId: details.id,
              accountEmail: account.email,
              to: details.to,
              subject: details.subject,
              status: 'pending',
            });
          }
        }
        counts.push({ email: account.email, total: rawDrafts.length, valid, scanned: true });
        addLog(`  ✓ ${valid} valid (has recipient), ${rawDrafts.length - valid} skipped (no recipient).`);
      } catch (err: any) {
        addLog(`  ✗ Error scanning ${account.email}: ${err.message || err}`);
        counts.push({ email: account.email, total: 0, valid: 0, scanned: false });
      }
    }

    setDrafts(allDrafts);
    setAccountCounts(counts);
    setScanning(false);
    addLog(`\nScan complete: ${allDrafts.length} valid draft(s) across ${state.accounts.length} account(s).`);
    if (allDrafts.length === 0) {
      setPhase('idle');
    }
  };

  // ── MANUAL SCHEDULE WORKFLOW ──────────────────────────────────────────

  /** Get the list of accounts that have valid drafts */
  const getAccountsWithDrafts = useCallback(() => {
    return state.accounts
      .filter(a => drafts.some(d => d.accountEmail === a.email))
      .map(a => a.email);
  }, [state.accounts, drafts]);

  /** Start the manual schedule flow */
  const handleStartScheduling = async () => {
    const accounts = getAccountsWithDrafts();
    if (accounts.length === 0) return;

    setScheduling(true);
    setManagingRef(true);
    setPhase('scheduling');
    setAccountsToProcess(accounts);
    setCompletedAccounts([]);
    setCurrentAccountIdx(0);
    setBrowserOpen(false);

    addLog(`\n═══════════════════════════════════════`);
    addLog(`📋 Manual scheduling mode started`);
    addLog(`Accounts to process: ${accounts.length}`);
    addLog(`═══════════════════════════════════════\n`);

    // Auto-open the first account
    await openBrowserForAccount(accounts[0]);
  };

  /** Open Chrome for a specific account */
  const openBrowserForAccount = async (email: string) => {
    const profileDir = `D:\\chrome_yt_profiles\\${email.split('@')[0]}`;
    addLog(`\n🚀 Opening Chrome for: ${email}`);
    addLog(`   Profile: ${profileDir}`);

    try {
      const res = await fetch(`${API_BASE}/api/browser/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, profileDir }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error || `Server returned ${res.status}`);
      }

      setBrowserOpen(true);
      addLog(`   ✅ Chrome is now open at Gmail Drafts`);
      addLog(`   ✋ Schedule the drafts manually, then click "Done" below.`);
    } catch (err: any) {
      addLog(`   ❌ Failed to open Chrome: ${err.message}`);
      addLog(`   💡 Make sure the server is running on ${API_BASE}`);
    }
  };

  /** Mark the current account as done and move to the next one */
  const handleAccountDone = async () => {
    const currentEmail = accountsToProcess[currentAccountIdx];

    // Close the browser first
    addLog(`   Closing Chrome for ${currentEmail}...`);
    try {
      await fetch(`${API_BASE}/api/browser/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
    } catch {}
    setBrowserOpen(false);

    // Mark as completed
    setCompletedAccounts(prev => [...prev, currentEmail]);
    addLog(`   ✅ Done with: ${currentEmail}`);

    // Mark this account's drafts as 'sent'
    setDrafts(prev =>
      prev.map(d =>
        d.accountEmail === currentEmail && d.status === 'pending'
          ? { ...d, status: 'sent' }
          : d
      )
    );

    // Move to the next account
    const nextIdx = currentAccountIdx + 1;
    if (nextIdx < accountsToProcess.length) {
      setCurrentAccountIdx(nextIdx);
      addLog(`\n─── Next account (${nextIdx + 1}/${accountsToProcess.length}) ───`);
      await openBrowserForAccount(accountsToProcess[nextIdx]);
    } else {
      // All done
      setCurrentAccountIdx(-1);
      setScheduling(false);
      setPhase('done');
      addLog(`\n═══════════════════════════════════════`);
      addLog(`✅ All accounts processed!`);
      addLog(`   ${completedAccounts.length + 1} account(s) completed.`);
      addLog(`═══════════════════════════════════════`);
    }
  };

  /** Skip the current account without marking drafts as done */
  const handleSkipAccount = async () => {
    const currentEmail = accountsToProcess[currentAccountIdx];

    addLog(`   Closing Chrome for ${currentEmail}...`);
    try {
      await fetch(`${API_BASE}/api/browser/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
    } catch {}
    setBrowserOpen(false);

    setCompletedAccounts(prev => [...prev, currentEmail]);
    addLog(`   ⏭ Skipped: ${currentEmail}`);

    const nextIdx = currentAccountIdx + 1;
    if (nextIdx < accountsToProcess.length) {
      setCurrentAccountIdx(nextIdx);
      addLog(`\n─── Next account (${nextIdx + 1}/${accountsToProcess.length}) ───`);
      await openBrowserForAccount(accountsToProcess[nextIdx]);
    } else {
      setCurrentAccountIdx(-1);
      setScheduling(false);
      setPhase('done');
      addLog(`\n═══════════════════════════════════════`);
      addLog(`✅ All accounts processed!`);
      addLog(`═══════════════════════════════════════`);
    }
  };

  // ── AUTOMATED SCHEDULE WORKFLOW ───────────────────────────────────────

  const stopAutoPolling = useCallback(() => {
    if (autoPollRef.current) {
      clearInterval(autoPollRef.current);
      autoPollRef.current = null;
    }
  }, []);

  // Clean up the poll interval when leaving the page
  useEffect(() => stopAutoPolling, [stopAutoPolling]);

  /** Apply a server status update: append new logs + sync draft statuses */
  const applyAutoStatus = useCallback((status: AutoRunStatus) => {
    setAutoStatus(status);

    // Append only the log lines we haven't shown yet
    const newLines = status.logs.slice(autoLogIdxRef.current);
    autoLogIdxRef.current = status.logs.length;
    if (newLines.length > 0) {
      setLogs(prev => [...prev, ...newLines]);
    }

    // Mark the first N pending drafts of each account as scheduled
    setDrafts(prev => {
      let changed = false;
      const next = [...prev];
      for (const acc of status.accounts) {
        let remaining = acc.scheduled;
        for (let i = 0; i < next.length && remaining > 0; i++) {
          if (next[i].accountEmail === acc.email) {
            remaining--;
            if (next[i].status !== 'sent') {
              next[i] = { ...next[i], status: 'sent' };
              changed = true;
            }
          }
        }
      }
      return changed ? next : prev;
    });

    if (status.done) {
      stopAutoPolling();
      setScheduling(false);
      setPhase('done');
    }
  }, [stopAutoPolling]);

  /** Start the fully automated schedule-send flow */
  const handleAutomateSending = async () => {
    const accounts = state.accounts
      .filter(a => drafts.some(d => d.accountEmail === a.email && d.status === 'pending'))
      .map(a => ({
        email: a.email,
        profileDir: `D:\\chrome_yt_profiles\\${a.email.split('@')[0]}`,
        draftCount: drafts.filter(d => d.accountEmail === a.email && d.status === 'pending').length,
      }));
    if (accounts.length === 0) return;

    setScheduling(true);
    setPhase('auto');
    setAutoStatus(null);
    autoLogIdxRef.current = 0;

    // Never ask for more lanes than there are accounts.
    const lanes = Math.max(1, Math.min(concurrency, accounts.length));

    addLog(
      `\n🤖 Starting automated scheduling — ${accounts.length} account(s), ` +
      `${lanes} at a time${watchWindows ? ' (windows visible)' : ''}...`
    );

    try {
      const res = await fetch(`${API_BASE}/api/auto-schedule/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accounts,
          concurrency: lanes,
          // Off-screen by default: minimizing (or Win+D) can never throttle a
          // window that was never on screen to begin with.
          hidden: !watchWindows,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `Server returned ${res.status}` }));
        throw new Error(err.error || `Server returned ${res.status}`);
      }
      const status: AutoRunStatus = await res.json();
      applyAutoStatus(status);

      // Poll the server for progress every 2 seconds
      stopAutoPolling();
      autoPollRef.current = setInterval(async () => {
        try {
          const r = await fetch(`${API_BASE}/api/auto-schedule/status`);
          if (r.ok) applyAutoStatus(await r.json());
        } catch { /* server briefly unreachable — keep polling */ }
      }, 2000);
    } catch (err: any) {
      addLog(`❌ Failed to start automation: ${err.message}`);
      addLog(`💡 Make sure the server is running on ${API_BASE}`);
      setScheduling(false);
      setPhase('scanned');
    }
  };

  /** Cancel the automated run */
  const handleCancelAuto = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/auto-schedule/cancel`, { method: 'POST' });
      if (res.ok) applyAutoStatus(await res.json());
    } catch {}
    addLog('⏹ Cancelling automation...');
  };

  /** Hard-reset a stuck run on the server, even if this tab never saw it
   *  start (e.g. after a refresh). Always available, regardless of `phase`,
   *  since the whole point is that local state doesn't know the server
   *  thinks a run is still active. */
  const [forceStopping, setForceStopping] = useState(false);
  const handleForceStop = async () => {
    setForceStopping(true);
    addLog('⛔ Force-stopping any running automation...');
    try {
      const res = await fetch(`${API_BASE}/api/auto-schedule/force-stop`, { method: 'POST' });
      const status: AutoRunStatus = await res.json();
      if (!res.ok) throw new Error((status as any)?.error || `Server returned ${res.status}`);
      applyAutoStatus(status);
      addLog('✅ Server run state cleared — you can start a new automation now.');
    } catch (err: any) {
      addLog(`❌ Force stop failed: ${err.message}`);
    } finally {
      stopAutoPolling();
      setScheduling(false);
      setForceStopping(false);
      if (phase === 'auto') setPhase('scanned');
    }
  };

  const handleReset = () => {
    // Close any open browser first
    if (browserOpen) {
      fetch(`${API_BASE}/api/browser/close`, { method: 'POST' }).catch(() => {});
    }
    stopAutoPolling();
    setAutoStatus(null);
    autoLogIdxRef.current = 0;
    setDrafts([]);
    setAccountCounts([]);
    setLogs([]);
    setPhase('idle');
    setScheduling(false);
    setManagingRef(false);
    setAccountsToProcess([]);
    setCurrentAccountIdx(-1);
    setCompletedAccounts([]);
    setBrowserOpen(false);
  };

  const handleCancelScheduling = async () => {
    if (browserOpen) {
      try {
        await fetch(`${API_BASE}/api/browser/close`, { method: 'POST' });
      } catch {}
      setBrowserOpen(false);
    }
    setScheduling(false);
    setManagingRef(false);
    setAccountsToProcess([]);
    setCurrentAccountIdx(-1);
    setCompletedAccounts([]);
    addLog('⏸ Scheduling cancelled.');
    setPhase('scanned');
  };

  // ── Derived stats ────────────────────────────────────────────────────
  const totalValid = accountCounts.reduce((sum, c) => sum + c.valid, 0);
  const totalDrafts = accountCounts.reduce((sum, c) => sum + c.total, 0);
  const sentCount = drafts.filter(d => d.status === 'sent').length;

  return (
    <div>
      {/* HEADER */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 4 }}>
          <span style={{ marginRight: 8 }}>📬</span>
          Draft Scheduler
        </h1>
        <p style={{ color: 'var(--text-secondary)' }}>
          Scan all connected Gmail accounts for drafts, then schedule them manually —
          one account at a time.
        </p>
      </div>

      {/* DRAFT MINI REPORT */}
      <div style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: 20,
        marginBottom: 24,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <FileText size={18} />
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Draft Mini Report</h2>
        </div>
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>
          Paste HTML with inline CSS and create a Gmail draft — mirrors the n8n Gmail "Create a draft" node.
        </p>

        <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: '0 1 260px', minWidth: 200 }}>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
              Account
            </label>
            <select
              value={draftAccountEmail}
              onChange={e => setDraftAccountEmail(e.target.value)}
              disabled={creatingDraft || state.accounts.length === 0}
              style={{
                width: '100%', padding: '8px 12px', boxSizing: 'border-box',
                borderRadius: 6, border: '1px solid var(--border)', fontSize: 14,
                background: 'var(--bg-page)', color: 'var(--text-primary)',
              }}
            >
              {state.accounts.length === 0 && <option value="">No accounts connected</option>}
              {state.accounts.map(a => (
                <option key={a.email} value={a.email}>{a.email}</option>
              ))}
            </select>
          </div>

          <div style={{ flex: '1 1 320px', minWidth: 220 }}>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
              Subject
            </label>
            <input
              type="text"
              value={draftSubject}
              onChange={e => setDraftSubject(e.target.value)}
              placeholder="Subject line..."
              disabled={creatingDraft}
              style={{
                width: '100%', padding: '8px 12px', boxSizing: 'border-box',
                borderRadius: 6, border: '1px solid var(--border)', fontSize: 14,
              }}
            />
          </div>
        </div>

        <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
          HTML body (inline CSS)
        </label>
        <textarea
          value={draftHtml}
          onChange={e => setDraftHtml(e.target.value)}
          placeholder="<div style=&quot;font-family: sans-serif;&quot;>...</div>"
          disabled={creatingDraft}
          rows={10}
          style={{
            width: '100%', padding: 12, boxSizing: 'border-box',
            borderRadius: 6, border: '1px solid var(--border)', fontSize: 13,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            resize: 'vertical', marginBottom: 12,
            background: 'var(--bg-page)', color: 'var(--text-primary)',
          }}
        />

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={handleCreateMiniReportDraft}
            disabled={creatingDraft || !draftAccountEmail || !draftSubject.trim() || !draftHtml.trim()}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '10px 20px',
              background: (creatingDraft || !draftAccountEmail || !draftSubject.trim() || !draftHtml.trim())
                ? 'var(--text-muted)' : 'var(--accent)',
              color: 'var(--text-inverse)', border: 'none', borderRadius: 8,
              cursor: (creatingDraft || !draftAccountEmail || !draftSubject.trim() || !draftHtml.trim())
                ? 'not-allowed' : 'pointer',
              fontWeight: 600, fontSize: 14,
            }}
          >
            {creatingDraft ? <Loader size={16} style={{ animation: 'spin 1s linear infinite' }} /> : <Send size={16} />}
            {creatingDraft ? 'Creating draft...' : 'Create Draft'}
          </button>

          {draftCreateResult && (
            <span style={{
              display: 'flex', alignItems: 'center', gap: 6, fontSize: 13,
              color: draftCreateResult.ok ? 'var(--green-text, #16a34a)' : 'var(--red-text, #dc2626)',
            }}>
              {draftCreateResult.ok ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
              {draftCreateResult.message}
            </span>
          )}
        </div>
      </div>

      {/* SCAN / ACTION BUTTONS ROW */}
      <div style={{
        display: 'flex',
        gap: 12,
        marginBottom: 20,
        flexWrap: 'wrap',
        alignItems: 'center',
      }}>
        {phase === 'idle' || phase === 'done' ? (
          <button
            onClick={handleScan}
            disabled={scanning || state.accounts.length === 0}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 20px',
              background: scanning || state.accounts.length === 0 ? 'var(--text-muted)' : 'var(--accent)',
              color: 'var(--text-inverse)',
              border: 'none',
              borderRadius: 8,
              cursor: scanning || state.accounts.length === 0 ? 'not-allowed' : 'pointer',
              fontWeight: 600,
              fontSize: 14,
            }}
          >
            <Search size={18} />
            Scan Drafts
          </button>
        ) : null}

        {phase === 'scanned' && !scheduling && getAccountsWithDrafts().length > 0 ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '6px 12px',
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border)',
              borderRadius: 8,
            }}
          >
            <label
              htmlFor="auto-concurrency"
              style={{ fontSize: 13, color: 'var(--text-secondary)', fontWeight: 600 }}
            >
              Run at once
            </label>
            <select
              id="auto-concurrency"
              value={Math.min(concurrency, getAccountsWithDrafts().length)}
              onChange={e => setConcurrency(Number(e.target.value))}
              style={{
                padding: '5px 8px',
                borderRadius: 6,
                border: '1px solid var(--border)',
                background: 'var(--bg-primary)',
                color: 'var(--text-primary)',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {Array.from({ length: getAccountsWithDrafts().length }, (_, i) => i + 1).map(n => (
                <option key={n} value={n}>
                  {n === getAccountsWithDrafts().length
                    ? `all ${n} profiles`
                    : `${n} profile${n > 1 ? 's' : ''}`}
                </option>
              ))}
            </select>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 12,
                color: 'var(--text-secondary)',
                cursor: 'pointer',
              }}
              title="Show the Chrome windows on screen instead of parking them off-screen. Useful for watching the first run; they stay full speed either way."
            >
              <input
                type="checkbox"
                checked={watchWindows}
                onChange={e => setWatchWindows(e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              Watch windows
            </label>
          </div>
        ) : null}

        {phase === 'scanned' && !scheduling ? (
          <button
            onClick={handleAutomateSending}
            disabled={drafts.length === 0}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 20px',
              background: drafts.length === 0 ? 'var(--text-muted)' : '#7c3aed',
              color: 'var(--text-inverse)',
              border: 'none',
              borderRadius: 8,
              cursor: drafts.length === 0 ? 'not-allowed' : 'pointer',
              fontWeight: 600,
              fontSize: 14,
            }}
          >
            <Zap size={18} />
            Automate Sending ({drafts.length})
          </button>
        ) : null}

        {phase === 'scanned' && !scheduling ? (
          <button
            onClick={handleStartScheduling}
            disabled={drafts.length === 0}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 20px',
              background: drafts.length === 0 ? 'var(--text-muted)' : '#16a34a',
              color: 'var(--text-inverse)',
              border: 'none',
              borderRadius: 8,
              cursor: drafts.length === 0 ? 'not-allowed' : 'pointer',
              fontWeight: 600,
              fontSize: 14,
            }}
          >
            <Globe size={18} />
            Schedule &amp; Send All ({drafts.length})
          </button>
        ) : null}

        {phase === 'auto' && autoStatus?.running ? (
          <button
            onClick={handleCancelAuto}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 20px',
              background: '#dc2626',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: 14,
            }}
          >
            <XCircle size={18} />
            Cancel Automation
          </button>
        ) : null}

        <button
          onClick={handleForceStop}
          disabled={forceStopping}
          title="Use this if 'Automate Sending' says a run is already in progress but you don't see a Cancel button — hard-resets the server's run state so you can start a new one."
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '10px 16px',
            background: 'transparent',
            color: '#dc2626',
            border: '1px solid #dc2626',
            borderRadius: 8,
            cursor: forceStopping ? 'not-allowed' : 'pointer',
            fontWeight: 600,
            fontSize: 13,
            opacity: forceStopping ? 0.6 : 1,
          }}
        >
          <XCircle size={16} />
          {forceStopping ? 'Force stopping...' : 'Force Stop Stuck Automation'}
        </button>

        {phase === 'scheduling' ? (
          <button
            onClick={handleCancelScheduling}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 20px',
              background: '#dc2626',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: 14,
            }}
          >
            <XCircle size={18} />
            Cancel
          </button>
        ) : null}

        {phase === 'done' ? (
          <button
            onClick={handleReset}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 20px',
              background: 'var(--bg-card)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: 14,
            }}
          >
            <RefreshCw size={18} />
            Start Fresh
          </button>
        ) : null}
      </div>

      {/* ACCOUNT SUMMARY CARDS */}
      {accountCounts.length > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
          gap: 12,
          marginBottom: 20,
        }}>
          {accountCounts.map(acc => {
            const isCompleted = completedAccounts.includes(acc.email);
            const isCurrent = accountsToProcess[currentAccountIdx] === acc.email;
            const isPending = phase === 'scheduling' && !isCompleted && !isCurrent;

            return (
              <div
                key={acc.email}
                style={{
                  padding: 14,
                  background: isCurrent
                    ? 'rgba(37,99,235,0.08)'
                    : isCompleted
                      ? 'rgba(22,163,74,0.06)'
                      : 'var(--bg-card)',
                  border: `1px solid ${
                    isCurrent ? 'var(--border-focus)' : isCompleted ? 'rgba(22,163,74,0.3)' : 'var(--border)'
                  }`,
                  borderRadius: 8,
                  position: 'relative',
                }}
              >
                {isCurrent && (
                  <div style={{
                    position: 'absolute',
                    top: -6,
                    right: 8,
                    background: 'var(--accent)',
                    color: 'var(--text-inverse)',
                    fontSize: 10,
                    fontWeight: 700,
                    padding: '2px 8px',
                    borderRadius: 10,
                  }}>
                    ACTIVE
                  </div>
                )}
                {isCompleted && (
                  <div style={{
                    position: 'absolute',
                    top: -6,
                    right: 8,
                    background: '#16a34a',
                    color: '#fff',
                    fontSize: 10,
                    fontWeight: 700,
                    padding: '2px 8px',
                    borderRadius: 10,
                  }}>
                    ✓ DONE
                  </div>
                )}
                <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)', marginBottom: 4 }}>
                  <Mail size={14} style={{ marginRight: 6, verticalAlign: 'middle' }} />
                  {acc.email}
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                  {acc.scanned ? (
                    <>
                      <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{acc.valid}</span>
                      {' '}valid / {acc.total} total
                    </>
                  ) : (
                    <span style={{ color: '#dc2626' }}>Scan failed</span>
                  )}
                </div>
              </div>
            );
          })}
          <div
            style={{
              padding: 14,
              background: 'var(--accent-light)',
              border: '1px solid var(--border-focus)',
              borderRadius: 8,
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--accent-text)', marginBottom: 4 }}>
              Totals
            </div>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--accent)' }}>
              {totalValid} valid / {totalDrafts} total drafts
            </div>
            {sentCount > 0 && (
              <div style={{ fontSize: 12, color: '#16a34a', marginTop: 4 }}>
                ✅ {sentCount} scheduled
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── MANUAL WORKFLOW PANEL ─────────────────────────────────────── */}
      {phase === 'scheduling' && (
        <div style={{
          background: 'var(--bg-card)',
          border: '2px solid var(--accent)',
          borderRadius: 12,
          padding: 20,
          marginBottom: 20,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <Globe size={22} style={{ color: 'var(--accent)' }} />
            <div>
              <div style={{ fontWeight: 700, fontSize: 16 }}>
                Manual Scheduling — Step {currentAccountIdx + 1} of {accountsToProcess.length}
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                Current: <strong>{accountsToProcess[currentAccountIdx]}</strong>
              </div>
            </div>
          </div>

          {/* Progress bar */}
          <div style={{ marginBottom: 16 }}>
            <div style={{
              display: 'flex',
              gap: 6,
              alignItems: 'center',
            }}>
              {accountsToProcess.map((email, idx) => {
                const isDone = completedAccounts.includes(email) || idx < currentAccountIdx;
                const isActive = idx === currentAccountIdx;
                const isPending = idx > currentAccountIdx;
                return (
                  <div key={email} style={{
                    flex: 1,
                    height: 6,
                    borderRadius: 3,
                    background: isDone
                      ? '#16a34a'
                      : isActive
                        ? 'var(--accent)'
                        : 'var(--bg-muted)',
                    transition: 'background 0.3s ease',
                  }} />
                );
              })}
            </div>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 11,
              color: 'var(--text-muted)',
              marginTop: 4,
            }}>
              <span>{completedAccounts.length} done</span>
              <span>{accountsToProcess.length - completedAccounts.length - 1} remaining</span>
            </div>
          </div>

          {/* Status indicator */}
          <div style={{
            padding: 12,
            background: browserOpen ? 'rgba(22,163,74,0.08)' : 'rgba(234,179,8,0.08)',
            borderRadius: 8,
            marginBottom: 16,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}>
            {browserOpen ? (
              <>
                <ExternalLink size={18} style={{ color: '#16a34a' }} />
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13, color: '#16a34a' }}>
                    Chrome is open — Gmail Drafts
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    Schedule the drafts manually in the Chrome window that opened.
                    Once done, click the button below.
                  </div>
                </div>
              </>
            ) : (
              <>
                <Loader size={18} style={{ color: '#eab308', animation: 'spin 1s linear infinite' }} />
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13, color: '#eab308' }}>
                    Opening Chrome...
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    A Chrome window should appear shortly with Gmail Drafts open.
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              onClick={handleAccountDone}
              disabled={!browserOpen}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '12px 24px',
                background: browserOpen ? '#16a34a' : 'var(--text-muted)',
                color: '#fff',
                border: 'none',
                borderRadius: 8,
                cursor: browserOpen ? 'pointer' : 'not-allowed',
                fontWeight: 600,
                fontSize: 14,
                flex: 1,
                justifyContent: 'center',
              }}
            >
              <CheckCircle size={20} />
              {currentAccountIdx < accountsToProcess.length - 1
                ? `Done — Next Account (${accountsToProcess[currentAccountIdx + 1]?.split('@')[0]})`
                : 'Done — All Accounts Complete'}
            </button>
            <button
              onClick={handleSkipAccount}
              disabled={!browserOpen}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '12px 16px',
                background: 'transparent',
                color: 'var(--text-secondary)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                cursor: browserOpen ? 'pointer' : 'not-allowed',
                fontWeight: 500,
                fontSize: 13,
              }}
            >
              <XCircle size={16} />
              Skip
            </button>
          </div>

          {/* Drafts for current account */}
          {currentAccountIdx >= 0 && currentAccountIdx < accountsToProcess.length && (
            <div style={{ marginTop: 16, fontSize: 13, color: 'var(--text-secondary)' }}>
              Drafts for <strong>{accountsToProcess[currentAccountIdx]}</strong>:
              {' '}{drafts.filter(d => d.accountEmail === accountsToProcess[currentAccountIdx]).length} draft(s)
            </div>
          )}
        </div>
      )}

      {/* ── AUTOMATED WORKFLOW PANEL ──────────────────────────────────── */}
      {phase === 'auto' && autoStatus && (
        <div style={{
          background: 'var(--bg-card)',
          border: '2px solid #7c3aed',
          borderRadius: 12,
          padding: 20,
          marginBottom: 20,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <Zap size={22} style={{ color: '#7c3aed' }} />
            <div>
              <div style={{ fontWeight: 700, fontSize: 16 }}>
                Automated Scheduling
                {(() => {
                  const active = autoStatus.accounts.filter(a => a.status === 'active').length;
                  const finished = autoStatus.accounts.filter(a => a.status === 'done' || a.status === 'error').length;
                  return autoStatus.running
                    ? ` — ${active} running in parallel, ${finished}/${autoStatus.accounts.length} finished`
                    : '';
                })()}
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                {autoStatus.running ? (
                  autoStatus.hidden !== false ? (
                    <>All accounts are being scheduled <strong>at the same time</strong>. The Chrome
                    windows are parked off-screen on purpose — they run at full speed there and
                    can't be slowed down by being minimized. Keep using your laptop normally.</>
                  ) : (
                    <>All accounts are being scheduled <strong>at the same time</strong> — Chrome is
                    being driven automatically, don't touch those windows.</>
                  )
                ) : autoStatus.done ? (
                  'Run finished.'
                ) : (
                  'Starting up...'
                )}
              </div>
            </div>
          </div>

          {/* Per-account progress */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {autoStatus.accounts.map(acc => {
              const color =
                acc.status === 'done' ? '#16a34a'
                : acc.status === 'active' ? '#7c3aed'
                : acc.status === 'error' ? '#dc2626'
                : 'var(--text-muted)';
              return (
                <div key={acc.email} style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 12px',
                  background: acc.status === 'active' ? 'rgba(124,58,237,0.08)' : 'var(--bg-muted)',
                  borderRadius: 8,
                  fontSize: 13,
                }}>
                  {acc.status === 'active'
                    ? <Loader size={15} style={{ color, animation: 'spin 1s linear infinite', flexShrink: 0 }} />
                    : acc.status === 'done'
                      ? <CheckCircle size={15} style={{ color, flexShrink: 0 }} />
                      : acc.status === 'error'
                        ? <XCircle size={15} style={{ color, flexShrink: 0 }} />
                        : <Clock size={15} style={{ color, flexShrink: 0 }} />}
                  <span style={{ fontWeight: 600, flex: 1 }}>{acc.email}</span>
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {acc.scheduled}/{acc.expected} scheduled
                    {acc.failed > 0 && <span style={{ color: '#dc2626' }}> · {acc.failed} failed</span>}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Send-time plan — one per account, since every account restarts at 10 PM */}
          {autoStatus.accounts.some(a => (a.plan?.length ?? 0) > 0) && (
            <div style={{ marginTop: 14, fontSize: 12, color: 'var(--text-secondary)' }}>
              <strong>Send-time plans (each account restarts at 10 PM):</strong>
              {autoStatus.accounts.filter(a => (a.plan?.length ?? 0) > 0).map(a => (
                <div key={a.email} style={{ marginTop: 6 }}>
                  <span style={{ fontWeight: 600 }}>{a.email.split('@')[0]}</span>{': '}
                  {a.plan!.slice(0, 12).map(iso =>
                    new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
                  ).join('  →  ')}
                  {a.plan!.length > 12 && `  →  … (${a.plan!.length - 12} more)`}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* DRAFTS TABLE */}
      {drafts.length > 0 && phase !== 'scheduling' && (
        <div style={{
          overflow: 'auto',
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          marginBottom: 20,
        }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, textAlign: 'left' }}>
            <thead>
              <tr style={{ background: 'var(--bg-muted)', borderBottom: '2px solid var(--border)' }}>
                <th style={{ padding: '12px 14px', fontWeight: 600, color: 'var(--text-primary)' }}>Account</th>
                <th style={{ padding: '12px 14px', fontWeight: 600, color: 'var(--text-primary)' }}>To</th>
                <th style={{ padding: '12px 14px', fontWeight: 600, color: 'var(--text-primary)' }}>Subject</th>
                <th style={{ padding: '12px 14px', fontWeight: 600, color: 'var(--text-primary)' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {drafts.map((d, idx) => (
                <tr
                  key={d.draftId + d.accountEmail}
                  style={{
                    borderBottom: '1px solid var(--border-light)',
                    background:
                      d.status === 'sent' ? 'rgba(22,163,74,0.04)' : 'transparent',
                  }}
                >
                  <td style={{ padding: '10px 14px', color: 'var(--text-secondary)', fontWeight: 500 }}>
                    <Mail size={13} style={{ marginRight: 6, verticalAlign: 'middle', opacity: 0.6 }} />
                    {d.accountEmail.split('@')[0]}
                  </td>
                  <td style={{ padding: '10px 14px', color: 'var(--text-primary)', fontWeight: 500 }}>
                    <User size={13} style={{ marginRight: 6, verticalAlign: 'middle', opacity: 0.6 }} />
                    {d.to}
                  </td>
                  <td style={{ padding: '10px 14px', color: 'var(--text-secondary)', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <FileText size={13} style={{ marginRight: 6, verticalAlign: 'middle', opacity: 0.6 }} />
                    {d.subject}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    <StatusBadge status={d.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* LOG CONSOLE */}
      {logs.length > 0 && (
        <div
          ref={logRef}
          style={{
            background: '#1e1e2e',
            color: '#cdd6f4',
            borderRadius: 8,
            padding: 16,
            fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
            fontSize: 12,
            lineHeight: 1.7,
            maxHeight: 300,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {logs.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
          {(scanning || scheduling) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <Loader size={14} style={{ animation: 'spin 1s linear infinite' }} />
              <span style={{ color: '#89b4fa' }}>
                {scanning
                  ? 'Scanning...'
                  : phase === 'auto'
                    ? 'Automation running...'
                    : scheduling && !browserOpen ? 'Opening Chrome...' : ''}
              </span>
            </div>
          )}
        </div>
      )}

      {/* EMPTY STATE */}
      {phase === 'idle' && logs.length === 0 && (
        <div style={{
          padding: 40,
          background: 'var(--bg-muted)',
          borderRadius: 8,
          textAlign: 'center',
          border: '1px dashed var(--border)',
        }}>
          <Send size={48} style={{ color: 'var(--text-muted)', marginBottom: 16 }} />
          <h3 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>Ready to send your drafts</h3>
          <p style={{ color: 'var(--text-secondary)', marginBottom: 16, maxWidth: 480, margin: '0 auto 16px' }}>
            Click <strong>"Scan Drafts"</strong> to search all connected Gmail accounts for draft emails.
            Then click <strong>"Automate Sending"</strong> to schedule-send everything automatically
            (10 PM tonight → 7 AM, random 30-60 min gaps), or <strong>"Schedule &amp; Send All"</strong> to
            open Chrome one account at a time and schedule them manually.
          </p>
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            {state.accounts.length === 0 ? (
              <span>⚠ No accounts connected — go to <strong>Accounts</strong> page first.</span>
            ) : (
              <span>{state.accounts.length} account(s) available</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── STATUS BADGE ──────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: DraftItem['status'] }) {
  const config: Record<string, { label: string; bg: string; color: string; icon: React.ReactNode }> = {
    pending: {
      label: 'Pending',
      bg: 'var(--bg-hover)',
      color: 'var(--text-secondary)',
      icon: <Clock size={13} />,
    },
    sent: {
      label: 'Scheduled ✓',
      bg: 'rgba(22,163,74,0.12)',
      color: '#16a34a',
      icon: <CheckCircle size={13} />,
    },
    skipped: {
      label: 'Skipped',
      bg: 'var(--bg-hover)',
      color: 'var(--text-muted)',
      icon: <XCircle size={13} />,
    },
  };

  const c = config[status];
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding: '3px 8px',
      borderRadius: 12,
      fontSize: 11,
      fontWeight: 600,
      background: c.bg,
      color: c.color,
    }}>
      {c.icon}
      {c.label}
    </span>
  );
}
