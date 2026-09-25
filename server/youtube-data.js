// ============================================================
// YouTube Data Collection — port of the n8n "gather youtubers data"
// and "get transcript" workflows. The batching (50 videos per
// videos.list call), the <24h / <120s filters, and the rolling-median
// outlier calculation are kept exactly as in the n8n Code nodes.
// ============================================================

// Optional separate key so data collection and lead reasoning draw from different quotas
const YT_API_KEY = process.env.YOUTUBE_DATA_API_KEY || process.env.YOUTUBE_API_KEY || 'YOUR_YOUTUBE_API_KEY_HERE';
const YT_BASE = 'https://www.googleapis.com/youtube/v3';

// ---------- Step 1: channel → uploads playlist id ----------
async function getUploadsPlaylistId(channelId) {
  const url = `${YT_BASE}/channels?part=contentDetails&id=${encodeURIComponent(channelId)}&key=${YT_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`channels.list failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const channel = data.items && data.items[0];
  const uploads = channel?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw new Error(`Channel not found or has no uploads playlist: ${channelId}`);
  return uploads;
}

// ---------- Step 2: all playlist items (returnAll, paginated) ----------
async function getAllPlaylistItems(playlistId, onProgress = () => {}) {
  const items = [];
  let pageToken = '';
  let page = 0;
  do {
    page++;
    const url = `${YT_BASE}/playlistItems?part=snippet,contentDetails&playlistId=${encodeURIComponent(playlistId)}&maxResults=50&key=${YT_API_KEY}${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`playlistItems.list failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    items.push(...(data.items || []));
    pageToken = data.nextPageToken || '';
    onProgress(`Fetched playlist page ${page} — ${items.length} videos so far`);
  } while (pageToken);
  return items;
}

// ---------- Step 3: chunk into 50s, videos.list per chunk ----------
// (same as "Code in JavaScript9" + "HTTP Request2" + "Code in JavaScript10")
async function getVideoDetails(playlistItems, onProgress = () => {}) {
  const chunkSize = 50;
  const allVideoIds = playlistItems.map(item => item.snippet.resourceId.videoId);

  const chunks = [];
  for (let i = 0; i < allVideoIds.length; i += chunkSize) {
    chunks.push(allVideoIds.slice(i, i + chunkSize));
  }

  const videos = [];
  for (let i = 0; i < chunks.length; i++) {
    onProgress(`Fetching video details — batch ${i + 1}/${chunks.length} (${chunks[i].length} videos)`);
    const url = `${YT_BASE}/videos?part=snippet,statistics,contentDetails&id=${chunks[i].join(',')}&key=${YT_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`videos.list failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    videos.push(...(data.items || []));
  }
  return videos;
}

// ---------- Step 4: filters (If3 node + "Code in JavaScript6") ----------
const parseDuration = (iso) => {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const hours = parseInt(match[1] || 0);
  const minutes = parseInt(match[2] || 0);
  const seconds = parseInt(match[3] || 0);
  return (hours * 3600) + (minutes * 60) + seconds;
};

// 50 minutes — videos at or above this length are treated as "live" (streams/VODs), not long-form
const LIVE_THRESHOLD_SECONDS = 50 * 60;

// videoType: 'long' (>= 180s and < 50min), 'short' (< 180s), 'live' (>= 50min), or 'both' (no duration filtering)
function filterVideos(videos, videoType = 'long') {
  // If3: only videos published more than 24 hours ago
  const cutoff = Date.now() - (24 * 60 * 60 * 1000);
  const olderThanDay = videos.filter(v => new Date(v.snippet.publishedAt).getTime() < cutoff);

  if (videoType === 'both') return olderThanDay;

  // Code in JavaScript6: split on the 120s Shorts boundary, plus the 50min live boundary
  return olderThanDay.filter(v => {
    const iso = v?.contentDetails?.duration || '';
    const sec = parseDuration(iso);
    if (videoType === 'short') return sec < 180;
    if (videoType === 'live') return sec >= LIVE_THRESHOLD_SECONDS;
    return sec >= 180 && sec < LIVE_THRESHOLD_SECONDS;
  });
}

