import React from 'react';
import { Download, Printer } from 'lucide-react';
import type { ThreadMessage } from '../services/gmail';

function formatMessagesAsText(leadName: string, leadEmail: string, messages: ThreadMessage[]): string {
  const lines = [`Conversation with ${leadName || leadEmail} <${leadEmail}>`, '='.repeat(60), ''];
  for (const m of messages) {
    lines.push(`From: ${m.from}`);
    lines.push(`To: ${m.to}`);
    lines.push(`Date: ${new Date(m.date).toLocaleString()}`);
    if (m.subject) lines.push(`Subject: ${m.subject}`);
    lines.push('');
    lines.push(m.body || m.snippet || '');
    lines.push('');
    lines.push('-'.repeat(60));
    lines.push('');
  }
  return lines.join('\n');
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildPrintHtml(leadName: string, leadEmail: string, messages: ThreadMessage[]): string {
  const title = `Conversation with ${escapeHtml(leadName || leadEmail)}`;
  const messageBlocks = messages.map(m => `
    <div class="message">
      <div class="meta">
        <div><strong>From:</strong> ${escapeHtml(m.from)}</div>
        <div><strong>To:</strong> ${escapeHtml(m.to)}</div>
        <div><strong>Date:</strong> ${new Date(m.date).toLocaleString()}</div>
        ${m.subject ? `<div><strong>Subject:</strong> ${escapeHtml(m.subject)}</div>` : ''}
      </div>
      <div class="body">${escapeHtml(m.body || m.snippet || '').replace(/\n/g, '<br/>')}</div>
    </div>
  `).join('');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #1a1a1a; max-width: 760px; margin: 32px auto; padding: 0 16px; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .subtitle { color: #666; font-size: 13px; margin-bottom: 24px; }
  .message { border: 1px solid #ddd; border-radius: 8px; padding: 16px; margin-bottom: 16px; page-break-inside: avoid; }
  .meta { font-size: 12px; color: #555; margin-bottom: 10px; line-height: 1.6; }
  .body { font-size: 14px; line-height: 1.5; white-space: pre-wrap; }
  @media print { body { margin: 0; } }
</style>
</head>
<body>
  <h1>${title}</h1>
  <div class="subtitle">${escapeHtml(leadEmail)} &middot; ${messages.length} message${messages.length !== 1 ? 's' : ''}</div>
  ${messageBlocks}
</body>
</html>`;
}

interface ThreadExportProps {
  leadName: string;
  leadEmail: string;
  messages: ThreadMessage[];
}

/** Text download + browser print-to-PDF export for a fetched email thread. No new dependency. */
export default function ThreadExport({ leadName, leadEmail, messages }: ThreadExportProps) {
  const disabled = !messages || messages.length === 0;

  function downloadText() {
    const text = formatMessagesAsText(leadName, leadEmail, messages);
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(leadName || leadEmail).replace(/[^a-z0-9]+/gi, '_')}_conversation.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function printAsPdf() {
    const html = buildPrintHtml(leadName, leadEmail, messages);
    const win = window.open('', '_blank');
    if (!win) return;
    win.document.write(html);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 300);
  }

  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <button
        onClick={downloadText}
        disabled={disabled}
        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, cursor: disabled ? 'not-allowed' : 'pointer', fontSize: 12, opacity: disabled ? 0.5 : 1 }}
      >
        <Download size={13} /> Download Text
      </button>
      <button
        onClick={printAsPdf}
        disabled={disabled}
        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, cursor: disabled ? 'not-allowed' : 'pointer', fontSize: 12, opacity: disabled ? 0.5 : 1 }}
      >
        <Printer size={13} /> Print / Save as PDF
      </button>
    </div>
  );
}
