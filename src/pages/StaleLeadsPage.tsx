import React, { useState } from 'react';
import { useStore } from '../store';
import { Lead } from '../types';
import { Trash2, RefreshCw, ArrowLeft, Search } from 'lucide-react';
import LeadDrawer from '../components/LeadDrawer';

export default function StaleLeadsPage() {
  const { state, dispatch } = useStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [drawerLead, setDrawerLead] = useState<Lead | null>(null);

  function removeLead(id: string) {
    if (!window.confirm('Delete this stale lead permanently?')) return;
    dispatch({ type: 'REMOVE_LEAD', payload: { id, page: 'stale' } });
  }

  function moveBackTo(lead: Lead, targetPage: 'new' | 'old') {
    if (!window.confirm(`Move this lead back to ${targetPage === 'new' ? 'New Leads' : 'Old Leads'}?`)) return;
    // Remove from stale
    dispatch({ type: 'REMOVE_LEAD', payload: { id: lead.id, page: 'stale' } });
    // Add to target page with page updated, stripping internal tracking fields
    const cleanCustomData = { ...lead.customData };
    delete cleanCustomData['_movedFromPage'];
    delete cleanCustomData['_originalStatus'];
    delete cleanCustomData['_movedAt'];
    dispatch({
      type: 'ADD_LEADS',
      payload: {
        leads: [{
          ...lead,
          page: targetPage,
          status: 'new',
          customData: cleanCustomData,
        }],
        page: targetPage,
      },
    });
  }

  const filtered = state.staleLeads.filter(lead => {
    const q = searchQuery.toLowerCase();
    return (
      lead.email.toLowerCase().includes(q) ||
      lead.name.toLowerCase().includes(q) ||
      Object.values(lead.customData || {}).some(v => String(v || '').toLowerCase().includes(q))
    );
  });

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 700 }}>Stale Leads</h1>
          <p style={{ color: 'var(--text-secondary)' }}>
            {state.staleLeads.length} leads &mdash; re-synced after 60+ days of no contact, moved here for review
          </p>
        </div>
      </div>

      {/* Search */}
      <div style={{
        display: 'flex', gap: 16, alignItems: 'center', marginBottom: 20,
        background: 'var(--bg-muted)', padding: 12, borderRadius: 8, border: '1px solid var(--border)',
      }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 240 }}>
          <input
            type="text"
            placeholder="Search stale leads..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            style={{
              width: '100%', padding: '8px 12px 8px 36px',
              borderRadius: 6, border: '1px solid var(--border)', fontSize: 14,
            }}
          />
          <Search size={16} style={{ position: 'absolute', left: 12, top: 11, color: 'var(--text-muted)' }} />
        </div>
      </div>

      <div style={{ overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid var(--border)', textAlign: 'left' }}>
              <th style={{ padding: 12, fontWeight: 600 }}>Email</th>
              <th style={{ padding: 12, fontWeight: 600 }}>Name</th>
              <th style={{ padding: 12, fontWeight: 600 }}>Orig. Page</th>
              <th style={{ padding: 12, fontWeight: 600 }}>Orig. Status</th>
              <th style={{ padding: 12, fontWeight: 600 }}>Moved At</th>
              <th style={{ padding: 12, fontWeight: 600 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(lead => {
              const movedFrom = lead.customData?.['_movedFromPage'] || '—';
              const originalStatus = lead.customData?.['_originalStatus'] || '—';
              const movedAt = lead.customData?.['_movedAt']
                ? new Date(lead.customData['_movedAt']).toLocaleDateString()
                : '—';

              return (
                <tr key={lead.id} style={{ borderBottom: '1px solid var(--border-light)', cursor: 'pointer', transition: 'background 0.1s' }}
                  onClick={() => setDrawerLead(lead)}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                  <td style={{ padding: 12 }}>{lead.email}</td>
                  <td style={{ padding: 12 }}>{lead.name}</td>
                  <td style={{ padding: 12, textTransform: 'capitalize' }}>{movedFrom}</td>
                  <td style={{ padding: 12 }}>{originalStatus}</td>
                  <td style={{ padding: 12, color: 'var(--text-secondary)', fontSize: 13 }}>{movedAt}</td>
                  <td style={{ padding: 12 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <button
                        title="Move back to New Leads"
                        onClick={(e) => { e.stopPropagation(); moveBackTo(lead, 'new'); }}
                        style={{
                          background: 'var(--accent)', color: 'var(--accent-text)',
                          border: 'none', borderRadius: 6, padding: '6px 12px',
                          cursor: 'pointer', fontWeight: 600, fontSize: 12,
                          display: 'flex', alignItems: 'center', gap: 4,
                        }}
                      >
                        <ArrowLeft size={14} />
                        Back to New
                      </button>
                      <button
                        title="Move back to Old Leads"
                        onClick={(e) => { e.stopPropagation(); moveBackTo(lead, 'old'); }}
                        style={{
                          background: 'var(--bg-hover)', color: 'var(--text-primary)',
                          border: '1px solid var(--border)', borderRadius: 6, padding: '6px 12px',
                          cursor: 'pointer', fontWeight: 600, fontSize: 12,
                          display: 'flex', alignItems: 'center', gap: 4,
                        }}
                      >
                        <ArrowLeft size={14} />
                        Back to Old
                      </button>
                      <button
                        title="Delete permanently"
                        onClick={(e) => { e.stopPropagation(); removeLead(lead.id); }}
                        style={{
                          background: 'none', border: 'none', cursor: 'pointer',
                          color: 'var(--red-text)', padding: 4,
                          display: 'flex', alignItems: 'center',
                        }}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {filtered.length === 0 && (
          <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-muted)' }}>
            <p>{state.staleLeads.length === 0 ? 'No stale leads yet.' : 'No matching stale leads.'}</p>
          </div>
        )}
      </div>

      {drawerLead && <LeadDrawer lead={drawerLead} onClose={() => setDrawerLead(null)} />}
    </div>
  );
}