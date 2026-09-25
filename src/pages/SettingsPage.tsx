import React from 'react';
import { useStore } from '../store';
import { Plus, Trash2 } from 'lucide-react';

export default function SettingsPage() {
  const { state, dispatch } = useStore();

  function updateFollowUp(index: number, delayDays: number) {
    const newFollowUps = state.settings.followUps.map((fu, i) =>
      i === index ? { ...fu, delayDays } : fu
    );
    dispatch({ type: 'UPDATE_SETTINGS', payload: { followUps: newFollowUps } });
  }

  function addFollowUp() {
    const newFollowUps = [...state.settings.followUps, { delayDays: 7 }];
    dispatch({ type: 'UPDATE_SETTINGS', payload: { followUps: newFollowUps } });
  }

  function removeFollowUp(index: number) {
    if (state.settings.followUps.length <= 1) {
      alert('You need at least one follow-up configured.');
      return;
    }
    if (!window.confirm(`Remove Follow-up ${index + 1}?`)) return;
    const newFollowUps = state.settings.followUps.filter((_, i) => i !== index);
    dispatch({ type: 'UPDATE_SETTINGS', payload: { followUps: newFollowUps } });
  }

  return (
    <div>
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 24 }}>Settings</h1>

      <div style={{ maxWidth: 600, display: 'flex', flexDirection: 'column', gap: 24 }}>
        <div style={{ padding: 20, background: 'var(--bg-muted)', borderRadius: 8, border: '1px solid var(--border)' }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>Follow-up Timing</h2>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
            Configure how many follow-ups you want and the delay (in days) before each one is sent. Add or remove follow-ups as needed.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {state.settings.followUps.map((fu, index) => (
              <div key={index} style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '10px 14px',
                background: 'var(--bg-card)',
                borderRadius: 8,
                border: '1px solid var(--border)',
              }}>
                <span style={{ fontWeight: 600, fontSize: 14, minWidth: 100 }}>
                  Follow-up {index + 1}
                </span>
                <label style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-secondary)' }}>
                  Delay (days):
                </label>
                <input
                  type="number"
                  min={1}
                  value={fu.delayDays}
                  onChange={e => updateFollowUp(index, parseInt(e.target.value) || 1)}
                  style={{
                    width: 80,
                    padding: '6px 8px',
                    borderRadius: 6,
                    border: '1px solid var(--border)',
                    fontSize: 14,
                    textAlign: 'center'
                  }}
                />
                <button
                  onClick={() => removeFollowUp(index)}
                  style={{
                    marginLeft: 'auto',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--red-text)',
                    padding: 4,
                    display: 'flex',
                    alignItems: 'center',
                  }}
                  title={`Remove Follow-up ${index + 1}`}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>

          <button
            onClick={addFollowUp}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              marginTop: 12,
              padding: '8px 14px',
              background: 'var(--accent)',
              color: 'var(--text-inverse)',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: 13,
            }}
          >
            <Plus size={16} />
            Add Follow-up
          </button>
        </div>

        <div style={{ padding: 20, background: 'var(--bg-muted)', borderRadius: 8, border: '1px solid var(--border)' }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>Date Cutoff</h2>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
            Emails before this date are ignored (for avoiding collisions with previous service)
          </p>
          <input
            type="date"
            value={state.settings.dateCutoff}
            onChange={e => dispatch({ 
              type: 'UPDATE_SETTINGS', 
              payload: { dateCutoff: e.target.value } 
            })}
            style={{ padding: 8, borderRadius: 6, border: '1px solid var(--border)' }}
          />
        </div>

        <div style={{ padding: 20, background: 'var(--bg-muted)', borderRadius: 8, border: '1px solid var(--border)' }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>Default Daily Limit</h2>
          <input
            type="number"
            value={state.settings.defaultDailyLimit}
            onChange={e => dispatch({ 
              type: 'UPDATE_SETTINGS', 
              payload: { defaultDailyLimit: parseInt(e.target.value) || 50 } 
            })}
            style={{ width: 200, padding: 8, borderRadius: 6, border: '1px solid var(--border)' }}
          />
        </div>

        <div style={{ padding: 20, background: 'var(--bg-muted)', borderRadius: 8, border: '1px solid var(--border)' }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Google OAuth Credentials (Permanent Sync)</h2>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
            To keep your accounts permanently connected (surviving laptop reboots and cookie clears), create a "Web Application" client inside your Google Cloud Console, add <b>http://localhost:3005</b> to Authorized Redirect URIs / JavaScript Origins, and paste both details here.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
                OAuth Client ID
              </label>
              <input
                type="text"
                placeholder="Pasted Client ID..."
                value={state.settings.clientId || ''}
                onChange={e => dispatch({ 
                  type: 'UPDATE_SETTINGS', 
                  payload: { clientId: e.target.value.trim() } 
                })}
                style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid var(--border)' }}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
                OAuth Client Secret
              </label>
              <input
                type="password"
                placeholder="Pasted Client Secret..."
                value={state.settings.clientSecret || ''}
                onChange={e => dispatch({ 
                  type: 'UPDATE_SETTINGS', 
                  payload: { clientSecret: e.target.value.trim() } 
                })}
                style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid var(--border)' }}
              />
            </div>
          </div>
        </div>

        <div style={{ padding: 20, background: 'var(--red-bg)', borderRadius: 8, border: '1px solid var(--red-bg)' }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 8, color: 'var(--red-text)' }}>Danger Zone</h2>
          <button
            onClick={async () => {
              if (!window.confirm('Clear ALL data? This cannot be undone.')) return;
              try {
                // Reset on the server database
                await fetch('http://localhost:3006/api/state/reset', { method: 'POST' });
              } catch (err) {
                console.warn('Server reset failed, falling back to localStorage reset:', err);
              }
              // Also clear localStorage backup
              localStorage.removeItem('coldEmailTracker');
              window.location.reload();
            }}
            style={{
              padding: '8px 16px',
              background: 'var(--red-text)',
              color: 'var(--text-inverse)',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              fontWeight: 600
            }}
          >
            Reset All Data
          </button>
        </div>
      </div>
    </div>
  );
}