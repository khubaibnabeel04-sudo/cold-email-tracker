import React, { useState } from 'react';
import { useStore } from '../store';
import { loginAccount, reLoginAccount, ensureValidToken } from '../services/gmail';
import { Plus, Trash2, Mail, AlertCircle, RefreshCw } from 'lucide-react';

export default function AccountsPage() {
  const { state, dispatch } = useStore();
  const [reloggingIds, setReloggingIds] = useState<Set<string>>(new Set());
  const [refreshingIds, setRefreshingIds] = useState<Set<string>>(new Set());
  const [reloggingAll, setReloggingAll] = useState(false);
  const [refreshingAll, setRefreshingAll] = useState(false);

  async function handleAddAccount() {
    try {
      const account = await loginAccount(state.settings);
      // Apply default daily limit
      account.dailyLimit = state.settings.defaultDailyLimit;
      dispatch({ type: 'ADD_ACCOUNT', payload: account });
      alert(`Added ${account.email}`);
    } catch (err) {
      alert('Login failed: ' + err);
    }
  }

  /**
   * Full re-login: forces OAuth popup with consent prompt.
   * Preserves the account ID so it replaces rather than duplicates.
   */
  async function handleReLogin(accountId: string) {
    const account = state.accounts.find(a => a.id === accountId);
    if (!account) return;
    setReloggingIds(prev => { const n = new Set(prev); n.add(accountId); return n; });
    try {
      const updated = await reLoginAccount(account, state.settings);
      updated.dailyLimit = account.dailyLimit; // preserve limit
      dispatch({ type: 'UPDATE_ACCOUNT', payload: updated });
      alert(`Re-login successful for ${updated.email}`);
    } catch (err) {
      alert(`Re-login failed: ${err}`);
    } finally {
      setReloggingIds(prev => { const n = new Set(prev); n.delete(accountId); return n; });
    }
  }

  /**
   * Silent token refresh (uses refresh token or GIS silent auth).
   * Works without user interaction if the refresh token is still valid.
   */
  async function handleRefreshToken(accountId: string) {
    const account = state.accounts.find(a => a.id === accountId);
    if (!account) return;
    setRefreshingIds(prev => { const n = new Set(prev); n.add(accountId); return n; });
    try {
      await ensureValidToken(
        account,
        (updatedAcc) => dispatch({ type: 'UPDATE_ACCOUNT', payload: updatedAcc }),
        state.settings
      );
      alert(`Token refreshed successfully for ${account.email}`);
    } catch (err) {
      alert(`Token refresh failed for ${account.email}. Try "Re-login" instead.`);
    } finally {
      setRefreshingIds(prev => { const n = new Set(prev); n.delete(accountId); return n; });
    }
  }

  /**
   * Silently refresh tokens for ALL accounts, one by one (no popups).
   * Uses the same silent refresh path as the per-account "Refresh" button.
   */
  async function handleRefreshAllTokens() {
    if (state.accounts.length === 0) {
      alert('No accounts to refresh.');
      return;
    }
    setRefreshingAll(true);
    let successCount = 0;
    let failCount = 0;
    const failedEmails: string[] = [];
    for (const acc of state.accounts) {
      setRefreshingIds(prev => { const n = new Set(prev); n.add(acc.id); return n; });
      try {
        // Hard cap per account so a single stuck account (e.g. a hung silent-auth
        // popup that never calls back) can never freeze the rest of the batch —
        // this is on top of ensureValidToken's own internal timeout, as a safety net.
        await Promise.race([
          ensureValidToken(
            acc,
            (updatedAcc) => dispatch({ type: 'UPDATE_ACCOUNT', payload: updatedAcc }),
            state.settings
          ),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Refresh timed out after 25s')), 25000)),
        ]);
        successCount++;
      } catch (err) {
        console.error(`Token refresh failed for ${acc.email}:`, err);
        failCount++;
        failedEmails.push(acc.email);
      } finally {
        setRefreshingIds(prev => { const n = new Set(prev); n.delete(acc.id); return n; });
      }
    }
    setRefreshingAll(false);
    alert(
      `Refresh complete: ${successCount} succeeded, ${failCount} failed.` +
      (failedEmails.length ? `\n\nFailed: ${failedEmails.join(', ')}\n(Use "Re-login" for these.)` : '')
    );
  }

  /**
   * Re-login all expired accounts, one by one.
   */
  async function handleReLoginAll() {
    const expired = state.accounts.filter(a => a.expiresAt < Date.now());
    if (expired.length === 0) {
      alert('No expired accounts to re-login.');
      return;
    }
    if (!window.confirm(`Re-login all ${expired.length} expired account(s)? Google popups will appear one at a time.`)) return;
    setReloggingAll(true);
    let successCount = 0;
    let failCount = 0;
    for (const acc of expired) {
      try {
        const updated = await reLoginAccount(acc, state.settings);
        updated.dailyLimit = acc.dailyLimit;
        dispatch({ type: 'UPDATE_ACCOUNT', payload: updated });
        successCount++;
      } catch (err) {
        console.error(`Re-login failed for ${acc.email}:`, err);
        failCount++;
      }
    }
    setReloggingAll(false);
    alert(`Re-login complete: ${successCount} succeeded, ${failCount} failed.`);
  }

  function removeAccount(id: string) {
    if (!window.confirm('Remove this account?')) return;
    dispatch({ type: 'REMOVE_ACCOUNT', payload: id });
  }

  function updateLimit(id: string, limit: number) {
    const acc = state.accounts.find(a => a.id === id);
    if (!acc) return;
    dispatch({ type: 'UPDATE_ACCOUNT', payload: { ...acc, dailyLimit: limit } });
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 700 }}>Accounts</h1>
          <p style={{ color: 'var(--text-secondary)' }}>{state.accounts.length} Gmail account{state.accounts.length === 1 ? '' : 's'} connected</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {/* Refresh All button — silently refreshes every account's token, one by one */}
          {state.accounts.length > 0 && (
            <button
              onClick={handleRefreshAllTokens}
              disabled={refreshingAll}
              title="Silently refresh access tokens for all accounts, one by one"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '10px 16px',
                background: refreshingAll ? 'var(--bg-hover)' : 'var(--bg-card)',
                color: 'var(--text-secondary)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                cursor: refreshingAll ? 'not-allowed' : 'pointer',
                fontWeight: 600,
                fontSize: 14,
              }}
            >
              <RefreshCw size={16} style={{ animation: refreshingAll ? 'spin 1s linear infinite' : 'none' }} />
              {refreshingAll ? 'Refreshing all...' : 'Refresh All'}
            </button>
          )}
          {/* Re-login All Expired button */}
          {state.accounts.some(a => a.expiresAt < Date.now()) && (
            <button
              onClick={handleReLoginAll}
              disabled={reloggingAll}
              title="Re-authenticate all expired accounts one by one"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '10px 16px',
                background: reloggingAll ? 'var(--yellow-bg)' : 'var(--red-bg)',
                color: reloggingAll ? 'var(--text-muted)' : 'var(--red-text)',
                border: '1px solid',
                borderColor: reloggingAll ? 'var(--border)' : 'var(--red-bg)',
                borderRadius: 8,
                cursor: reloggingAll ? 'not-allowed' : 'pointer',
                fontWeight: 600,
                fontSize: 14,
              }}
            >
              <AlertCircle size={16} />
              {reloggingAll ? 'Re-logging all...' : `Re-login All Expired (${state.accounts.filter(a => a.expiresAt < Date.now()).length})`}
            </button>
          )}
          <button
            onClick={handleAddAccount}
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
              fontWeight: 600
            }}
          >
            <Plus size={16} />
            Add Gmail Account
          </button>
        </div>
      </div>

      {state.accounts.length === 0 && (
        <div style={{ 
          padding: 40, 
          background: 'var(--bg-muted)', 
          borderRadius: 8, 
          textAlign: 'center',
          border: '1px dashed var(--border)'
        }}>
          <Mail size={48} style={{ color: 'var(--text-muted)', marginBottom: 16 }} />
          <h3 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>No accounts connected</h3>
          <p style={{ color: 'var(--text-secondary)', marginBottom: 16 }}>Add Gmail accounts to start tracking</p>
          <button
            onClick={handleAddAccount}
            style={{
              padding: '10px 20px',
              background: 'var(--accent)',
              color: 'var(--text-inverse)',
              border: 'none',
              borderRadius: 8,
              cursor: 'pointer',
              fontWeight: 600
            }}
          >
            Connect Gmail
          </button>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {state.accounts.map(account => {
          const isExpired = account.expiresAt < Date.now();
          
          return (
            <div 
              key={account.id} 
              style={{ 
                padding: 20, 
                background: 'var(--bg-card)', 
                borderRadius: 8,
                border: '1px solid var(--border)',
                display: 'flex',
                alignItems: 'center',
                gap: 16
              }}
            >
              <div style={{ 
                width: 40, 
                height: 40, 
                borderRadius: '50%', 
                background: 'var(--accent-light)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--accent)'
              }}>
                <Mail size={20} />
              </div>
              
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 16 }}>{account.email}</div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  {isExpired && <AlertCircle size={14} color="var(--red-text)" />}
                  {isExpired ? 'Token expired — re-login needed' : `Sent today: ${account.sentToday}/${account.dailyLimit}`}
                </div>
              </div>
              
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div>
                  <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 2 }}>Daily Limit</label>
                  <input
                    type="number"
                    value={account.dailyLimit}
                    onChange={e => updateLimit(account.id, parseInt(e.target.value) || 50)}
                    style={{ width: 70, padding: 6, borderRadius: 6, border: '1px solid var(--border)', fontSize: 14 }}
                  />
                </div>

                {/* Refresh Token button (silent, no popup) */}
                <button
                  onClick={() => handleRefreshToken(account.id)}
                  disabled={refreshingIds.has(account.id)}
                  title="Silently refresh access token (works if refresh token is still valid)"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '6px 10px',
                    borderRadius: 6,
                    border: '1px solid var(--border)',
                    background: refreshingIds.has(account.id) ? 'var(--bg-hover)' : 'var(--bg-card)',
                    color: 'var(--text-secondary)',
                    cursor: refreshingIds.has(account.id) ? 'not-allowed' : 'pointer',
                    fontSize: 12,
                    fontWeight: 500,
                    whiteSpace: 'nowrap',
                  }}
                >
                  <RefreshCw size={13} style={{ animation: refreshingIds.has(account.id) ? 'spin 1s linear infinite' : 'none' }} />
                  {refreshingIds.has(account.id) ? '...' : 'Refresh'}
                </button>

                {/* Full Re-login button (opens OAuth popup) */}
                {isExpired && (
                  <button
                    onClick={() => handleReLogin(account.id)}
                    disabled={reloggingIds.has(account.id)}
                    title="Fully re-authenticate this account (opens Google sign-in popup)"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '6px 10px',
                      borderRadius: 6,
                      border: 'none',
                      background: reloggingIds.has(account.id) ? 'var(--yellow-bg)' : 'var(--red-text)',
                      color: reloggingIds.has(account.id) ? 'var(--text-muted)' : 'var(--text-inverse)',
                      cursor: reloggingIds.has(account.id) ? 'not-allowed' : 'pointer',
                      fontSize: 12,
                      fontWeight: 600,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <AlertCircle size={13} />
                    {reloggingIds.has(account.id) ? 'Re-logging...' : 'Re-login'}
                  </button>
                )}

                <button
                  onClick={() => removeAccount(account.id)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--red-text)', padding: 8 }}
                >
                  <Trash2 size={18} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}