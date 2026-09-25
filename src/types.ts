export interface Account {
  id: string;
  email: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  dailyLimit: number;
  sentToday: number;
  lastResetDate: string;
}

export interface Lead {
  id: string;
  email: string;
  name: string;
  page: 'new' | 'old' | 'stale';
  status: LeadStatus;
  customData: Record<string, string>;
  threadId?: string;
  sentFromAccount?: string;
  lastContactDate?: string;
  /** Timestamp of the lead's FIRST reply in the winning thread (ignores any messages,
   *  from either side, that came after it). Used to sort the Replies list so a lead
   *  doesn't keep jumping to the top just because the conversation continues. */
  firstReplyDate?: string;
  lastAnalyzed?: string;
  createdAt: string;
  /** Template used for the most recent send (initial or follow-up). Only set on
   *  sends made after per-template reply tracking was added — leads sent before
   *  that have no value here and are excluded from template stats. */
  templateId?: string;
  /** Marked by user as an automated/non-human reply (out-of-office, etc.) */
  automatedReply?: boolean;
  /** Marked by user as a bounced email (hard bounce, invalid address, etc.) */
  bounced?: boolean;
  /** Marked by user as a closed deal (a real reply that converted) */
  closed?: boolean;
  /**
   * Has this lead been through the sync/analysis pipeline at least once?
   * New leads default to `false`; the sync pipelines (server/gmail-sync.js and the
   * per-lead / batch sync functions in New Leads, Old Leads, and Today pages) set this
   * to `true` once a lead has been analyzed. Used to gate the fu2 "gone stale" rule so
   * a lead's very first sync can't immediately sweep it into Stale Leads.
   */
  syncedOnce?: boolean;
}

export type LeadStatus = string;

export interface FollowUpConfig {
  delayDays: number;
}

export interface Template {
  id: string;
  name: string;
  type: string; // 'initial' | 'fu1' | 'fu2' | 'fu3' | ...
  leadType: 'new' | 'old';
  subject: string;
  body: string;
}

export interface AppSettings {
  defaultDailyLimit: number;
  followUps: FollowUpConfig[];
  dateCutoff: string; // "2025-11-01"
  clientId?: string;
  clientSecret?: string;
  theme?: 'light' | 'dark';
  youtubeApiKey?: string;
}

export interface YouTubeChannel {
  id: string;
  title: string;
  description: string;
  thumbnailUrl: string;
  subscriberCount: string;
  videoCount: string;
  viewCount: string;
  email?: string;
  customUrl?: string;
  country?: string;
  publishedAt: string;
}

export interface YouTubeSearchResult {
  channels: YouTubeChannel[];
  nextPageToken?: string;
  totalResults?: number;
}

// ─── Middle of Funnel Types ───────────────────────────────────────

export interface MofTouchConfig {
  day: number;
  /** Per-touch personalized content (overrides lead-level default for this touch) */
  personalizedSubject?: string;
  personalizedBody?: string;
  /**
   * When true, this touch sends into the thread created by the immediately
   * preceding touch in the same phase (reply, no subject) instead of starting
   * its own brand-new thread. Meaningless on a phase's first touch.
   */
  joinPrevious?: boolean;
}

export interface MofLeadConfig {
  /** Default personalized content used when a touch doesn't have its own */
  defaultPersonalizedSubject: string;
  defaultPersonalizedBody: string;
  phase1Touches: MofTouchConfig[];  // default: day 3,7,14,21 — sent in same thread
  phase2Touches: MofTouchConfig[];  // default: day 35,55,75,90 — new thread
  phase3Touches: MofTouchConfig[];  // default: day 120,150,180,210,240,270,300,330,360 — new thread
  followUpThreadId?: string; // thread used for phase 2+ follow-ups (new thread)
  /**
   * "Start new thread" override. `undefined` = default behavior (phase 1 continues
   * lead.threadId). Set to '' by the "Start New Thread" action as a sentinel meaning
   * the next send should omit threadId entirely; once that send succeeds, this is
   * updated to the real new threadId so subsequent phase-1 touches continue it.
   */
  activeThreadOverride?: string;
}

/** A lead added directly within MOF — lives only here unless explicitly promoted. */
export interface IndividualMofLead {
  id: string;
  email: string;
  name: string;
  channelId?: string;
  channelName?: string;
  notes?: string;
  createdAt: string;
  threadId?: string;
  sentFromAccount?: string;
  /** True once pushed into the main app's newLeads via MOF_PROMOTE_INDIVIDUAL_LEAD */
  promotedToMainApp?: boolean;
}

