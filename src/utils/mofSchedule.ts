import { AppState, IndividualMofLead, MofLeadConfig, MofPhaseType, MofState, MofTouchConfig } from '../types';

/**
 * Shared, pure MOF touch/phase resolution logic — mirrors the computation used on the
 * Middle of Funnel board (see MiddleOfFunnelPage.tsx: getPhase/getNextTouch/resolveTemplate/
 * resolveThreadPlan) so any other surface (e.g. the Today page) that needs to know "is this
 * lead's next touch due, and does it have a message written" agrees with what MOF itself shows.
 */

export const DEFAULT_PHASE1_TOUCHES: MofTouchConfig[] = [
  { day: 3, personalizedSubject: '', personalizedBody: '' },
  { day: 7, personalizedSubject: '', personalizedBody: '', joinPrevious: true },
  { day: 14, personalizedSubject: '', personalizedBody: '', joinPrevious: true },
  { day: 21, personalizedSubject: '', personalizedBody: '', joinPrevious: true },
];
export const DEFAULT_PHASE2_TOUCHES: MofTouchConfig[] = [
  { day: 35, personalizedSubject: '', personalizedBody: '' },
  { day: 55, personalizedSubject: '', personalizedBody: '' },
  { day: 75, personalizedSubject: '', personalizedBody: '' },
  { day: 90, personalizedSubject: '', personalizedBody: '' },
];
export const DEFAULT_PHASE3_TOUCHES: MofTouchConfig[] = [
  { day: 120, personalizedSubject: '', personalizedBody: '' },
  { day: 150, personalizedSubject: '', personalizedBody: '' },
  { day: 180, personalizedSubject: '', personalizedBody: '' },
  { day: 210, personalizedSubject: '', personalizedBody: '' },
  { day: 240, personalizedSubject: '', personalizedBody: '' },
  { day: 270, personalizedSubject: '', personalizedBody: '' },
  { day: 300, personalizedSubject: '', personalizedBody: '' },
  { day: 330, personalizedSubject: '', personalizedBody: '' },
  { day: 360, personalizedSubject: '', personalizedBody: '' },
];
const PHASE3_MONTHLY_DAY_STEP = 30;

export function daysSince(dateStr?: string): number {
  if (!dateStr) return Infinity;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24));
}

export function interp(template: string, lead: any): string {
  return template
    .replace(/\{\{name\}\}/g, lead.name || 'there')
    .replace(/\{\{channelName\}\}/g, lead.customData?.channelName || 'your channel')
    .replace(/\{\{videoTitle\}\}/g, lead.customData?.videoTitle || 'your content');
}

export function isIndividualLeadId(id: string): boolean {
  return id.startsWith('ind_');
}

/** Adapts an IndividualMofLead into the lead-shaped object the phase/touch/send machinery expects. */
export function toBoardLead(il: IndividualMofLead): any {
  return {
    id: il.id,
    name: il.name,
    email: il.email,
    threadId: il.threadId,
    sentFromAccount: il.sentFromAccount,
    customData: {
      miniReportStatus: 'sent',
      miniReportSentDate: il.createdAt,
      channelId: il.channelId,
      channelName: il.channelName,
    },
  };
}

/** Real leads with a mini report sent, plus manually-added individual leads (adapted). */
export function getBoardLeads(state: AppState): any[] {
  const allLeads = [...state.newLeads, ...state.oldLeads];
  const mofLeads = allLeads.filter((l: any) => l.customData?.miniReportStatus === 'sent');
  return [...mofLeads, ...state.mof.individualLeads.map(toBoardLead)];
}

/** Get a Phase 3 touch, generating monthly ones beyond the defined 9 touches */
function getPhase3Touch(touches: MofTouchConfig[], touchNumber: number): MofTouchConfig {
  if (touchNumber <= touches.length) return touches[touchNumber - 1];
  const day = (touches[touches.length - 1]?.day || 360) + (touchNumber - touches.length) * PHASE3_MONTHLY_DAY_STEP;
  return { day, personalizedSubject: '', personalizedBody: '' };
}

/**
 * Pure phase computation (no cache-correcting dispatch — callers just use the fresh
 * value). Auto (non-pinned) phase is driven by how many touches have actually been
 * sent in the current phase, not by raw days elapsed — days alone used to push leads
 * from Active into Nurture (and beyond) even with zero follow-ups ever sent, since the
 * days-since-mini-report clock runs regardless of whether anyone clicked Send. Mirrors
 * MiddleOfFunnelPage.tsx's computeAutoPhase.
 */