// ---------- Step 5: rolling-median outlier calc ----------
// Exact port of "Code in JavaScript8"
function computeOutliers(videos) {
  const now = Date.now();
  const MS_PER_HOUR = 1000 * 60 * 60;
  const MS_PER_DAY = MS_PER_HOUR * 24;

  const valid = videos.filter(v => v && v.statistics && v.snippet);

  const hoursSince = (ms) => Math.max(1, (now - ms) / MS_PER_HOUR);

  const getMedian = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  // 1) PRE-PROCESS & SORT BY DATE (oldest → newest for rolling calc)
  const processed = valid.map(v => {
    const views = Number(v.statistics.viewCount || 0);
    const publishedMs = new Date(v.snippet.publishedAt).getTime();
    const channelId = v.snippet.channelId || (v.snippet.resourceId ? v.snippet.resourceId.channelId : null);

    return {
      ...v,
      __channelId: channelId,
      __views: views,
      __publishedMs: publishedMs,
      __VPH: views / hoursSince(publishedMs),
      __engagement: (Number(v.statistics.likeCount || 0) + Number(v.statistics.commentCount || 0)) / (views || 1)
    };
  }).sort((a, b) => a.__publishedMs - b.__publishedMs);

  // 2) ROLLING CALCULATION — window of 15 videos before each one
  const results = processed.map((v, index) => {
    const start = Math.max(0, index - 15);
    const window = processed.slice(start, index);

    const windowViews = window.length >= 5 ? window.map(x => x.__views) : processed.map(x => x.__views);
    const baseline = getMedian(windowViews) || 1;

    const ratio = v.__views / baseline;

    let outlierLabel = 'none';
    if (ratio >= 2.0) outlierLabel = 'high';
    else if (ratio <= 0.5) outlierLabel = 'low';

    return {
      channelId: v.__channelId,
      title: v.snippet.title,
      videoId: v.id || (v.snippet.resourceId && v.snippet.resourceId.videoId),
      publishedAt: v.snippet.publishedAt,
      daysSinceUpload: Number(((now - v.__publishedMs) / MS_PER_DAY).toFixed(2)),
      views: v.__views,
      VPH: Number(v.__VPH.toFixed(2)),
      ratio: Number(ratio.toFixed(2)),
      bracket: ratio >= 10 ? `>10x` : `${ratio.toFixed(1)}x`,
      outlier: outlierLabel,
      likeCount: Number(v.statistics.likeCount || 0),
      commentCount: Number(v.statistics.commentCount || 0),
      transcript: v.transcript || ''
    };
  });

  // 3) RE-SORT NEWEST TO OLDEST
  return results.reverse();
}

// ---------- Full pipeline ----------
async function collectChannelData(channelId, videoType = 'long', onProgress = () => {}) {
  onProgress(`Looking up channel ${channelId}...`);
  const uploadsPlaylistId = await getUploadsPlaylistId(channelId);
  onProgress(`Found uploads playlist ${uploadsPlaylistId} — fetching all videos...`);
  const playlistItems = await getAllPlaylistItems(uploadsPlaylistId, onProgress);
  onProgress(`Playlist complete: ${playlistItems.length} videos. Fetching details in batches of 50...`);
  const videos = await getVideoDetails(playlistItems, onProgress);
  const typeLabel = videoType === 'both' ? 'long-form + shorts + live'
    : videoType === 'short' ? 'shorts only'
    : videoType === 'live' ? 'live only (50min+)'
    : 'long-form only (<50min)';
  const filtered = filterVideos(videos, videoType);
  onProgress(`Filtered ${videos.length} videos → ${filtered.length} kept (published >24h ago, ${typeLabel})`);
  if (filtered.length === 0) {
    return { videos: [], message: 'No matching videos found' };
  }
  onProgress(`Computing VPH, rolling-median ratios and outliers...`);
  const results = computeOutliers(filtered);
  onProgress(`Done — ${results.length} videos ready`);
  return { videos: results };
}

