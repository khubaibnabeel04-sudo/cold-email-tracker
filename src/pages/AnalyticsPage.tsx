import React, { useState, useMemo } from 'react';
import { useStore } from '../store';
import { Lead } from '../types';
import LeadDrawer from '../components/LeadDrawer';
import { analyzeLead } from '../services/gmail';
import { RefreshCw } from 'lucide-react';

export default function AnalyticsPage() {
  const { state, dispatch } = useStore();
  const [periodFilter, setPeriodFilter] = useState('all');
  const [showAutomated, setShowAutomated] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [drawerLead, setDrawerLead] = useState<Lead | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncLogs, setSyncLogs] = useState<string[]>([]);

  const allLeads = useMemo(() => [...state.newLeads, ...state.oldLeads], [state.newLeads, state.oldLeads]);

  const now = Date.now();
  const day7ago = now - 7 * 24 * 60 * 60 * 1000;
  const day30ago = now - 30 * 24 * 60 * 60 * 1000;

  const filteredLeads = useMemo(() => {
    return allLeads.filter(l => {
      if (periodFilter === '7d') {
        const d = l.lastContactDate ? new Date(l.lastContactDate).getTime() : 0;
        if (d < day7ago && l.status !== 'new') return false;
      }
      if (periodFilter === '30d') {
        const d = l.lastContactDate ? new Date(l.lastContactDate).getTime() : 0;
        if (d < day30ago && l.status !== 'new') return false;
      }
      return true;
    });
  }, [allLeads, periodFilter, day7ago, day30ago]);

  const totalLeads = filteredLeads.length;
  const contacted = filteredLeads.filter(l => l.status !== 'new').length;
  const totalReplied = filteredLeads.filter(l => l.status === 'replied' && !l.bounced).length;
  const automatedReplies = filteredLeads.filter(l => l.status === 'replied' && l.automatedReply && !l.bounced).length;
  const realReplies = totalReplied - automatedReplies;
  const replyRate = contacted > 0 ? ((realReplies / contacted) * 100).toFixed(1) : '0.0';

  const totalBounced = filteredLeads.filter(l => l.bounced).length;
  const bounceRate = contacted > 0 ? ((totalBounced / contacted) * 100).toFixed(1) : '0.0';

  const totalClosed = filteredLeads.filter(l => l.closed).length;
  const closeRate = realReplies > 0 ? ((totalClosed / realReplies) * 100).toFixed(1) : '0.0';

  const repliedLeads = useMemo(() => {
    if (showAutomated === 'bounced') {
      let list = filteredLeads.filter(l => l.bounced);
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        list = list.filter(l =>
          l.email.toLowerCase().includes(q) ||
          l.name.toLowerCase().includes(q) ||
          (l.sentFromAccount || '').toLowerCase().includes(q)
        );
      }
      return list.sort((a, b) => {
        const da = a.lastContactDate ? new Date(a.lastContactDate).getTime() : 0;
        const db = b.lastContactDate ? new Date(b.lastContactDate).getTime() : 0;
        return db - da;
      });
    }
    let list = filteredLeads.filter(l => l.status === 'replied' && !l.bounced);
    if (showAutomated === 'real') list = list.filter(l => !l.automatedReply);
    if (showAutomated === 'automated') list = list.filter(l => l.automatedReply);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(l =>
        l.email.toLowerCase().includes(q) ||
        l.name.toLowerCase().includes(q) ||
        (l.sentFromAccount || '').toLowerCase().includes(q)
      );
    }
    return list.sort((a, b) => {
      // Sort by the lead's FIRST reply — later replies (from either side) in the
      // same thread must never bump a lead back up. Falls back to lastContactDate
      // for leads analyzed before this field existed.
      const da = a.firstReplyDate ? new Date(a.firstReplyDate).getTime() : (a.lastContactDate ? new Date(a.lastContactDate).getTime() : 0);
      const db = b.firstReplyDate ? new Date(b.firstReplyDate).getTime() : (b.lastContactDate ? new Date(b.lastContactDate).getTime() : 0);
      return db - da;
    });
  }, [filteredLeads, showAutomated, searchQuery]);

  const templateStats = useMemo(() => {
    // Build all "contacted" statuses dynamically
    const contactedStatuses = ['initial_sent'];
    for (let i = 1; i <= state.settings.followUps.length; i++) {
      contactedStatuses.push(`needs_fu${i}`, `fu${i}_sent`);
    }
    contactedStatuses.push('replied');

    const initialSent = allLeads.filter(l => contactedStatuses.includes(l.status));
    const initialReplied = allLeads.filter(l => l.status === 'replied' && !l.automatedReply && !l.bounced);
    return {
      totalSent: initialSent.length,
      totalReplied: initialReplied.length,
      replyRate: initialSent.length > 0 ? ((initialReplied.length / initialSent.length) * 100).toFixed(1) : '0.0',
    };
  }, [allLeads, state.settings.followUps.length]);

  const accountStats = useMemo(() => {
    return state.accounts.map(acc => {
      const sent = allLeads.filter(l => l.sentFromAccount === acc.email).length;
      const replied = allLeads.filter(l => l.sentFromAccount === acc.email && l.status === 'replied' && !l.automatedReply && !l.bounced);
      const bounced = allLeads.filter(l => l.sentFromAccount === acc.email && l.bounced);
      return {
        email: acc.email,
        sent,
        replied: replied.length,
        bounced: bounced.length,
        rate: sent > 0 ? ((replied.length / sent) * 100).toFixed(1) : '0.0',
        bounceRate: sent > 0 ? ((bounced.length / sent) * 100).toFixed(1) : '0.0'
      };
    });
  }, [state.accounts, allLeads]);

  const dailyActivity = useMemo(() => {
    const days = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toDateString();
      const sent = allLeads.filter(l => l.lastContactDate && new Date(l.lastContactDate).toDateString() === dateStr).length;
      const replied = allLeads.filter(l =>
        l.lastContactDate && new Date(l.lastContactDate).toDateString() === dateStr &&
        l.status === 'replied' && !l.automatedReply && !l.bounced
      ).length;
      days.push({ date: dateStr, sent, replied });
    }
    return days;
  }, [allLeads]);

  const weeklyTrend = useMemo(() => {
    const thisWeek = dailyActivity.slice(-7);
    const lastWeek = dailyActivity.slice(-14, -7);
    const thisTotal = thisWeek.reduce((s, d) => s + d.replied, 0);
    const lastTotal = lastWeek.reduce((s, d) => s + d.replied, 0);
    return { thisWeek: thisTotal, lastWeek: lastTotal, change: lastTotal > 0 ? (((thisTotal - lastTotal) / lastTotal) * 100).toFixed(1) : '0' };
  }, [dailyActivity]);

  async function handleCheckReplies() {
    if (!state.accounts.length) {
      alert('Add Gmail accounts first in the Accounts page');
      return;
    }
    setSyncing(true);
    setSyncLogs([]);

    const addLog = (msg: string) => {
      setSyncLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
    };

    const contactedStatuses = ['initial_sent'];
    for (let i = 1; i <= state.settings.followUps.length; i++) {
      contactedStatuses.push(`needs_fu${i}`, `fu${i}_sent`);
    }
    contactedStatuses.push('replied');
    const leadsToCheck = allLeads.filter(l => contactedStatuses.includes(l.status));

    addLog(`=== Checking ${leadsToCheck.length} sent leads for replies ===`);
    addLog(`Cutoff date: ${state.settings.dateCutoff}\n`);

    let replyCount = 0;
    for (let i = 0; i < leadsToCheck.length; i++) {
      const lead = leadsToCheck[i];
      addLog(`[${i + 1}/${leadsToCheck.length}] ${lead.email}...`);

      try {
        const updates = await analyzeLead(
          lead,
          state.accounts,
          state.settings.dateCutoff,
          state.settings.followUps,
          (msg) => addLog(`  ${msg}`),
          (updatedAcc) => dispatch({ type: 'UPDATE_ACCOUNT', payload: updatedAcc }),
          state.settings
        );

        if (updates.status === 'replied' && lead.status !== 'replied') {
          replyCount++;
          addLog(`  -> NEW REPLY DETECTED!`);
        }

        dispatch({
          type: 'UPDATE_LEAD',
          payload: { ...lead, ...updates }
        });
      } catch (err) {
        addLog(`  -> Error: ${err}`);
      }
      addLog('');
    }

    addLog(`=== Done! Checked ${leadsToCheck.length} leads, found ${replyCount} new replies. ===`);
    setSyncing(false);
  }

  function toggleAutomated(lead: Lead) {
    dispatch({ type: 'UPDATE_LEAD', payload: { ...lead, automatedReply: !lead.automatedReply } });
  }

  function toggleClosed(lead: Lead) {
    dispatch({ type: 'UPDATE_LEAD', payload: { ...lead, closed: !lead.closed } });
  }

  function setReplyType(lead: Lead, type: 'real' | 'automated' | 'bounced') {
    dispatch({
      type: 'UPDATE_LEAD',
      payload: {
        ...lead,
        automatedReply: type === 'automated',
        bounced: type === 'bounced'
      }
    });
  }

  function getStageColor(status: string) {
    const stageColors: Record<string, { bg: string; text: string }> = {
      replied: { bg: 'var(--green-bg)', text: 'var(--green-text)' },
      initial_sent: { bg: 'var(--blue-bg)', text: 'var(--blue-text)' },
    };
    const colorPalette = [
      { bg: 'var(--yellow-bg)', text: 'var(--yellow-text)' },
      { bg: 'var(--pink-bg)', text: 'var(--pink-text)' },
      { bg: 'var(--blue-bg)', text: 'var(--blue-text)' },
      { bg: 'var(--green-bg)', text: 'var(--green-text)' },
      { bg: 'var(--red-bg)', text: 'var(--red-text)' },
    ];
    for (let i = 1; i <= state.settings.followUps.length; i++) {
      stageColors[`fu${i}_sent`] = colorPalette[(i - 1) % colorPalette.length];
    }
    return stageColors[status] || { bg: 'var(--bg-hover)', text: 'var(--text-primary)' };
  }

  return (
    <div style={{ maxWidth: 1200 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 700, margin: '0 0 4px', color: 'var(--text-primary)' }}>Analytics</h1>
          <p style={{ fontSize: 14, color: 'var(--text-secondary)', margin: 0 }}>Track your outreach performance and reply rates</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {['all', '30d', '7d'].map(p => (
            <button key={p} onClick={() => setPeriodFilter(p)} style={{
              padding: '6px 14px', borderRadius: 20, border: '1px solid',
              borderColor: periodFilter === p ? 'var(--accent)' : 'var(--border)',
              background: periodFilter === p ? 'var(--accent)' : 'transparent',
              color: periodFilter === p ? 'var(--bg-card)' : 'var(--text-secondary)',
              fontSize: 13, fontWeight: 600, cursor: 'pointer',
            }}>
              {p === 'all' ? 'All Time' : p === '30d' ? 'Last 30 Days' : 'Last 7 Days'}
            </button>
          ))}
          <div style={{ width: 1, height: 28, background: 'var(--border)', margin: '0 4px' }} />
          <button
            onClick={handleCheckReplies}
            disabled={syncing}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 14px', borderRadius: 20, border: 'none',
              background: 'var(--accent)', color: 'var(--accent-text)',
              fontSize: 13, fontWeight: 600, cursor: syncing ? 'not-allowed' : 'pointer',
              opacity: syncing ? 0.7 : 1,
            }}
          >
            <RefreshCw size={14} style={{ animation: syncing ? 'spin 1s linear infinite' : 'none' }} />
            {syncing ? 'Checking...' : 'Check for Replies'}
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 16, marginBottom: 28 }}>
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: 8 }}>Total Leads</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--text-primary)' }}>{totalLeads}</div>
        </div>
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: 8 }}>Contacted</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--text-primary)' }}>{contacted}</div>
        </div>
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: 8 }}>Real Replies</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--text-primary)' }}>{realReplies}</div>
        </div>
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: 8 }}>Real Reply Rate</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--accent)' }}>{replyRate}%</div>
        </div>
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: 8 }}>Automated</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--text-muted)' }}>{automatedReplies}</div>
        </div>
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: 8 }}>Closed</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--text-primary)' }}>{totalClosed}</div>
        </div>
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: 8 }}>Close Rate</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--accent)' }}>{closeRate}%</div>
        </div>
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: 8 }}>Total Inbox</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--text-primary)' }}>{totalReplied}</div>
        </div>
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: 8 }}>Total Bounced</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--red-text)' }}>{totalBounced}</div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>{bounceRate}% bounce rate</div>
        </div>
      </div>

      {/* Sync Log Console */}
      {syncLogs.length > 0 && (
        <div style={{
          background: 'var(--bg-console)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: 16,
          marginBottom: 28,
          fontFamily: 'monospace',
          fontSize: 12,
          maxHeight: 300,
          overflow: 'auto',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, borderBottom: '1px solid #334155', paddingBottom: 6 }}>
            <span style={{ fontWeight: 600, color: '#f8fafc' }}>Reply Check Log</span>
            <button
              onClick={() => setSyncLogs([])}
              style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 11 }}
            >
              Clear Logs
            </button>
          </div>
          {syncLogs.map((log, idx) => (
            <div key={idx} style={{
              marginBottom: 3,
              color: log.includes('NEW REPLY') ? '#34d399' :
                     log.includes('Error') ? '#fca5a5' :
                     log.includes('===') ? '#60a5fa' : '#cbd5e1',
              whiteSpace: 'pre-wrap',
            }}>
              {log}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 28 }}>
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 16px', color: 'var(--text-primary)' }}>Campaign Performance</h3>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 12px', background: 'var(--bg-muted)', borderRadius: 6, marginBottom: 8 }}>
            <span style={{ fontWeight: 600 }}>Initial Outreach</span>
            <span style={{ fontWeight: 700 }}>{templateStats.totalSent}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 12px', background: 'var(--green-bg)', borderRadius: 6 }}>
            <span style={{ fontWeight: 600, color: 'var(--green-text)' }}>Real Replies</span>
            <span style={{ fontWeight: 700, color: 'var(--green-text)' }}>{templateStats.totalReplied} ({templateStats.replyRate}%)</span>
          </div>
        </div>
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 16px', color: 'var(--text-primary)' }}>Account Performance</h3>
          {accountStats.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 20 }}>No accounts connected</div>
          ) : (
            accountStats.map(acc => (
              <div key={acc.email} style={{ padding: '8px 12px', background: 'var(--bg-muted)', borderRadius: 6, marginBottom: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{acc.email}</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-secondary)' }}>
                  <span>Sent: {acc.sent}</span>
                  <span>Replies: {acc.replied}</span>
                  <span>Bounced: <span style={{ color: 'var(--red-text)', fontWeight: 600 }}>{acc.bounced}</span></span>
                  <span style={{ fontWeight: 600 }}>{acc.rate}% reply</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                  Bounce rate: <span style={{ color: parseFloat(acc.bounceRate) > 5 ? 'var(--red-text)' : 'var(--text-muted)', fontWeight: 600 }}>{acc.bounceRate}%</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, boxShadow: '0 1px 2px rgba(0,0,0,0.04)', marginBottom: 28 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 16px', color: 'var(--text-primary)' }}>30-Day Activity</h3>
        <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: 60 }}>
          {dailyActivity.map((day) => {
            const maxVal = Math.max(...dailyActivity.map(d => Math.max(d.sent, d.replied, 1)), 1);
            return (
              <div key={day.date} title={day.date + ': ' + day.sent + ' sent, ' + day.replied + ' replied'}
                style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%', gap: 1 }}>
                <div style={{ height: Math.max((day.replied / maxVal) * 100, 1) + '%', background: 'var(--green-text)', borderRadius: '2px 2px 0 0', opacity: day.replied > 0 ? 0.9 : 0.15 }} />
                <div style={{ height: Math.max((day.sent / maxVal) * 100, 1) + '%', background: 'var(--accent)', borderRadius: '2px 2px 0 0', opacity: day.sent > 0 ? 0.4 : 0.08 }} />
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
            {showAutomated === 'bounced' ? 'Bounced Leads' : 'All Replies'} ({repliedLeads.length})
          </h3>
          <div style={{ display: 'flex', gap: 8 }}>
            <input type="text" placeholder="Search..." value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 13, width: 160 }} />
            {['all', 'real', 'automated', 'bounced'].map(f => (
              <button key={f} onClick={() => setShowAutomated(f)}
                style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid', borderColor: showAutomated === f ? 'var(--accent)' : 'var(--border)', background: showAutomated === f ? 'var(--accent-light)' : 'transparent', color: showAutomated === f ? 'var(--accent)' : 'var(--text-secondary)', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                {f === 'all' ? 'All' : f === 'real' ? 'Real' : f === 'automated' ? 'Auto' : 'Bounce'}
              </button>
            ))}
          </div>
        </div>

        {repliedLeads.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
            <p>{showAutomated === 'bounced' ? 'No bounced leads found.' : 'No replies match your filters.'}</p>
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--border)', textAlign: 'left' }}>
                <th style={{ padding: '10px 12px', fontWeight: 600, color: 'var(--text-secondary)' }}>Name</th>
                <th style={{ padding: '10px 12px', fontWeight: 600, color: 'var(--text-secondary)' }}>Email</th>
                <th style={{ padding: '10px 12px', fontWeight: 600, color: 'var(--text-secondary)' }}>Account</th>
                <th style={{ padding: '10px 12px', fontWeight: 600, color: 'var(--text-secondary)' }}>Stage</th>
                <th style={{ padding: '10px 12px', fontWeight: 600, color: 'var(--text-secondary)' }}>Date</th>
                <th style={{ padding: '10px 12px', fontWeight: 600, color: 'var(--text-secondary)' }}>Type</th>
                <th style={{ padding: '10px 12px', fontWeight: 600, color: 'var(--text-secondary)' }}>Closed</th>
              </tr>
            </thead>
            <tbody>
              {repliedLeads.map((lead) => {
                const sc = getStageColor(lead.status);
                return (
                  <tr key={lead.id} onClick={() => setDrawerLead(lead)} style={{ borderBottom: '1px solid var(--border-light)', background: lead.bounced ? 'var(--red-bg)' : lead.automatedReply ? 'var(--bg-muted)' : 'transparent', opacity: lead.bounced ? 0.7 : lead.automatedReply ? 0.6 : 1, cursor: 'pointer', transition: 'background 0.15s ease' }}
                    onMouseEnter={e => { e.currentTarget.style.background = lead.bounced ? 'var(--red-bg)' : 'var(--bg-hover)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = lead.bounced ? 'var(--red-bg)' : lead.automatedReply ? 'var(--bg-muted)' : 'transparent'; }}>
                    <td style={{ padding: '10px 12px', fontWeight: 600 }}>{lead.name || '�'}</td>
                    <td style={{ padding: '10px 12px', color: 'var(--text-secondary)' }}>{lead.email}</td>
                    <td style={{ padding: '10px 12px', color: 'var(--text-secondary)' }}>{lead.sentFromAccount || '�'}</td>
                    <td style={{ padding: '10px 12px' }}>
                      <span style={{ padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600, background: sc.bg, color: sc.text }}>
                        {lead.status === 'replied' ? 'Replied' : lead.status}
                      </span>
                    </td>
                    <td style={{ padding: '10px 12px', color: 'var(--text-muted)', fontSize: 12 }}>
                      {(() => {
                        const d = showAutomated === 'bounced' ? lead.lastContactDate : (lead.firstReplyDate || lead.lastContactDate);
                        return d ? new Date(d).toLocaleDateString() : '�';
                      })()}
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button onClick={(e) => { e.stopPropagation(); setReplyType(lead, 'real'); }}
                          style={{ padding: '4px 8px', borderRadius: 20, border: '1px solid', borderColor: !lead.automatedReply && !lead.bounced ? 'var(--green-bg)' : 'var(--border)', background: !lead.automatedReply && !lead.bounced ? 'var(--green-bg)' : 'transparent', color: !lead.automatedReply && !lead.bounced ? 'var(--green-text)' : 'var(--text-secondary)', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                          Real
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); setReplyType(lead, 'automated'); }}
                          style={{ padding: '4px 8px', borderRadius: 20, border: '1px solid', borderColor: lead.automatedReply ? 'var(--yellow-bg)' : 'var(--border)', background: lead.automatedReply ? 'var(--yellow-bg)' : 'transparent', color: lead.automatedReply ? 'var(--yellow-text)' : 'var(--text-secondary)', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                          Auto
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); setReplyType(lead, 'bounced'); }}
                          style={{ padding: '4px 8px', borderRadius: 20, border: '1px solid', borderColor: lead.bounced ? 'var(--red-bg)' : 'var(--border)', background: lead.bounced ? 'var(--red-bg)' : 'transparent', color: lead.bounced ? 'var(--red-text)' : 'var(--text-secondary)', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                          Bounce
                        </button>
                      </div>
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      <button onClick={(e) => { e.stopPropagation(); toggleClosed(lead); }}
                        style={{ padding: '4px 8px', borderRadius: 20, border: '1px solid', borderColor: lead.closed ? 'var(--accent)' : 'var(--border)', background: lead.closed ? 'var(--accent)' : 'transparent', color: lead.closed ? 'var(--accent-text)' : 'var(--text-secondary)', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                        {lead.closed ? '✓ Closed' : 'Mark Closed'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div style={{ marginTop: 12, padding: '8px 12px', background: 'var(--bg-muted)', borderRadius: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
          Click <strong>Real</strong>, <strong>Auto</strong>, or <strong>Bounce</strong> to classify each lead.
        </div>
      </div>

      {drawerLead && <LeadDrawer lead={drawerLead} onClose={() => setDrawerLead(null)} onSetReplyType={(lead, type) => setReplyType(lead, type)} onToggleClosed={(lead) => toggleClosed(lead)} />}
    </div>
  );
}