export function computePhase(lead: any, mof: MofState): { phase: MofPhaseType; manualPhase: boolean } {
  const p = mof.leadPhases[lead.id];
  if (p && (p.phase === 'closed' || p.phase === 'cold_storage')) return { phase: p.phase, manualPhase: false };
  if (p && p.manualPhase) return { phase: p.phase, manualPhase: true };
  const sd = lead.customData?.miniReportSentDate;
  if (!sd) return { phase: 'active', manualPhase: false };
  const cfg = mof.leadConfigs[lead.id];
  const hist = mof.followUpHistory[lead.id] || [];
  const activeTouches = cfg?.phase1Touches || DEFAULT_PHASE1_TOUCHES;
  const nurtureTouches = cfg?.phase2Touches || DEFAULT_PHASE2_TOUCHES;
  const doneInActive = hist.filter(h => h.phase === 'active').length;
  let computed: MofPhaseType = 'active';
  if (doneInActive >= activeTouches.length) {
    computed = 'nurture';
    const doneInNurture = hist.filter(h => h.phase === 'nurture').length;
    if (doneInNurture >= nurtureTouches.length) computed = 'perpetual';
  }
  return { phase: computed, manualPhase: false };
}

export function getTouchesForPhase(phase: MofPhaseType, cfg: MofLeadConfig | undefined): MofTouchConfig[] {
  if (phase === 'active') return cfg?.phase1Touches || DEFAULT_PHASE1_TOUCHES;
  if (phase === 'nurture') return cfg?.phase2Touches || DEFAULT_PHASE2_TOUCHES;
  if (phase === 'perpetual') {
    const touches = [...(cfg?.phase3Touches || DEFAULT_PHASE3_TOUCHES)];
    for (let tn = touches.length + 1; tn <= touches.length + 15; tn++) {
      touches.push(getPhase3Touch(touches, tn));
    }
    return touches;
  }
  return [];
}

export function getNextTouch(lead: any, mof: MofState): { day: number; isDue: boolean; touchIdx: number; touch?: MofTouchConfig; phase: MofPhaseType } | null {
  const sd = lead.customData?.miniReportSentDate;
  if (!sd) return null;
  const ds = daysSince(sd);
  const { phase } = computePhase(lead, mof);
  const cfg = mof.leadConfigs[lead.id];
  const hist = mof.followUpHistory[lead.id] || [];
  const doneInPhase = hist.filter(h => h.phase === phase).length;
  const touches = getTouchesForPhase(phase, cfg);
  for (let i = doneInPhase; i < touches.length; i++) {
    const d = touches[i].day;
    return { day: d, isDue: ds >= d, touchIdx: i, touch: touches[i], phase };
  }
  return { day: 0, isDue: false, touchIdx: -1, touch: undefined, phase };
}

/**
 * Decides which Gmail thread a given touch sends into, and whether it "owns" that
 * thread (i.e. is starting it fresh and therefore needs a subject line) or is
 * replying inside a thread started earlier (no subject).
 */
export function resolveThreadPlan(lead: any, cfg: MofLeadConfig | undefined, phase: MofPhaseType, touches: MofTouchConfig[], touchIdx: number, hist: any[]): { tid: string | undefined; ownsNewThread: boolean } {
  if (touchIdx === 0) {
    if (phase === 'active') {
      const overrideValue = cfg?.activeThreadOverride;
      if (overrideValue !== undefined) return { tid: overrideValue || undefined, ownsNewThread: overrideValue === '' };
      return { tid: lead.threadId || undefined, ownsNewThread: false };
    }
    return { tid: undefined, ownsNewThread: true };
  }
  const touch = touches[touchIdx];
  if (touch?.joinPrevious) {
    const phaseHist = hist.filter(h => h.phase === phase);
    const prevThreadId = phaseHist[touchIdx - 1]?.threadId;
    return { tid: prevThreadId || undefined, ownsNewThread: false };
  }
  return { tid: undefined, ownsNewThread: true };
}

export interface MofEligibleEntry {
  lead: any;
  phase: MofPhaseType;
  touch: MofTouchConfig;
  touchIdx: number;
  touchNumber: number;
  cfg: MofLeadConfig | undefined;
  touches: MofTouchConfig[];
  hist: any[];
}

/**
 * Leads eligible for a manual, daily-limit-respecting draft batch: their next touch
 * has come due (day arrived or passed). Content is no longer pre-written anywhere, so
 * there's nothing to gate on here beyond "due" — each entry's actual email is generated
 * by AI at draft-creation time (see TodayPage.tsx's handleCreateMofDrafts).
 */
export function getMofEligibleForDraft(state: AppState): MofEligibleEntry[] {
  const boardLeads = getBoardLeads(state);
  const results: MofEligibleEntry[] = [];
  for (const lead of boardLeads) {
    const p = state.mof.leadPhases[lead.id];
    if (p && (p.phase === 'closed' || p.phase === 'cold_storage')) continue;
    const nt = getNextTouch(lead, state.mof);
    if (!nt || nt.touchIdx < 0 || !nt.touch || !nt.isDue) continue;
    const cfg = state.mof.leadConfigs[lead.id];
    const hist = state.mof.followUpHistory[lead.id] || [];
    const touchNumber = hist.length + 1;
    const touches = getTouchesForPhase(nt.phase, cfg);
    results.push({ lead, phase: nt.phase, touch: nt.touch, touchIdx: nt.touchIdx, touchNumber, cfg, touches, hist });
  }
  return results;
}
