import { Account, MofFollowUpRecord, MofLeadChannelData, MofPhaseType, VideoRow } from '../types';
import { fetchThreadMessages, ThreadMessage } from './gmail';
import { pickAngle, computeHasFreshVideo, computeHasDeclineSignal, MofAngle } from '../utils/mofAngles';

const API_BASE = 'http://localhost:3006';
const THREAD_CONTEXT_MAX_CHARS = 6000;

export interface GenerateFollowUpParams {
  leadName: string;
  channelName?: string;
  /** The lead's original mini-report thread id (lead.threadId). Context is pulled from
   *  this PLUS every thread any past touch actually landed in (from history) — not just
   *  the thread this touch happens to be sending into — since most touches start a brand
   *  new Gmail thread and would otherwise have zero memory of the relationship so far. */
  miniReportThreadId?: string;
  account?: Account;
  onAccountUpdated?: (updatedAcc: Account) => void;
  channelData?: MofLeadChannelData;
  history: MofFollowUpRecord[];
  phase: MofPhaseType;
  touchNumber: number;
  day: number;
  /** Days since the last message to this lead (the mini report, or their last follow-up,
   *  whichever is more recent) — lets the AI notice when a "quick nudge" is actually going
   *  out after a long silence and adjust accordingly, instead of pretending no time passed. */
  daysSinceLastContact: number;
  /** True when this touch starts a brand new thread (no threadId to reply into yet). */
  needsSubject: boolean;
}

export interface GeneratedFollowUp {
  subject: string;
  body: string;
  angle: MofAngle;
}

function summarizeThread(messages: ThreadMessage[]): string {
  if (!messages || messages.length === 0) return '';
  return messages
    .map(m => `From: ${m.from}\nDate: ${m.date}\n${(m.body || m.snippet || '').trim()}`)
    .join('\n\n---\n\n')
    .slice(-THREAD_CONTEXT_MAX_CHARS);
}

function angleSummary(record: MofFollowUpRecord): string {
  return `Touch #${record.touchNumber} (${record.phase} phase, ${record.sentAt.slice(0, 10)}): angle "${record.angle || 'unknown'}"`;
}

function lastTouchAtForAngle(history: MofFollowUpRecord[], angle: string): string | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].angle === angle) return history[i].sentAt;
  }
  return undefined;
}

/**
 * Assembles full context for a lead's next follow-up (thread history, channel/video
 * data, angle rotation state) and asks the server's Groq-backed route to write the
 * actual email. This is the only place that decides which angle a touch gets, so
 * the "never repeat yourself" rule stays in one spot.
 */
export async function generateFollowUp(params: GenerateFollowUpParams): Promise<GeneratedFollowUp> {
  const { leadName, channelName, miniReportThreadId, account, onAccountUpdated, channelData, history, phase, touchNumber, day, daysSinceLastContact, needsSubject } = params;

  const usedAngles = history.map(h => h.angle).filter((a): a is string => !!a);
  const videos: VideoRow[] = channelData?.videos || [];

  const angle = pickAngle({
    touchNumber,
    usedAngles,
    daysSinceLastContact,
    hasVideos: videos.length > 0,
    hasFreshVideo: computeHasFreshVideo(videos, usedAngles, lastTouchAtForAngle(history, 'new_video')),
    hasDeclineSignal: computeHasDeclineSignal(videos),
  });

  // Gather every thread this lead has ever actually been touched in, not just the one
  // this send happens to be going into, so the AI still has full memory of the
  // relationship even when the touch schedule starts a brand new Gmail thread.
  let threadContext = '';
  if (account) {
    const threadIds = new Set<string>();
    if (miniReportThreadId) threadIds.add(miniReportThreadId);
    for (const h of history) {
      if (h.threadId) threadIds.add(h.threadId);
      if (h.miniReportThreadId) threadIds.add(h.miniReportThreadId);
    }
    if (threadIds.size > 0) {
      const results = await Promise.all(
        Array.from(threadIds).map(tid => fetchThreadMessages(tid, account, onAccountUpdated).catch(() => [] as ThreadMessage[]))
      );
      const allMessages = results.flat().sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      // Safety guard: if the lead replied AFTER our last recorded touch (or, for the
      // first touch, at any point — an early "sure, send it over" consent reply is
      // expected and fine there) and that reply hasn't been processed yet
      // (checkForReplies would normally close the sequence), refuse to generate a
      // follow-up over it instead of sending an awkward "bumping this" email.
      const lastTouchAt = history.length > 0 ? new Date(history[history.length - 1].sentAt).getTime() : null;
      const leadReplied = lastTouchAt !== null && allMessages.some(m =>
        m.from && !m.from.toLowerCase().includes(account.email.toLowerCase()) && new Date(m.date).getTime() > lastTouchAt
      );
      if (leadReplied) {
        throw new Error(`${leadName} has a reply in their thread that hasn't been processed yet — run Check Replies first.`);
      }

      threadContext = summarizeThread(allMessages);
    }
  }

  // Title, view count, and outlier status only — the AI generator doesn't use
  // transcripts, quoting an isolated line out of context read as clunky in testing.
  const videosForPrompt = videos.slice(0, 3).map(v => ({
    title: v.title,
    daysSinceUpload: v.daysSinceUpload,
    views: v.views,
    outlier: v.outlier,
  }));

  const res = await fetch(`${API_BASE}/api/ai/generate-followup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      leadName,
      channelName,
      angle,
      needsSubject,
      phase,
      touchNumber,
      day,
      daysSinceLastContact,
      threadContext,
      videos: videosForPrompt,
      previousAngleSummaries: history.slice(-5).map(angleSummary),
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `AI generation failed (${res.status})`);

  return { subject: data.subject || '', body: data.body || '', angle };
}
