import React, { useState } from 'react';
import { useStore } from '../store';
import { parseCSV } from '../services/csv';
import { Lead, LeadStatus } from '../types';
import { Upload, Trash2, Edit3, X, Plus, Search, RefreshCw, Download } from 'lucide-react';
import LeadDrawer from '../components/LeadDrawer';
import { analyzeLead } from '../services/gmail';
import { checkFu2Stale } from '../utils/staleLogic';

function truncateText(text: string, maxWords: number = 5): string {
  if (!text) return '';
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(' ') + '...';
}

function needsTruncation(col: string): boolean {
  const norm = col.toLowerCase().replace(/[\s_-]/g, '');
  return norm === 'videotitle' || norm === 'reason' || norm === 'observation';
}

export default function OldLeadsPage() {
  const { state, dispatch } = useStore();
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [editingColumns, setEditingColumns] = useState(false);
  const [newColumn, setNewColumn] = useState('');
  const [drawerLead, setDrawerLead] = useState<Lead | null>(null);
  const [syncingLeads, setSyncingLeads] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedStatus, setSelectedStatus] = useState<'all' | LeadStatus>('all');
  const [singleSyncLogs, setSingleSyncLogs] = useState<string[]>([]);
  const [syncingLeadEmail, setSyncingLeadEmail] = useState<string | null>(null);
  const [editingNameId, setEditingNameId] = useState<string | null>(null);
  const [editingNameValue, setEditingNameValue] = useState('');

  function startEditingName(e: React.MouseEvent, lead: Lead) {
    e.stopPropagation();
    setEditingNameId(lead.id);
    setEditingNameValue(lead.name);
  }

  function saveEditingName(lead: Lead) {
    const trimmed = editingNameValue.trim();
    if (trimmed && trimmed !== lead.name) {
      dispatch({ type: 'UPDATE_LEAD', payload: { ...lead, name: trimmed } });
    }
    setEditingNameId(null);
  }

  // States for Individual Lead Form Modal
  const [showAddLeadModal, setShowAddLeadModal] = useState(false);
  const [newLeadForm, setNewLeadForm] = useState({
    name: '',
    email: '',
    customData: {} as Record<string, string>
  });

  // Dynamic Channel ID resolver
  function getChannelId(row: any): string | undefined {
    const keys = ['channelId', 'channel_id', 'channelID', 'channel_Id', 'channelid'];
    for (const key of keys) {
      if (row[key]) return String(row[key]).trim();
    }
    return undefined;
  }

  // Dynamic Video Title resolver (case-insensitive autodetection)
  function getVideoTitle(row: any): string {
    if (!row) return '';
    const keys = Object.keys(row);
    const match = keys.find(k => {
      const norm = k.toLowerCase().replace(/[\s_-]/g, '');
      return norm === 'videotitle' || norm === 'lastvideo' || norm === 'video';
    });
    return match ? String(row[match] || '').trim() : '';
  }

  // Dynamic Channel Name resolver (case-insensitive autodetection)
  function getChannelName(row: any, fallbackName: string = ''): string {
    if (!row) return fallbackName;
    const keys = Object.keys(row);
    const match = keys.find(k => {
      const norm = k.toLowerCase().replace(/[\s_-]/g, '');
      return norm === 'channelname' || norm === 'channel';
    });
    if (match && row[match]) return String(row[match]).trim();
    const nameMatch = keys.find(k => {
      const norm = k.toLowerCase().replace(/[\s_-]/g, '');
      return norm === 'name' || norm === 'fullname';
    });
    if (nameMatch && row[nameMatch]) return String(row[nameMatch]).trim();
    return fallbackName;
  }

  /** Process a dropped/selected file and import leads */
  async function processFile(file: File) {
    if (!file.name.endsWith('.csv') && !file.type.includes('csv') && !file.type.includes('text')) {
      alert('Please select a CSV file.');
      return;
    }

    setImporting(true);
    try {
      const rows = await parseCSV(file);

      if (rows.length === 0) {
        console.warn('[Import] CSV is empty. Aborting.');
        alert("The CSV file is empty.");
        setImporting(false);
        return;
      }

      const existingChannelIds = new Set<string>();
      const existingEmails = new Set<string>();

      [...state.newLeads, ...state.oldLeads].forEach(l => {
        const cid = getChannelId(l.customData);
        if (cid) existingChannelIds.add(cid.toLowerCase());
        if (l.email) existingEmails.add(l.email.toLowerCase());
      });

      let skippedCount = 0;
      const leads: Lead[] = rows.map((row, idx): Lead | null => {
        const email = (row.channel_email || row.channelEmail || row.email || row.Email || row['Email Address'] || row.email_address || '').trim();
        const name = (row.channel_name || row.channelName || row.name || row.Name || '').trim();

        if (!email) {
          if (idx === 0) console.warn('[Import] Row missing email field:', row);
          return null;
        }

        const rowChannelId = getChannelId(row);

        if (rowChannelId && existingChannelIds.has(rowChannelId.toLowerCase())) {
          skippedCount++;
          return null;
        }

        if (existingEmails.has(email.toLowerCase())) {
          skippedCount++;
          return null;
        }

        if (rowChannelId) existingChannelIds.add(rowChannelId.toLowerCase());
        existingEmails.add(email.toLowerCase());

        const customData: Record<string, string> = {};
        for (const [key, val] of Object.entries(row)) {
          const trimmedKey = key.trim();
          const matchedCol = state.columns.find(c => c.toLowerCase() === trimmedKey.toLowerCase());
          if (matchedCol) {
            customData[matchedCol] = String(val || '').trim();
          } else {
            customData[trimmedKey] = String(val || '').trim();
          }
        }

        return {
          id: crypto.randomUUID(),
          email,
          name,
          page: 'old',
          status: 'new',
          customData: {
            ...customData,
            channelName: getChannelName(row, name),
            videoTitle: getVideoTitle(row),
          },
          createdAt: new Date().toISOString()
        };
      }).filter((l): l is Lead => l !== null);

      dispatch({ type: 'ADD_LEADS', payload: { leads, page: 'old' } });
      alert(`Import complete! Added ${leads.length} old leads. Skipped ${skippedCount} duplicates/empty records.`);
    } catch (err: any) {
      console.error('[Import] Error during upload:', err);
      alert(err?.message || 'Failed to parse CSV');
    }
    setImporting(false);
  }

  /** Drag-and-drop handlers */
  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragging(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDragging(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);

    const file = e.dataTransfer?.files?.[0];
    if (file) {
      processFile(file);
    }
  }

  function handleAddLeadSubmit(e: React.FormEvent) {
    e.preventDefault();
    const email = newLeadForm.email.trim();
    const name = newLeadForm.name.trim();

    if (!email || !email.includes('@')) {
      alert('Please enter a valid email address.');
      return;
    }

    const existingChannelIds = new Set<string>();
    const existingEmails = new Set<string>();
    [...state.newLeads, ...state.oldLeads].forEach(l => {
      const cid = getChannelId(l.customData);
      if (cid) existingChannelIds.add(cid.toLowerCase());
      if (l.email) existingEmails.add(l.email.toLowerCase());
    });

    const formChannelId = getChannelId(newLeadForm.customData);

    // 1. Channel ID deduplication check
    if (formChannelId && existingChannelIds.has(formChannelId.toLowerCase())) {
      alert(`A lead with Channel ID "${formChannelId}" already exists (duplicate skipped).`);
      return;
    }

    // 2. Email deduplication check
    if (existingEmails.has(email.toLowerCase())) {
      alert(`A lead with email "${email}" already exists (duplicate skipped).`);
      return;
    }

    // Initialize customData with empty values for all registered columns
    const customData: Record<string, string> = {};
    state.columns.forEach(col => {
      customData[col] = '';
    });
    // Overlay values filled in the modal
    Object.assign(customData, newLeadForm.customData);
    
    // Maintain standard fields
    customData.channelName = getChannelName(customData, name || customData.channelName);
    customData.videoTitle = getVideoTitle(customData);

    const newLead: Lead = {
      id: crypto.randomUUID(),
      email,
      name,
      page: 'old',
      status: 'new',
      customData,
      createdAt: new Date().toISOString()
    };

    dispatch({
      type: 'ADD_LEADS',
      payload: { leads: [newLead], page: 'old' }
    });

    setShowAddLeadModal(false);
    setNewLeadForm({ name: '', email: '', customData: {} });
    alert('Old lead added successfully!');
  }

  function addColumn() {
    if (!newColumn.trim()) return;
    if (state.columns.includes(newColumn.trim())) return;
    dispatch({ type: 'SET_COLUMNS', payload: [...state.columns, newColumn.trim()] });
    setNewColumn('');
  }

  function removeColumn(col: string) {
    if (['name', 'email'].includes(col)) {
      alert('Cannot remove name or email columns');
      return;
    }
    dispatch({ type: 'SET_COLUMNS', payload: state.columns.filter(c => c !== col) });
  }

  function removeLead(id: string) {
    if (!window.confirm('Delete this lead?')) return;
    dispatch({ type: 'REMOVE_LEAD', payload: { id, page: 'old' } });
  }

  async function syncSingleLead(lead: Lead) {
    if (!state.accounts.length) {
      alert('Add Gmail accounts first in the Accounts page');
      return;
    }
    setSyncingLeads(prev => {
      const next = new Set(prev);
      next.add(lead.id);
      return next;
    });
    setSyncingLeadEmail(lead.email);
    setSingleSyncLogs([`[${new Date().toLocaleTimeString()}] Starting status sync for old lead ${lead.email}...`]);
    try {
      const updates = await analyzeLead(
        lead,
        state.accounts,
        state.settings.dateCutoff,
        state.settings.followUps,
        (msg) => setSingleSyncLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]),
        (updatedAcc) => dispatch({ type: 'UPDATE_ACCOUNT', payload: updatedAcc }),
        state.settings
      );
      
      // Mark this lead as having been through the sync pipeline at least once.
      updates.syncedOnce = true;

      let movedToStale = false;

      // Skip reset for replied or draft leads — those are active conversations
      const syncResultStatus = updates.status || lead.status;
      const isActiveConversation = syncResultStatus === 'replied' || syncResultStatus === 'draft';

      // Highest-priority rule: lead has exhausted the follow-up sequence (sitting at the
      // final fuN_sent status) and has gone dark (no contact/reply) for 60+ days → stale.
      const fu2Check = checkFu2Stale(lead, updates, (state.settings.followUps || []).length);

      if (fu2Check.shouldMoveToStale) {
        dispatch({ type: 'MOVE_TO_STALE', payload: { id: lead.id, sourcePage: 'old', updates } });
        movedToStale = true;
        setSingleSyncLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] -> Lead at ${fu2Check.lastFuStatus}, no contact/reply for ${Math.floor(fu2Check.daysSince!)} day(s) (> 60 day cutoff). Moving to Stale Leads.`]);
      } else if (!isActiveConversation && updates.lastContactDate) {
        const daysSince = (Date.now() - new Date(updates.lastContactDate).getTime()) / (1000 * 60 * 60 * 24);

        if (daysSince > 60) {
          // >60 days since last contact → reset to new in place
          setSingleSyncLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] -> Lead last contacted ${Math.floor(daysSince)} day(s) ago (> 60 day cutoff). Resetting status to: new.`]);
          updates.status = 'new';
          updates.threadId = undefined;
          updates.sentFromAccount = undefined;
          updates.lastContactDate = undefined;
          updates.firstReplyDate = undefined;
        } else {
          setSingleSyncLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] -> Lead last contacted ${Math.floor(daysSince)} day(s) ago (< 60 day cutoff). Keeping status: ${updates.status}.`]);
        }
      }

      if (!movedToStale) {
        dispatch({
          type: 'UPDATE_LEAD',
          payload: { ...lead, ...updates }
        });
      }
      setSingleSyncLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] Sync completed! Resolved status: ${updates.status}`]);
    } catch (err) {
      console.error(err);
      setSingleSyncLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] Error: ${err}`]);
    } finally {
      setSyncingLeads(prev => {
        const next = new Set(prev);
        next.delete(lead.id);
        return next;
      });
    }
  }

  function exportToCSV() {
    const leads = state.oldLeads;
    if (leads.length === 0) {
      alert('No leads to export.');
      return;
    }

    // Build columns: email, name, custom columns (excluding name/email), status, lead type
    const customCols = state.columns.filter(c => !['name', 'email'].includes(c));
    const headers = ['Email', 'Name', ...customCols, 'Status', 'LeadType'];

    const rows = leads.map(lead => {
      const row: string[] = [
        lead.email,
        lead.name,
        ...customCols.map(col => (lead.customData[col] || '')),
        lead.status,
        'old'
      ];
      return row.map(val => `"${String(val).replace(/"/g, '""')}"`).join(',');
    });

    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `old-leads-export-${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  const filteredLeads = state.oldLeads.filter(lead => {
    const matchesSearch = 
      lead.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
      lead.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      Object.values(lead.customData || {}).some(val => String(val || '').toLowerCase().includes(searchQuery.toLowerCase()));
      
    const matchesStatus = selectedStatus === 'all' || lead.status === selectedStatus;
    
    return matchesSearch && matchesStatus;
  });

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 700 }}>Old Leads</h1>
          <p style={{ color: 'var(--text-secondary)' }}>{state.oldLeads.length} leads</p>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <button
            onClick={exportToCSV}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '10px 16px',
              background: 'var(--bg-hover)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              cursor: 'pointer',
              fontWeight: 600
            }}
          >
            <Download size={16} />
            Export CSV
          </button>

          <button
            onClick={() => setEditingColumns(!editingColumns)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '10px 16px',
              background: 'var(--bg-hover)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              cursor: 'pointer',
              fontWeight: 600
            }}
          >
            <Edit3 size={16} />
            Columns
          </button>

          <button
            onClick={() => {
              setNewLeadForm({ name: '', email: '', customData: {} });
              setShowAddLeadModal(true);
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '10px 16px',
              background: 'var(--accent)',
              color: 'var(--accent-text)',
              border: 'none',
              borderRadius: 8,
              cursor: 'pointer',
              fontWeight: 600
            }}
          >
            <Plus size={16} />
            Add Lead
          </button>

        </div>
      </div>

      {/* Drag-and-drop CSV import zone */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        style={{
          border: '2px dashed',
          borderColor: dragging ? 'var(--accent)' : 'var(--border)',
          borderRadius: 12,
          padding: '32px 24px',
          marginBottom: 20,
          textAlign: 'center',
          cursor: 'default',
          background: dragging ? 'var(--accent-light)' : 'var(--bg-muted)',
          transition: 'all 0.2s ease',
          opacity: importing ? 0.6 : 1,
          pointerEvents: importing ? 'none' : undefined,
        }}
      >
        <Upload
          size={32}
          style={{
            color: dragging ? 'var(--accent)' : 'var(--text-muted)',
            marginBottom: 8,
          }}
        />
        <div style={{ fontWeight: 600, fontSize: 14, color: dragging ? 'var(--accent)' : 'var(--text-secondary)' }}>
          {importing
            ? 'Importing CSV...'
            : dragging
              ? 'Drop CSV file here'
              : 'Drag & drop a CSV file here to import'
          }
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
          {importing ? 'Processing...' : 'Column headers must match your current columns'}
        </div>
      </div>

      {editingColumns && (
        <div style={{ padding: 16, background: 'var(--bg-muted)', borderRadius: 8, marginBottom: 24, border: '1px solid var(--border)' }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>Manage Columns</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            {state.columns.map(col => (
              <span key={col} style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '4px 10px',
                background: 'var(--bg-card)',
                border: '1px solid var(--border)',
                borderRadius: 16,
                fontSize: 13
              }}>
                {col}
                {!['name', 'email'].includes(col) && (
                  <button onClick={() => removeColumn(col)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                    <X size={14} />
                  </button>
                )}
              </span>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={newColumn}
              onChange={e => setNewColumn(e.target.value)}
              placeholder="New column name..."
              style={{ flex: 1, padding: 8, borderRadius: 6, border: '1px solid var(--border)' }}
              onKeyPress={e => e.key === 'Enter' && addColumn()}
            />
            <button onClick={addColumn} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '8px 12px', background: 'var(--green-text)', color: 'var(--text-inverse)', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
              <Plus size={16} /> Add
            </button>
          </div>
        </div>
      )}

      {/* Search and Status Filters */}
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
        <div style={{ position: 'relative', flex: 1, minWidth: 240 }}>
          <input
            type="text"
            placeholder="Search old leads by name, email, or details..."
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
        
        <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 2 }}>
          {(() => {
            const statuses = ['all', 'new', 'draft', 'initial_sent'];
            for (let i = 1; i <= state.settings.followUps.length; i++) {
              statuses.push(`needs_fu${i}`, `fu${i}_sent`);
            }
            statuses.push('replied');
            const labels: Record<string, string> = {
              all: 'All Leads', new: 'New (Needs Analysis)', draft: 'Draft', initial_sent: 'Initial Sent', replied: 'Replied'
            };
            state.settings.followUps.forEach((_, i) => {
              labels[`needs_fu${i + 1}`] = `Needs FU${i + 1}`;
              labels[`fu${i + 1}_sent`] = `FU${i + 1} Sent`;
            });
            return statuses.map((status) => (
              <button
                key={status}
                onClick={() => setSelectedStatus(status as any)}
                style={{
                  padding: '6px 12px',
                  borderRadius: 20,
                  border: '1px solid',
                  borderColor: selectedStatus === status ? 'var(--accent)' : 'var(--border)',
                  background: selectedStatus === status ? 'var(--accent)' : 'var(--bg-card)',
                  color: selectedStatus === status ? 'var(--text-inverse)' : 'var(--text-primary)',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  transition: 'all 0.15s ease'
                }}
              >
                {labels[status] || status}
              </button>
            ));
          })()}
        </div>
      </div>

      {syncingLeadEmail && (
        <div style={{
          background: '#0f172a',
          color: '#38bdf8',
          padding: 16,
          borderRadius: 8,
          marginBottom: 20,
          fontFamily: 'monospace',
          fontSize: 13,
          boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -1px rgba(0,0,0,0.06)',
          border: '1px solid #1e293b'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, borderBottom: '1px solid #334155', paddingBottom: 6 }}>
            <span style={{ fontWeight: 600, color: '#f8fafc' }}>Sync Log: {syncingLeadEmail}</span>
            <button 
              onClick={() => { setSyncingLeadEmail(null); setSingleSyncLogs([]); }}
              style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 12 }}
            >
              Clear Logs
            </button>
          </div>
          <div style={{ maxHeight: 150, overflowY: 'auto' }}>
            {singleSyncLogs.map((log, idx) => (
              <div key={idx} style={{ 
                marginBottom: 4,
                color: log.includes('Error') ? 'var(--red-text)' : 
                       log.includes('Sync completed!') ? '#34d399' : '#cbd5e1'
              }}>
                {log}
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid var(--border)', textAlign: 'left' }}>
              <th style={{ padding: 12 }}>Email</th>
              <th style={{ padding: 12 }}>Name</th>
              {state.columns.filter(c => !['name', 'email'].includes(c)).map(col => (
                <th key={col} style={{ padding: 12 }}>{col}</th>
              ))}
              <th style={{ padding: 12 }}>Status</th>
              <th style={{ padding: 12 }}>Last Contact</th>
              <th style={{ padding: 12 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredLeads.map(lead => {
              const isSyncing = syncingLeads.has(lead.id);
              return (
                <tr 
                  key={lead.id} 
                  style={{ borderBottom: '1px solid var(--border-light)', cursor: 'pointer' }}
                  onClick={() => setDrawerLead(lead)}
                >
                  <td style={{ padding: 12 }}>{lead.email}</td>
                  <td style={{ padding: 12 }} onClick={e => editingNameId !== lead.id && startEditingName(e, lead)}>
                    {editingNameId === lead.id ? (
                      <input
                        autoFocus
                        value={editingNameValue}
                        onChange={e => setEditingNameValue(e.target.value)}
                        onClick={e => e.stopPropagation()}
                        onBlur={() => saveEditingName(lead)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') saveEditingName(lead);
                          if (e.key === 'Escape') setEditingNameId(null);
                        }}
                        style={{
                          width: '100%',
                          padding: '4px 6px',
                          border: '1px solid var(--accent)',
                          borderRadius: 4,
                          fontSize: 14,
                          background: 'var(--bg-card)',
                          color: 'var(--text-primary)'
                        }}
                      />
                    ) : (
                      <span title="Click to edit" style={{ cursor: 'text' }}>{lead.name}</span>
                    )}
                  </td>
                  {state.columns.filter(c => !['name', 'email'].includes(c)).map(col => {
                    const raw = lead.customData[col];
                    return (
                      <td key={col} style={{ padding: 12, color: 'var(--text-secondary)' }}>
                        {needsTruncation(col) ? (
                          <span title={raw || ''} style={{ cursor: 'help' }}>
                            {truncateText(raw) || '—'}
                          </span>
                        ) : (
                          raw || '—'
                        )}
                      </td>
                    );
                  })}
                  <td style={{ padding: 12 }}>
                    <span style={{
                      padding: '4px 10px',
                      borderRadius: 12,
                      fontSize: 12,
                      fontWeight: 600,
                      background: lead.status === 'new'
                        ? (lead.lastAnalyzed ? 'var(--accent-light)' : 'var(--yellow-bg)')
                        : (lead.status === 'replied' ? 'var(--green-bg)' : 'var(--blue-bg)'),
                      color: lead.status === 'new'
                        ? (lead.lastAnalyzed ? 'var(--accent)' : 'var(--yellow-text)')
                        : (lead.status === 'replied' ? 'var(--green-text)' : 'var(--blue-text)')
                    }}>
                      {lead.status === 'new' 
                        ? (lead.lastAnalyzed ? 'New (Synced)' : 'Needs Analysis') 
                        : lead.status}
                    </span>
                  </td>
                  <td style={{ padding: 12, color: 'var(--text-secondary)', fontSize: 13 }}>
                    {lead.lastContactDate ? new Date(lead.lastContactDate).toLocaleDateString() : '—'}
                  </td>
                  <td style={{ padding: 12 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <button
                        title="Sync Status"
                        disabled={isSyncing}
                        onClick={e => { e.stopPropagation(); syncSingleLead(lead); }}
                        style={{ 
                          background: 'none', 
                          border: 'none', 
                          cursor: isSyncing ? 'not-allowed' : 'pointer', 
                          color: 'var(--accent)',
                          padding: 4,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center'
                        }}
                      >
                        <RefreshCw size={16} style={{ animation: isSyncing ? 'spin 1s linear infinite' : 'none' }} />
                      </button>
                      <button
                        title="Delete Lead"
                        onClick={e => { e.stopPropagation(); removeLead(lead.id); }}
                        style={{ 
                          background: 'none', 
                          border: 'none', 
                          cursor: 'pointer', 
                          color: 'var(--red-text)',
                          padding: 4,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center'
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
        
        {filteredLeads.length === 0 && (
          <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-muted)' }}>
            <p>No matching old leads found.</p>
          </div>
        )}
      </div>

      {/* POPUP MODAL: Add Individual Old Lead */}
      {showAddLeadModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(15, 23, 42, 0.6)',
          backdropFilter: 'blur(4px)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 1000,
          padding: 20
        }}>
          <div style={{
            background: 'var(--bg-card)',
            borderRadius: 12,
            width: '100%',
            maxWidth: 500,
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04)',
            overflow: 'hidden'
          }}>
            {/* Modal Header */}
            <div style={{
              padding: '16px 24px',
              borderBottom: '1px solid var(--border)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
                Add New Old Lead
              </h2>
              <button
                onClick={() => setShowAddLeadModal(false)}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 4 }}
              >
                <X size={20} />
              </button>
            </div>

            {/* Modal Form */}
            <form onSubmit={handleAddLeadSubmit}>
              <div style={{ padding: '20px 24px', maxHeight: '60vh', overflowY: 'auto' }}>
                <div style={{ marginBottom: 12 }}>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>
                    Email Address *
                  </label>
                  <input
                    type="email"
                    required
                    value={newLeadForm.email}
                    onChange={e => setNewLeadForm(prev => ({ ...prev, email: e.target.value }))}
                    placeholder="lead@example.com"
                    style={{
                      width: '100%',
                      padding: 8,
                      borderRadius: 6,
                      border: '1px solid var(--border)',
                      fontSize: 13
                    }}
                  />
                </div>

                <div style={{ marginBottom: 12 }}>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>
                    Full Name
                  </label>
                  <input
                    type="text"
                    value={newLeadForm.name}
                    onChange={e => setNewLeadForm(prev => ({ ...prev, name: e.target.value }))}
                    placeholder="John Doe"
                    style={{
                      width: '100%',
                      padding: 8,
                      borderRadius: 6,
                      border: '1px solid var(--border)',
                      fontSize: 13
                    }}
                  />
                </div>

                {/* Custom Fields Dynamically Renders */}
                {state.columns.filter(col => !['name', 'email'].includes(col)).map(col => (
                  <div key={col} style={{ marginBottom: 12 }}>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>
                      {col.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase())}
                    </label>
                    <input
                      type="text"
                      value={newLeadForm.customData[col] || ''}
                      onChange={e => setNewLeadForm(prev => ({
                        ...prev,
                        customData: {
                          ...prev.customData,
                          [col]: e.target.value
                        }
                      }))}
                      placeholder={`Enter ${col}...`}
                      style={{
                        width: '100%',
                        padding: 8,
                        borderRadius: 6,
                        border: '1px solid var(--border)',
                        fontSize: 13
                      }}
                    />
                  </div>
                ))}
              </div>

              {/* Modal Footer */}
              <div style={{
                padding: '12px 24px',
                borderTop: '1px solid var(--border)',
                display: 'flex',
                justifyContent: 'flex-end',
                gap: 8,
                background: 'var(--bg-muted)'
              }}>
                <button
                  type="button"
                  onClick={() => setShowAddLeadModal(false)}
                  style={{
                    padding: '8px 16px',
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    cursor: 'pointer',
                    fontWeight: 600,
                    fontSize: 13,
                    color: 'var(--text-primary)'
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  style={{
                    padding: '8px 16px',
                    background: 'var(--accent)',
                    color: 'var(--text-inverse)',
                    border: 'none',
                    borderRadius: 6,
                    cursor: 'pointer',
                    fontWeight: 600,
                    fontSize: 13
                  }}
                >
                  Save Lead
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {drawerLead && <LeadDrawer lead={drawerLead} onClose={() => setDrawerLead(null)} />}
    </div>
  );
}