import React, { useState, useMemo, useEffect } from 'react';
import { useStore } from '../store';
import { Lead } from '../types';
import { Calendar, Search, Mail, User, Clock, AlertCircle, BarChart3, RefreshCw } from 'lucide-react';

const API_BASE = 'http://localhost:3006';

interface LeadSendRecord {
  leadId: string;
  name: string;
  channelName: string;
  email: string;
  page: 'new' | 'old' | 'stale';
  date: string;
}

interface MonthEntry {
  computedAt: string;
  final: boolean;
  stages: Record<string, LeadSendRecord[]>;
}

interface MonthlyStats {
  computedAt: string;
  rangeStart: string;
  rangeEnd: string;
  monthly: Record<string, MonthEntry>;
}

function monthKeyStr(year: number, monthIdx0: number) {
  return `${year}-${String(monthIdx0 + 1).padStart(2, '0')}`;
}

function monthLabel(monthKey: string, short = false) {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: short ? 'short' : 'long', year: short ? undefined : 'numeric', timeZone: 'UTC' });
}

function sortStageKeys(keys: string[]) {
  const fuKeys = keys.filter(k => k !== 'Initial').sort((a, b) => parseInt(a.replace('FU', ''), 10) - parseInt(b.replace('FU', ''), 10));
  return keys.includes('Initial') ? ['Initial', ...fuKeys] : fuKeys;
}

