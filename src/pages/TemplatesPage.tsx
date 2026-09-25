import React, { useState, useMemo } from 'react';
import { useStore } from '../store';
import { Template } from '../types';
import { Plus, Trash2, Edit, X } from 'lucide-react';

interface TemplateStat {
  sent: number;
  real: number;
  automated: number;
  bounced: number;
}

export default function TemplatesPage() {
  const { state, dispatch } = useStore();
  const [activeLeadType, setActiveLeadType] = useState<'new' | 'old'>('new');
  const [editing, setEditing] = useState<Template | null>(null);
  const [creating, setCreating] = useState(false);

  // Per-template send/reply counts. Only leads sent after templateId tracking was
  // added carry a templateId, so this naturally excludes all historical sends.
  const templateStats = useMemo(() => {
    const allLeads = [...state.newLeads, ...state.oldLeads, ...(state.staleLeads || [])];
    const stats: Record<string, TemplateStat> = {};
    for (const lead of allLeads) {
      if (!lead.templateId) continue;
      const s = stats[lead.templateId] || (stats[lead.templateId] = { sent: 0, real: 0, automated: 0, bounced: 0 });
      s.sent++;
      if (lead.status === 'replied') {
        if (lead.bounced) s.bounced++;
        else if (lead.automatedReply) s.automated++;
        else s.real++;
      }
    }
    return stats;
  }, [state.newLeads, state.oldLeads, state.staleLeads]);

  const emptyTemplate: Omit<Template, 'id'> = {
    name: '',
    type: 'initial',
    leadType: activeLeadType,
    subject: '',
    body: ''
  };

  function saveTemplate(template: Template) {
    const isInitial = template.type === 'initial';
    if (!template.name || (isInitial && !template.subject) || !template.body) {
      alert('Fill all required fields');
      return;
    }
    
    const cleanTemplate: Template = {
      ...template,
      subject: isInitial ? template.subject : ''
    };

    if (state.templates.find(t => t.id === cleanTemplate.id)) {
      dispatch({ type: 'UPDATE_TEMPLATE', payload: cleanTemplate });
    } else {
      dispatch({ type: 'ADD_TEMPLATE', payload: { ...cleanTemplate, id: crypto.randomUUID() } });
    }
    setEditing(null);
    setCreating(false);
  }

  function deleteTemplate(id: string) {
    if (!window.confirm('Delete this template?')) return;
    dispatch({ type: 'REMOVE_TEMPLATE', payload: id });
  }

  const grouped: Record<string, Template[]> = {
    initial: state.templates.filter(t => t.type === 'initial' && t.leadType === activeLeadType),
  };
  for (let i = 1; i <= state.settings.followUps.length; i++) {
    grouped[`fu${i}`] = state.templates.filter(t => t.type === `fu${i}` && t.leadType === activeLeadType);
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 700 }}>Templates</h1>
          <p style={{ color: 'var(--text-secondary)' }}>Use {'{{columnName}}'} for variables from CSV</p>
        </div>
        <button
          onClick={() => { setCreating(true); setEditing({ ...emptyTemplate, id: '' } as Template); }}
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
          New Template
        </button>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 24, borderBottom: '1px solid var(--border)', paddingBottom: 12 }}>
        <button
          onClick={() => setActiveLeadType('new')}
          style={{
            padding: '8px 16px',
            background: activeLeadType === 'new' ? 'var(--accent)' : 'transparent',
            color: activeLeadType === 'new' ? 'var(--text-inverse)' : 'var(--text-secondary)',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
            fontWeight: 600,
            transition: 'all 0.2s'
          }}
        >
          New Leads Templates
        </button>
        <button
          onClick={() => setActiveLeadType('old')}
          style={{
            padding: '8px 16px',
            background: activeLeadType === 'old' ? 'var(--accent)' : 'transparent',
            color: activeLeadType === 'old' ? 'var(--text-inverse)' : 'var(--text-secondary)',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
            fontWeight: 600,
            transition: 'all 0.2s'
          }}
        >
          Old Leads Templates
        </button>
      </div>

      {(['initial', ...state.settings.followUps.map((_, i) => `fu${i + 1}`)] as const).map(type => {
        const labels: Record<string, string> = { initial: 'Initial Email' };
        state.settings.followUps.forEach((_, i) => {
          labels[`fu${i + 1}`] = `Follow-up ${i + 1}`;
        });
        const colors: Record<string, string> = {
          initial: 'var(--blue-bg)',
        };
        state.settings.followUps.forEach((_, i) => {
          const stageColors = ['var(--yellow-bg)', 'var(--pink-bg)', 'var(--blue-bg)', 'var(--green-bg)', 'var(--red-bg)'];
          colors[`fu${i + 1}`] = stageColors[i % stageColors.length];
        });
        return (
          <div key={type} style={{ marginBottom: 32 }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>{labels[type]}</h2>
            {grouped[type].length === 0 ? (
              <p style={{ color: 'var(--text-muted)', fontSize: 14, fontStyle: 'italic' }}>No templates created for this stage.</p>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(350px, 1fr))', gap: 16 }}>
                {grouped[type].map(template => (
                  <div 
                    key={template.id} 
                    style={{
                      padding: 16,
                      background: colors[type] || 'var(--bg-muted)',
                      borderRadius: 8,
                      border: '1px solid var(--border)'
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 8 }}>
                      <h3 style={{ fontWeight: 600, fontSize: 16 }}>{template.name}</h3>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button onClick={() => setEditing(template)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}>
                          <Edit size={16} />
                        </button>
                        <button onClick={() => deleteTemplate(template.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--red-text)' }}>
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                    {template.type === 'initial' && (
                      <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 6 }}>
                        <strong>Subject:</strong> {template.subject}
                      </div>
                    )}
                    {templateStats[template.id] ? (
                      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
                        <span>Sent: <strong>{templateStats[template.id].sent}</strong></span>
                        <span>Replied: <strong style={{ color: 'var(--green-text)' }}>{templateStats[template.id].real}</strong></span>
                        {templateStats[template.id].automated > 0 && <span>Auto: {templateStats[template.id].automated}</span>}
                        {templateStats[template.id].bounced > 0 && <span style={{ color: 'var(--red-text)' }}>Bounced: {templateStats[template.id].bounced}</span>}
                        <span style={{ fontWeight: 600 }}>
                          {((templateStats[template.id].real / templateStats[template.id].sent) * 100).toFixed(1)}% reply rate
                        </span>
                      </div>
                    ) : (
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic', marginBottom: 8 }}>
                        No sends tracked yet
                      </div>
                    )}
                    <pre style={{
                      fontSize: 13, 
                      whiteSpace: 'pre-wrap', 
                      fontFamily: 'inherit',
                      color: 'var(--text-primary)',
                      margin: 0
                    }}>
                      {template.body}
                    </pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {(creating || editing) && (
        <div style={{
          position: 'fixed',
          top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 100
        }}>
          <div style={{ background: 'var(--bg-card)', padding: 24, borderRadius: 12, width: 600, maxHeight: '90vh', overflow: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ fontSize: 20, fontWeight: 700 }}>
                {creating ? 'New Template' : 'Edit Template'}
              </h2>
              <button onClick={() => { setEditing(null); setCreating(false); }} style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
                <X size={24} />
              </button>
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Name</label>
                <input
                  value={editing?.name || ''}
                  onChange={e => setEditing(prev => prev ? { ...prev, name: e.target.value } : null)}
                  style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid var(--border)' }}
                  placeholder="e.g. Initial Outreach - Tier 1"
                />
              </div>
              
              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Type</label>
                <select
                  value={editing?.type || 'initial'}
                  onChange={e => setEditing(prev => prev ? { ...prev, type: e.target.value as any } : null)}
                  style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid var(--border)' }}
                >
                  <option value="initial">Initial</option>
                  {state.settings.followUps.map((_, i) => (
                    <option key={`fu${i + 1}`} value={`fu${i + 1}`}>Follow-up {i + 1}</option>
                  ))}
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Lead Type</label>
                <select
                  value={editing?.leadType || 'new'}
                  onChange={e => setEditing(prev => prev ? { ...prev, leadType: e.target.value as any } : null)}
                  style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid var(--border)' }}
                >
                  <option value="new">New Lead</option>
                  <option value="old">Old Lead</option>
                </select>
              </div>
              
              {editing?.type === 'initial' && (
                <div>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Subject</label>
                  <input
                    value={editing?.subject || ''}
                    onChange={e => setEditing(prev => prev ? { ...prev, subject: e.target.value } : null)}
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid var(--border)' }}
                    placeholder="e.g. Collaboration with {{channelName}}"
                  />
                </div>
              )}
              
              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Body</label>
                <textarea
                  value={editing?.body || ''}
                  onChange={e => setEditing(prev => prev ? { ...prev, body: e.target.value } : null)}
                  rows={10}
                  style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid var(--border)', fontFamily: 'inherit' }}
                  placeholder="Type your email body here..."
                />
              </div>
              
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                Available variables: {state.columns.map(c => `{{${c}}}`).join(', ')}
              </div>
              
              <button
                onClick={() => editing && saveTemplate(editing)}
                style={{
                  padding: '10px 16px',
                  background: 'var(--accent)',
                  color: 'var(--text-inverse)',
                  border: 'none',
                  borderRadius: 8,
                  cursor: 'pointer',
                  fontWeight: 600,
                  marginTop: 8
                }}
              >
                Save Template
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}