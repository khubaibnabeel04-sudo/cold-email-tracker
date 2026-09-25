import React, { useMemo, useState } from 'react';
import { useStore } from '../store';
import { Flame, Target, UserPlus, Send, Repeat, Layers } from 'lucide-react';

// Formats using LOCAL date components (not toISOString, which is UTC and
// lands on the previous calendar day for positive UTC-offset timezones).
function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

function formatShort(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Small bar chart matching the style used on the Analytics page's 30-day activity chart. */
function BarChart({ values, color }: { values: number[]; color: string }) {
  const maxVal = Math.max(...values, 1);
  return (
    <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: 60 }}>
      {values.map((v, i) => (
        <div key={i} title={String(v)} style={{
          flex: 1,
          height: Math.max((v / maxVal) * 100, 1) + '%',
          background: color,
          borderRadius: '2px 2px 0 0',
          opacity: v > 0 ? 0.9 : 0.12,
        }} />
      ))}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      background: 'var(--bg-card)',
      border: '1px solid var(--border)',
      borderRadius: 12,
      padding: 20,
      boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
    }}>
      {children}
    </div>
  );
}

export default function GoalsPage() {
  const { state, dispatch } = useStore();
  const { goals } = state;

  const [editing, setEditing] = useState(!goals.taskName);
  const [taskNameInput, setTaskNameInput] = useState(goals.taskName);
  const [totalDaysInput, setTotalDaysInput] = useState(String(goals.totalDays));

  const today = toDateStr(new Date());

  // ─── Day range for the configured challenge ───
  const days = useMemo(() => {
    const arr: string[] = [];
    for (let i = 0; i < goals.totalDays; i++) arr.push(addDays(goals.startDate, i));
    return arr;
  }, [goals.startDate, goals.totalDays]);

  const doneCount = days.filter(d => goals.checkIns[d]).length;
  const progressPct = goals.totalDays > 0 ? Math.round((doneCount / goals.totalDays) * 100) : 0;

  // ─── Streaks (current + best), only counting days up to today ───
  const { currentStreak, bestStreak } = useMemo(() => {
    let best = 0;
    let running = 0;
    let current = 0;
    for (const d of days) {
      if (d > today) break; // don't count future days
      if (goals.checkIns[d]) {
        running++;
        best = Math.max(best, running);
      } else {
        running = 0;
      }
    }
    // current streak = run of checked days ending at the most recent past-or-today day
    for (let i = days.length - 1; i >= 0; i--) {
      const d = days[i];
      if (d > today) continue;
      if (goals.checkIns[d]) current++;
      else break;
    }
    return { currentStreak: current, bestStreak: best };
  }, [days, goals.checkIns, today]);

  function saveConfig() {
    const totalDays = Math.max(1, Math.min(365, parseInt(totalDaysInput) || 30));
    dispatch({
      type: 'GOAL_SET_CONFIG',
      payload: { taskName: taskNameInput.trim() || 'My daily task', totalDays, startDate: goals.taskName ? goals.startDate : today },
    });
    setEditing(false);
  }

  function toggleDay(date: string) {
    if (date > today) return; // can't check off the future
    dispatch({ type: 'GOAL_TOGGLE_DAY', payload: { date } });
  }

  function resetChallenge() {
    if (!window.confirm('Start a new challenge? This clears all check-ins.')) return;
    dispatch({ type: 'GOAL_RESET' });
    setTaskNameInput('');
    setTotalDaysInput('30');
    setEditing(true);
  }

  // ─── Bottom section: auto-computed input metrics, derived from existing lead/MOF data ───
  // Tracks the SAME date range as the goal itself — starts counting from the day the goal
  // was set and runs for the full configured duration, so today's activity shows up
  // immediately and every prior day since day 1 stays visible as the challenge progresses.
  const allLeads = useMemo(() => [...state.newLeads, ...state.oldLeads, ...state.staleLeads], [state.newLeads, state.oldLeads, state.staleLeads]);

  const metrics = useMemo(() => {
    const newLeadsSourced = days.map(d =>
      allLeads.filter(l => l.createdAt && toDateStr(new Date(l.createdAt)) === d).length
    );
    const initialSent = days.map(d =>
      allLeads.filter(l => l.lastContactDate && toDateStr(new Date(l.lastContactDate)) === d && l.status === 'initial_sent').length
    );
    const followUpsSent = days.map(d =>
      allLeads.filter(l => l.lastContactDate && toDateStr(new Date(l.lastContactDate)) === d && /^fu\d+_sent$/.test(l.status)).length
    );
    const mofRecords = Object.values(state.mof.followUpHistory || {}).flat();
    const mofTouchesSent = days.map(d =>
      mofRecords.filter(r => r.sentAt && toDateStr(new Date(r.sentAt)) === d).length
    );
    return { newLeadsSourced, initialSent, followUpsSent, mofTouchesSent };
  }, [allLeads, days, state.mof.followUpHistory]);

  const metricCards = [
    { label: 'New Leads Sourced', icon: UserPlus, color: 'var(--blue-text)', values: metrics.newLeadsSourced },
    { label: 'Initial Outreach Sent', icon: Send, color: 'var(--accent)', values: metrics.initialSent },
    { label: 'Follow-ups Sent', icon: Repeat, color: 'var(--yellow-text)', values: metrics.followUpsSent },
    { label: 'MOF Touches Sent', icon: Layers, color: 'var(--green-text)', values: metrics.mofTouchesSent },
  ];

  return (
    <div style={{ maxWidth: 1200 }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, margin: '0 0 4px', color: 'var(--text-primary)' }}>Goals</h1>
        <p style={{ fontSize: 14, color: 'var(--text-secondary)', margin: 0 }}>
          Track whether you did the input task that actually moves revenue — not the outcome.
        </p>
      </div>

      {/* ─── Daily Task Tracker ─── */}
      <Card>
        {editing ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 480 }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>Set up your tracker</h3>
            <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>
              What's the one task you're tracking?
            </label>
            <input
              type="text"
              value={taskNameInput}
              onChange={e => setTaskNameInput(e.target.value)}
              placeholder="e.g. Send 20 outreach emails"
              style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 14 }}
            />
            <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>
              Number of days to track
            </label>
            <input
              type="number"
              min={1}
              max={365}
              value={totalDaysInput}
              onChange={e => setTotalDaysInput(e.target.value)}
              style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 14, width: 120 }}
            />
            <button
              onClick={saveConfig}
              style={{ alignSelf: 'flex-start', padding: '8px 16px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
            >
              Start Tracking
            </button>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Target size={18} color="var(--accent)" />
                  <h3 style={{ fontSize: 16, fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>{goals.taskName}</h3>
                </div>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0' }}>
                  {formatShort(goals.startDate)} → {formatShort(days[days.length - 1])} ({goals.totalDays} days)
                </p>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => setEditing(true)}
                  style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                  Edit
                </button>
                <button onClick={resetChallenge}
                  style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--red-text)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                  Restart
                </button>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', background: 'var(--bg-muted)', borderRadius: 8 }}>
                <Flame size={18} color="var(--red-text)" />
                <div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>{currentStreak}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Current streak</div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', background: 'var(--bg-muted)', borderRadius: 8 }}>
                <Flame size={18} color="var(--yellow-text)" />
                <div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>{bestStreak}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Best streak</div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', background: 'var(--bg-muted)', borderRadius: 8 }}>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--accent)' }}>{doneCount}/{goals.totalDays}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Days completed ({progressPct}%)</div>
                </div>
              </div>
            </div>

            {/* Day grid — click to check/uncheck */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(34px, 1fr))', gap: 6, marginBottom: 20 }}>
              {days.map(d => {
                const checked = !!goals.checkIns[d];
                const isFuture = d > today;
                const isToday = d === today;
                return (
                  <button
                    key={d}
                    title={`${formatShort(d)}${isFuture ? ' (upcoming)' : checked ? ' — done' : ' — not done'}`}
                    onClick={() => toggleDay(d)}
                    disabled={isFuture}
                    style={{
                      width: '100%',
                      aspectRatio: '1',
                      borderRadius: 6,
                      border: isToday ? '2px solid var(--accent)' : '1px solid var(--border)',
                      background: isFuture ? 'var(--bg-page)' : checked ? 'var(--green-bg)' : 'var(--bg-muted)',
                      color: checked ? 'var(--green-text)' : 'var(--text-muted)',
                      cursor: isFuture ? 'not-allowed' : 'pointer',
                      fontSize: 11,
                      fontWeight: 700,
                      opacity: isFuture ? 0.4 : 1,
                    }}
                  >
                    {checked ? '✓' : ''}
                  </button>
                );
              })}
            </div>

            {/* Graph of the same data */}
            <BarChart values={days.map(d => (goals.checkIns[d] ? 1 : 0))} color="var(--accent)" />
          </>
        )}
      </Card>

      {/* ─── Auto-computed input metrics ─── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16, marginTop: 20 }}>
        {metricCards.map(m => {
          const Icon = m.icon;
          const total = m.values.reduce((s, v) => s + v, 0);
          return (
            <Card key={m.label}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Icon size={16} color={m.color} />
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>{m.label}</span>
                </div>
                <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>{total}</span>
              </div>
              <BarChart values={m.values} color={m.color} />
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                {formatShort(goals.startDate)} → {formatShort(days[days.length - 1])} ({goals.totalDays} days)
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
