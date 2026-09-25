import React, { useState, useRef, useEffect } from 'react';
import { Search, Download, FileText, Loader2, CheckCircle2, XCircle, Trash2, Lightbulb } from 'lucide-react';
import * as XLSX from 'xlsx';

const API_BASE = 'http://localhost:3006';

// How many transcript requests run at the same time
const TRANSCRIPT_CONCURRENCY = 5;

// Excel hard limit for a single cell is 32,767 characters
const EXCEL_CELL_LIMIT = 32767;

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

type TranscriptStatus = 'idle' | 'loading' | 'done' | 'error';
type VideoType = 'long' | 'short' | 'live' | 'both';
type OutlierFilter = 'all' | 'outliers' | 'high' | 'low';

interface LogLine {
  time: string;
  message: string;
  kind: 'info' | 'success' | 'error';
}

// Module-level cache so results survive navigating to another page and back
let cachedChannelId = '';
let cachedRows: VideoRow[] = [];
let cachedLogs: LogLine[] = [];

export default function DataCollectionPage() {
  const [channelIdInput, setChannelIdInput] = useState(cachedChannelId);
  const [rows, setRows] = useState<VideoRow[]>(cachedRows);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [transcriptStatus, setTranscriptStatus] = useState<Record<string, TranscriptStatus>>({});
  const [fetchingTranscripts, setFetchingTranscripts] = useState(false);
  const [fetchingTranscriptsLocal, setFetchingTranscriptsLocal] = useState(false);
  const [expandedTranscript, setExpandedTranscript] = useState<string | null>(null);
  // Anchor row for shift+click range selection
  const [lastClickedIndex, setLastClickedIndex] = useState<number | null>(null);
  const [videoType, setVideoType] = useState<VideoType>('long');
  const [outlierFilter, setOutlierFilter] = useState<OutlierFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [logs, setLogs] = useState<LogLine[]>(cachedLogs);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const searchQueryTrimmed = searchQuery.trim().toLowerCase();

  useEffect(() => {
    if (!searchQueryTrimmed) return;
    const match = rows.find(r =>
      r.title.toLowerCase().includes(searchQueryTrimmed) || r.videoId.toLowerCase().includes(searchQueryTrimmed)
    );
    if (match) {
      document.getElementById(`yt-row-${match.videoId}`)?.scrollIntoView({ behavior: 'auto', block: 'center' });
    }
    // Only re-scroll when the search text itself changes, not on every row/state update
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQueryTrimmed]);

  function updateRows(newRows: VideoRow[]) {
    cachedRows = newRows;
    setRows(newRows);
  }

  function addLog(message: string, kind: LogLine['kind'] = 'info') {
    const line: LogLine = { time: new Date().toLocaleTimeString(), message, kind };
    cachedLogs = [...cachedLogs, line];
    setLogs(cachedLogs);
  }

  function clearLogs() {
    cachedLogs = [];
    setLogs([]);
  }

  async function fetchChannelData() {
    const channelId = channelIdInput.trim();
    if (!channelId || fetching) return;

    // New channel run wipes everything from the previous one
    setFetching(true);
    setError('');
    updateRows([]);
    setSelected(new Set());
    setTranscriptStatus({});
    setExpandedTranscript(null);
    setLastClickedIndex(null);
    setOutlierFilter('all');
    setSearchQuery('');
    clearLogs();
    cachedChannelId = channelId;
    addLog(`Starting data collection for channel ${channelId}`);

    try {
      const res = await fetch(`${API_BASE}/api/youtube/channel-data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId, videoType }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as any).error || `Request failed (${res.status})`);
      }

      // The server streams NDJSON: log lines as it works, then the result
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
          updateRows(msg.videos || []);
          if ((msg.videos || []).length === 0) {
            addLog(msg.message || 'No videos found for this channel.', 'error');
            setError(msg.message || 'No videos found for this channel.');
          } else {
            addLog(`Loaded ${msg.videos.length} videos into the table`, 'success');
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
      if (!gotResult) {
        throw new Error('Stream ended without a result');
      }
    } catch (err: any) {
      addLog(`Failed: ${err.message || 'unknown error'}`, 'error');
      setError(err.message || 'Failed to fetch channel data');
    } finally {
      setFetching(false);
    }
  }

  function toggleRow(videoId: string, index: number, shiftKey: boolean, visibleRows: VideoRow[]) {
    setSelected(prev => {
      const next = new Set(prev);
      if (shiftKey && lastClickedIndex !== null) {
        // Shift+click: select the whole range between the anchor and this row
        // (range is within the currently visible/filtered rows)
        const start = Math.min(lastClickedIndex, index);
        const end = Math.max(lastClickedIndex, index);
        for (let i = start; i <= end; i++) {
          next.add(visibleRows[i].videoId);
        }
      } else if (next.has(videoId)) {
        next.delete(videoId);
      } else {
        next.add(videoId);
      }
      return next;
    });
    setLastClickedIndex(index);
  }

  function deleteSelected() {
    if (selected.size === 0) return;
    if (!window.confirm(`Delete ${selected.size} selected row(s)?`)) return;
    updateRows(rows.filter(r => !selected.has(r.videoId)));
    setSelected(new Set());
    setLastClickedIndex(null);
    if (expandedTranscript && selected.has(expandedTranscript)) setExpandedTranscript(null);
  }

  const filteredRows = rows.filter(r => {
    if (outlierFilter === 'all') return true;
    if (outlierFilter === 'outliers') return r.outlier === 'high' || r.outlier === 'low';
    return r.outlier === outlierFilter;
  });

  const searchMatches = searchQueryTrimmed
    ? filteredRows.filter(r =>
        r.title.toLowerCase().includes(searchQueryTrimmed) || r.videoId.toLowerCase().includes(searchQueryTrimmed)
      )
    : [];
  const searchMatchSet = new Set(searchMatches.map(r => r.videoId));

  const allSelected = filteredRows.length > 0 && filteredRows.every(r => selected.has(r.videoId));

  function toggleAll() {
    setSelected(prev => {
      const next = new Set(prev);
      if (allSelected) {
        filteredRows.forEach(r => next.delete(r.videoId));
      } else {
        filteredRows.forEach(r => next.add(r.videoId));
      }
      return next;
    });
  }

  async function fetchTranscripts(source: 'kome' | 'local' = 'kome') {
    const ids = rows.filter(r => selected.has(r.videoId)).map(r => r.videoId);
    if (ids.length === 0 || fetchingTranscripts || fetchingTranscriptsLocal) return;

    const endpoint = source === 'local' ? '/api/youtube/transcript-local' : '/api/youtube/transcript';
    const setBusy = source === 'local' ? setFetchingTranscriptsLocal : setFetchingTranscripts;
    const sourceLabel = source === 'local' ? 'local (yt-dlp)' : 'Kome';

    setBusy(true);
    setTranscriptStatus(prev => {
      const next = { ...prev };
      ids.forEach(id => { next[id] = 'loading'; });
      return next;
    });
    addLog(`Fetching transcripts via ${sourceLabel} for ${ids.length} video(s) — ${Math.min(TRANSCRIPT_CONCURRENCY, ids.length)} in parallel`);

    const titleOf = (videoId: string) => {
      const t = cachedRows.find(r => r.videoId === videoId)?.title || videoId;
      return t.length > 50 ? `${t.slice(0, 50)}...` : t;
    };

    let doneCount = 0;
    // Parallel processing with a small concurrency pool — several videos
    // fetch at once instead of one by one
    const queue = [...ids];
    const worker = async () => {
      while (queue.length > 0) {
        const videoId = queue.shift();
        if (!videoId) break;
        addLog(`→ Requesting transcript: "${titleOf(videoId)}"`);
        try {
          const res = await fetch(`${API_BASE}${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ videoId }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'transcript failed');
          cachedRows = cachedRows.map(r =>
            r.videoId === videoId ? { ...r, transcript: data.transcript || '' } : r
          );
          setRows(cachedRows);
          setTranscriptStatus(prev => ({ ...prev, [videoId]: 'done' }));
          doneCount++;
          addLog(`✓ [${doneCount}/${ids.length}] Transcript received (${(data.transcript || '').length.toLocaleString()} chars): "${titleOf(videoId)}"`, 'success');
        } catch (err: any) {
          setTranscriptStatus(prev => ({ ...prev, [videoId]: 'error' }));
          doneCount++;
          addLog(`✗ [${doneCount}/${ids.length}] Transcript failed (${err.message}): "${titleOf(videoId)}"`, 'error');
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(TRANSCRIPT_CONCURRENCY, ids.length) }, () => worker())
    );
    addLog(`Transcript run complete — ${ids.length} video(s) processed`);
    setBusy(false);
  }

  function exportToExcel() {
    if (rows.length === 0) return;
    const exportRows = rows.map(r => ({
      channelId: r.channelId,
      title: r.title,
      videoId: r.videoId,
      publishedAt: r.publishedAt,
      daysSinceUpload: r.daysSinceUpload,
      views: r.views,
      VPH: r.VPH,
      ratio: r.ratio,
      bracket: r.bracket,
      outlier: r.outlier,
      likeCount: r.likeCount,
      commentCount: r.commentCount,
      transcript: (r.transcript || '').slice(0, EXCEL_CELL_LIMIT),
    }));
    const ws = XLSX.utils.json_to_sheet(exportRows, {
      header: ['channelId', 'title', 'videoId', 'publishedAt', 'daysSinceUpload', 'views', 'VPH', 'ratio', 'bracket', 'outlier', 'likeCount', 'commentCount', 'transcript'],
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Videos');
    XLSX.writeFile(wb, `youtube_data_${cachedChannelId || 'channel'}.xlsx`);
  }

  const selectedCount = selected.size;
  const withTranscript = rows.filter(r => r.transcript).length;

  function outlierStyle(outlier: string): React.CSSProperties {
    if (outlier === 'high') return { background: 'var(--green-bg, #dcfce7)', color: 'var(--green-text, #15803d)' };
    if (outlier === 'low') return { background: 'var(--red-bg, #fee2e2)', color: 'var(--red-text, #b91c1c)' };
    return { background: 'var(--bg-muted)', color: 'var(--text-secondary)' };
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 700 }}>Data Collection</h1>
          <p style={{ color: 'var(--text-secondary)' }}>
            Pull a YouTube channel's videos with outlier analysis, fetch transcripts, and export to Excel
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={() => window.open('/ideas', '_blank', 'noopener,noreferrer')}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              background: 'var(--bg-muted)', color: 'var(--text-primary)',
              border: '1px solid var(--border)', borderRadius: 8, padding: '10px 16px',
              cursor: 'pointer', fontWeight: 600, fontSize: 14,
            }}
          >
            <Lightbulb size={16} />
            IDEAS
          </button>
          {rows.length > 0 && (
            <button
              onClick={exportToExcel}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                background: 'var(--accent)', color: 'var(--accent-text)',
                border: 'none', borderRadius: 8, padding: '10px 16px',
                cursor: 'pointer', fontWeight: 600, fontSize: 14,
              }}
            >
              <Download size={16} />
              Export to Excel
            </button>
          )}
        </div>
      </div>

      {/* Channel ID input */}
      <div style={{
        display: 'flex', gap: 12, alignItems: 'center', marginBottom: 20, flexWrap: 'wrap',
        background: 'var(--bg-muted)', padding: 12, borderRadius: 8, border: '1px solid var(--border)',
      }}>
        <div style={{ position: 'relative', flex: '1 1 220px', minWidth: 180, maxWidth: 320 }}>
          <input
            type="text"
            placeholder="Enter channel ID..."
            value={channelIdInput}
            onChange={e => setChannelIdInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') fetchChannelData(); }}
            disabled={fetching}
            style={{
              width: '100%', padding: '10px 12px 10px 36px', boxSizing: 'border-box',
              borderRadius: 6, border: '1px solid var(--border)', fontSize: 14,
            }}
          />
          <Search size={16} style={{ position: 'absolute', left: 12, top: 13, color: 'var(--text-muted)' }} />
        </div>

        {/* Video type selector */}
        <div style={{ display: 'flex', borderRadius: 6, border: '1px solid var(--border)', overflow: 'hidden', flexShrink: 0 }}>
          {([
            { value: 'long', label: 'Long-form' },
            { value: 'short', label: 'Shorts' },
            { value: 'live', label: 'Live' },
            { value: 'both', label: 'Both' },
          ] as { value: VideoType; label: string }[]).map(opt => (
            <button
              key={opt.value}
              onClick={() => setVideoType(opt.value)}
              disabled={fetching}
              style={{
                padding: '10px 14px', fontSize: 13, fontWeight: 600, border: 'none',
                cursor: fetching ? 'not-allowed' : 'pointer',
                background: videoType === opt.value ? 'var(--accent)' : 'var(--bg-page)',
                color: videoType === opt.value ? 'var(--accent-text)' : 'var(--text-secondary)',
                transition: 'all 0.15s ease',
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <button
          onClick={fetchChannelData}
          disabled={fetching || !channelIdInput.trim()}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            background: 'var(--accent)', color: 'var(--accent-text)',
            border: 'none', borderRadius: 6, padding: '10px 20px',
            cursor: fetching || !channelIdInput.trim() ? 'not-allowed' : 'pointer',
            fontWeight: 600, fontSize: 14,
            opacity: fetching || !channelIdInput.trim() ? 0.6 : 1,
          }}
        >
          {fetching ? <Loader2 size={16} style={{ animation: 'spin 0.8s linear infinite' }} /> : <Search size={16} />}
          {fetching ? 'Fetching...' : 'Fetch Data'}
        </button>
      </div>

      {/* Live console log */}
      {logs.length > 0 && (
        <div style={{
          marginBottom: 20, borderRadius: 8, border: '1px solid var(--border)',
          background: '#0d1117', overflow: 'hidden',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px',
            borderBottom: '1px solid #21262d', fontSize: 12, fontWeight: 600, color: '#8b949e',
          }}>
            {(fetching || fetchingTranscripts || fetchingTranscriptsLocal) && (
              <Loader2 size={13} style={{ animation: 'spin 0.8s linear infinite', color: '#58a6ff' }} />
            )}
            Console
            <button
              onClick={clearLogs}
              style={{
                marginLeft: 'auto', background: 'transparent', border: 'none',
                color: '#8b949e', cursor: 'pointer', fontSize: 12,
              }}
            >
              clear
            </button>
          </div>
          <div style={{
            maxHeight: 180, overflowY: 'auto', padding: '10px 14px',
            fontFamily: 'Consolas, Menlo, monospace', fontSize: 12, lineHeight: 1.7,
          }}>
            {logs.map((line, i) => (
              <div key={i} style={{
                color: line.kind === 'error' ? '#f85149' : line.kind === 'success' ? '#3fb950' : '#c9d1d9',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              }}>
                <span style={{ color: '#8b949e' }}>[{line.time}]</span> {line.message}
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>
      )}

      {error && (
        <div style={{
          padding: '12px 16px', borderRadius: 8, marginBottom: 20,
          background: 'var(--red-bg, #fee2e2)', color: 'var(--red-text, #b91c1c)',
          fontSize: 14, border: '1px solid var(--red-text, #b91c1c)',
        }}>
          {error}
        </div>
      )}

      {rows.length > 0 && (
        <>
          {/* Toolbar */}
          <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
              <strong style={{ color: 'var(--text-primary)' }}>{filteredRows.length}</strong>
              {filteredRows.length !== rows.length && <> of <strong style={{ color: 'var(--text-primary)' }}>{rows.length}</strong></>} videos
              {withTranscript > 0 && <> &middot; <strong style={{ color: 'var(--text-primary)' }}>{withTranscript}</strong> with transcript</>}
              {selectedCount > 0 && <> &middot; <strong style={{ color: 'var(--text-primary)' }}>{selectedCount}</strong> selected</>}
            </span>

            {/* Search — highlights matching rows in place, doesn't remove others */}
            <div style={{ position: 'relative', flex: '0 1 220px', minWidth: 160 }}>
              <input
                type="text"
                placeholder="Search title or video ID..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                style={{
                  width: '100%', padding: '7px 28px 7px 30px', boxSizing: 'border-box',
                  borderRadius: 6, border: '1px solid var(--border)', fontSize: 13,
                }}
              />
              <Search size={14} style={{ position: 'absolute', left: 10, top: 9, color: 'var(--text-muted)' }} />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  title="Clear search"
                  style={{
                    position: 'absolute', right: 6, top: 6, background: 'transparent',
                    border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 2, display: 'flex',
                  }}
                >
                  <XCircle size={14} />
                </button>
              )}
            </div>
            {searchQueryTrimmed && (
              <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                {searchMatches.length} result{searchMatches.length !== 1 ? 's' : ''} found
              </span>
            )}

            {/* Outlier filter */}
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
                    padding: '7px 12px', fontSize: 12, fontWeight: 600, border: 'none',
                    cursor: 'pointer',
                    background: outlierFilter === opt.value ? 'var(--accent)' : 'var(--bg-page)',
                    color: outlierFilter === opt.value ? 'var(--accent-text)' : 'var(--text-secondary)',
                    transition: 'all 0.15s ease',
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            <button
              onClick={deleteSelected}
              disabled={selectedCount === 0}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto',
                background: selectedCount === 0 ? 'var(--bg-muted)' : 'var(--red-bg, #fee2e2)',
                color: selectedCount === 0 ? 'var(--text-muted)' : 'var(--red-text, #b91c1c)',
                border: '1px solid var(--border)', borderRadius: 6, padding: '8px 16px',
                cursor: selectedCount === 0 ? 'not-allowed' : 'pointer',
                fontWeight: 600, fontSize: 13,
              }}
            >
              <Trash2 size={15} />
              {`Delete${selectedCount > 0 ? ` (${selectedCount})` : ''}`}
            </button>
            <button
              onClick={() => fetchTranscripts('kome')}
              disabled={selectedCount === 0 || fetchingTranscripts || fetchingTranscriptsLocal}
              title="Fetch transcripts via kome.ai"
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                background: selectedCount === 0 || fetchingTranscripts || fetchingTranscriptsLocal ? 'var(--bg-muted)' : 'var(--accent)',
                color: selectedCount === 0 || fetchingTranscripts || fetchingTranscriptsLocal ? 'var(--text-muted)' : 'var(--accent-text)',
                border: '1px solid var(--border)', borderRadius: 6, padding: '8px 16px',
                cursor: selectedCount === 0 || fetchingTranscripts || fetchingTranscriptsLocal ? 'not-allowed' : 'pointer',
                fontWeight: 600, fontSize: 13,
              }}
            >
              {fetchingTranscripts
                ? <Loader2 size={15} style={{ animation: 'spin 0.8s linear infinite' }} />
                : <FileText size={15} />}
              {fetchingTranscripts ? 'Fetching transcripts...' : `Get Transcripts${selectedCount > 0 ? ` (${selectedCount})` : ''}`}
            </button>
            <button
              onClick={() => fetchTranscripts('local')}
              disabled={selectedCount === 0 || fetchingTranscripts || fetchingTranscriptsLocal}
              title="Fetch transcripts locally via yt-dlp (no kome.ai)"
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                background: selectedCount === 0 || fetchingTranscripts || fetchingTranscriptsLocal ? 'var(--bg-muted)' : 'var(--bg-page)',
                color: selectedCount === 0 || fetchingTranscripts || fetchingTranscriptsLocal ? 'var(--text-muted)' : 'var(--text-primary, inherit)',
                border: '1px solid var(--border)', borderRadius: 6, padding: '8px 16px',
                cursor: selectedCount === 0 || fetchingTranscripts || fetchingTranscriptsLocal ? 'not-allowed' : 'pointer',
                fontWeight: 600, fontSize: 13,
              }}
            >
              {fetchingTranscriptsLocal
                ? <Loader2 size={15} style={{ animation: 'spin 0.8s linear infinite' }} />
                : <FileText size={15} />}
              {fetchingTranscriptsLocal ? 'Fetching (local)...' : `Get Transcripts (Local)${selectedCount > 0 ? ` (${selectedCount})` : ''}`}
            </button>
          </div>

          {/* Data table */}
          {filteredRows.length === 0 ? (
            <div style={{
              padding: 40, textAlign: 'center', color: 'var(--text-muted)',
              border: '1px dashed var(--border)', borderRadius: 8,
            }}>
              No videos match this filter.
            </div>
          ) : (
          <div style={{ overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, whiteSpace: 'nowrap' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--border)', textAlign: 'left', background: 'var(--bg-muted)' }}>
                  <th style={{ padding: '10px 12px' }}>
                    <input type="checkbox" checked={allSelected} onChange={toggleAll} style={{ cursor: 'pointer' }} />
                  </th>
                  <th style={{ padding: '10px 12px', fontWeight: 600 }}>Title</th>
                  <th style={{ padding: '10px 12px', fontWeight: 600 }}>Video ID</th>
                  <th style={{ padding: '10px 12px', fontWeight: 600 }}>Published</th>
                  <th style={{ padding: '10px 12px', fontWeight: 600 }}>Days</th>
                  <th style={{ padding: '10px 12px', fontWeight: 600 }}>Views</th>
                  <th style={{ padding: '10px 12px', fontWeight: 600 }}>VPH</th>
                  <th style={{ padding: '10px 12px', fontWeight: 600 }}>Ratio</th>
                  <th style={{ padding: '10px 12px', fontWeight: 600 }}>Bracket</th>
                  <th style={{ padding: '10px 12px', fontWeight: 600 }}>Outlier</th>
                  <th style={{ padding: '10px 12px', fontWeight: 600 }}>Likes</th>
                  <th style={{ padding: '10px 12px', fontWeight: 600 }}>Comments</th>
                  <th style={{ padding: '10px 12px', fontWeight: 600 }}>Transcript</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row, index) => {
                  const status = transcriptStatus[row.videoId] || 'idle';
                  const isSelected = selected.has(row.videoId);
                  const isExpanded = expandedTranscript === row.videoId;
                  const isMatch = searchQueryTrimmed !== '' && searchMatchSet.has(row.videoId);
                  return (
                    <tr
                      key={row.videoId}
                      id={`yt-row-${row.videoId}`}
                      style={{
                        borderBottom: '1px solid var(--border-light)',
                        background: isMatch
                          ? 'rgba(250, 204, 21, 0.25)'
                          : isSelected ? 'var(--bg-hover)' : 'transparent',
                        boxShadow: isMatch ? 'inset 0 0 0 1px rgba(202, 138, 4, 0.6)' : 'none',
                      }}
                    >
                      <td style={{ padding: '8px 12px', userSelect: 'none' }}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          readOnly
                          onClick={e => toggleRow(row.videoId, index, e.shiftKey, filteredRows)}
                          style={{ cursor: 'pointer' }}
                        />
                      </td>
                      <td style={{ padding: '8px 12px', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis' }} title={row.title}>
                        {row.title}
                      </td>
                      <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontSize: 12 }}>
                        <a
                          href={`https://www.youtube.com/watch?v=${row.videoId}`}
                          target="_blank"
                          rel="noreferrer"
                          style={{ color: 'var(--accent)', textDecoration: 'none' }}
                        >
                          {row.videoId}
                        </a>
                      </td>
                      <td style={{ padding: '8px 12px', color: 'var(--text-secondary)' }}>
                        {new Date(row.publishedAt).toLocaleDateString()}
                      </td>
                      <td style={{ padding: '8px 12px' }}>{row.daysSinceUpload}</td>
                      <td style={{ padding: '8px 12px' }}>{row.views.toLocaleString()}</td>
                      <td style={{ padding: '8px 12px' }}>{row.VPH.toLocaleString()}</td>
                      <td style={{ padding: '8px 12px' }}>{row.ratio}</td>
                      <td style={{ padding: '8px 12px', fontWeight: 600 }}>{row.bracket}</td>
                      <td style={{ padding: '8px 12px' }}>
                        <span style={{
                          padding: '2px 10px', borderRadius: 12, fontSize: 12, fontWeight: 600,
                          ...outlierStyle(row.outlier),
                        }}>
                          {row.outlier}
                        </span>
                      </td>
                      <td style={{ padding: '8px 12px' }}>{row.likeCount.toLocaleString()}</td>
                      <td style={{ padding: '8px 12px' }}>{row.commentCount.toLocaleString()}</td>
                      <td
                        style={{
                          padding: '8px 12px', maxWidth: 300, color: 'var(--text-secondary)',
                          whiteSpace: isExpanded ? 'normal' : 'nowrap',
                          overflow: 'hidden', textOverflow: 'ellipsis',
                          cursor: row.transcript ? 'pointer' : 'default',
                        }}
                        title={row.transcript ? (isExpanded ? 'Click to collapse' : 'Click to expand') : ''}
                        onClick={() => {
                          if (row.transcript) setExpandedTranscript(isExpanded ? null : row.videoId);
                        }}
                      >
                        {status === 'loading' && (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)' }}>
                            <Loader2 size={14} style={{ animation: 'spin 0.8s linear infinite' }} /> fetching...
                          </span>
                        )}
                        {status === 'error' && (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--red-text, #b91c1c)' }}>
                            <XCircle size={14} /> failed
                          </span>
                        )}
                        {status !== 'loading' && status !== 'error' && (
                          row.transcript
                            ? (
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%' }}>
                                {status === 'done' && <CheckCircle2 size={14} style={{ color: 'var(--green-text, #15803d)', flexShrink: 0 }} />}
                                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                  {isExpanded ? row.transcript : `${row.transcript.slice(0, 60)}...`}
                                </span>
                              </span>
                            )
                            : <span style={{ color: 'var(--text-muted)' }}>—</span>
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

      {rows.length === 0 && !fetching && !error && (
        <div style={{
          padding: 60, textAlign: 'center', color: 'var(--text-muted)',
          border: '2px dashed var(--border)', borderRadius: 12,
        }}>
          <Search size={32} style={{ marginBottom: 12, opacity: 0.5 }} />
          <p style={{ fontSize: 15 }}>Enter a YouTube channel ID above to collect video data</p>
        </div>
      )}
    </div>
  );
}
