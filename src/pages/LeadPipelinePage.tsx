import React, { useState, useEffect, useCallback } from 'react';
import { useStore } from '../store';
import {
  getSheetSummary,
  getAcceptedNeedsEmail,
  getReasonedNewLeads,
  getReasonedOldLeads,
  moveAcceptedToReasoning,
  moveNoReplyToReasoning,
  transferToApp,
  refreshSheets,
  startReasoning,
  SheetSummary,
  AcceptedItem,
  ReasonedLead,
} from '../services/sheets';
import {
  RefreshCw,
  Send,
  Database,
  CheckCircle,
  ArrowRight,
  List,
} from 'lucide-react';

export default function LeadPipelinePage() {
  const { state, dispatch } = useStore();

  // ─── State ─────────────────────────────────────────────────────────────
  const [summary, setSummary] = useState<SheetSummary | null>(null);
  const [acceptedNew, setAcceptedNew] = useState<AcceptedItem[]>([]);
  const [reasonedNew, setReasonedNew] = useState<AcceptedItem[]>([]);
  const [reasonedOld, setReasonedOld] = useState<AcceptedItem[]>([]);
  const [pendingReasoningNew, setPendingReasoningNew] = useState(0);
  const [pendingReasoningOld, setPendingReasoningOld] = useState(0);

  // Loading states
  const [loading, setLoading] = useState(false);
  const [movingToReason, setMovingToReason] = useState(false);
  const [movingNoReply, setMovingNoReply] = useState(false);
  const [transferringNew, setTransferringNew] = useState(false);
  const [transferringOld, setTransferringOld] = useState(false);

  // Logs / messages
  const [log, setLog] = useState<string[]>([]);

  // Reasoning state
  const [reasoningNewActive, setReasoningNewActive] = useState(false);
  const [reasoningOldActive, setReasoningOldActive] = useState(false);
  const [reasoningLogs, setReasoningLogs] = useState<string[]>([]);
  const [showReasoningLog, setShowReasoningLog] = useState(false);

  const addLog = useCallback((msg: string) => {
    setLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  }, []);

  // ─── Load data ─────────────────────────────────────────────────────────
  async function loadAll() {
    setLoading(true);
    addLog('Loading Google Sheet data...');
    try {
      const [summ, accepted, rNew, rOld] = await Promise.all([
        getSheetSummary(),
        getAcceptedNeedsEmail().catch(() => ({ rows: [] as AcceptedItem[], headers: [], totalRows: 0 })),
        getReasonedNewLeads().catch(() => ({ rows: [] as AcceptedItem[], headers: [], totalRows: 0, pendingRows: 0 })),
        getReasonedOldLeads().catch(() => ({ rows: [] as AcceptedItem[], headers: [], totalRows: 0, pendingRows: 0 })),
      ]);
      setSummary(summ);
      setAcceptedNew(accepted.rows);
      setReasonedNew(rNew.rows);
      setReasonedOld(rOld.rows);
      setPendingReasoningNew(rNew.pendingRows);
      setPendingReasoningOld(rOld.pendingRows);
      addLog(`Loaded: ${accepted.rows.length} accepted, ${rNew.rows.length} new reasoned, ${rOld.rows.length} old reasoned`);
    } catch (err) {
      addLog(`ERROR loading: ${err}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
    // Auto-refresh every 5 minutes (frontend polls while open)
    const interval = setInterval(loadAll, 5 * 60 * 1000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Actions ───────────────────────────────────────────────────────────
  async function handleMoveToReasoning() {
    setMovingToReason(true);
    addLog('Moving accepted Needs Email leads to reasoning...');
    try {
      const result = await moveAcceptedToReasoning();
      addLog(`Moved ${result.moved} leads to new_leads_reason`);
      await loadAll();
    } catch (err) {
      addLog(`ERROR: ${err}`);
    } finally {
      setMovingToReason(false);
    }
  }

  async function handleMoveNoReply() {
    setMovingNoReply(true);
    addLog('Moving 50 leads from No Reply to reasoning...');
    try {
      const result = await moveNoReplyToReasoning(50);
      addLog(`Moved ${result.moved} leads to old_leads_reason`);
      await loadAll();
    } catch (err) {
      addLog(`ERROR: ${err}`);
    } finally {
      setMovingNoReply(false);
    }
  }

  async function handleTransferNew() {
    setTransferringNew(true);
    addLog(`Transferring ${reasonedNew.length} reasoned new leads to app...`);

    // Build ReasonedLead objects from the sheet rows
    const leads: ReasonedLead[] = reasonedNew.map(item => {
      const getVal = (name: string) => {
        const idx = item.headers.findIndex(
          h => h && h.toString().toLowerCase() === name.toLowerCase()
        );
        return idx >= 0 && idx < item.data.length ? String(item.data[idx] || '') : '';
      };

      return {
        rowIndex: item.rowIndex,
        email: getVal('channel_email'),
        name: getVal('channel_name') || getVal('channel_email'),
        page: 'new' as 'new',
        status: 'new',
        customData: {
          // CamelCase names (for app UI)
          channelName: getVal('channel_name'),
          channelId: getVal('channelId'),
          channelUrl: getVal('channelurl'),
          videoTitle: getVal('videotitle'),
          // Raw header names from reason sheet (for template substitutions)
          channel_email: getVal('channel_email'),
          channel_name: getVal('channel_name'),
          channelurl: getVal('channelurl'),
          videotitle: getVal('videotitle'),
        },
        createdAt: new Date().toISOString(),
      };
    }).filter(l => l.email); // Only leads with an email

    if (leads.length === 0) {
      addLog('No valid leads to transfer (missing email)');
      setTransferringNew(false);
      return;
    }

    // Deduplicate against existing leads in the app (new, old, and stale all count)
    const existingEmails = new Set([
      ...state.newLeads.map(l => l.email.trim().toLowerCase()),
      ...state.oldLeads.map(l => l.email.trim().toLowerCase()),
      ...state.staleLeads.map(l => l.email.trim().toLowerCase()),
    ]);
    const seenInBatch = new Set<string>();
    const uniqueLeads = leads.filter(l => {
      const key = l.email.trim().toLowerCase();
      if (existingEmails.has(key) || seenInBatch.has(key)) return false;
      seenInBatch.add(key);
      return true;
    });
    const skipped = leads.length - uniqueLeads.length;

    if (uniqueLeads.length === 0) {
      addLog(`All ${leads.length} leads already exist in app (skipped).`);
      setTransferringNew(false);
      return;
    }

    try {
      const result = await transferToApp(uniqueLeads, 'new');
      addLog(`Transferred ${result.transferred} leads to app (${skipped} duplicates skipped)`);
      if (result.failed && result.failed.length > 0) {
        addLog(`WARNING: ${result.failed.length} leads failed to transfer and were left untouched: ${result.failed.map(f => f.email).join(', ')}`);
      }
      if (result.skippedDuplicates && result.skippedDuplicates.length > 0) {
        addLog(`Server caught ${result.skippedDuplicates.length} more duplicate(s) already in the app: ${result.skippedDuplicates.map(d => d.email).join(', ')}`);
      }

      // Add leads to local store
      dispatch({
        type: 'ADD_LEADS',
        payload: {
          leads: result.leads.map(l => ({
            id: l.id || crypto.randomUUID(),
            email: l.email,
            name: l.name,
            page: 'new' as const,
            status: 'new',
            customData: l.customData,
            createdAt: l.createdAt,
          })),
          page: 'new',
        },
      });

      await loadAll();
    } catch (err) {
      addLog(`ERROR transferring: ${err}`);
    } finally {
      setTransferringNew(false);
    }
  }

  async function handleTransferOld() {
    setTransferringOld(true);
    addLog(`Transferring ${reasonedOld.length} reasoned old leads to app...`);

    const leads: ReasonedLead[] = reasonedOld.map(item => {
      const getVal = (name: string) => {
        const idx = item.headers.findIndex(
          h => h && h.toString().toLowerCase() === name.toLowerCase()
        );
        return idx >= 0 && idx < item.data.length ? String(item.data[idx] || '') : '';
      };

      return {
        rowIndex: item.rowIndex,
        email: getVal('channel_email'),
        name: getVal('channel_name') || getVal('channel_email'),
        page: 'old' as 'old',
        status: 'new',
        customData: {
          // CamelCase names (for app UI)
          channelName: getVal('channel_name'),
          channelId: getVal('channelId'),
          channelUrl: getVal('channelurl'),
          videoTitle: getVal('videotitle'),
          // Raw header names from reason sheet (for template substitutions)
          channel_email: getVal('channel_email'),
          channel_name: getVal('channel_name'),
          channelurl: getVal('channelurl'),
          videotitle: getVal('videotitle'),
        },
        createdAt: new Date().toISOString(),
      };
    }).filter(l => l.email);

    if (leads.length === 0) {
      addLog('No valid old leads to transfer');
      setTransferringOld(false);
      return;
    }

    const existingEmails = new Set([
      ...state.newLeads.map(l => l.email.trim().toLowerCase()),
      ...state.oldLeads.map(l => l.email.trim().toLowerCase()),
      ...state.staleLeads.map(l => l.email.trim().toLowerCase()),
    ]);
    const seenInBatch = new Set<string>();
    const uniqueLeads = leads.filter(l => {
      const key = l.email.trim().toLowerCase();
      if (existingEmails.has(key) || seenInBatch.has(key)) return false;
      seenInBatch.add(key);
      return true;
    });
    const skipped = leads.length - uniqueLeads.length;

    if (uniqueLeads.length === 0) {
      addLog(`All ${leads.length} old leads already exist in app (skipped).`);
      setTransferringOld(false);
      return;
    }

    try {
      const result = await transferToApp(uniqueLeads, 'old');
      addLog(`Transferred ${result.transferred} old leads to app (${skipped} duplicates skipped)`);
      if (result.failed && result.failed.length > 0) {
        addLog(`WARNING: ${result.failed.length} leads failed to transfer and were left untouched: ${result.failed.map(f => f.email).join(', ')}`);
      }
      if (result.skippedDuplicates && result.skippedDuplicates.length > 0) {
        addLog(`Server caught ${result.skippedDuplicates.length} more duplicate(s) already in the app: ${result.skippedDuplicates.map(d => d.email).join(', ')}`);
      }

      dispatch({
        type: 'ADD_LEADS',
        payload: {
          leads: result.leads.map(l => ({
            id: l.id || crypto.randomUUID(),
            email: l.email,
            name: l.name,
            page: 'old' as const,
            status: 'new',
            customData: l.customData,
            createdAt: l.createdAt,
          })),
          page: 'old',
        },
      });

      await loadAll();
    } catch (err) {
      addLog(`ERROR transferring old: ${err}`);
    } finally {
      setTransferringOld(false);
    }
  }

  async function handleStartReasoning(page: 'new' | 'old') {
    const isNew = page === 'new';
    if (isNew) setReasoningNewActive(true);
    else setReasoningOldActive(true);
    setShowReasoningLog(true);

    const reasoningLog: string[] = [];
    const addRLog = (msg: string) => {
      reasoningLog.push(msg);
      if (isNew) setReasoningLogs([...reasoningLog]);
      else setReasoningLogs([...reasoningLog]);
      addLog(msg);
    };

    addRLog(`Starting reasoning for ${page === 'new' ? 'new' : 'old'} leads...`);

    try {
      const result = await startReasoning(page);
      addRLog(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      addRLog(`Reasoning complete!`);
      addRLog(`  Rows processed: ${result.processed}`);
      addRLog(`  Rows updated with video data: ${result.updated}`);
      addRLog(`  Errors: ${result.errors}`);
      addRLog(`  Transcripts fetched: ${result.transcripts}`);
      addRLog(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      // Also include backend logs
      if (result.logs && result.logs.length > 0) {
        addRLog(`Backend logs:`);
        result.logs.forEach(l => addRLog(`  ${l}`));
      }
      await loadAll();
    } catch (err) {
      addRLog(`ERROR: ${err}`);
    } finally {
      if (isNew) setReasoningNewActive(false);
      else setReasoningOldActive(false);
    }
  }

  function getSheetCount(key: string): number {
    if (!summary) return -1;
    const entry = summary[key];
    return entry ? entry.count : -1;
  }

  // ─── Render ────────────────────────────────────────────────────────────
  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 4 }}>Lead Pipeline</h1>
          <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
            Manage leads flowing from Google Sheets into the app
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={loadAll}
            disabled={loading}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '10px 16px',
              background: loading ? 'var(--border)' : 'var(--bg-card)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              cursor: loading ? 'not-allowed' : 'pointer',
              fontWeight: 600,
            }}
          >
            <RefreshCw size={16} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
            {loading ? 'Loading...' : 'Refresh'}
          </button>
          <button
            onClick={async () => {
              try {
                const result = await refreshSheets();
                addLog(`Manual refresh complete. ${Object.keys(result.summary).length} sheets synced.`);
                await loadAll();
              } catch (err) {
                addLog(`Refresh error: ${err}`);
              }
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '10px 16px',
              background: 'var(--accent)',
              color: 'var(--text-inverse)',
              border: 'none',
              borderRadius: 8,
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            <Database size={16} />
            Sync Sheets
          </button>
        </div>
      </div>

      {/* Sheet Overview Cards */}
      {summary && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12, marginBottom: 28 }}>
          {Object.entries(summary).map(([key, s]) => (
            <div key={key} style={{
              padding: 14,
              background: 'var(--bg-card)',
              borderRadius: 8,
              border: '1px solid var(--border)',
            }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 2, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {s.name}
              </div>
              <div style={{ fontSize: 24, fontWeight: 700, color: s.error ? 'var(--red-text)' : 'var(--text-primary)' }}>
                {s.error ? '!' : s.count}
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 24 }}>
        {/* ─── NEW LEADS PIPELINE ─── */}
        <div style={{ background: 'var(--bg-card)', borderRadius: 12, border: '1px solid var(--border)', overflow: 'hidden' }}>
          <div style={{ padding: 16, borderBottom: '1px solid var(--border)', background: 'var(--accent-light)' }}>
            <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0, color: 'var(--accent)' }}>
              New Leads Pipeline
            </h2>
            <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '4px 0 0' }}>
              Needs Email → reasoning → app (New Leads)
            </p>
          </div>

          <div style={{ padding: 16 }}>
            {/* Step 1: Accepted from Needs Email */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>
                  Accepted from Needs Email
                  <span style={{ marginLeft: 6, color: 'var(--text-secondary)', fontWeight: 400 }}>
                    ({acceptedNew.length})
                  </span>
                </span>
                <button
                  onClick={handleMoveToReasoning}
                  disabled={movingToReason || acceptedNew.length === 0}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '6px 12px',
                    borderRadius: 6,
                    border: 'none',
                    background: (movingToReason || acceptedNew.length === 0) ? 'var(--border)' : 'var(--accent)',
                    color: (movingToReason || acceptedNew.length === 0) ? 'var(--text-muted)' : 'var(--text-inverse)',
                    cursor: (movingToReason || acceptedNew.length === 0) ? 'not-allowed' : 'pointer',
                    fontWeight: 600,
                    fontSize: 12,
                  }}
                >
                  <ArrowRight size={14} />
                  {movingToReason ? 'Moving...' : 'Send to Reasoning'}
                </button>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                Total in Needs Email: {getSheetCount('NEEDS_EMAIL') >= 0 ? getSheetCount('NEEDS_EMAIL') : '—'}
              </div>
            </div>

            {/* Divider */}
            <div style={{ borderTop: '2px dashed var(--border)', margin: '12px 0' }} />

            {/* Step 2: Analyze Videos (Reasoning) */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>
                  Analyze Videos
                  <span style={{ marginLeft: 6, color: 'var(--text-secondary)', fontWeight: 400 }}>
                    (YouTube analysis + transcripts)
                    {pendingReasoningNew > 0 && (
                      <span style={{ marginLeft: 6, color: '#8b5cf6', fontWeight: 600 }}>
                        {pendingReasoningNew} need reasoning
                      </span>
                    )}
                  </span>
                </span>
                <button
                  onClick={() => handleStartReasoning('new')}
                  disabled={reasoningNewActive || pendingReasoningNew <= 0}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '6px 12px',
                    borderRadius: 6,
                    border: 'none',
                    background: (reasoningNewActive || pendingReasoningNew <= 0) ? 'var(--border)' : '#8b5cf6',
                    color: (reasoningNewActive || pendingReasoningNew <= 0) ? 'var(--text-muted)' : '#fff',
                    cursor: (reasoningNewActive || pendingReasoningNew <= 0) ? 'not-allowed' : 'pointer',
                    fontWeight: 600,
                    fontSize: 12,
                  }}
                >
                  {reasoningNewActive ? 'Running...' : 'Start Reasoning'}
                </button>
              </div>
              {reasoningNewActive && (
                <div style={{
                  marginTop: 8,
                  padding: 8,
                  background: '#1e293b',
                  color: '#38bdf8',
                  fontFamily: 'monospace',
                  fontSize: 11,
                  borderRadius: 6,
                  maxHeight: 120,
                  overflowY: 'auto',
                  whiteSpace: 'pre-wrap',
                }}>
                  {reasoningLogs.length === 0
                    ? <span style={{ color: '#64748b' }}>Starting reasoning workflow...</span>
                    : reasoningLogs.map((msg, i) => (
                        <div key={i} style={{ marginBottom: 1 }}>{msg}</div>
                      ))
                  }
                </div>
              )}
            </div>

            {/* Divider */}
            <div style={{ borderTop: '2px dashed var(--border)', margin: '12px 0' }} />

            {/* Step 3: Reasoned, ready to transfer */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>
                  Ready to Transfer (New)
                  <span style={{ marginLeft: 6, color: 'var(--text-secondary)', fontWeight: 400 }}>
                    ({reasonedNew.length})
                  </span>
                </span>
                <button
                  onClick={handleTransferNew}
                  disabled={transferringNew || reasonedNew.length === 0}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '6px 12px',
                    borderRadius: 6,
                    border: 'none',
                    background: (transferringNew || reasonedNew.length === 0) ? 'var(--border)' : 'var(--green-text)',
                    color: (transferringNew || reasonedNew.length === 0) ? 'var(--text-muted)' : 'var(--text-inverse)',
                    cursor: (transferringNew || reasonedNew.length === 0) ? 'not-allowed' : 'pointer',
                    fontWeight: 600,
                    fontSize: 12,
                  }}
                >
                  <Send size={14} />
                  {transferringNew ? 'Transferring...' : `Transfer ${reasonedNew.length} to App`}
                </button>
              </div>

              {reasonedNew.length > 0 && (
                <div style={{ maxHeight: 200, overflowY: 'auto', fontSize: 12, border: '1px solid var(--border)', borderRadius: 6 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: 'var(--bg-muted)' }}>
                        <th style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600 }}>Email</th>
                        <th style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600 }}>Name</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reasonedNew.slice(0, 50).map((item, i) => {
                        const getVal = (name: string) => {
                          const idx = item.headers.findIndex(h => h && h.toString().toLowerCase() === name.toLowerCase());
                          return idx >= 0 && idx < item.data.length ? String(item.data[idx] || '') : '';
                        };
                        return (
                          <tr key={i} style={{ borderBottom: '1px solid var(--border-light)' }}>
                            <td style={{ padding: '4px 8px' }}>{getVal('channel_email')}</td>
                            <td style={{ padding: '4px 8px' }}>{getVal('channel_name')}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {reasonedNew.length === 0 && !loading && (
                <div style={{ fontSize: 13, color: 'var(--text-muted)', textAlign: 'center', padding: 20, border: '1px dashed var(--border)', borderRadius: 6 }}>
                  <CheckCircle size={24} style={{ marginBottom: 8, opacity: 0.4 }} />
                  <div>No reasoned leads waiting for transfer</div>
                  <div style={{ fontSize: 11 }}>Run "Start Reasoning" to analyze videos → they'll appear here</div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ─── OLD LEADS PIPELINE ─── */}
        <div style={{ background: 'var(--bg-card)', borderRadius: 12, border: '1px solid var(--border)', overflow: 'hidden' }}>
          <div style={{ padding: 16, borderBottom: '1px solid var(--border)', background: 'var(--yellow-bg)' }}>
            <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0, color: 'var(--yellow-text)' }}>
              Old Leads Pipeline
            </h2>
            <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '4px 0 0' }}>
              No Reply → reasoning → app (Old Leads)
            </p>
          </div>

          <div style={{ padding: 16 }}>
            {/* Step 1: Move from No Reply */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>
                  Move from No Reply
                  <span style={{ marginLeft: 6, color: 'var(--text-secondary)', fontWeight: 400 }}>
                    ({getSheetCount('NO_REPLY') >= 0 ? getSheetCount('NO_REPLY') : '—'} available)
                  </span>
                </span>
                <button
                  onClick={handleMoveNoReply}
                  disabled={movingNoReply || (getSheetCount('NO_REPLY') <= 0)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '6px 12px',
                    borderRadius: 6,
                    border: 'none',
                    background: (movingNoReply || getSheetCount('NO_REPLY') <= 0) ? 'var(--border)' : 'var(--yellow-text)',
                    color: (movingNoReply || getSheetCount('NO_REPLY') <= 0) ? 'var(--text-muted)' : 'var(--text-inverse)',
                    cursor: (movingNoReply || getSheetCount('NO_REPLY') <= 0) ? 'not-allowed' : 'pointer',
                    fontWeight: 600,
                    fontSize: 12,
                  }}
                >
                  <List size={14} />
                  {movingNoReply ? 'Moving...' : 'Move 50 to Reasoning'}
                </button>
              </div>
            </div>

            {/* Divider */}
            <div style={{ borderTop: '2px dashed var(--border)', margin: '12px 0' }} />

            {/* Step 2: Analyze Videos (Reasoning) */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>
                  Analyze Videos
                  <span style={{ marginLeft: 6, color: 'var(--text-secondary)', fontWeight: 400 }}>
                    (YouTube analysis + transcripts)
                    {pendingReasoningOld > 0 && (
                      <span style={{ marginLeft: 6, color: '#8b5cf6', fontWeight: 600 }}>
                        {pendingReasoningOld} need reasoning
                      </span>
                    )}
                  </span>
                </span>
                <button
                  onClick={() => handleStartReasoning('old')}
                  disabled={reasoningOldActive || pendingReasoningOld <= 0}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '6px 12px',
                    borderRadius: 6,
                    border: 'none',
                    background: (reasoningOldActive || pendingReasoningOld <= 0) ? 'var(--border)' : '#8b5cf6',
                    color: (reasoningOldActive || pendingReasoningOld <= 0) ? 'var(--text-muted)' : '#fff',
                    cursor: (reasoningOldActive || pendingReasoningOld <= 0) ? 'not-allowed' : 'pointer',
                    fontWeight: 600,
                    fontSize: 12,
                  }}
                >
                  {reasoningOldActive ? 'Running...' : 'Start Reasoning'}
                </button>
              </div>
              {reasoningOldActive && (
                <div style={{
                  marginTop: 8,
                  padding: 8,
                  background: '#1e293b',
                  color: '#38bdf8',
                  fontFamily: 'monospace',
                  fontSize: 11,
                  borderRadius: 6,
                  maxHeight: 120,
                  overflowY: 'auto',
                  whiteSpace: 'pre-wrap',
                }}>
                  {reasoningLogs.length === 0
                    ? <span style={{ color: '#64748b' }}>Starting reasoning workflow...</span>
                    : reasoningLogs.map((msg, i) => (
                        <div key={i} style={{ marginBottom: 1 }}>{msg}</div>
                      ))
                  }
                </div>
              )}
            </div>

            {/* Divider */}
            <div style={{ borderTop: '2px dashed var(--border)', margin: '12px 0' }} />

            {/* Step 3: Reasoned, ready to transfer */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>
                  Ready to Transfer (Old)
                  <span style={{ marginLeft: 6, color: 'var(--text-secondary)', fontWeight: 400 }}>
                    ({reasonedOld.length})
                  </span>
                </span>
                <button
                  onClick={handleTransferOld}
                  disabled={transferringOld || reasonedOld.length === 0}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '6px 12px',
                    borderRadius: 6,
                    border: 'none',
                    background: (transferringOld || reasonedOld.length === 0) ? 'var(--border)' : 'var(--green-text)',
                    color: (transferringOld || reasonedOld.length === 0) ? 'var(--text-muted)' : 'var(--text-inverse)',
                    cursor: (transferringOld || reasonedOld.length === 0) ? 'not-allowed' : 'pointer',
                    fontWeight: 600,
                    fontSize: 12,
                  }}
                >
                  <Send size={14} />
                  {transferringOld ? 'Transferring...' : `Transfer ${reasonedOld.length} to App`}
                </button>
              </div>

              {reasonedOld.length > 0 && (
                <div style={{ maxHeight: 200, overflowY: 'auto', fontSize: 12, border: '1px solid var(--border)', borderRadius: 6 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: 'var(--bg-muted)' }}>
                        <th style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600 }}>Email</th>
                        <th style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600 }}>Name</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reasonedOld.slice(0, 50).map((item, i) => {
                        const getVal = (name: string) => {
                          const idx = item.headers.findIndex(h => h && h.toString().toLowerCase() === name.toLowerCase());
                          return idx >= 0 && idx < item.data.length ? String(item.data[idx] || '') : '';
                        };
                        return (
                          <tr key={i} style={{ borderBottom: '1px solid var(--border-light)' }}>
                            <td style={{ padding: '4px 8px' }}>{getVal('channel_email')}</td>
                            <td style={{ padding: '4px 8px' }}>{getVal('channel_name')}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {reasonedOld.length === 0 && !loading && (
                <div style={{ fontSize: 13, color: 'var(--text-muted)', textAlign: 'center', padding: 20, border: '1px dashed var(--border)', borderRadius: 6 }}>
                  <CheckCircle size={24} style={{ marginBottom: 8, opacity: 0.4 }} />
                  <div>No reasoned old leads waiting for transfer</div>
                  <div style={{ fontSize: 11 }}>Move 50 from No Reply, then run "Start Reasoning" → they'll appear here</div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Activity Log Console */}
      <div style={{ marginBottom: 24 }}>
        <div style={{
          background: '#1e293b',
          borderRadius: '8px 8px 0 0',
          padding: '8px 16px',
          color: '#94a3b8',
          fontSize: 12,
          fontWeight: 600,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderBottom: '1px solid #334155',
        }}>
          <span>Activity Log</span>
          <div style={{ display: 'flex', gap: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--red-text)' }}></span>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#eab308' }}></span>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e' }}></span>
          </div>
        </div>
        <div style={{
          height: 150,
          background: '#0f172a',
          color: '#38bdf8',
          fontFamily: 'monospace',
          fontSize: 12,
          padding: 12,
          borderRadius: '0 0 8px 8px',
          overflowY: 'auto',
          whiteSpace: 'pre-wrap',
        }}>
          {log.length === 0 ? (
            <span style={{ color: '#64748b' }}>Waiting for activity... Click "Sync Sheets" or perform an action.</span>
          ) : (
            log.map((msg, i) => (
              <div key={i} style={{
                marginBottom: 2,
                color: msg.includes('ERROR') ? '#f87171' :
                       msg.includes('Transferred') ? '#34d399' :
                       msg.includes('Moved') ? '#a78bfa' : '#cbd5e1',
              }}>
                {msg}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Info box */}
      <div style={{
        padding: 16,
        background: 'var(--bg-muted)',
        borderRadius: 8,
        border: '1px solid var(--border)',
        fontSize: 13,
        color: 'var(--text-secondary)',
        lineHeight: 1.6,
      }}>
        <strong style={{ color: 'var(--text-primary)' }}>How this works:</strong>
        <ol style={{ margin: '8px 0 0', paddingLeft: 20 }}>
          <li><strong>New Leads:</strong> Mark leads as "Accepted" in <em>Needs Email</em> sheet → click "Send to Reasoning" → click "Start Reasoning" to analyze YouTube videos &amp; find the high-performing video title → click "Transfer to App"</li>
          <li><strong>Old Leads:</strong> Click "Move 50 to Reasoning" → fills <em>old_leads_reason</em> sheet → click "Start Reasoning" to analyze YouTube videos &amp; find the high-performing video title → click "Transfer to App"</li>
          <li><strong>YouTube Analysis:</strong> "Start Reasoning" searches for each channel, fetches recent uploads, filters Shorts (&lt;120s), analyzes view windows (3mo/5mo/2yr), and flags outlier videos (views ≥ 1.5x window average). Only the winning video title is saved to the sheet.</li>
          <li><strong>Transferred rows skipped:</strong> Rows marked with "transferred" = "yes" are ignored by "Start Reasoning" — only fresh leads get analyzed.</li>
          <li><strong>Dedup:</strong> When transferring, the app checks existing leads by email — duplicates are skipped automatically</li>
          <li><strong>Auto-refresh:</strong> Data refreshes every 5 minutes while this page is open. Use "Sync Sheets" to force an immediate refresh</li>
          <li><strong>Google Sheet:</strong> Your master sheet updates automatically when leads are transferred (appended to "1. Old Leads (App)" and "2. New Leads (App)")</li>
        </ol>
      </div>
    </div>
  );
}
