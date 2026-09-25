import { VideoRow } from '../types';

const API_BASE = 'http://localhost:3006';

/**
 * Runs the same channel-data pipeline as the Data Collection page / ChannelDataPanel,
 * but as a standalone function (no React component) so it can run automatically in the
 * background — on mini-report confirmation and as a one-time backfill for existing MOF
 * leads — instead of only when a user opens the per-lead data panel.
 */
export async function fetchChannelVideos(channelId: string, videoType: 'long' | 'short' | 'both' = 'long'): Promise<VideoRow[]> {
  const res = await fetch(`${API_BASE}/api/youtube/channel-data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelId, videoType }),
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as any).error || `Request failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: VideoRow[] | null = null;

  const handleLine = (line: string) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    if (msg.type === 'result') result = msg.videos || [];
    else if (msg.type === 'error') throw new Error(msg.error);
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
  if (result === null) throw new Error('Stream ended without a result');
  return result;
}

/** Channel/video data ready to store in MofState.leadChannelData. The AI generator
 *  only uses titles, view counts, and outlier status, not transcripts, so this stays
 *  a plain video-stats fetch rather than also pulling transcripts per video. */
export async function collectLeadChannelData(channelId: string): Promise<VideoRow[]> {
  return fetchChannelVideos(channelId, 'long');
}