// ============================================================
// Transcript — port of the n8n transcript workflow
// (kome.ai request with same headers, retryOnFail maxTries: 2)
// ============================================================

function decodeHtml(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'");
}

async function fetchTranscriptOnce(videoId) {
  const res = await fetch('https://kome.ai/api/transcript', {
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://kome.ai/tools/youtube-transcript-generator',
      'content-type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'Origin': 'https://kome.ai'
    },
    body: JSON.stringify({
      video_id: `https://www.youtube.com/watch?v=${videoId}`,
      format: true,
      source: 'tool'
    })
  });
  if (!res.ok) throw new Error(`kome.ai transcript failed: ${res.status}`);
  const json = await res.json();

  let transcript = '';
  // CASE 1: captions array (old format)
  if (json.captions && Array.isArray(json.captions)) {
    transcript = json.captions.map(c => decodeHtml(c.text)).join(' ');
  }
  // CASE 2: direct transcript string
  else if (json.transcript && typeof json.transcript === 'string') {
    transcript = decodeHtml(json.transcript);
  }

  // Hard cap (same as the n8n workflow)
  return transcript.slice(0, 45900);
}

async function getTranscript(videoId) {
  const maxTries = 2;
  let lastErr;
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    try {
      return await fetchTranscriptOnce(videoId);
    } catch (err) {
      lastErr = err;
      if (attempt < maxTries) await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw lastErr;
}

// ============================================================
// Transcript (local) — yt-dlp, no third-party transcript service.
//
// Direct scraping of YouTube's own timedtext/InnerTube endpoints was
// tried first and currently gets rejected ("Precondition check failed" /
// empty 200 responses) because YouTube now requires a proof-of-origin
// token bound to a real browser session. yt-dlp already solves that
// (it's updated constantly to track YouTube's changes), so we shell out
// to it per video, asking only for the subtitle track (--skip-download)
// and parsing the json3 caption format it writes to a temp dir.
// ============================================================

const { spawn, spawnSync } = require('child_process');
const os = require('os');
const path = require('path');
const fsp = require('fs/promises');

let cachedYtDlpBin = null;

function resolveYtDlpBin() {
  if (cachedYtDlpBin) return cachedYtDlpBin;

  const candidates = [
    process.env.YTDLP_PATH,
    'yt-dlp',
    'yt-dlp.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Packages', 'PythonSoftwareFoundation.Python.3.12_qbz5n2kfra8p0', 'LocalCache', 'local-packages', 'Python312', 'Scripts', 'yt-dlp.exe'),
  ].filter(Boolean);

  for (const bin of candidates) {
    const probe = spawnSync(bin, ['--version'], { windowsHide: true, shell: process.platform === 'win32' });
    if (probe.status === 0) {
      cachedYtDlpBin = bin;
      return bin;
    }
  }
  throw new Error('yt-dlp not found. Install it with "pip install -U yt-dlp" (and make sure it is on PATH, or set YTDLP_PATH to its full .exe path).');
}

function runYtDlp(args) {
  const bin = resolveYtDlpBin();
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { windowsHide: true, shell: process.platform === 'win32' });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`yt-dlp exited with code ${code}: ${stderr.trim().slice(-500) || 'no error output'}`));
    });
  });
}