export default function SchedulePage() {
  const { state } = useStore();
  const allLeads = [...state.newLeads, ...state.oldLeads].filter(l => l.page === 'new' || l.page === 'old');
  const followUpCount = state.settings.followUps.length;

  const [viewMode, setViewMode] = useState<'day' | 'month'>('day');
  const [selectedDateStr, setSelectedDateStr] = useState<string>(new Date().toDateString());
  const [searchQuery, setSearchQuery] = useState('');

  // Monthly send-history stats (computed server-side from real Gmail Sent data)
  const [monthlyStats, setMonthlyStats] = useState<MonthlyStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState('');
  const [computeProgress, setComputeProgress] = useState<{ currentMonth?: string; monthProgress?: { done: number; total: number } } | null>(null);

  const currentYear = new Date().getFullYear();
  const currentMonthKey = monthKeyStr(new Date().getFullYear(), new Date().getMonth());
  const [selectedMonth, setSelectedMonth] = useState<string>(currentMonthKey);
  const [selectedStage, setSelectedStage] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/api/send-stats`)
      .then(r => r.json())
      .then(data => { if (data.cached) setMonthlyStats(data.cached); })
      .catch(() => {});
  }, []);

  async function handleComputeStats() {
    setStatsLoading(true);
    setStatsError('');
    setComputeProgress(null);
    try {
      const startRes = await fetch(`${API_BASE}/api/send-stats/compute`, { method: 'POST' });
      const startData = await startRes.json();
      if (!startRes.ok) throw new Error(startData.error || 'Failed to start computation');

      const jobId = startData.jobId;
      let done = false;
      while (!done) {
        await new Promise(r => setTimeout(r, 1500));
        const statusRes = await fetch(`${API_BASE}/api/send-stats/status/${jobId}`);
        if (!statusRes.ok) continue;
        const status = await statusRes.json();
        setComputeProgress({ currentMonth: status.currentMonth, monthProgress: status.monthProgress });

        if (status.status === 'completed') {
          setMonthlyStats(status.result);
          done = true;
        } else if (status.status === 'error') {
          setStatsError(status.error || 'Computation failed');
          done = true;
        }
      }
    } catch (err: any) {
      setStatsError(err.message || 'Failed to compute stats');
    } finally {
      setStatsLoading(false);
      setComputeProgress(null);
    }
  }

  // All 12 months of the current year, for the month picker.
  const yearMonths = useMemo(() => Array.from({ length: 12 }, (_, i) => monthKeyStr(currentYear, i)), [currentYear]);

  const selectedMonthEntry: MonthEntry | null = monthlyStats?.monthly[selectedMonth] || null;
  const selectedMonthStages = selectedMonthEntry?.stages || {};
  const selectedMonthStageKeys = sortStageKeys(Object.keys(selectedMonthStages));
  const selectedMonthTotal = Object.values(selectedMonthStages).reduce((sum, arr) => sum + arr.length, 0);

  // Keep the selected stage valid whenever the month (or its data) changes.
  useEffect(() => {
    if (selectedMonthStageKeys.length === 0) {
      setSelectedStage(null);
    } else if (!selectedStage || !selectedMonthStageKeys.includes(selectedStage)) {
      setSelectedStage(selectedMonthStageKeys[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMonth, monthlyStats]);

  const selectedStageLeads: LeadSendRecord[] = (selectedStage && selectedMonthStages[selectedStage]) || [];

  // Generate dynamic type filter options
  const typeFilters = ['all', 'Initial', ...state.settings.followUps.map((_, i) => `FU${i + 1}`)];
  const [selectedTypeFilter, setSelectedTypeFilter] = useState<string>('all');

  // Generate date list: last 10 days + Today + Tomorrow
  const datesList = useMemo(() => {
    const list = [];
    const today = new Date();
    
    // Last 10 days
    for (let i = 10; i >= 1; i--) {
      const d = new Date();
      d.setDate(today.getDate() - i);
      list.push(d);
    }
    // Today
    list.push(today);
    // Tomorrow
    const tomorrow = new Date();
    tomorrow.setDate(today.getDate() + 1);
    list.push(tomorrow);
    
    return list;
  }, []);

  // Helper: format button labels beautifully
  function getDateLabel(d: Date) {
    const todayStr = new Date().toDateString();
    
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toDateString();
    
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toDateString();

    const dStr = d.toDateString();
    const formattedDate = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    
    if (dStr === todayStr) return `Today (${formattedDate})`;
    if (dStr === yesterdayStr) return `Yesterday (${formattedDate})`;
    if (dStr === tomorrowStr) return `Tomorrow (${formattedDate})`;
    
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  // Build items sent (or simulated for tomorrow) on the selected date
  const displayedItems = useMemo(() => {
    const todayStr = new Date().toDateString();
    const tomorrow = new Date();
    tomorrow.setDate(new Date().getDate() + 1);
    const tomorrowStr = tomorrow.toDateString();

    const items: Array<{
      id: string;
      channelName: string;
      email: string;
      sentFromAccount: string;
      emailType: string;
      statusTag: string;
      leadPage: Lead['page'];
    }> = [];

    if (selectedDateStr === tomorrowStr) {
      // Tomorrow's simulated projection
      const remainingCapacity = state.accounts.reduce((sum, a) => sum + Math.max(0, a.dailyLimit - a.sentToday), 0);

      // Build dynamic status groups
      const statusGroups: Record<string, Lead[]> = { new: allLeads.filter(l => l.status === 'new') };
      for (let i = 1; i <= followUpCount; i++) {
        statusGroups[`needs_fu${i}`] = allLeads.filter(l => l.status === `needs_fu${i}`);
      }

      // 1. Initial Carryovers
      const projectedInitialLeads = statusGroups.new.slice(remainingCapacity);
      projectedInitialLeads.forEach(l => {
        items.push({
          id: l.id,
          channelName: l.customData.channelName || l.name || '—',
          email: l.email,
          sentFromAccount: 'Round-Robin (Capacity)',
          emailType: 'Initial',
          statusTag: 'Projected (Carryover)',
          leadPage: l.page
        });
      });

      // 2. Follow-up Carryovers (dynamic for all FUs)
      for (let i = 1; i <= followUpCount; i++) {
        const needsKey = `needs_fu${i}`;
        const fuEmailType = `FU${i}`;
        const carryovers = (statusGroups[needsKey] || []).filter(l => {
          const acc = state.accounts.find(a => a.email === l.sentFromAccount);
          return acc ? (acc.dailyLimit - acc.sentToday <= 0) : false;
        });
        carryovers.forEach(l => {
          items.push({
            id: l.id,
            channelName: l.customData.channelName || l.name || '—',
            email: l.email,
            sentFromAccount: l.sentFromAccount || `Locked Account (Limit)`,
            emailType: fuEmailType,
            statusTag: 'Projected (Carryover)',
            leadPage: l.page
          });
        });
      }

      // 3. Graduating leads (dynamic for all FUs)
      for (let i = 1; i <= followUpCount; i++) {
        const prevStatus = i === 1 ? 'initial_sent' : `fu${i - 1}_sent`;
        const fuEmailType = `FU${i}`;
        const graduating = allLeads.filter(l => {
          if (l.status !== prevStatus || !l.lastContactDate) return false;
          const daysSince = Math.floor((Date.now() - new Date(l.lastContactDate).getTime()) / (1000 * 60 * 60 * 24));
          const delayDays = state.settings.followUps[i - 1].delayDays;
          return daysSince === (delayDays - 1);
        });
        graduating.forEach(l => {
          items.push({
            id: l.id,
            channelName: l.customData.channelName || l.name || '—',
            email: l.email,
            sentFromAccount: l.sentFromAccount || 'Locked Account',
            emailType: fuEmailType,
            statusTag: 'Projected (Graduating)',
            leadPage: l.page
          });
        });
      }

    } else {
      // Past days and Today
      const leadsOnDay = allLeads.filter(l => l.lastContactDate && new Date(l.lastContactDate).toDateString() === selectedDateStr);
      leadsOnDay.forEach(l => {
        // Determine email type based on status dynamically
        let emailType = 'Initial';
        if (l.status === 'initial_sent' || l.status === 'needs_fu1') {
          emailType = 'Initial';
        } else {
          for (let i = 1; i <= followUpCount; i++) {
            if (l.status === `fu${i}_sent` || (i < followUpCount && l.status === `needs_fu${i + 1}`) || (i === followUpCount && l.status === `needs_fu${i}`)) {
              emailType = `FU${i}`;
              break;
            }
          }
        }

        items.push({
          id: l.id,
          channelName: l.customData.channelName || l.name || '—',
          email: l.email,
          sentFromAccount: l.sentFromAccount || 'Unknown Account',
          emailType,
          statusTag: selectedDateStr === todayStr ? 'Drafted/Sent Today' : 'Sent',
          leadPage: l.page
        });
      });
    }

    return items;
  }, [selectedDateStr, allLeads, state.accounts, state.settings, followUpCount]);

  // Filter items by search query and type filter
  const filteredItems = useMemo(() => {
    return displayedItems.filter(item => {
      const matchesSearch =
        item.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.channelName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.sentFromAccount.toLowerCase().includes(searchQuery.toLowerCase());

      const matchesType = selectedTypeFilter === 'all' || item.emailType === selectedTypeFilter;

      return matchesSearch && matchesType;
    });
  }, [displayedItems, searchQuery, selectedTypeFilter]);

  // Calculate summary metrics for the selected day
  const summaryMetrics = useMemo(() => {
    const initial = displayedItems.filter(item => item.emailType === 'Initial').length;
    const fuCounts: Record<string, number> = {};
    for (let i = 1; i <= followUpCount; i++) {
      fuCounts[`fu${i}`] = displayedItems.filter(item => item.emailType === `FU${i}`).length;
    }
    return {
      total: displayedItems.length,
      initial,
      ...fuCounts,
    };
  }, [displayedItems, followUpCount]);

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 4 }}>Schedule & Batch History</h1>
        <p style={{ color: 'var(--text-secondary)' }}>Track, audit, and preview emails drafted, sent, or projected day-by-day.</p>
      </div>

      {/* View Mode Tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 24, borderBottom: '1px solid var(--border)' }}>
        {(['day', 'month'] as const).map(mode => (
          <button
            key={mode}
            onClick={() => setViewMode(mode)}
            style={{
              padding: '10px 18px',
              border: 'none',
              borderBottom: viewMode === mode ? '2px solid var(--accent)' : '2px solid transparent',
              background: 'transparent',
              color: viewMode === mode ? 'var(--accent)' : 'var(--text-secondary)',
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              marginBottom: -1
            }}
          >
            {mode === 'day' ? <Calendar size={15} /> : <BarChart3 size={15} />}
            {mode === 'day' ? 'Day View' : 'Monthly Overview'}
          </button>
        ))}
      </div>

      {viewMode === 'month' ? (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
            <div>
              <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>Emails Sent Per Month</h2>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>
                {monthlyStats
                  ? `Last computed ${new Date(monthlyStats.computedAt).toLocaleString()}`
                  : 'No data computed yet — this reads your accounts’ real Gmail Sent history and matches it against your current leads.'}
              </p>
            </div>
            <button
              onClick={handleComputeStats}
              disabled={statsLoading}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '9px 16px', borderRadius: 8, border: '1px solid var(--accent)',
                background: statsLoading ? 'var(--bg-hover)' : 'var(--accent)',
                color: statsLoading ? 'var(--text-secondary)' : 'var(--text-inverse)',
                fontSize: 13, fontWeight: 600, cursor: statsLoading ? 'default' : 'pointer'
              }}
            >
              <RefreshCw size={14} style={statsLoading ? { animation: 'spin 1s linear infinite' } : undefined} />
              {statsLoading ? 'Computing…' : monthlyStats ? 'Recalculate' : 'Calculate Now'}
            </button>
          </div>

          {statsLoading && (
            <div style={{ marginBottom: 16, padding: 12, background: 'var(--bg-muted)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13, color: 'var(--text-secondary)' }}>
              {computeProgress?.currentMonth
                ? `Computing ${monthLabel(computeProgress.currentMonth)}${computeProgress.monthProgress && computeProgress.monthProgress.total > 0 ? ` — ${computeProgress.monthProgress.done}/${computeProgress.monthProgress.total} messages inspected` : '…'}`
                : 'Starting…'}
              <span style={{ display: 'block', marginTop: 4, fontSize: 12, opacity: 0.8 }}>
                Only new/unfinalized months are re-read from Gmail — past months are cached and skipped.
              </span>
            </div>
          )}

          {statsError && (
            <div style={{ marginBottom: 16, padding: 12, background: 'var(--red-bg)', border: '1px solid var(--red-bg)', borderRadius: 8, fontSize: 13, color: 'var(--red-text)' }}>
              {statsError}
            </div>
          )}

          {!monthlyStats && !statsLoading ? (
            <div style={{ textAlign: 'center', padding: '48px 16px', color: 'var(--text-muted)', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8 }}>
              <BarChart3 size={36} style={{ margin: '0 auto 12px', opacity: 0.5 }} />
              <p style={{ margin: 0, fontSize: 15 }}>Click "Calculate Now" to build your monthly send history.</p>
            </div>
          ) : monthlyStats && (
            <div>
              {/* Month Picker (current year) */}
              <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 8, marginBottom: 16 }}>
                {yearMonths.map(mKey => {
                  const isSelected = mKey === selectedMonth;
                  const hasData = !!monthlyStats.monthly[mKey];
                  const isCurrent = mKey === currentMonthKey;
                  return (
                    <button
                      key={mKey}
                      onClick={() => setSelectedMonth(mKey)}
                      style={{
                        padding: '8px 14px',
                        borderRadius: 20,
                        border: '1px solid',
                        borderColor: isSelected ? 'var(--accent)' : 'var(--border)',
                        background: isSelected ? 'var(--accent)' : 'var(--bg-card)',
                        color: isSelected ? 'var(--text-inverse)' : hasData ? 'var(--text-primary)' : 'var(--text-muted)',
                        fontSize: 13,
                        fontWeight: 600,
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                        opacity: hasData || isSelected ? 1 : 0.55
                      }}
                    >
                      {monthLabel(mKey, true)}{isCurrent ? ' •' : ''}
                    </button>
                  );
                })}
              </div>

              {/* Total for selected month */}
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 16 }}>
                <span style={{ fontSize: 32, fontWeight: 700, color: 'var(--text-primary)' }}>{selectedMonthTotal}</span>
                <span style={{ fontSize: 14, color: 'var(--text-secondary)' }}>emails sent in {monthLabel(selectedMonth)}</span>
              </div>

              {!selectedMonthEntry ? (
                <div style={{ textAlign: 'center', padding: '36px 16px', color: 'var(--text-muted)', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8 }}>
                  <p style={{ margin: 0, fontSize: 14 }}>No data for this month yet.</p>
                </div>
              ) : (
                <>
                  {/* Stage Picker */}
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
                    {selectedMonthStageKeys.map(stage => {
                      const count = selectedMonthEntry.stages[stage]?.length || 0;
                      const isSelected = stage === selectedStage;
                      return (
                        <button
                          key={stage}
                          onClick={() => setSelectedStage(stage)}
                          style={{
                            padding: '6px 14px',
                            borderRadius: 20,
                            border: '1px solid',
                            borderColor: isSelected ? 'var(--accent)' : 'var(--border)',
                            background: isSelected ? 'var(--accent)' : 'var(--bg-card)',
                            color: isSelected ? 'var(--text-inverse)' : 'var(--text-primary)',
                            fontSize: 13,
                            fontWeight: 600,
                            cursor: 'pointer',
                            whiteSpace: 'nowrap'
                          }}
                        >
                          {stage} ({count})
                        </button>
                      );
                    })}
                  </div>

                  {/* Lead list for selected stage */}
                  <div style={{ overflow: 'auto', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8 }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, textAlign: 'left' }}>
                      <thead>
                        <tr style={{ background: 'var(--bg-muted)', borderBottom: '2px solid var(--border)' }}>
                          <th style={{ padding: '14px 16px', fontWeight: 600, color: 'var(--text-primary)' }}>Channel / Name</th>
                          <th style={{ padding: '14px 16px', fontWeight: 600, color: 'var(--text-primary)' }}>Email</th>
                          <th style={{ padding: '14px 16px', fontWeight: 600, color: 'var(--text-primary)' }}>Page</th>
                          <th style={{ padding: '14px 16px', fontWeight: 600, color: 'var(--text-primary)' }}>Date Sent</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedStageLeads.map((rec, idx) => (
                          <tr key={rec.leadId + idx} style={{ borderBottom: '1px solid var(--border-light)' }}>
                            <td style={{ padding: '12px 16px', fontWeight: 600, color: 'var(--text-primary)' }}>{rec.channelName || rec.name}</td>
                            <td style={{ padding: '12px 16px', color: 'var(--text-secondary)' }}>{rec.email}</td>
                            <td style={{ padding: '12px 16px' }}>
                              <span style={{
                                fontSize: 10, padding: '2px 6px', borderRadius: 4,
                                background: rec.page === 'new' ? 'var(--accent-light)' : 'var(--bg-hover)',
                                color: rec.page === 'new' ? 'var(--accent)' : 'var(--text-secondary)',
                                fontWeight: 600
                              }}>
                                {rec.page === 'new' ? 'New' : rec.page === 'old' ? 'Old' : 'Stale'}
                              </span>
                            </td>
                            <td style={{ padding: '12px 16px', color: 'var(--text-secondary)' }}>{new Date(rec.date).toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>

                    {selectedStageLeads.length === 0 && (
                      <div style={{ textAlign: 'center', padding: '36px 16px', color: 'var(--text-muted)' }}>
                        <p style={{ margin: 0, fontSize: 14 }}>No leads at this stage this month.</p>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      ) : (
      <>
      {/* Date Switcher Bar */}
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Calendar size={16} style={{ color: 'var(--accent)' }} />
          Select Date Filter
        </h2>
        <div style={{ 
          display: 'flex', 
          gap: 8, 
          overflowX: 'auto', 
          paddingBottom: 8,
          borderBottom: '1px solid var(--border)'
        }}>
          {datesList.map((date) => {
            const isSelected = date.toDateString() === selectedDateStr;
            const label = getDateLabel(date);
            return (
              <button
                key={date.toDateString()}
                onClick={() => setSelectedDateStr(date.toDateString())}
                style={{
                  padding: '8px 16px',
                  borderRadius: 20,
                  border: '1px solid',
                  borderColor: isSelected ? 'var(--accent)' : 'var(--border)',
                  background: isSelected ? 'var(--accent)' : 'var(--bg-card)',
                  color: isSelected ? 'var(--text-inverse)' : 'var(--text-primary)',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  transition: 'all 0.15s ease',
                  boxShadow: isSelected ? '0 2px 4px rgba(37,99,235,0.2)' : 'none'
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Summary Cards */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
        gap: 16,
        marginBottom: 24
      }}>
        <div style={{ padding: 16, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600, textTransform: 'uppercase' }}>Total Batch Volume</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-primary)', marginTop: 4 }}>{summaryMetrics.total}</div>
        </div>
        <div style={{ padding: 16, background: 'var(--accent-light)', border: '1px solid var(--border-focus)', borderRadius: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--blue-text)', fontWeight: 600, textTransform: 'uppercase' }}>Initial Outreach</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--accent)', marginTop: 4 }}>{summaryMetrics.initial}</div>
        </div>
        {state.settings.followUps.map((fu, i) => {
          const colors = [
            { bg: 'var(--yellow-bg)', text: 'var(--yellow-text)' },
            { bg: 'var(--pink-bg)', text: 'var(--pink-text)' },
            { bg: 'var(--blue-bg)', text: 'var(--blue-text)' },
            { bg: 'var(--green-bg)', text: 'var(--green-text)' },
            { bg: 'var(--red-bg)', text: 'var(--red-text)' },
          ];
          const c = colors[i % colors.length];
          const count = (summaryMetrics as any)[`fu${i + 1}`] || 0;
          return (
            <div key={i} style={{ padding: 16, background: c.bg, border: `1px solid ${c.bg}`, borderRadius: 10 }}>
              <div style={{ fontSize: 12, color: c.text, fontWeight: 600, textTransform: 'uppercase' }}>Follow-up {i + 1}</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: c.text, marginTop: 4 }}>{count}</div>
            </div>
          );
        })}
      </div>

      {/* Controls: Search and Filters (Matching NewLeadsPage layout style) */}
      <div style={{ 
        display: 'flex', 
        gap: 16, 
        alignItems: 'center', 
        marginBottom: 20, 
        flexWrap: 'wrap',
        background: 'var(--bg-muted)',
        padding: 12,
        borderRadius: 8,
        border: '1px solid var(--border)'
      }}>
        {/* Search */}
        <div style={{ position: 'relative', flex: 1, minWidth: 240 }}>
          <input
            type="text"
            placeholder="Search this batch by channel name, email, or account..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            style={{
              width: '100%',
              padding: '8px 12px 8px 36px',
              borderRadius: 6,
              border: '1px solid var(--border)',
              fontSize: 14
            }}
          />
          <Search size={16} style={{ position: 'absolute', left: 12, top: 11, color: 'var(--text-muted)' }} />
        </div>
        
        {/* Stage Type Filter Pills */}
        <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 2 }}>
          {typeFilters.map((type) => (
            <button
              key={type}
              onClick={() => setSelectedTypeFilter(type)}
              style={{
                padding: '6px 12px',
                borderRadius: 20,
                border: '1px solid',
                borderColor: selectedTypeFilter === type ? 'var(--accent)' : 'var(--border)',
                background: selectedTypeFilter === type ? 'var(--accent)' : 'var(--bg-card)',
                color: selectedTypeFilter === type ? 'var(--text-inverse)' : 'var(--text-primary)',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                transition: 'all 0.15s ease'
              }}
            >
              {type === 'all' ? 'All Stages' : type}
            </button>
          ))}
        </div>
      </div>

      {/* Batch Details Table */}
      <div style={{ overflow: 'auto', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, textAlign: 'left' }}>
          <thead>
            <tr style={{ background: 'var(--bg-muted)', borderBottom: '2px solid var(--border)' }}>
              <th style={{ padding: '14px 16px', fontWeight: 600, color: 'var(--text-primary)' }}>Channel Name</th>
              <th style={{ padding: '14px 16px', fontWeight: 600, color: 'var(--text-primary)' }}>Email</th>
              <th style={{ padding: '14px 16px', fontWeight: 600, color: 'var(--text-primary)' }}>Sent From Account</th>
              <th style={{ padding: '14px 16px', fontWeight: 600, color: 'var(--text-primary)' }}>Email Stage</th>
              <th style={{ padding: '14px 16px', fontWeight: 600, color: 'var(--text-primary)' }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {filteredItems.map((item, idx) => (
              <tr 
                key={item.id + idx} 
                style={{ 
                  borderBottom: '1px solid var(--border-light)', 
                  transition: 'background 0.1s',
                  cursor: 'default'
                }}
                onMouseEnter={e => e.currentTarget.style.background = '#f8fafc'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                {/* Channel Name */}
                <td style={{ padding: '12px 16px', fontWeight: 600, color: 'var(--text-primary)' }}>
                  {item.channelName}
                  <span style={{
                    fontSize: 10,
                    padding: '2px 6px',
                    borderRadius: 4,
                    marginLeft: 8,
                    background: item.leadPage === 'new' ? 'var(--accent-light)' : 'var(--bg-hover)',
                    color: item.leadPage === 'new' ? 'var(--accent)' : 'var(--text-secondary)',
                    fontWeight: 600
                  }}>
                    {item.leadPage === 'new' ? 'New' : 'Old'}
                  </span>
                </td>

                {/* Email Address */}
                <td style={{ padding: '12px 16px', color: 'var(--text-secondary)' }}>{item.email}</td>

                {/* Sent From Account */}
                <td style={{ padding: '12px 16px', color: 'var(--text-secondary)', fontWeight: 500 }}>
                  {item.sentFromAccount}
                </td>

                {/* Email Stage */}
                <td style={{ padding: '12px 16px' }}>
                  <span style={{
                    padding: '4px 10px',
                    borderRadius: 12,
                    fontSize: 12,
                    fontWeight: 600,
                    background: item.emailType === 'Initial' ? 'var(--blue-bg)' : 'var(--pink-bg)',
                    color: item.emailType === 'Initial' ? 'var(--blue-text)' : 'var(--pink-text)'
                  }}>
                    {item.emailType}
                  </span>
                </td>

                {/* Simulated Status Tag */}
                <td style={{ padding: '12px 16px' }}>
                  <span style={{
                    padding: '4px 8px',
                    borderRadius: 4,
                    fontSize: 11,
                    fontWeight: 500,
                    background: item.statusTag.startsWith('Projected') ? 'var(--bg-hover)' : 'var(--green-bg)',
                    color: item.statusTag.startsWith('Projected') ? 'var(--text-secondary)' : 'var(--green-text)',
                    border: '1px solid',
                    borderColor: item.statusTag.startsWith('Projected') ? 'var(--border)' : 'var(--green-bg)'
                  }}>
                    {item.statusTag}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {filteredItems.length === 0 && (
          <div style={{ textAlign: 'center', padding: '48px 16px', color: 'var(--text-muted)' }}>
            <AlertCircle size={36} style={{ margin: '0 auto 12px', opacity: 0.5 }} />
            <p style={{ margin: 0, fontSize: 15 }}>No emails were sent or are projected for this date.</p>
          </div>
        )}
      </div>
      </>
      )}
    </div>
  );
}
