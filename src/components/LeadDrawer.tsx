import React, { useEffect, useState } from 'react';
import { Lead } from '../types';
import { useStore } from '../store';
import { fetchThreadMessages, ThreadMessage } from '../services/gmail';
import { X, Mail, MessageSquare, Calendar, Loader2, ChevronDown, ChevronUp, Reply, Send } from 'lucide-react';

interface Props {
  lead: Lead | null;
  onClose: () => void;
  onToggleAutomated?: (lead: Lead) => void;
  onSetReplyType?: (lead: Lead, type: 'real' | 'automated' | 'bounced') => void;
  onToggleClosed?: (lead: Lead) => void;
}

function formatEmailDate(dateStr: string): string {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'short' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  } catch {
    return dateStr;
  }
}

export default function LeadDrawer({ lead, onClose, onToggleAutomated, onSetReplyType, onToggleClosed }: Props) {
  const { state, dispatch } = useStore();
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    if (!lead?.threadId) return;
    let cancelled = false;

    async function loadThread() {
      setLoading(true);
      const account = state.accounts.find(a => a.email === lead!.sentFromAccount);
      if (!account) {
        setLoading(false);
        return;
      }
      const msgs = await fetchThreadMessages(
        lead!.threadId!,
        account,
        (updated) => dispatch({ type: 'UPDATE_ACCOUNT', payload: updated }),
        state.settings
      );
      if (!cancelled) {
        setMessages(msgs);
        setLoading(false);
      }
    }

    loadThread();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead?.id, lead?.threadId, lead?.sentFromAccount]);

  if (!lead) return null;

  const followUpCount = state.settings.followUps.length;
  const statusLabels: Record<string, string> = {
    new: 'New',
    draft: 'Draft Exists',
    initial_sent: 'Initial Sent',
    replied: 'Replied'
  };
  for (let i = 1; i <= followUpCount; i++) {
    statusLabels[`needs_fu${i}`] = `Needs Follow-up ${i}`;
    statusLabels[`fu${i}_sent`] = `Follow-up ${i} Sent`;
  }

  return (
    <div style={{
      position: 'fixed',
      top: 0, right: 0, bottom: 0,
      width: 400,
      background: 'var(--bg-card)',
      boxShadow: '-4px 0 24px rgba(0,0,0,0.1)',
      zIndex: 50,
      padding: 24,
      overflow: 'auto',
      borderLeft: '1px solid var(--border)'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700 }}>Lead Details</h2>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
          <X size={24} />
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div>
          <label style={{ fontSize: 12, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Name</label>
          <div style={{ fontSize: 16, fontWeight: 600, marginTop: 4 }}>{lead.name || '—'}</div>
        </div>

        <div>
          <label style={{ fontSize: 12, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Email</label>
          <div style={{ fontSize: 16, marginTop: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Mail size={16} />
            {lead.email}
          </div>
        </div>

        <div>
          <label style={{ fontSize: 12, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Status</label>
          <div style={{
            marginTop: 4,
            padding: '6px 12px',
            borderRadius: 20,
            background: lead.status === 'replied' ? 'var(--green-bg)' : lead.status === 'new' ? 'var(--bg-hover)' : 'var(--blue-bg)',
            color: lead.status === 'replied' ? 'var(--green-text)' : lead.status === 'new' ? 'var(--text-primary)' : 'var(--blue-text)',
            fontSize: 14,
            fontWeight: 600,
            display: 'inline-block'
          }}>
            {statusLabels[lead.status] || lead.status}
          </div>
        </div>

        <div>
          <label style={{ fontSize: 12, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Reply Type</label>
          <div style={{ marginTop: 4, display: 'flex', gap: 6 }}>
            <button
              onClick={() => onSetReplyType?.(lead, 'real')}
              style={{
                padding: '4px 10px',
                borderRadius: 20,
                border: '1px solid',
                borderColor: !lead.automatedReply && !lead.bounced ? 'var(--green-bg)' : 'var(--border)',
                background: !lead.automatedReply && !lead.bounced ? 'var(--green-bg)' : 'transparent',
                color: !lead.automatedReply && !lead.bounced ? 'var(--green-text)' : 'var(--text-secondary)',
                fontSize: 12,
                fontWeight: 600,
                cursor: onSetReplyType ? 'pointer' : 'default',
              }}
            >
              Real
            </button>
            <button
              onClick={() => onSetReplyType?.(lead, 'automated')}
              style={{
                padding: '4px 10px',
                borderRadius: 20,
                border: '1px solid',
                borderColor: lead.automatedReply ? 'var(--yellow-bg)' : 'var(--border)',
                background: lead.automatedReply ? 'var(--yellow-bg)' : 'transparent',
                color: lead.automatedReply ? 'var(--yellow-text)' : 'var(--text-secondary)',
                fontSize: 12,
                fontWeight: 600,
                cursor: onSetReplyType ? 'pointer' : 'default',
              }}
            >
              Automated
            </button>
            <button
              onClick={() => onSetReplyType?.(lead, 'bounced')}
              style={{
                padding: '4px 10px',
                borderRadius: 20,
                border: '1px solid',
                borderColor: lead.bounced ? 'var(--red-bg)' : 'var(--border)',
                background: lead.bounced ? 'var(--red-bg)' : 'transparent',
                color: lead.bounced ? 'var(--red-text)' : 'var(--text-secondary)',
                fontSize: 12,
                fontWeight: 600,
                cursor: onSetReplyType ? 'pointer' : 'default',
              }}
            >
              Bounced
            </button>
          </div>
        </div>

        <div>
          <label style={{ fontSize: 12, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Deal Status</label>
          <div style={{ marginTop: 4 }}>
            <button
              onClick={() => onToggleClosed?.(lead)}
              style={{
                padding: '4px 10px',
                borderRadius: 20,
                border: '1px solid',
                borderColor: lead.closed ? 'var(--accent)' : 'var(--border)',
                background: lead.closed ? 'var(--accent)' : 'transparent',
                color: lead.closed ? 'var(--accent-text)' : 'var(--text-secondary)',
                fontSize: 12,
                fontWeight: 600,
                cursor: onToggleClosed ? 'pointer' : 'default',
              }}
            >
              {lead.closed ? '✓ Closed' : 'Mark Closed'}
            </button>
          </div>
        </div>

        <div>
          <label style={{ fontSize: 12, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Channel Name</label>
          <div style={{ fontSize: 16, marginTop: 4 }}>{lead.customData.channelName || '—'}</div>
        </div>

        <div>
          <label style={{ fontSize: 12, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Video Title</label>
          <div style={{ fontSize: 16, marginTop: 4 }}>{lead.customData.videoTitle || '—'}</div>
        </div>

        <div>
          <label style={{ fontSize: 12, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Sent From Account</label>
          <div style={{ fontSize: 16, marginTop: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
            <MessageSquare size={16} />
            {lead.sentFromAccount || 'Not yet sent'}
          </div>
        </div>

        <div>
          <label style={{ fontSize: 12, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Email Thread {lead.threadId && messages.length > 0 && `(${messages.length} messages)`}
          </label>

          {!lead.threadId && (
            <div style={{ marginTop: 8, fontSize: 13, color: 'var(--text-muted)', fontStyle: 'italic' }}>
              No thread history — lead hasn't been synced yet.
            </div>
          )}

          {lead.threadId && loading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, color: 'var(--text-muted)', fontSize: 13 }}>
              <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
              Loading thread...
            </div>
          )}

          {lead.threadId && !loading && messages.length === 0 && (
            <div style={{ marginTop: 8, fontSize: 13, color: 'var(--text-muted)', fontStyle: 'italic' }}>
              Could not load thread. The connected account may not have access to this thread.
            </div>
          )}

          {messages.map((msg, idx) => {
            const isExpanded = expandedId === msg.id;
            const fromName = msg.from.split('<')[0].trim() || msg.from;
            const fromEmail = msg.from.match(/<([^>]+)>/)?.[1] || msg.from;
            const isFromLead = fromEmail.toLowerCase() === lead.email.toLowerCase();
            const isFromMe = state.accounts.some(a => a.email.toLowerCase() === fromEmail.toLowerCase());

            return (
              <div key={msg.id} style={{
                marginTop: 8,
                border: '1px solid var(--border)',
                borderRadius: 8,
                overflow: 'hidden',
                background: isFromLead ? 'var(--green-bg)' : isFromMe ? 'var(--blue-bg)' : 'var(--bg-muted)',
                opacity: isFromLead ? 1 : 0.85,
              }}>
                {/* Header bar */}
                <div
                  onClick={() => setExpandedId(isExpanded ? null : msg.id)}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '8px 12px',
                    cursor: 'pointer',
                    borderBottom: isExpanded ? '1px solid var(--border)' : 'none',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
                    {isFromLead ? <Reply size={12} style={{ flexShrink: 0, color: 'var(--green-text)' }} />
                      : isFromMe ? <Send size={12} style={{ flexShrink: 0, color: 'var(--blue-text)' }} />
                      : <Mail size={12} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />}
                    <span style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: isFromLead ? 'var(--green-text)' : isFromMe ? 'var(--blue-text)' : 'var(--text-primary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {fromName}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto', flexShrink: 0 }}>
                      {formatEmailDate(msg.date)}
                    </span>
                  </div>
                  {isExpanded ? <ChevronUp size={14} style={{ flexShrink: 0, marginLeft: 8, color: 'var(--text-muted)' }} />
                    : <ChevronDown size={14} style={{ flexShrink: 0, marginLeft: 8, color: 'var(--text-muted)' }} />}
                </div>

                {/* Subject (always visible) */}
                {msg.subject && (
                  <div style={{
                    padding: '0 12px 6px',
                    fontSize: 11,
                    color: 'var(--text-secondary)',
                    fontWeight: 500,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {msg.subject}
                  </div>
                )}

                {/* Expanded body */}
                {isExpanded && (
                  <div style={{
                    padding: '8px 12px 10px',
                    fontSize: 12,
                    lineHeight: 1.5,
                    color: 'var(--text-primary)',
                    borderTop: '1px solid var(--border-light)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    maxHeight: 300,
                    overflow: 'auto',
                    background: 'var(--bg-card)',
                  }}>
                    {msg.body || msg.snippet || '(No content)'}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div>
          <label style={{ fontSize: 12, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Last Contact</label>
          <div style={{ fontSize: 14, marginTop: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Calendar size={16} />
            {lead.lastContactDate ? new Date(lead.lastContactDate).toLocaleDateString() : '—'}
          </div>
        </div>

        <div>
          <label style={{ fontSize: 12, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Sync Status</label>
          <div style={{
            marginTop: 4,
            padding: '6px 12px',
            borderRadius: 20,
            background: lead.syncedOnce ? 'var(--green-bg)' : 'var(--bg-hover)',
            color: lead.syncedOnce ? 'var(--green-text)' : 'var(--text-primary)',
            fontSize: 14,
            fontWeight: 600,
            display: 'inline-block'
          }}>
            {lead.syncedOnce ? 'Synced (1)' : 'Not Yet Synced (0)'}
          </div>
        </div>

        <div>
          <label style={{ fontSize: 12, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Custom Data</label>
          <pre style={{ 
            marginTop: 4, 
            padding: 12, 
            background: 'var(--bg-muted)',
            borderRadius: 8, 
            fontSize: 13,
            overflow: 'auto'
          }}>
            {JSON.stringify(lead.customData, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  );
}