function json3ToText(raw) {
  const data = JSON.parse(raw);
  return (data.events || [])
    .filter((e) => Array.isArray(e.segs))
    .map((e) => e.segs.map((s) => s.utf8 || '').join(''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchTranscriptLocalOnce(videoId, subLang) {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'yt-transcript-'));
  try {
    await runYtDlp([
      '--skip-download',
      '--write-auto-sub',
      '--write-sub',
      '--sub-lang', subLang,
      '--sub-format', 'json3',
      '--no-warnings',
      '-o', path.join(tmpDir, 'sub.%(ext)s'),
      `https://www.youtube.com/watch?v=${videoId}`,
    ]);
    const files = await fsp.readdir(tmpDir);
    const jsonFile = files.find((f) => f.endsWith('.json3'));
    if (!jsonFile) return '';
    const raw = await fsp.readFile(path.join(tmpDir, jsonFile), 'utf8');
    return json3ToText(raw);
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Same 45900-char cap as the Kome path, so downstream code (Excel export
// cell limit, AI prompt building) doesn't need to care which source ran.
async function getTranscriptLocal(videoId) {
  // First pass: English tracks only (fast, covers most channels).
  let text = await fetchTranscriptLocalOnce(videoId, 'en,en-US,en-GB,en-orig');
  // Fallback: whatever caption language the video actually has.
  if (!text) text = await fetchTranscriptLocalOnce(videoId, 'all');
  if (!text) throw new Error('No captions available for this video');
  return text.slice(0, 45900);
}

// ============================================================
// Ideas search — YouTube search.list endpoint, top 20 recent videos
// for a topic, plus the channels behind them.
// ============================================================

const IDEAS_RESULT_COUNT = 20;
const IDEAS_MAX_AGE_MONTHS = 4;
// How many search candidates to pull before filtering out Shorts — search.list
// can't filter Shorts directly, so we over-fetch, drop anything <180s
// (same Shorts boundary used by the channel-data pipeline), then keep the top 20.
const IDEAS_CANDIDATE_POOL = 100;
const IDEAS_PAGE_SIZE = 50;

// ---------- videos.list in chunks of 50 (shared helper) ----------
async function getVideosByIds(videoIds) {
  const chunkSize = 50;
  const videos = [];
  for (let i = 0; i < videoIds.length; i += chunkSize) {
    const chunk = videoIds.slice(i, i + chunkSize);
    const url = `${YT_BASE}/videos?part=snippet,statistics,contentDetails&id=${chunk.join(',')}&key=${YT_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`videos.list failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    videos.push(...(data.items || []));
  }
  return videos;
}

// ---------- channels.list in chunks of 50 ----------
async function getChannelsByIds(channelIds) {
  const chunkSize = 50;
  const channels = [];
  for (let i = 0; i < channelIds.length; i += chunkSize) {
    const chunk = channelIds.slice(i, i + chunkSize);
    const url = `${YT_BASE}/channels?part=snippet,statistics&id=${chunk.join(',')}&key=${YT_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`channels.list failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    channels.push(...(data.items || []));
  }
  return channels;
}

async function searchIdeas(query, onProgress = () => {}) {
  const trimmed = (query || '').trim();
  if (!trimmed) throw new Error('Search query is required');

  const publishedAfter = new Date(Date.now() - IDEAS_MAX_AGE_MONTHS * 30 * 24 * 60 * 60 * 1000).toISOString();

  onProgress(`Searching YouTube for "${trimmed}" (recent, by relevance)...`);
  // Use YouTube's own relevance ranking (same as searching on youtube.com) —
  // ordering by viewCount pulled loosely-matching popular videos instead of
  // the ones an actual YouTube user would see for this query.
  // Over-fetch candidates across pages since search.list has no Shorts filter;
  // we drop Shorts below using real duration. We also preserve each result's
  // rank in the response as the tie-breaker for our own sort.
  let items = [];
  let pageToken = '';
  while (items.length < IDEAS_CANDIDATE_POOL) {
    const searchUrl = `${YT_BASE}/search?part=snippet&type=video&order=relevance` +
      `&q=${encodeURIComponent(trimmed)}&publishedAfter=${publishedAfter}` +
      `&maxResults=${IDEAS_PAGE_SIZE}&key=${YT_API_KEY}` +
      (pageToken ? `&pageToken=${pageToken}` : '');
    const searchRes = await fetch(searchUrl);
    if (!searchRes.ok) throw new Error(`search.list failed: ${searchRes.status} ${await searchRes.text()}`);
    const searchData = await searchRes.json();
    items.push(...(searchData.items || []));
    pageToken = searchData.nextPageToken || '';
    if (!pageToken) break;
  }

  if (items.length === 0) {
    return { videos: [], channels: [] };
  }

  const seenVideoIds = new Set();
  items = items.filter(it => {
    const id = it.id.videoId;
    if (!id || seenVideoIds.has(id)) return false;
    seenVideoIds.add(id);
    return true;
  });

  const videoIds = Array.from(seenVideoIds);
  onProgress(`Found ${videoIds.length} candidate videos — fetching stats and filtering out Shorts...`);
  const videoDetails = await getVideosByIds(videoIds);
  const detailsById = new Map(videoDetails.map(v => [v.id, v]));

  // Tokenize the query for relevance scoring — lowercase words 2+ chars long,
  // strip punctuation, drop obvious stopwords.
  const STOPWORDS = new Set(['the','a','an','and','or','of','for','in','on','to','with','how','why','what','is','are','be']);
  const queryTokens = trimmed
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2 && !STOPWORDS.has(w));

  const candidates = items
    .map((it, idx) => {
      const d = detailsById.get(it.id.videoId);
      if (!d) return null;
      // Shorts boundary (<180s) — same cutoff the channel-data pipeline uses
      const durationSec = parseDuration(d.contentDetails?.duration || '');
      if (durationSec < 180) return null;
      const stats = d.statistics || {};
      const title = d.snippet.title || '';
      const titleLower = title.toLowerCase();
      const matchedCount = queryTokens.filter(t => titleLower.includes(t)).length;
      return {
        videoId: it.id.videoId,
        title,
        channelId: d.snippet.channelId,
        channelTitle: d.snippet.channelTitle,
        publishedAt: d.snippet.publishedAt,
        thumbnail: d.snippet.thumbnails?.medium?.url || d.snippet.thumbnails?.default?.url || '',
        views: Number(stats.viewCount || 0),
        likeCount: Number(stats.likeCount || 0),
        commentCount: Number(stats.commentCount || 0),
        url: `https://www.youtube.com/watch?v=${it.id.videoId}`,
        _matched: matchedCount,
        _rank: idx, // preserve YouTube's own relevance ranking as tie-break
      };
    })
    .filter(Boolean);

  // Primary sort: number of query tokens matched in title (desc).
  // Tie-break: YouTube's own relevance rank (asc) so results look like what a
  // user would actually see on youtube.com — high-view videos that don't
  // match the query no longer float to the top.
  const videos = candidates
    .sort((a, b) => (b._matched - a._matched) || (a._rank - b._rank))
    .slice(0, IDEAS_RESULT_COUNT)
    .map(({ _matched, _rank, ...v }) => v);

  onProgress(`Fetching channel info for ${new Set(videos.map(v => v.channelId)).size} channel(s)...`);
  const uniqueChannelIds = Array.from(new Set(videos.map(v => v.channelId)));
  const channelDetails = await getChannelsByIds(uniqueChannelIds);
  const channels = channelDetails.map(c => ({
    channelId: c.id,
    channelTitle: c.snippet.title,
    channelUrl: `https://www.youtube.com/channel/${c.id}`,
    thumbnail: c.snippet.thumbnails?.medium?.url || c.snippet.thumbnails?.default?.url || '',
    subscriberCount: c.statistics.hiddenSubscriberCount ? null : Number(c.statistics.subscriberCount || 0),
  }));

  onProgress(`Done — ${videos.length} videos, ${channels.length} channels`);
  return { videos, channels };
}

module.exports = { collectChannelData, getTranscript, getTranscriptLocal, searchIdeas };