export type MofPhaseType = 'active' | 'nurture' | 'perpetual' | 'cold_storage' | 'closed';

export interface MofPhase {
  phase: MofPhaseType;
  enteredAt: string;
  lastTouchAt: string;
  silenceMonths: number;
  /** True when the user manually picked this phase (via the phase selector).
   *  When set, the phase is NOT auto-recomputed from days-since-mini-report;
   *  it stays exactly where the user put it until they change it again. */
  manualPhase?: boolean;
}

export interface MofFollowUpRecord {
  sentAt: string;
  phase: MofPhaseType;
  touchNumber: number;
  templateType: string;
  threadId: string;
  miniReportThreadId: string;
  /** Which content angle the AI used for this touch (see src/utils/mofAngles.ts) — tracked
   *  so the next touch's angle picker never repeats what was just used for this lead. */
  angle?: string;
}

/** One video row from the YouTube data-collection pipeline (server/youtube-data.js). */
export interface VideoRow {
  channelId: string;
  title: string;
  videoId: string;
  publishedAt: string;
  daysSinceUpload: number;
  views: number;
  VPH: number;
  ratio: number;
  bracket: string;
  /** 'high' | 'low' | 'none' */
  outlier: string;
  likeCount: number;
  commentCount: number;
  transcript?: string;
}

export interface MofLeadChannelData {
  channelId: string;
  videos: VideoRow[];
  fetchedAt: string;
}

export interface MofState {
  leadConfigs: Record<string, MofLeadConfig>;
  leadPhases: Record<string, MofPhase>;
  followUpHistory: Record<string, MofFollowUpRecord[]>;
  individualLeads: IndividualMofLead[];
  /** Auto-collected channel/video/transcript data per lead, keyed by lead id — feeds the
   *  AI follow-up generator. Populated automatically (see confirmMiniReportSent and the
   *  backfill effect in MiddleOfFunnelPage.tsx) rather than through the Data Collection page. */
  leadChannelData: Record<string, MofLeadChannelData>;
}

// ─── Goal Tracker Types ───────────────────────────────────────────

export interface GoalState {
  /** The single input task being tracked, e.g. "Send 20 outreach emails" */
  taskName: string;
  /** Length of the tracking period in days, set by the user */
  totalDays: number;
  /** ISO date (YYYY-MM-DD) of day 1 of the current tracking period */
  startDate: string;
  /** date (YYYY-MM-DD) -> true if the task was done that day */
  checkIns: Record<string, boolean>;
}

export interface AppState {
  accounts: Account[];
  newLeads: Lead[];
  oldLeads: Lead[];
  staleLeads: Lead[];
  templates: Template[];
  columns: string[];
  settings: AppSettings;
  mof: MofState;
  goals: GoalState;
}

/** Check if a status is a follow-up needed status (e.g. needs_fu1, needs_fu2) */
export function isNeedsFollowUp(status: string): boolean {
  return /^needs_fu\d+$/.test(status);
}

/** Check if a status is a follow-up sent status (e.g. fu1_sent, fu2_sent) */
export function isFollowUpSent(status: string): boolean {
  return /^fu\d+_sent$/.test(status);
}

/** Check if a status is any follow-up related status */
export function isFollowUpStatus(status: string): boolean {
  return isNeedsFollowUp(status) || isFollowUpSent(status);
}

/** Extract the follow-up number from a status (e.g. "needs_fu3" -> 3, "fu2_sent" -> 2) */
export function getFollowUpNumber(status: string): number | null {
  const m = status.match(/(?:needs_)?fu(\d+)(?:_sent)?/);
  return m ? parseInt(m[1]) : null;
}

/** Get the "needs_fuX" status for a given follow-up number */
export function needsFollowUpStatus(num: number): string {
  return `needs_fu${num}`;
}

/** Get the "fuX_sent" status for a given follow-up number */
export function followUpSentStatus(num: number): string {
  return `fu${num}_sent`;
}

/** Generate all statuses for a given number of follow-ups */
export function generateAllStatuses(followUpCount: number): string[] {
  const statuses = ['new', 'draft', 'initial_sent'];
  for (let i = 1; i <= followUpCount; i++) {
    statuses.push(needsFollowUpStatus(i), followUpSentStatus(i));
  }
  statuses.push('replied');
  return statuses;
}