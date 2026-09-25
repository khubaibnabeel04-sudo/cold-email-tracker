import React, { useEffect, useState } from 'react';
import { Search, Download, Loader2, XCircle, Copy, ExternalLink, Trash2, Lightbulb, Users } from 'lucide-react';
import * as XLSX from 'xlsx';

const API_BASE = 'http://localhost:3006';

interface IdeaVideo {
  videoId: string;
  title: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
  thumbnail: string;
  views: number;
  likeCount: number;
  commentCount: number;
  url: string;
  searchQuery?: string;
}

interface IdeaChannel {
  channelId: string;
  channelTitle: string;
  channelUrl: string;
  thumbnail: string;
  subscriberCount: number | null;
  firstSeenAt: string;
  lastSeenAt: string;
  queries: string[];
  timesFound: number;
}

export default function IdeasPage() {
  const [query, setQuery] = useState('');
  const [videos, setVideos] = useState<IdeaVideo[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [lastQuery, setLastQuery] = useState('');
  const [channels, setChannels] = useState<IdeaChannel[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'Ideas — YouTube Search';
    loadChannels();
  }, []);

  async function loadChannels() {
    try {
      const res = await fetch(`${API_BASE}/api/ideas/channels`);
      const data = await res.json();
      setChannels((data.channels || []).sort((a: IdeaChannel, b: IdeaChannel) =>
        new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime()
      ));
    } catch {
      // Channels panel is best-effort; a failed load just leaves it empty
    }
  }

  async function runSearch() {
    const q = query.trim();
    if (!q || searching) return;

    setSearching(true);
    setError('');
    setLastQuery(q);

    try {
      const res = await fetch(`${API_BASE}/api/youtube/search-ideas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      const newVideos: IdeaVideo[] = (data.videos || []).map((v: IdeaVideo) => ({ ...v, searchQuery: q }));
      // Accumulate results across searches, de-duped by videoId (keep the first occurrence)
      setVideos(prev => {
        const seen = new Set(prev.map(v => v.videoId));
        const additions = newVideos.filter(v => !seen.has(v.videoId));
        return [...prev, ...additions];
      });
      if (data.channels) {
        setChannels(data.channels.sort((a: IdeaChannel, b: IdeaChannel) =>
          new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime()
        ));
      }
      if ((data.videos || []).length === 0) {
        setError('No recent videos found for this topic.');
      }
    } catch (err: any) {
      setError(err.message || 'Search failed');
    } finally {
      setSearching(false);
    }
  }

  function clearResults() {
    if (videos.length === 0) return;
    if (!window.confirm('Clear all search results? This cannot be undone.')) return;
    setVideos([]);
    setError('');
    setLastQuery('');
  }

  function exportToExcel() {
    if (videos.length === 0) return;
    const exportRows = videos.map(v => ({
      searchQuery: v.searchQuery || '',
      title: v.title,
      channelTitle: v.channelTitle,
      publishedAt: v.publishedAt,
      views: v.views,
      likeCount: v.likeCount,
      commentCount: v.commentCount,
      videoId: v.videoId,
      url: v.url,
      channelId: v.channelId,
    }));
    const ws = XLSX.utils.json_to_sheet(exportRows, {
      header: ['searchQuery', 'title', 'channelTitle', 'publishedAt', 'views', 'likeCount', 'commentCount', 'videoId', 'url', 'channelId'],
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Ideas');
    const stamp = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `youtube_ideas_${stamp}.xlsx`);
  }

  async function copyChannelUrl(channel: IdeaChannel) {
    try {
      await navigator.clipboard.writeText(channel.channelUrl);
      setCopiedId(channel.channelId);
      setTimeout(() => setCopiedId(prev => (prev === channel.channelId ? null : prev)), 1500);
    } catch {
      window.prompt('Copy channel URL:', channel.channelUrl);
    }
  }

  async function removeChannel(channelId: string) {
    try {
      const res = await fetch(`${API_BASE}/api/ideas/channels/${encodeURIComponent(channelId)}`, { method: 'DELETE' });
      const data = await res.json();
      setChannels((data.channels || []).sort((a: IdeaChannel, b: IdeaChannel) =>
        new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime()
      ));
    } catch {
      // ignore
    }
  }

  async function clearAllChannels() {
    if (!window.confirm('Clear all saved channels? This cannot be undone.')) return;
    try {
      const res = await fetch(`${API_BASE}/api/ideas/channels/clear`, { method: 'POST' });
      const data = await res.json();
      setChannels(data.channels || []);
    } catch {
      // ignore
    }
  }

  return (
    <div style={{
      display: 'flex', height: '100vh', fontFamily: 'system-ui, sans-serif',
      background: 'var(--bg-page)', color: 'var(--text-primary)',
    }}>
      {/* Main: search + video results */}
      <main style={{ flex: 1, overflow: 'auto', padding: 32 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <div>
            <h1 style={{ fontSize: 28, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 10 }}>
              <Lightbulb size={26} /> Ideas
            </h1>
            <p style={{ color: 'var(--text-secondary)' }}>
              Search a topic to find the top 20 recent (last 4 months) YouTube videos, by views. Results accumulate across searches.
            </p>
          </div>
          {videos.length > 0 && (
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={clearResults}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  background: 'var(--bg-muted)', color: 'var(--text-primary)',
                  border: '1px solid var(--border)', borderRadius: 8, padding: '10px 16px',
                  cursor: 'pointer', fontWeight: 600, fontSize: 14,
                }}
              >
                <Trash2 size={16} />
                Clear results
              </button>
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
            </div>
          )}
        </div>

        {/* Search bar */}
        <div style={{
          display: 'flex', gap: 12, alignItems: 'center', marginBottom: 20,
          background: 'var(--bg-muted)', padding: 12, borderRadius: 8, border: '1px solid var(--border)',
        }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <input
              type="text"
              placeholder="Search a topic, e.g. 'AI coding agents'..."
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') runSearch(); }}
              disabled={searching}
              style={{
                width: '100%', padding: '10px 12px 10px 36px', boxSizing: 'border-box',
                borderRadius: 6, border: '1px solid var(--border)', fontSize: 14,
              }}
            />
            <Search size={16} style={{ position: 'absolute', left: 12, top: 13, color: 'var(--text-muted)' }} />
          </div>
          <button
            onClick={runSearch}
            disabled={searching || !query.trim()}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              background: 'var(--accent)', color: 'var(--accent-text)',
              border: 'none', borderRadius: 6, padding: '10px 20px',
              cursor: searching || !query.trim() ? 'not-allowed' : 'pointer',
              fontWeight: 600, fontSize: 14,
              opacity: searching || !query.trim() ? 0.6 : 1,
            }}
          >
            {searching ? <Loader2 size={16} style={{ animation: 'spin 0.8s linear infinite' }} /> : <Search size={16} />}
            {searching ? 'Searching...' : 'Search'}
          </button>
        </div>

        {error && (
          <div style={{
            padding: '12px 16px', borderRadius: 8, marginBottom: 20,
            background: 'var(--red-bg, #fee2e2)', color: 'var(--red-text, #b91c1c)',
            fontSize: 14, border: '1px solid var(--red-text, #b91c1c)',
          }}>
            {error}
          </div>
        )}

        {videos.length > 0 && (
          <>
            <div style={{ marginBottom: 12, fontSize: 14, color: 'var(--text-secondary)' }}>
              <strong style={{ color: 'var(--text-primary)' }}>{videos.length}</strong> videos accumulated
              {lastQuery && <> — last search: "{lastQuery}"</>}
            </div>
            <div style={{ overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid var(--border)', textAlign: 'left', background: 'var(--bg-muted)' }}>
                    <th style={{ padding: '10px 12px' }}></th>
                    <th style={{ padding: '10px 12px', fontWeight: 600 }}>Title</th>
                    <th style={{ padding: '10px 12px', fontWeight: 600 }}>Search</th>
                    <th style={{ padding: '10px 12px', fontWeight: 600 }}>Channel</th>
                    <th style={{ padding: '10px 12px', fontWeight: 600 }}>Published</th>
                    <th style={{ padding: '10px 12px', fontWeight: 600 }}>Views</th>
                    <th style={{ padding: '10px 12px', fontWeight: 600 }}>Likes</th>
                    <th style={{ padding: '10px 12px', fontWeight: 600 }}>Comments</th>
                  </tr>
                </thead>
                <tbody>
                  {videos.map(v => (
                    <tr key={v.videoId} style={{ borderBottom: '1px solid var(--border-light)' }}>
                      <td style={{ padding: '8px 12px' }}>
                        {v.thumbnail && (
                          <img src={v.thumbnail} alt="" width={80} style={{ borderRadius: 4, display: 'block' }} />
                        )}
                      </td>
                      <td style={{ padding: '8px 12px', maxWidth: 340 }}>
                        <a href={v.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', textDecoration: 'none' }}>
                          {v.title}
                        </a>
                      </td>
                      <td style={{ padding: '8px 12px', whiteSpace: 'nowrap', color: 'var(--text-secondary)', fontSize: 12 }}>
                        {v.searchQuery || ''}
                      </td>
                      <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>{v.channelTitle}</td>
                      <td style={{ padding: '8px 12px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                        {new Date(v.publishedAt).toLocaleDateString()}
                      </td>
                      <td style={{ padding: '8px 12px' }}>{v.views.toLocaleString()}</td>
                      <td style={{ padding: '8px 12px' }}>{v.likeCount.toLocaleString()}</td>
                      <td style={{ padding: '8px 12px' }}>{v.commentCount.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {videos.length === 0 && !searching && !error && (
          <div style={{
            padding: 60, textAlign: 'center', color: 'var(--text-muted)',
            border: '2px dashed var(--border)', borderRadius: 12,
          }}>
            <Search size={32} style={{ marginBottom: 12, opacity: 0.5 }} />
            <p style={{ fontSize: 15 }}>Search a topic above to find recent video ideas</p>
          </div>
        )}
      </main>

      {/* Sidebar: persisted top channels, unaffected by "new search" clearing */}
      <aside style={{
        width: 320, flexShrink: 0, borderLeft: '1px solid var(--border)',
        background: 'var(--bg-sidebar)', padding: 20, overflow: 'auto',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
            <Users size={16} /> Top Channels
          </h2>
          {channels.length > 0 && (
            <button
              onClick={clearAllChannels}
              title="Clear all saved channels"
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, marginBottom: 16 }}>
          Saved across every search — never cleared by a new search.
        </p>

        {channels.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: 12 }}>
            No channels saved yet. Run a search to start collecting them.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {channels.map(c => (
              <div key={c.channelId} style={{
                border: '1px solid var(--border)', borderRadius: 8, padding: 10,
                background: 'var(--bg-card)',
              }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  {c.thumbnail && (
                    <img src={c.thumbnail} alt="" width={32} height={32} style={{ borderRadius: '50%', flexShrink: 0 }} />
                  )}
                  <div style={{ overflow: 'hidden' }}>
                    <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={c.channelTitle}>
                      {c.channelTitle}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {c.subscriberCount != null ? `${c.subscriberCount.toLocaleString()} subs` : 'subs hidden'}
                      {c.timesFound > 1 && <> &middot; found {c.timesFound}x</>}
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <button
                    onClick={() => copyChannelUrl(c)}
                    style={{
                      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                      padding: '6px 8px', fontSize: 12, fontWeight: 600, borderRadius: 6,
                      border: '1px solid var(--border)', cursor: 'pointer',
                      background: copiedId === c.channelId ? 'var(--green-bg, #dcfce7)' : 'var(--bg-muted)',
                      color: copiedId === c.channelId ? 'var(--green-text, #15803d)' : 'var(--text-secondary)',
                    }}
                  >
                    <Copy size={12} />
                    {copiedId === c.channelId ? 'Copied' : 'Copy URL'}
                  </button>
                  <a
                    href={c.channelUrl}
                    target="_blank"
                    rel="noreferrer"
                    title="Open channel"
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)',
                      color: 'var(--text-secondary)', textDecoration: 'none',
                    }}
                  >
                    <ExternalLink size={12} />
                  </a>
                  <button
                    onClick={() => removeChannel(c.channelId)}
                    title="Remove from saved channels"
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)',
                      cursor: 'pointer', background: 'var(--bg-muted)', color: 'var(--text-muted)',
                    }}
                  >
                    <XCircle size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}
