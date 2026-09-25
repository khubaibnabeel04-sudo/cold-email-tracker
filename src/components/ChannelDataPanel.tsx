import React, { useState } from 'react';
import { Search, Download, Loader2, XCircle, FileText, CheckCircle2, Trash2 } from 'lucide-react';
import * as XLSX from 'xlsx';

const API_BASE = 'http://localhost:3006';
const EXCEL_CELL_LIMIT = 32767;
const TRANSCRIPT_CONCURRENCY = 5;

interface VideoRow {
  channelId: string;
  title: string;
  videoId: string;
  publishedAt: string;
  daysSinceUpload: number;
  views: number;
  VPH: number;
  ratio: number;
  bracket: string;
  outlier: string;
  likeCount: number;
  commentCount: number;
  transcript: string;
}

interface ChannelDataPanelProps {
  channelId: string;
  onChannelIdChange: (id: string) => void;
}

/** Compact per-lead YouTube channel data collection panel — same backend as DataCollectionPage. */
type VideoType = 'long' | 'short' | 'both';
type OutlierFilter = 'all' | 'outliers' | 'high' | 'low';
type TranscriptStatus = 'idle' | 'loading' | 'done' | 'error';

export default function ChannelDataPanel({ channelId, onChannelIdChange }: ChannelDataPanelProps) {
  const [rows, setRows] = useState<VideoRow[]>([]);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState('');
  const [logs, setLogs] = useState<string[]>([]);
  const [videoType, setVideoType] = useState<VideoType>('long');
  const [outlierFilter, setOutlierFilter] = useState<OutlierFilter>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastClickedIndex, setLastClickedIndex] = useState<number | null>(null);
  const [transcriptStatus, setTranscriptStatus] = useState<Record<string, TranscriptStatus>>({});
  const [fetchingTranscripts, setFetchingTranscripts] = useState(false);
  const [expandedTranscript, setExpandedTranscript] = useState<string | null>(null);

  function addLog(msg: string) {
    setLogs(prev => [...prev, msg].slice(-30));
  }

  async function fetchChannelData() {
    const id = channelId.trim();
    if (!id || fetching) return;
    setFetching(true);
    setError('');
    setRows([]);
    setLogs([]);
    setSelected(new Set());
    setTranscriptStatus({});
    setExpandedTranscript(null);
    setLastClickedIndex(null);
    setOutlierFilter('all');
    addLog(`Starting data collection for channel ${id}`);

    try {
      const res = await fetch(`${API_BASE}/api/youtube/channel-data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId: id, videoType }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as any).error || `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let gotResult = false;

      const handleLine = (line: string) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.type === 'log') {
          addLog(msg.message);
        } else if (msg.type === 'result') {
          gotResult = true;
          setRows(msg.videos || []);
          if ((msg.videos || []).length === 0) {
            setError(msg.message || 'No videos found for this channel.');
          } else {
            addLog(`Loaded ${msg.videos.length} videos`);
          }
        } else if (msg.type === 'error') {
          throw new Error(msg.error);
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          handleLine(line);
        }
      }
      if (buffer.trim()) handleLine(buffer);
      if (!gotResult) throw new Error('Stream ended without a result');
    } catch (err: any) {
      addLog(`Failed: ${err.message || 'unknown error'}`);
      setError(err.message || 'Failed to fetch channel data');
    } finally {
      setFetching(false);
    }
  }

  function exportToExcel() {
    if (rows.length === 0) return;
    const exportRows = rows.map(r => ({ ...r, transcript: (r.transcript || '').slice(0, EXCEL_CELL_LIMIT) }));
    const ws = XLSX.utils.json_to_sheet(exportRows, {
      header: ['channelId', 'title', 'videoId', 'publishedAt', 'daysSinceUpload', 'views', 'VPH', 'ratio', 'bracket', 'outlier', 'likeCount', 'commentCount', 'transcript'],
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Videos');
    XLSX.writeFile(wb, `youtube_data_${channelId || 'channel'}.xlsx`);
  }

  const filteredRows = rows.filter(r => {
    if (outlierFilter === 'all') return true;
    if (outlierFilter === 'outliers') return r.outlier === 'high' || r.outlier === 'low';
    return r.outlier === outlierFilter;
  });

  const allSelected = filteredRows.length > 0 && filteredRows.every(r => selected.has(r.videoId));

  function toggleRow(videoId: string, index: number, shiftKey: boolean, visibleRows: VideoRow[]) {
    setSelected(prev => {
      const next = new Set(prev);
      if (shiftKey && lastClickedIndex !== null) {
        const start = Math.min(lastClickedIndex, index);
        const end = Math.max(lastClickedIndex, index);
        for (let i = start; i <= end; i++) next.add(visibleRows[i].videoId);
      } else if (next.has(videoId)) {
        next.delete(videoId);
      } else {
        next.add(videoId);
      }
      return next;
    });
    setLastClickedIndex(index);
  }

  function toggleAll() {
    setSelected(prev => {
      const next = new Set(prev);
      if (allSelected) filteredRows.forEach(r => next.delete(r.videoId));
      else filteredRows.forEach(r => next.add(r.videoId));
      return next;
    });
  }

  function deleteSelected() {
    if (selected.size === 0) return;
    if (!window.confirm(`Delete ${selected.size} selected row(s)?`)) return;
    setRows(prev => prev.filter(r => !selected.has(r.videoId)));
    setSelected(new Set());
    setLastClickedIndex(null);
    if (expandedTranscript && selected.has(expandedTranscript)) setExpandedTranscript(null);
  }

  async function fetchTranscripts() {
    const ids = rows.filter(r => selected.has(r.videoId)).map(r => r.videoId);
    if (ids.length === 0 || fetchingTranscripts) return;
    setFetchingTranscripts(true);
    setTranscriptStatus(prev => {
      const next = { ...prev };
      ids.forEach(id => { next[id] = 'loading'; });
      return next;
    });
    addLog(`Fetching transcripts for ${ids.length} video(s)`);

    const queue = [...ids];
    const worker = async () => {
      while (queue.length > 0) {
        const videoId = queue.shift();
        if (!videoId) break;
        try {
          const res = await fetch(`${API_BASE}/api/youtube/transcript`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ videoId }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'transcript failed');
          setRows(prev => prev.map(r => r.videoId === videoId ? { ...r, transcript: data.transcript || '' } : r));
          setTranscriptStatus(prev => ({ ...prev, [videoId]: 'done' }));
          addLog(`✓ Transcript received (${(data.transcript || '').length.toLocaleString()} chars)`);
        } catch (err: any) {
          setTranscriptStatus(prev => ({ ...prev, [videoId]: 'error' }));
          addLog(`✗ Transcript failed: ${err.message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(TRANSCRIPT_CONCURRENCY, ids.length) }, () => worker()));
    addLog(`Transcript run complete — ${ids.length} video(s) processed`);
    setFetchingTranscripts(false);
  }

  function outlierStyle(outlier: string): React.CSSProperties {
    if (outlier === 'high') return { background: 'var(--green-bg, #dcfce7)', color: 'var(--green-text, #15803d)' };
    if (outlier === 'low') return { background: 'var(--red-bg, #fee2e2)', color: 'var(--red-text, #b91c1c)' };
    return { background: 'var(--bg-muted)', color: 'var(--text-secondary)' };
  }

  const selectedCount = selected.size;

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: '1 1 200px', minWidth: 160 }}>
          <input
            type="text"
            placeholder="Channel ID..."
            value={channelId}
            onChange={e => onChannelIdChange(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') fetchChannelData(); }}
            disabled={fetching}
            style={{ width: '100%', padding: '7px 10px 7px 30px', boxSizing: 'border-box', borderRadius: 6, border: '1px solid var(--border)', fontSize: 13 }}
          />
          <Search size={14} style={{ position: 'absolute', left: 10, top: 9, color: 'var(--text-muted)' }} />
        </div>
        <div style={{ display: 'flex', borderRadius: 6, border: '1px solid var(--border)', overflow: 'hidden', flexShrink: 0 }}>
          {([
            { value: 'long', label: 'Long-form' },
            { value: 'short', label: 'Shorts' },
            { value: 'both', label: 'Both' },
          ] as { value: VideoType; label: string }[]).map(opt => (
            <button
              key={opt.value}
              onClick={() => setVideoType(opt.value)}
              disabled={fetching}
              style={{
                padding: '7px 12px', fontSize: 12, fontWeight: 600, border: 'none',
                cursor: fetching ? 'not-allowed' : 'pointer',
                background: videoType === opt.value ? 'var(--accent)' : 'var(--bg-page)',
                color: videoType === opt.value ? '#fff' : 'var(--text-secondary)',
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <button
          onClick={fetchChannelData}
          disabled={fetching || !channelId.trim()}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, cursor: fetching || !channelId.trim() ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: 12, opacity: fetching || !channelId.trim() ? 0.6 : 1 }}
        >
          {fetching ? <Loader2 size={13} style={{ animation: 'spin 0.8s linear infinite' }} /> : <Search size={13} />}
          {fetching ? 'Fetching...' : 'Fetch Data'}
        </button>
        {rows.length > 0 && (
          <button onClick={exportToExcel} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: 12 }}>
            <Download size={13} /> Export Excel
          </button>
        )}
      </div>

      {error && (
        <div style={{ padding: '8px 12px', borderRadius: 6, marginBottom: 10, background: 'var(--red-bg, #fee2e2)', color: 'var(--red-text, #b91c1c)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
          <XCircle size={13} /> {error}
        </div>
      )}

      {logs.length > 0 && rows.length === 0 && (
        <div style={{ maxHeight: 100, overflowY: 'auto', background: '#0d1117', color: '#c9d1d9', borderRadius: 6, padding: '8px 10px', fontFamily: 'monospace', fontSize: 11, marginBottom: 10 }}>
          {logs.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}

      {rows.length > 0 && (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
              <strong style={{ color: 'var(--text-primary)' }}>{filteredRows.length}</strong>
              {filteredRows.length !== rows.length && <> of {rows.length}</>} videos
              {selectedCount > 0 && <> · <strong style={{ color: 'var(--text-primary)' }}>{selectedCount}</strong> selected</>}
            </span>

            <div style={{ display: 'flex', borderRadius: 6, border: '1px solid var(--border)', overflow: 'hidden' }}>
              {([
                { value: 'all', label: 'All' },
                { value: 'outliers', label: 'Outliers' },
                { value: 'high', label: 'High' },
                { value: 'low', label: 'Low' },
              ] as { value: OutlierFilter; label: string }[]).map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setOutlierFilter(opt.value)}
                  style={{
                    padding: '5px 10px', fontSize: 11, fontWeight: 600, border: 'none',
                    cursor: 'pointer',
                    background: outlierFilter === opt.value ? 'var(--accent)' : 'var(--bg-page)',
                    color: outlierFilter === opt.value ? '#fff' : 'var(--text-secondary)',
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            <button
              onClick={fetchTranscripts}
              disabled={selectedCount === 0 || fetchingTranscripts}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto',
                background: selectedCount === 0 || fetchingTranscripts ? 'var(--bg-muted)' : 'var(--accent)',
                color: selectedCount === 0 || fetchingTranscripts ? 'var(--text-muted)' : '#fff',
                border: '1px solid var(--border)', borderRadius: 6, padding: '6px 12px',
                cursor: selectedCount === 0 || fetchingTranscripts ? 'not-allowed' : 'pointer',
                fontWeight: 600, fontSize: 11,
              }}
            >
              {fetchingTranscripts ? <Loader2 size={13} style={{ animation: 'spin 0.8s linear infinite' }} /> : <FileText size={13} />}
              {fetchingTranscripts ? 'Fetching...' : `Get Transcripts${selectedCount > 0 ? ` (${selectedCount})` : ''}`}
            </button>
            <button
              onClick={deleteSelected}
              disabled={selectedCount === 0}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                background: selectedCount === 0 ? 'var(--bg-muted)' : 'var(--red-bg, #fee2e2)',
                color: selectedCount === 0 ? 'var(--text-muted)' : 'var(--red-text, #b91c1c)',
                border: '1px solid var(--border)', borderRadius: 6, padding: '6px 12px',
                cursor: selectedCount === 0 ? 'not-allowed' : 'pointer',
                fontWeight: 600, fontSize: 11,
              }}
            >
              <Trash2 size={13} />
              {`Delete${selectedCount > 0 ? ` (${selectedCount})` : ''}`}
            </button>
          </div>

          {filteredRows.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', border: '1px dashed var(--border)', borderRadius: 8, fontSize: 12 }}>
              No videos match this filter.
            </div>
          ) : (
          <div style={{ overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8, maxHeight: 320 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, whiteSpace: 'nowrap' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--border)', textAlign: 'left', background: 'var(--bg-muted)', position: 'sticky', top: 0 }}>
                  <th style={{ padding: '6px 10px' }}>
                    <input type="checkbox" checked={allSelected} onChange={toggleAll} style={{ cursor: 'pointer' }} />
                  </th>
                  <th style={{ padding: '6px 10px' }}>Title</th>
                  <th style={{ padding: '6px 10px' }}>Published</th>
                  <th style={{ padding: '6px 10px' }}>Views</th>
                  <th style={{ padding: '6px 10px' }}>VPH</th>
                  <th style={{ padding: '6px 10px' }}>Outlier</th>
                  <th style={{ padding: '6px 10px' }}>Transcript</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row, index) => {
                  const status = transcriptStatus[row.videoId] || 'idle';
                  const isSelected = selected.has(row.videoId);
                  const isExpanded = expandedTranscript === row.videoId;
                  return (
                    <tr key={row.videoId} style={{ borderBottom: '1px solid var(--border-light)', background: isSelected ? 'var(--bg-hover)' : 'transparent' }}>
                      <td style={{ padding: '6px 10px', userSelect: 'none' }}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          readOnly
                          onClick={e => toggleRow(row.videoId, index, e.shiftKey, filteredRows)}
                          style={{ cursor: 'pointer' }}
                        />
                      </td>
                      <td style={{ padding: '6px 10px', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }} title={row.title}>
                        <a href={`https://www.youtube.com/watch?v=${row.videoId}`} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', textDecoration: 'none' }}>{row.title}</a>
                      </td>
                      <td style={{ padding: '6px 10px', color: 'var(--text-secondary)' }}>{new Date(row.publishedAt).toLocaleDateString()}</td>
                      <td style={{ padding: '6px 10px' }}>{row.views.toLocaleString()}</td>
                      <td style={{ padding: '6px 10px' }}>{row.VPH.toLocaleString()}</td>
                      <td style={{ padding: '6px 10px' }}>
                        <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, ...outlierStyle(row.outlier) }}>
                          {row.outlier}
                        </span>
                      </td>
                      <td
                        style={{
                          padding: '6px 10px', maxWidth: 260, color: 'var(--text-secondary)',
                          whiteSpace: isExpanded ? 'normal' : 'nowrap',
                          overflow: 'hidden', textOverflow: 'ellipsis',
                          cursor: row.transcript ? 'pointer' : 'default',
                        }}
                        title={row.transcript ? (isExpanded ? 'Click to collapse' : 'Click to expand') : ''}
                        onClick={() => { if (row.transcript) setExpandedTranscript(isExpanded ? null : row.videoId); }}
                      >
                        {status === 'loading' && (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)' }}>
                            <Loader2 size={13} style={{ animation: 'spin 0.8s linear infinite' }} /> fetching...
                          </span>
                        )}
                        {status === 'error' && (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--red-text, #b91c1c)' }}>
                            <XCircle size={13} /> failed
                          </span>
                        )}
                        {status !== 'loading' && status !== 'error' && (
                          row.transcript ? (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%' }}>
                              {status === 'done' && <CheckCircle2 size={13} style={{ color: 'var(--green-text, #15803d)', flexShrink: 0 }} />}
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {isExpanded ? row.transcript : `${row.transcript.slice(0, 60)}...`}
                              </span>
                            </span>
                          ) : <span style={{ color: 'var(--text-muted)' }}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          )}
        </>
      )}
    </div>
  );
}
