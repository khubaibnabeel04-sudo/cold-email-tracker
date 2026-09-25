import React, { useState, useRef, useEffect } from 'react';
import { useStore } from '../store';
import { sendEmail, createDraft, getDraftDetails, fetchThreadMessages, findLatestThreadForEmail, ThreadMessage } from '../services/gmail';
import { generateFollowUp } from '../services/groqFollowup';
import { collectLeadChannelData } from '../services/leadDataCollection';
import type { MofPhaseType, MofTouchConfig, MofLeadConfig, IndividualMofLead } from '../types';
import LeadDrawer from '../components/LeadDrawer';
import ChannelDataPanel from '../components/ChannelDataPanel';
import ThreadExport from '../components/ThreadExport';
import {
  ArrowLeft, AlertTriangle, Clock,
  Plus, Trash2, Settings,
  ArrowRight, Zap, ExternalLink, CheckCircle, Undo2, History,
  UserPlus, Repeat, MessageSquare, X
} from 'lucide-react';

const DEFAULT_PHASE1_TOUCHES: MofTouchConfig[] = [
  { day: 3, personalizedSubject: '', personalizedBody: '' },
  { day: 7, personalizedSubject: '', personalizedBody: '', joinPrevious: true },
  { day: 14, personalizedSubject: '', personalizedBody: '', joinPrevious: true },
  { day: 21, personalizedSubject: '', personalizedBody: '', joinPrevious: true },
];
const DEFAULT_PHASE2_TOUCHES: MofTouchConfig[] = [
  { day: 35, personalizedSubject: '', personalizedBody: '' },
  { day: 55, personalizedSubject: '', personalizedBody: '' },
  { day: 75, personalizedSubject: '', personalizedBody: '' },
  { day: 90, personalizedSubject: '', personalizedBody: '' },
];
const DEFAULT_PHASE3_TOUCHES: MofTouchConfig[] = [
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
const PHASE_LABELS: Record<string, string> = {
  active: 'Active (Day 1-21)',
  nurture: 'Nurture (Day 22-90)',
  perpetual: 'Perpetual (Day 91+)',
  cold_storage: 'Cold Storage',
  closed: 'Closed',
};
const PHASE_COLORS: Record<string, string> = {
  active: '#22c55e',
  nurture: '#3b82f6',
  perpetual: '#8b5cf6',
  cold_storage: '#64748b',
  closed: '#ef4444',
};

function daysSince(dateStr: string) {
  if (!dateStr) return Infinity;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24));
}

function interp(template: string, lead: any) {
  return template
    .replace(/\{\{name\}\}/g, lead.name || 'there')
    .replace(/\{\{channelName\}\}/g, lead.customData?.channelName || 'your channel')
    .replace(/\{\{videoTitle\}\}/g, lead.customData?.videoTitle || 'your content');
}

function emptyTouch(day: number): MofTouchConfig {
  return { day, personalizedSubject: '', personalizedBody: '' };
}

/** Get a Phase 3 touch, generating monthly ones beyond the defined 9 touches */
function getPhase3Touch(touches: MofTouchConfig[], touchNumber: number): MofTouchConfig {
  if (touchNumber <= touches.length) return touches[touchNumber - 1];
  const day = (touches[touches.length - 1]?.day || 360) + (touchNumber - touches.length) * PHASE3_MONTHLY_DAY_STEP;
  return { day, personalizedSubject: '', personalizedBody: '' };
}

/**
 * A lead's auto (non-pinned) phase is driven by how many touches it has actually
 * received in the current phase, not by raw days elapsed. Calendar time alone used
 * to push leads from Active into Nurture (and beyond) even when zero follow-ups had
 * ever been sent, since the days-since-mini-report clock keeps running regardless of
 * whether anyone clicked Send. Tying phase to touches-completed means a lead can only
 * "graduate" out of Active once every Active touch has actually gone out — days still
 * decide whether any given touch is *due*, they just no longer skip a whole phase.
 */
function computeAutoPhase(lead: any, cfg: MofLeadConfig | undefined, hist: any[]): MofPhaseType {
  const sd = lead.customData?.miniReportSentDate;
  if (!sd) return 'active';
  const activeTouches = cfg?.phase1Touches || DEFAULT_PHASE1_TOUCHES;
  const nurtureTouches = cfg?.phase2Touches || DEFAULT_PHASE2_TOUCHES;
  const doneInActive = hist.filter((h: any) => h.phase === 'active').length;
  if (doneInActive < activeTouches.length) return 'active';
  const doneInNurture = hist.filter((h: any) => h.phase === 'nurture').length;
  if (doneInNurture < nurtureTouches.length) return 'nurture';
  return 'perpetual';
}

function isIndividualLeadId(id: string) {
  return id.startsWith('ind_');
}

/** Adapts an IndividualMofLead into the lead-shaped object the phase/touch/send machinery expects. */
function toBoardLead(il: IndividualMofLead): any {
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

function genIndividualId() {
  return 'ind_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export default function MiddleOfFunnelPage() {
  const { state, dispatch } = useStore();
  const [view, setView] = useState<'board' | 'lead'>('board');
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [drawerLead, setDrawerLead] = useState<any | null>(null);
  const [sendingFU, setSendingFU] = useState<string | null>(null);
  const [autoSending, setAutoSending] = useState(false);
  const [autoLog, setAutoLog] = useState<string[]>([]);
  /** Leads whose AI generation failed on the last Run Auto pass — cleared and rebuilt
   *  each run, so a failure stays visible until you either fix it or re-run and it
   *  succeeds. Surfaced as a board-level badge since the Log panel is easy to miss. */
  const [genFailures, setGenFailures] = useState<{ leadId: string; email: string; message: string }[]>([]);
  const [showAutoLog, setShowAutoLog] = useState(false);
  const [historyLead, setHistoryLead] = useState<any | null>(null);
  const [dataModalOpen, setDataModalOpen] = useState(false);
  const [sendToast, setSendToast] = useState<{ email: string; account: string; touchNumber: number } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const backfillAttempted = useRef<Set<string>>(new Set());
  const dragLead = useRef<string | null>(null);
  const [checkingReplies, setCheckingReplies] = useState(false);

  const [showAddForm, setShowAddForm] = useState(false);
  const [newLeadEmail, setNewLeadEmail] = useState('');
  const [newLeadName, setNewLeadName] = useState('');
  const [newLeadChannelId, setNewLeadChannelId] = useState('');
  const [newLeadChannelName, setNewLeadChannelName] = useState('');
  const [newLeadNotes, setNewLeadNotes] = useState('');
  const [resolvingThreadFor, setResolvingThreadFor] = useState<string | null>(null);

  const [threadMessages, setThreadMessages] = useState<ThreadMessage[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);

  // Reset daily send counters on a new day — mirrors TodayPage so the daily
  // limit check here is correct even if the user never visits Today first.
  useEffect(() => {
    const todayStr = new Date().toDateString();
    state.accounts.forEach((acc: any) => {
      if (acc.lastResetDate !== todayStr) {
        dispatch({ type: 'UPDATE_ACCOUNT', payload: { ...acc, sentToday: 0, lastResetDate: todayStr } });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.accounts]);

  const allLeads = [...state.newLeads, ...state.oldLeads];
  const mofLeads = allLeads.filter((l: any) => l.customData?.miniReportStatus === 'sent');
  /** Leads who have replied (real human reply) but mini report not yet sent */
  const awaitingMiniReport = allLeads.filter((l: any) =>
    !l.customData?.miniReportStatus &&
    !l.automatedReply && !l.bounced &&
    l.status === 'replied'
  );
  const individualLeads = state.mof.individualLeads;
  /** Merged list — real leads with a mini report sent, plus manually-added individual leads (adapted). */
  const boardLeads = [...mofLeads, ...individualLeads.map(toBoardLead)];

  /** Leads where lead replied during follow-up sequence (pulled out) */
  const stoppedLeads = boardLeads.filter((l: any) => {
    const p = state.mof.leadPhases[l.id];
    return p && (p.phase === 'closed' || p.phase === 'cold_storage');
  });

  /** Has a follow-up gone out to this lead today? */
  function isSentToday(lead: any): boolean {
    const hist = state.mof.followUpHistory[lead.id] || [];
    if (!hist.length) return false;
    return new Date(hist[hist.length - 1].sentAt).toDateString() === new Date().toDateString();
  }

  /** Leads with a touch due right now but no collected channel data — the AI can
   *  still write something, it just won't have anything channel-specific to say. */
  const noChannelDataLeads = boardLeads.filter((l: any) => {
    const p = state.mof.leadPhases[l.id];
    if (p && (p.phase === 'closed' || p.phase === 'cold_storage')) return false;
    const nt = getNextTouch(l);
    return !!(nt && nt.isDue && !state.mof.leadChannelData[l.id]);
  });
  function pushLog(msg: string) {
    const ts = new Date().toLocaleTimeString();
    setAutoLog(prev => [`${ts} — ${msg}`, ...prev].slice(0, 20));
  }

  /**
   * Asks the Groq-backed AI generator to write this touch's actual email content.
   * Replaces the old static personalizedSubject/personalizedBody model — nothing is
   * pre-written any more, the content is produced fresh at send time from the lead's
   * thread history and collected channel/video data.
   */
  async function generateContentForTouch(
    lead: any, phase: string, touches: MofTouchConfig[], touchIdx: number,
    hist: any[], touchNumber: number, plan: { tid: string | undefined; ownsNewThread: boolean }
  ): Promise<{ subject: string; body: string; angle: string }> {
    const acc = state.accounts.find((a: any) => a.email === lead.sentFromAccount);
    const touch = touches[touchIdx];
    const channelName = isIndividualLeadId(lead.id)
      ? individualLeads.find(l => l.id === lead.id)?.channelName
      : lead.customData?.channelName;
    const lastContactAt = hist.length > 0 ? hist[hist.length - 1].sentAt : lead.customData?.miniReportSentDate;
    return generateFollowUp({
      leadName: lead.name || lead.email,
      channelName,
      miniReportThreadId: lead.threadId,
      account: acc,
      onAccountUpdated: (u: any) => dispatch({ type: 'UPDATE_ACCOUNT', payload: u }),
      channelData: state.mof.leadChannelData[lead.id],
      history: hist,
      phase: phase as MofPhaseType,
      touchNumber,
      day: touch?.day ?? 0,
      daysSinceLastContact: daysSince(lastContactAt),
      needsSubject: plan.ownsNewThread,
    });
  }

  /** Fetches channel/video data + a few transcripts for a lead and stores it for the AI generator. */
  async function autoCollectChannelData(lead: any) {
    const channelId = getChannelId(lead);
    if (!channelId) return;
    try {
      const videos = await collectLeadChannelData(channelId);
      dispatch({ type: 'MOF_SET_CHANNEL_DATA', payload: { leadId: lead.id, data: { channelId, videos, fetchedAt: new Date().toISOString() } } });
      pushLog(`📊 Collected channel data for ${lead.name || lead.email} (${videos.length} videos)`);
    } catch (e: any) {
      pushLog(`⚠️ Channel data collection failed for ${lead.name || lead.email}: ${e.message || e}`);
    }
  }

  /**
   * Decides which Gmail thread a given touch sends into, and whether it "owns" that
   * thread (i.e. is starting it fresh and therefore needs a subject line) or is
   * replying inside a thread started earlier (no subject).
   * - Touch #1 of Active: continues the mini-report thread by default, or starts fresh
   *   right after "Start New Thread" (activeThreadOverride === '').
   * - Touch #1 of Nurture/Perpetual: always starts a fresh thread.
   * - Any later touch: joins the previous touch's resulting thread if `joinPrevious` is
   *   set on it (reply, no subject); otherwise starts its own new thread (subject shown).
   */
  function resolveThreadPlan(lead: any, cfg: any, phase: string, touches: MofTouchConfig[], touchIdx: number, hist: any[]): { tid: string | undefined; ownsNewThread: boolean } {
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
      // Whether the prior touch's thread has actually been recorded yet only affects
      // *which* thread we send into — the "no subject" intent holds regardless, since
      // the user explicitly asked this touch to continue the previous one.
      const phaseHist = hist.filter(h => h.phase === phase);
      const prevThreadId = phaseHist[touchIdx - 1]?.threadId;
      return { tid: prevThreadId || undefined, ownsNewThread: false };
    }
    return { tid: undefined, ownsNewThread: true };
  }

  /** Confirm mini report sent — updates the lead's customData */
  function confirmMiniReportSent(lead: any) {
    const updated = {
      ...lead,
      customData: { ...lead.customData, miniReportStatus: 'sent', miniReportSentDate: new Date().toISOString() },
    };
    dispatch({ type: 'UPDATE_LEAD', payload: updated });
    dispatch({ type: 'MOF_SET_PHASE', payload: { leadId: lead.id, phase: { phase: 'active', enteredAt: new Date().toISOString(), lastTouchAt: '', silenceMonths: 0 } } });
    // Kick off channel/video data collection in the background so it's ready by the
    // time the first follow-up is due — no need to wait on it here.
    autoCollectChannelData(updated);
  }

  /** Stop/close a lead (mark as replied out of sequence) */
  function stopLeadSequence(lead: any) {
    dispatch({ type: 'MOF_SET_PHASE', payload: { leadId: lead.id, phase: { phase: 'closed' as MofPhaseType, enteredAt: new Date().toISOString(), lastTouchAt: new Date().toISOString(), silenceMonths: 0 } } });
  }

  function startNewThread(lead: any, cfg: MofLeadConfig) {
    if (window.confirm('Start a brand new email thread with this lead? The next message sent will begin a fresh conversation instead of continuing the old one.')) {
      // The touch that kicks off the new thread should fire sooner (day 1) and will carry the subject line.
      const phase1Touches = cfg.phase1Touches.length
        ? [{ ...cfg.phase1Touches[0], day: 1 }, ...cfg.phase1Touches.slice(1)]
        : cfg.phase1Touches;
      dispatch({ type: 'MOF_UPDATE_LEAD_CONFIG', payload: { leadId: lead.id, config: { ...cfg, phase1Touches } } });
      dispatch({ type: 'MOF_SET_THREAD_OVERRIDE', payload: { leadId: lead.id, threadId: '' } });
    }
  }

  async function addIndividualLead() {
    const email = newLeadEmail.trim();
    if (!email) return;
    const id = genIndividualId();
    const lead: IndividualMofLead = {
      id,
      email,
      name: newLeadName.trim() || email,
      channelId: newLeadChannelId.trim() || undefined,
      channelName: newLeadChannelName.trim() || undefined,
      notes: newLeadNotes.trim() || undefined,
      createdAt: new Date().toISOString(),
    };
    dispatch({ type: 'MOF_ADD_INDIVIDUAL_LEAD', payload: lead });
    dispatch({ type: 'MOF_SET_PHASE', payload: { leadId: id, phase: { phase: 'active', enteredAt: new Date().toISOString(), lastTouchAt: '', silenceMonths: 0 } } });
    setNewLeadEmail(''); setNewLeadName(''); setNewLeadChannelId(''); setNewLeadChannelName(''); setNewLeadNotes('');
    setShowAddForm(false);

    setResolvingThreadFor(id);
    try {
      const found = await findLatestThreadForEmail(email, state.accounts, (u: any) => dispatch({ type: 'UPDATE_ACCOUNT', payload: u }), state.settings);
      if (found) {
        dispatch({ type: 'MOF_UPDATE_INDIVIDUAL_LEAD', payload: { ...lead, threadId: found.threadId, sentFromAccount: found.account.email } });
      }
    } catch (e) {
      console.error('Failed to locate latest thread for', email, e);
    }
    setResolvingThreadFor(null);
  }

  function promoteIndividualLead(id: string) {
    if (window.confirm("Promote this lead into the main app's New Leads list? It will remain visible here too.")) {
      dispatch({ type: 'MOF_PROMOTE_INDIVIDUAL_LEAD', payload: id });
    }
  }

  function removeIndividualLead(id: string) {
    if (window.confirm('Remove this individually-added lead from MOF? This only stops tracking it here — no email or account data is affected.')) {
      dispatch({ type: 'MOF_REMOVE_INDIVIDUAL_LEAD', payload: id });
      if (selectedLeadId === id) { setSelectedLeadId(null); setView('board'); }
    }
  }

  /** Check Gmail threads for lead replies and auto-close */
  async function checkForReplies() {
    setCheckingReplies(true);
    pushLog('🔎 Checking all threads for replies...');
    let stopped = 0;
    let checked = 0;
    for (const lead of boardLeads) {
      if (!lead.sentFromAccount) continue;
      const acc = state.accounts.find((a: any) => a.email === lead.sentFromAccount);
      if (!acc || !acc.accessToken) continue;
      const threadIds = new Set<string>();
      if (lead.threadId) threadIds.add(lead.threadId);
      const hist = state.mof.followUpHistory[lead.id] || [];
      for (const rec of hist) {
        if (rec.miniReportThreadId && rec.miniReportThreadId !== lead.threadId) threadIds.add(rec.miniReportThreadId);
        if (rec.threadId) threadIds.add(rec.threadId);
      }
      if (threadIds.size === 0) continue;
      let leadReplied = false;
      for (const tid of threadIds) {
        checked++;
        try {
          const msgs = await fetchThreadMessages(tid, acc, undefined, state.settings);
          if (!msgs || msgs.length <= 1) continue;
          for (const msg of msgs) {
            if (msg.from && !msg.from.includes(acc.email)) {
              leadReplied = true;
              break;
            }
          }
        } catch (e) {
          continue;
        }
        if (leadReplied) break;
      }
      if (leadReplied) {
        stopLeadSequence(lead);
        stopped++;
        pushLog(`🔴 ${lead.email}: Reply found in thread — stopped sequence`);
      }
    }
    setCheckingReplies(false);
    if (stopped > 0) pushLog(`✅ Check Replies done — ${stopped} stopped (checked ${checked} threads)`);
    else pushLog(`✅ Check Replies done — no replies found (checked ${checked} threads)`);
  }

  /** Auto-sender: finds first overdue touch per lead, creates a draft, shifts subsequent touches by the gap */
  async function processAutoSend() {
    const s = stateRef.current;
    if (!s) return;
    setAutoSending(true);
    pushLog('Auto-send started — scanning leads...');
    const now = Date.now();
    let sent = 0;
    let skipped = 0;
    let checked = 0;
    const failures: { leadId: string; email: string; message: string }[] = [];
    const allLeadsNow = [...s.newLeads, ...s.oldLeads];
    const mofLeadsNow = allLeadsNow.filter((l: any) => l.customData?.miniReportStatus === 'sent');
    const boardLeadsNow = [...mofLeadsNow, ...s.mof.individualLeads.map(toBoardLead)];
    for (const lead of boardLeadsNow) {
      checked++;
      const lp = s.mof.leadPhases[lead.id];
      if (lp && (lp.phase === 'closed' || lp.phase === 'cold_storage')) { skipped++; continue; }
      const sd = lead.customData?.miniReportSentDate;
      if (!sd) { skipped++; continue; }
      const ds = Math.floor((now - new Date(sd).getTime()) / (1000 * 60 * 60 * 24));
      const cfg = s.mof.leadConfigs[lead.id];
      const hist = s.mof.followUpHistory[lead.id] || [];
      const phase: string = (lp && lp.manualPhase) ? lp.phase : computeAutoPhase(lead, cfg, hist);
      let touches: MofTouchConfig[];
      if (phase === 'active') touches = cfg?.phase1Touches || DEFAULT_PHASE1_TOUCHES;
      else if (phase === 'nurture') touches = cfg?.phase2Touches || DEFAULT_PHASE2_TOUCHES;
      else {
        touches = [...(cfg?.phase3Touches || DEFAULT_PHASE3_TOUCHES)];
        while (touches.length < 25) touches.push(getPhase3Touch(touches, touches.length + 1));
      }
      const doneInPhase = hist.filter(h => h.phase === phase).length;
      if (doneInPhase >= touches.length) { skipped++; continue; }
      const touch = touches[doneInPhase];
      if (ds < touch.day) { skipped++; continue; }
      const touchNumber = hist.length + 1;
      pushLog(`🔍 ${lead.name || lead.email}: Phase=${phase}, Day ${ds}, overdue touch Day ${touch.day}, #${touchNumber}`);
      if (!lead.sentFromAccount) { pushLog(`⏭️ ${lead.name || lead.email}: No account assigned`); skipped++; continue; }
      const acc = s.accounts.find((a: any) => a.email === lead.sentFromAccount);
      if (!acc) { pushLog(`⏭️ ${lead.name || lead.email}: Account not found`); skipped++; continue; }
      try {
        const gap = ds - touch.day;
        const plan = resolveThreadPlan(lead, cfg, phase, touches, doneInPhase, hist);
        const lastContactAt = hist.length > 0 ? hist[hist.length - 1].sentAt : sd;
        let generated;
        try {
          generated = await generateFollowUp({
            leadName: lead.name || lead.email,
            channelName: lead.customData?.channelName,
            miniReportThreadId: lead.threadId,
            account: acc,
            channelData: s.mof.leadChannelData[lead.id],
            history: hist,
            phase: phase as MofPhaseType,
            touchNumber,
            day: touch.day,
            daysSinceLastContact: daysSince(lastContactAt),
            needsSubject: plan.ownsNewThread,
          });
        } catch (genErr: any) {
          const msg = genErr.message || String(genErr);
          pushLog(`⚠️ ${lead.name || lead.email}: AI generation failed — ${msg}`);
          failures.push({ leadId: lead.id, email: lead.name || lead.email, message: msg });
          skipped++; continue;
        }
        if (!generated.body) { pushLog(`⏭️ ${lead.name || lead.email}: Skipped — AI returned an empty body`); skipped++; continue; }
        const subj = plan.ownsNewThread ? generated.subject : '';
        const body = generated.body;
        const tid = plan.tid;
        const draftId = await createDraft(acc, lead.email, subj, body, tid, undefined, s.settings);
        if (draftId) {
          // Learn the draft's real thread id so a later touch can join it (and so a
          // fresh-thread override resolves to the actual new thread id).
          let resultThreadId = '';
          try {
            const details = await getDraftDetails(draftId, acc, undefined, s.settings);
            resultThreadId = details?.message?.threadId || '';
          } catch { /* record keeps an empty threadId; a subsequent join/override just falls back to a new thread */ }
          dispatch({ type: 'MOF_ADD_FOLLOW_UP_RECORD', payload: { leadId: lead.id, record: { sentAt: new Date().toISOString(), phase: phase as MofPhaseType, touchNumber, templateType: 'personalized', threadId: resultThreadId, miniReportThreadId: lead.threadId || resultThreadId, angle: generated.angle } } });
          const cp = s.mof.leadPhases[lead.id] || { phase: 'active' as MofPhaseType, enteredAt: new Date().toISOString(), lastTouchAt: '', silenceMonths: 0 };
          dispatch({ type: 'MOF_SET_PHASE', payload: { leadId: lead.id, phase: { ...cp, lastTouchAt: new Date().toISOString(), silenceMonths: 0 } } });
          if (cfg?.activeThreadOverride === '' && resultThreadId) {
            dispatch({ type: 'MOF_SET_THREAD_OVERRIDE', payload: { leadId: lead.id, threadId: resultThreadId } });
          }
          if (gap > 0) {
            const newTouches = touches.map((t, i) => (i > doneInPhase ? { ...t, day: t.day + gap } : { ...t }));
            if (phase === 'active') dispatch({ type: 'MOF_UPDATE_LEAD_CONFIG', payload: { leadId: lead.id, config: { ...cfg, phase1Touches: newTouches } } });
            else if (phase === 'nurture') dispatch({ type: 'MOF_UPDATE_LEAD_CONFIG', payload: { leadId: lead.id, config: { ...cfg, phase2Touches: newTouches } } });
            else dispatch({ type: 'MOF_UPDATE_LEAD_CONFIG', payload: { leadId: lead.id, config: { ...cfg, phase3Touches: newTouches } } });
          }
          sent++;
          pushLog(`📝 Draft #${touchNumber} created for ${lead.email} (Day ${touch.day}, gap ${gap}d)`);
        } else {
          pushLog(`❌ Draft failed for ${lead.email}`);
        }
      } catch (e: any) { pushLog(`⚠️ Error creating draft for ${lead.email}: ${e.message || e}`); continue; }
    }
    if (sent === 0) pushLog(`No overdue leads found (checked ${checked}, skipped ${skipped})`);
    else pushLog(`Done — created ${sent} draft(s)`);
    setGenFailures(failures);
    setAutoSending(false);
  }

  /** Load the conversation thread for whichever lead's detail view is open (real or individual) */
  useEffect(() => {
    if (view !== 'lead' || !selectedLeadId) { setThreadMessages([]); return; }
    const isInd = isIndividualLeadId(selectedLeadId);
    const il = isInd ? state.mof.individualLeads.find(l => l.id === selectedLeadId) : undefined;
    const realLead = !isInd ? [...state.newLeads, ...state.oldLeads].find((l: any) => l.id === selectedLeadId) : undefined;
    const threadId = il?.threadId || realLead?.threadId;
    const accountEmail = il?.sentFromAccount || realLead?.sentFromAccount;
    if (!threadId || !accountEmail) { setThreadMessages([]); return; }
    const acc = state.accounts.find((a: any) => a.email === accountEmail);
    if (!acc) { setThreadMessages([]); return; }
    let cancelled = false;
    setThreadLoading(true);
    fetchThreadMessages(threadId, acc, (u: any) => dispatch({ type: 'UPDATE_ACCOUNT', payload: u }), state.settings)
      .then(msgs => { if (!cancelled) setThreadMessages(msgs); })
      .finally(() => { if (!cancelled) setThreadLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, selectedLeadId]);

  /**
   * One-time backfill: any lead already in MOF that has a channel ID but no
   * collected channel data yet gets it fetched now, sequentially (throttled) so we
   * don't hammer the YouTube/kome.ai APIs. Runs once on mount; new leads get their
   * data collected immediately via confirmMiniReportSent instead.
   */
  useEffect(() => {
    let cancelled = false;
    async function backfill() {
      const s = stateRef.current;
      const realLeads = [...s.newLeads, ...s.oldLeads].filter((l: any) => l.customData?.miniReportStatus === 'sent');
      const targets = [...realLeads, ...s.mof.individualLeads.map(toBoardLead)];
      for (const lead of targets) {
        if (cancelled) return;
        if (stateRef.current.mof.leadChannelData[lead.id]) continue;
        if (backfillAttempted.current.has(lead.id)) continue;
        const channelId = getChannelId(lead);
        if (!channelId) continue;
        backfillAttempted.current.add(lead.id);
        await autoCollectChannelData(lead);
        if (cancelled) return;
        await new Promise(r => setTimeout(r, 1500));
      }
    }
    backfill();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Channel ID for the Channel Data panel — stored on the individual lead record, or in customData for real leads */
  function getChannelId(lead: any): string {
    if (isIndividualLeadId(lead.id)) return individualLeads.find(l => l.id === lead.id)?.channelId || '';
    return lead.customData?.channelId || '';
  }
  function setChannelIdFor(lead: any, id: string) {
    if (isIndividualLeadId(lead.id)) {
      const il = individualLeads.find(l => l.id === lead.id);
      if (il) dispatch({ type: 'MOF_UPDATE_INDIVIDUAL_LEAD', payload: { ...il, channelId: id } });
    } else {
      dispatch({ type: 'UPDATE_LEAD', payload: { ...lead, customData: { ...lead.customData, channelId: id } } });
    }
  }

  async function handleSend(lead: any, touchDay?: number) {
    if (!lead.sentFromAccount) { console.error('No sentFromAccount for', lead.id); return; }
    const acc = state.accounts.find((a: any) => a.email === lead.sentFromAccount);
    if (!acc) { console.error('Account not found for', lead.sentFromAccount); return; }
    if (acc.sentToday >= acc.dailyLimit) {
      alert(`Daily sending limit reached for ${acc.email} (${acc.sentToday}/${acc.dailyLimit}). Try again tomorrow or send from a different account.`);
      return;
    }
    const ph = getPhase(lead);
    const phase = ph.phase as string;
    const cfg = state.mof.leadConfigs[lead.id];
    let touches: MofTouchConfig[] = [];
    const hist = state.mof.followUpHistory[lead.id] || [];
    const doneInPhase = hist.filter(h => h.phase === phase).length;
    if (phase === 'active') touches = cfg?.phase1Touches || DEFAULT_PHASE1_TOUCHES;
    else if (phase === 'nurture') touches = cfg?.phase2Touches || DEFAULT_PHASE2_TOUCHES;
    else if (phase === 'perpetual') {
      touches = [...(cfg?.phase3Touches || DEFAULT_PHASE3_TOUCHES)];
      while (touches.length < doneInPhase + 15) touches.push(getPhase3Touch(touches, touches.length + 1));
    }
    let touch: MofTouchConfig | undefined;
    let touchIdx = doneInPhase;
    const touchNumber = hist.length + 1;
    if (touchDay !== undefined) {
      const foundIdx = touches.findIndex(t => t.day === touchDay);
      if (foundIdx >= 0) { touch = touches[foundIdx]; touchIdx = foundIdx; }
      else { touch = { day: touchDay, personalizedSubject: '', personalizedBody: '' }; }
    } else if (doneInPhase < touches.length) {
      touch = touches[doneInPhase];
    }
    if (!touch) { console.error('No pending touch for', lead.id); return; }
    setSendingFU(lead.id);
    try {
      const plan = resolveThreadPlan(lead, cfg, phase, touches, touchIdx, hist);
      const generated = await generateContentForTouch(lead, phase, touches, touchIdx, hist, touchNumber, plan);
      const subj = plan.ownsNewThread ? generated.subject : '';
      const body = generated.body;
      if (!body) { setSendingFU(null); console.error('AI generation returned an empty body for', lead.email, 'touch #' + touchNumber); alert('The AI did not return any message content. Try again in a moment.'); return; }
      const overrideValue = cfg?.activeThreadOverride;
      const tid = plan.tid;
      const result = await sendEmail(acc, lead.email, subj, body, tid,
        (u: any) => dispatch({ type: 'UPDATE_ACCOUNT', payload: u }), state.settings);
      if (result) {
        dispatch({ type: 'MOF_ADD_FOLLOW_UP_RECORD', payload: { leadId: lead.id, record: { sentAt: new Date().toISOString(), phase: phase as MofPhaseType, touchNumber, templateType: 'personalized', threadId: result.threadId, miniReportThreadId: lead.threadId || result.threadId, angle: generated.angle } } });
        const cp = state.mof.leadPhases[lead.id] || { phase: 'active' as MofPhaseType, enteredAt: new Date().toISOString(), lastTouchAt: '', silenceMonths: 0 };
        dispatch({ type: 'MOF_SET_PHASE', payload: { leadId: lead.id, phase: { ...cp, lastTouchAt: new Date().toISOString(), silenceMonths: 0 } } });
        if (phase !== 'active' && !cfg?.followUpThreadId) {
          dispatch({ type: 'MOF_UPDATE_LEAD_CONFIG', payload: { leadId: lead.id, config: { ...cfg, followUpThreadId: result.threadId } } });
        }
        if (overrideValue === '') {
          dispatch({ type: 'MOF_SET_THREAD_OVERRIDE', payload: { leadId: lead.id, threadId: result.threadId } });
        }
        const sd = lead.customData?.miniReportSentDate;
        if (sd) {
          const ds = daysSince(sd);
          const gap = ds - touch.day;
          if (gap > 0) {
            const newTouches = touches.map((t, i) => (i > doneInPhase ? { ...t, day: t.day + gap } : { ...t }));
            if (phase === 'active') dispatch({ type: 'MOF_UPDATE_LEAD_CONFIG', payload: { leadId: lead.id, config: { ...cfg, phase1Touches: newTouches } } });
            else if (phase === 'nurture') dispatch({ type: 'MOF_UPDATE_LEAD_CONFIG', payload: { leadId: lead.id, config: { ...cfg, phase2Touches: newTouches } } });
            else dispatch({ type: 'MOF_UPDATE_LEAD_CONFIG', payload: { leadId: lead.id, config: { ...cfg, phase3Touches: newTouches } } });
          }
        }
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        setSendToast({ email: lead.email, account: acc.email, touchNumber });
        toastTimerRef.current = setTimeout(() => setSendToast(null), 6000);
      } else {
        console.error('Send failed for', lead.email);
        alert(`Failed to send message to ${lead.email}. Check the console for details.`);
      }
    } catch (e: any) {
      console.error('Send error for', lead.email, e.message || e);
      alert(e.message || `Something went wrong generating or sending this follow-up for ${lead.email}.`);
    }
    setSendingFU(null);
  }

  function getPhase(lead: any) {
    const p = state.mof.leadPhases[lead.id];
    if (p && (p.phase === 'closed' || p.phase === 'cold_storage')) return { phase: p.phase, label: PHASE_LABELS[p.phase], color: PHASE_COLORS[p.phase], manualPhase: false };
    if (p && p.manualPhase) return { phase: p.phase, label: PHASE_LABELS[p.phase], color: PHASE_COLORS[p.phase], manualPhase: true };
    const sd = lead.customData?.miniReportSentDate;
    if (!sd) return { phase: 'active', label: PHASE_LABELS.active, color: PHASE_COLORS.active, manualPhase: false };
    const cfg = state.mof.leadConfigs[lead.id];
    const hist = state.mof.followUpHistory[lead.id] || [];
    const computed = computeAutoPhase(lead, cfg, hist);
    if (p && p.phase !== computed) {
      dispatch({ type: 'MOF_SET_PHASE', payload: { leadId: lead.id, phase: { ...p, phase: computed } } });
    }
    return { phase: computed, label: PHASE_LABELS[computed], color: PHASE_COLORS[computed], manualPhase: false };
  }

  /**
   * Manually set (or clear) a lead's phase. Picking a specific phase pins it there — the
   * auto-sender treats it as that phase regardless of days elapsed. Picking "Auto" clears
   * the override and goes back to the days-since-sent computation.
   */
  function setManualPhase(lead: any, value: string) {
    const p = state.mof.leadPhases[lead.id];
    if (value === 'auto') {
      const cfg = state.mof.leadConfigs[lead.id];
      const hist = state.mof.followUpHistory[lead.id] || [];
      const computed = computeAutoPhase(lead, cfg, hist);
      dispatch({
        type: 'MOF_SET_PHASE',
        payload: {
          leadId: lead.id,
          phase: { phase: computed, enteredAt: p?.enteredAt || new Date().toISOString(), lastTouchAt: p?.lastTouchAt || '', silenceMonths: p?.silenceMonths || 0, manualPhase: false },
        },
      });
    } else {
      dispatch({
        type: 'MOF_SET_PHASE',
        payload: {
          leadId: lead.id,
          phase: { phase: value as MofPhaseType, enteredAt: new Date().toISOString(), lastTouchAt: p?.lastTouchAt || '', silenceMonths: 0, manualPhase: true },
        },
      });
    }
  }

  function getNextTouch(lead: any) {
    const sd = lead.customData?.miniReportSentDate;
    if (!sd) return null;
    const ds = daysSince(sd);
    const ph = getPhase(lead);
    const cfg = state.mof.leadConfigs[lead.id];
    const hist = state.mof.followUpHistory[lead.id] || [];
    const doneInPhase = hist.filter(h => h.phase === ph.phase).length;
    let touches: MofTouchConfig[] = [];
    if (ph.phase === 'active') touches = cfg?.phase1Touches || DEFAULT_PHASE1_TOUCHES;
    else if (ph.phase === 'nurture') touches = cfg?.phase2Touches || DEFAULT_PHASE2_TOUCHES;
    else if (ph.phase === 'perpetual') {
      touches = [...(cfg?.phase3Touches || DEFAULT_PHASE3_TOUCHES)];
      for (let tn = touches.length + 1; tn <= touches.length + 15; tn++) {
        touches.push(getPhase3Touch(touches, tn));
      }
    }
    for (let i = doneInPhase; i < touches.length; i++) {
      const d = touches[i].day;
      const isDue = ds >= d;
      return { day: d, label: 'Day ' + d, isDue, touchIdx: i, touch: touches[i] };
    }
    return { day: 0, label: 'All sent', isDue: false, touchIdx: -1, touch: undefined as MofTouchConfig | undefined };
  }


  function renderTouchRow(touches: MofTouchConfig[], setTouches: (t: MofTouchConfig[]) => void, i: number, leadId: string, phase: string, cfg: any) {
    const t = touches[i];
    const rowLead = boardLeads.find((l: any) => l.id === leadId);
    const rowAcc = state.accounts.find((a: any) => a.email === rowLead?.sentFromAccount);
    const rowAtLimit = !!rowAcc && rowAcc.sentToday >= rowAcc.dailyLimit;
    const rowHist = state.mof.followUpHistory[leadId] || [];
    const plan = rowLead ? resolveThreadPlan(rowLead, cfg, phase, touches, i, rowHist) : { tid: undefined, ownsNewThread: true };
    const hideSubject = !plan.ownsNewThread;
    return (
      <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8, padding: '8px 12px', background: 'var(--bg-muted)', borderRadius: 8 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, fontSize: 13, minWidth: 55 }}>#{i + 1}</span>
          <span style={{ fontSize: 12 }}>Day</span>
          <input type="number" value={t.day} onChange={e => { const n = [...touches]; n[i] = { ...n[i], day: parseInt((e.target as any).value) || 0 }; setTouches(n); }} style={{ width: 60, padding: '4px 8px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-page)', color: 'var(--text-primary)', fontSize: 12 }} />
          {i > 0 && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-secondary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={!!t.joinPrevious} onChange={e => { const n = [...touches]; n[i] = { ...n[i], joinPrevious: (e.target as any).checked }; setTouches(n); }} />
              Join to previous (same thread)
            </label>
          )}
          <button
            onClick={() => rowLead && handleSend(rowLead, t.day)}
            disabled={sendingFU === leadId || rowAtLimit || !rowLead}
            title={rowAtLimit ? `Daily limit reached for ${rowAcc!.email} (${rowAcc!.sentToday}/${rowAcc!.dailyLimit})` : undefined}
            style={{ marginLeft: 'auto', padding: '4px 10px', background: rowAtLimit ? 'var(--text-muted)' : 'var(--accent)', color: '#fff', border: 'none', borderRadius: 4, cursor: (sendingFU === leadId || rowAtLimit) ? 'not-allowed' : 'pointer', fontSize: 11, fontWeight: 600 }}
          >{sendingFU === leadId ? '...' : rowAtLimit ? 'Limit reached' : 'Send'}</button>
          <button onClick={() => setTouches(touches.filter((_, j) => j !== i))} style={{ padding: '4px 6px', background: 'transparent', border: 'none', cursor: 'pointer', color: '#ef4444' }}><Trash2 size={12} /></button>
        </div>
        <div style={{ paddingLeft: 63, fontSize: 11, color: 'var(--text-muted)' }}>
          {hideSubject ? 'Replies in the previous touch\'s thread, no subject.' : 'Starts a new thread with its own subject.'} Content is written by AI at send time, not pre-written.
        </div>
      </div>
    );
  }

  function renderCard(l: any) {
    const isInd = isIndividualLeadId(l.id);
    const nt = getNextTouch(l);
    const noChannelData = nt && nt.isDue && !state.mof.leadChannelData[l.id];
    const h = state.mof.followUpHistory[l.id] || [];
    return (
      <div key={l.id} draggable onDragStart={() => { dragLead.current = l.id; }}
        onClick={() => { setSelectedLeadId(l.id); setView('lead'); }}
        style={{ background: 'var(--bg-card)', borderRadius: 10, border: '1px solid var(--border)', padding: '10px 12px', marginBottom: 8, cursor: 'pointer' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 6 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name || l.email}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.email}</div>
          </div>
          {isInd && <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--accent)', background: 'var(--accent)20', padding: '2px 6px', borderRadius: 8, flexShrink: 0 }}>Manual</span>}
        </div>
        {nt && nt.touchIdx >= 0 ? (
          <div style={{ marginTop: 6, fontSize: 10, color: nt.isDue ? '#ef4444' : 'var(--text-muted)' }}>
            {nt.isDue ? `Touch #${h.length + 1} due now (Day ${nt.day})` : `Next: Day ${nt.day}`}
          </div>
        ) : null}
        {noChannelData && (
          <div style={{ marginTop: 6, fontSize: 10, fontWeight: 600, color: '#d97706', background: '#fef3c7', padding: '3px 6px', borderRadius: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
            <AlertTriangle size={10} /> No channel data yet — AI will write a more generic email
          </div>
        )}
        <div style={{ marginTop: 6, display: 'flex', gap: 6, alignItems: 'center' }}>
          {isSentToday(l) && <span style={{ fontSize: 9, fontWeight: 700, color: '#16a34a', background: '#16a34a20', padding: '1px 6px', borderRadius: 8 }}>Sent today</span>}
          {h.length > 0 && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{h.length} sent</span>}
        </div>
      </div>
    );
  }

  function renderAddLeadForm() {
    const inputStyle: React.CSSProperties = { padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-page)', color: 'var(--text-primary)', fontSize: 12, boxSizing: 'border-box' };
    return (
      <div style={{ marginBottom: 16, padding: 14, background: 'var(--bg-card)', borderRadius: 10, border: '1px solid var(--border)' }}>
        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>Add an Individual Lead</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
          For leads you sent a mini report to outside the normal flow. Lives only here in MOF unless you promote it.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
          <input value={newLeadEmail} onChange={e => setNewLeadEmail((e.target as any).value)} placeholder="Email *" style={inputStyle} />
          <input value={newLeadName} onChange={e => setNewLeadName((e.target as any).value)} placeholder="Name" style={inputStyle} />
          <input value={newLeadChannelId} onChange={e => setNewLeadChannelId((e.target as any).value)} placeholder="Channel ID" style={inputStyle} />
          <input value={newLeadChannelName} onChange={e => setNewLeadChannelName((e.target as any).value)} placeholder="Channel name" style={inputStyle} />
        </div>
        <textarea value={newLeadNotes} onChange={e => setNewLeadNotes((e.target as any).value)} placeholder="Notes (optional)" rows={2} style={{ ...inputStyle, width: '100%', marginBottom: 10, fontFamily: 'inherit', resize: 'vertical' }} />
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={addIndividualLead} disabled={!newLeadEmail.trim()} style={{ padding: '7px 16px', background: newLeadEmail.trim() ? 'var(--accent)' : 'var(--text-muted)', color: '#fff', border: 'none', borderRadius: 6, cursor: newLeadEmail.trim() ? 'pointer' : 'not-allowed', fontWeight: 600, fontSize: 12 }}>Add Lead</button>
          <button onClick={() => setShowAddForm(false)} style={{ padding: '7px 14px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>Cancel</button>
        </div>
      </div>
    );
  }

  function renderAwaitingCard(l: any) {
    return (
      <div key={l.id} draggable onDragStart={() => { dragLead.current = 'await:' + l.id; }}
        onClick={() => setDrawerLead(l)}
        style={{ background: 'var(--bg-card)', borderRadius: 10, border: '1px solid var(--border)', padding: '10px 12px', marginBottom: 8, cursor: 'pointer' }}>
        <div style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name || l.email}</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.email} · {l.status}</div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={e => { (e as any).stopPropagation(); confirmMiniReportSent(l); }} style={{ flex: 1, padding: '5px 0', background: '#22c55e', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}><CheckCircle size={11} /> Sent</button>
          <button onClick={e => { (e as any).stopPropagation(); dispatch({ type: 'UPDATE_LEAD', payload: { ...l, customData: { ...l.customData, miniReportStatus: 'no' } } }); }} style={{ flex: 1, padding: '5px 0', background: '#6b7280', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: 11 }}>Done</button>
        </div>
      </div>
    );
  }

  function renderBoard() {
    const activeCol = boardLeads.filter(l => getPhase(l).phase === 'active');
    const nurtureCol = boardLeads.filter(l => getPhase(l).phase === 'nurture');
    const perpetualCol = boardLeads.filter(l => getPhase(l).phase === 'perpetual');

    function onDropToPhase(phase: MofPhaseType) {
      if (!dragLead.current) return;
      const raw = dragLead.current;
      dragLead.current = null;
      if (raw.startsWith('await:')) {
        const l = awaitingMiniReport.find(x => x.id === raw.slice(6));
        if (l) confirmMiniReportSent(l);
        return;
      }
      const leadId = raw;
      const p = state.mof.leadPhases[leadId];
      dispatch({ type: 'MOF_SET_PHASE', payload: { leadId, phase: { phase, enteredAt: new Date().toISOString(), lastTouchAt: p?.lastTouchAt || '', silenceMonths: 0, manualPhase: true } } });
    }
    function onDropToStopped() {
      if (!dragLead.current) return;
      const raw = dragLead.current;
      dragLead.current = null;
      if (raw.startsWith('await:')) {
        const l = awaitingMiniReport.find(x => x.id === raw.slice(6));
        if (l) dispatch({ type: 'UPDATE_LEAD', payload: { ...l, customData: { ...l.customData, miniReportStatus: 'no' } } });
        return;
      }
      const leadId = raw;
      const lead = boardLeads.find(l => l.id === leadId);
      if (lead) stopLeadSequence(lead);
    }

    const columnDefs: Array<{ key: string; label: string; color: string; leads: any[]; onDrop?: () => void; isAwaiting?: boolean }> = [
      { key: 'awaiting', label: 'Awaiting Mini Report', color: '#d97706', leads: awaitingMiniReport, isAwaiting: true },
      { key: 'active', label: 'Active · Day 1-21', color: PHASE_COLORS.active, leads: activeCol, onDrop: () => onDropToPhase('active') },
      { key: 'nurture', label: 'Nurture · Day 22-90', color: PHASE_COLORS.nurture, leads: nurtureCol, onDrop: () => onDropToPhase('nurture') },
      { key: 'perpetual', label: 'Perpetual · Day 91+', color: PHASE_COLORS.perpetual, leads: perpetualCol, onDrop: () => onDropToPhase('perpetual') },
      { key: 'stopped', label: 'Stopped / Closed', color: PHASE_COLORS.closed, leads: stoppedLeads, onDrop: onDropToStopped },
    ];

    return (
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ fontSize: 26, fontWeight: 700, marginBottom: 4 }}>Middle of Funnel</h1>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 12, alignItems: 'center' }}>
              <span style={{ color: 'var(--text-muted)' }}>{mofLeads.length + individualLeads.length} leads tracked</span>
              {noChannelDataLeads.length > 0 && (
                <span onClick={() => { setSelectedLeadId(noChannelDataLeads[0].id); setView('lead'); }}
                  style={{ padding: '3px 10px', borderRadius: 12, background: '#fef3c7', color: '#d97706', fontWeight: 700, fontSize: 11, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <AlertTriangle size={11} />{noChannelDataLeads.length} due with no channel data
                </span>
              )}
              {genFailures.length > 0 && (
                <span onClick={() => setShowAutoLog(true)} title={genFailures.map(f => `${f.email}: ${f.message}`).join('\n')}
                  style={{ padding: '3px 10px', borderRadius: 12, background: '#fee2e2', color: '#dc2626', fontWeight: 700, fontSize: 11, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <AlertTriangle size={11} />{genFailures.length} failed to generate on last run
                </span>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {autoSending && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Auto-sending...</span>}
            <button onClick={processAutoSend} disabled={autoSending} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 8, cursor: 'pointer', fontWeight: 500, fontSize: 13, color: autoSending ? 'var(--text-muted)' : 'inherit' }}><Zap size={16} /> {autoSending ? 'Sending...' : 'Run Auto'}</button>
            <button onClick={checkForReplies} disabled={checkingReplies} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 8, cursor: 'pointer', fontWeight: 500, fontSize: 13 }}><ExternalLink size={16} /> {checkingReplies ? 'Checking...' : 'Check Replies'}</button>
            <button onClick={() => setShowAutoLog(!showAutoLog)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', background: showAutoLog ? 'var(--bg-muted)' : 'transparent', border: '1px solid var(--border)', borderRadius: 8, cursor: 'pointer', fontWeight: 500, fontSize: 13 }}><Clock size={16} /> Log</button>
            <button onClick={() => setShowAddForm(!showAddForm)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}><UserPlus size={16} /> Add Lead</button>
          </div>
        </div>

        {showAutoLog && autoLog.length > 0 && (
          <div style={{ marginBottom: 16, padding: 10, background: '#1e1e2e', color: '#cdd6f4', borderRadius: 8, maxHeight: 140, overflowY: 'auto', fontSize: 11, fontFamily: 'monospace', lineHeight: 1.5 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, color: '#6c7086' }}>
              <span>Auto-Sender Log</span>
              <button onClick={() => setAutoLog([])} style={{ background: 'none', border: 'none', color: '#6c7086', cursor: 'pointer', fontSize: 10, textDecoration: 'underline' }}>Clear</button>
            </div>
            {autoLog.map((entry, i) => <div key={i}>{entry}</div>)}
          </div>
        )}

        {showAddForm && renderAddLeadForm()}

        <div style={{ display: 'flex', gap: 14, overflowX: 'auto', paddingBottom: 8 }}>
          {columnDefs.map(col => (
            <div key={col.key}
              onDragOver={e => e.preventDefault()}
              onDrop={col.onDrop}
              style={{ flex: '0 0 280px', minWidth: 280, background: 'var(--bg-muted)', borderRadius: 12, padding: 10, maxHeight: 'calc(100vh - 260px)', display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, padding: '0 2px' }}>
                <span style={{ width: 8, height: 8, borderRadius: 4, background: col.color, display: 'inline-block' }} />
                <span style={{ fontWeight: 700, fontSize: 13 }}>{col.label}</span>
                <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>{col.leads.length}</span>
              </div>
              <div style={{ overflowY: 'auto', flex: 1 }}>
                {col.leads.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)', fontSize: 12 }}>No leads</div>
                ) : col.leads.map(l => col.isAwaiting ? renderAwaitingCard(l) : renderCard(l))}
              </div>
            </div>
          ))}
        </div>

        {individualLeads.length > 0 && (
          <div style={{ marginTop: 24 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Individually Added Leads ({individualLeads.length})</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 8 }}>
              {individualLeads.map(il => (
                <div key={il.id} onClick={() => { setSelectedLeadId(il.id); setView('lead'); }} style={{ background: 'var(--bg-card)', borderRadius: 10, border: '1px solid var(--border)', padding: '10px 14px', cursor: 'pointer' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{il.name || il.email}</div>
                    {il.promotedToMainApp && <span style={{ fontSize: 9, fontWeight: 700, color: '#16a34a', background: '#16a34a20', padding: '2px 6px', borderRadius: 8, flexShrink: 0 }}>Promoted</span>}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{il.email}</div>
                  {resolvingThreadFor === il.id ? (
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>Locating latest thread...</div>
                  ) : il.threadId ? (
                    <div style={{ fontSize: 10, color: '#16a34a', marginTop: 4 }}>Thread linked · {il.sentFromAccount}</div>
                  ) : (
                    <div style={{ fontSize: 10, color: '#d97706', marginTop: 4 }}>No thread found yet</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  function renderLeadDetail() {
    if (!selectedLeadId) return null;
    const isInd = isIndividualLeadId(selectedLeadId);
    const il = isInd ? individualLeads.find(l => l.id === selectedLeadId) : undefined;
    const realLead = !isInd ? allLeads.find((l: any) => l.id === selectedLeadId) : undefined;
    if (isInd && !il) return null;
    if (!isInd && !realLead) return null;
    const lead = isInd ? toBoardLead(il!) : realLead;

    const defaultCfg = {
      defaultPersonalizedSubject: '', defaultPersonalizedBody: '',
      phase1Touches: DEFAULT_PHASE1_TOUCHES.map(t => ({ ...t })),
      phase2Touches: DEFAULT_PHASE2_TOUCHES.map(t => ({ ...t })),
      phase3Touches: DEFAULT_PHASE3_TOUCHES.map(t => ({ ...t })),
    };
    const cfg = state.mof.leadConfigs[lead.id] || defaultCfg;
    const ph = getPhase(lead);
    const h = state.mof.followUpHistory[lead.id] || [];

    function upd(update: any) {
      dispatch({ type: 'MOF_UPDATE_LEAD_CONFIG', payload: { leadId: lead.id, config: { ...cfg, ...update } } });
    }
    function setPhase1Touches(t: MofTouchConfig[]) { upd({ phase1Touches: t }); }
    function setPhase2Touches(t: MofTouchConfig[]) { upd({ phase2Touches: t }); }
    function setPhase3Touches(t: MofTouchConfig[]) { upd({ phase3Touches: t }); }

    return (
      <div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          <button onClick={() => { setView('board'); setSelectedLeadId(null); setDataModalOpen(false); }} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}><ArrowLeft size={14} /> Back</button>
          {!isInd && <button onClick={() => setDrawerLead(realLead)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}><ExternalLink size={14} /> View Thread</button>}
          <button onClick={() => startNewThread(lead, cfg)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}><Repeat size={14} /> Start New Thread</button>
          <button onClick={() => setDataModalOpen(true)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}><MessageSquare size={14} /> Conversation & Data</button>
          <button onClick={() => { if (window.confirm('Stop sequence for ' + (lead.name || lead.email) + '? This marks the lead as closed.')) stopLeadSequence(lead); }} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', background: 'transparent', border: '1px solid #fca5a5', borderRadius: 6, cursor: 'pointer', fontSize: 12, color: '#ef4444' }}><Undo2 size={14} /> Stop</button>
          {isInd && !il!.promotedToMainApp && <button onClick={() => promoteIndividualLead(lead.id)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}><ArrowRight size={14} /> Promote to Main App</button>}
          {isInd && <button onClick={() => removeIndividualLead(lead.id)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', background: 'transparent', border: '1px solid #fca5a5', borderRadius: 6, cursor: 'pointer', fontSize: 12, color: '#ef4444' }}><Trash2 size={14} /> Remove</button>}
        </div>

        <div style={{ background: 'var(--bg-card)', borderRadius: 12, border: '1px solid var(--border)', padding: 20, marginBottom: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 2 }}>{lead.name || '---'}</h1>
              <div style={{ color: 'var(--text-secondary)', fontSize: 14 }}>{lead.email}</div>
            </div>
            {['active', 'nurture', 'perpetual'].includes(ph.phase) ? (
              <select
                value={ph.manualPhase ? ph.phase : 'auto'}
                onChange={e => setManualPhase(lead, (e.target as any).value)}
                title="Manually set this lead's phase. Overrides the automatic days-since-sent calculation and restarts that phase's follow-up schedule."
                style={{ fontSize: 11, fontWeight: 700, padding: '5px 10px', borderRadius: 12, background: ph.color + '20', color: ph.color, border: '1px solid ' + ph.color + '55', cursor: 'pointer' }}
              >
                <option value="auto">Auto — {ph.label}</option>
                <option value="active">Active (Day 1-21)</option>
                <option value="nurture">Nurture (Day 22-90)</option>
                <option value="perpetual">Perpetual (Day 91+)</option>
              </select>
            ) : (
              <div style={{ fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 12, background: ph.color + '20', color: ph.color }}>{ph.label}</div>
            )}
          </div>
          {ph.manualPhase && (
            <div style={{ marginTop: 8, fontSize: 11, color: '#8b5cf6', background: '#8b5cf620', padding: '4px 8px', borderRadius: 6, display: 'inline-block' }}>
              Manually pinned to this phase — follow-ups fire per this phase's schedule regardless of days elapsed. Pick "Auto" to let it recalculate.
            </div>
          )}
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }}>
            {lead.customData?.channelName && <span>Channel: {lead.customData.channelName} · </span>}
            {lead.customData?.miniReportSentDate && <span>{isInd ? 'Added' : 'Mini Report'}: {daysSince(lead.customData.miniReportSentDate)}d ago</span>}
          </div>
          {h.length > 0 && (
            <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>{h.length} follow-up{h.length !== 1 ? 's' : ''} sent · Last: {new Date(h[h.length - 1].sentAt).toLocaleDateString()}</span>
              {isSentToday(lead) && <span style={{ fontSize: 10, fontWeight: 700, color: '#16a34a', background: '#16a34a20', padding: '2px 8px', borderRadius: 10 }}>Sent today</span>}
              <button onClick={() => setHistoryLead(lead)} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', fontSize: 10, color: 'var(--text-secondary)' }}><History size={11} /> Full History</button>
            </div>
          )}
          {cfg.activeThreadOverride === '' && (
            <div style={{ marginTop: 12, fontSize: 12, color: '#3b82f6', background: '#3b82f620', padding: '8px 12px', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Repeat size={13} /> The next message sent will start a brand-new thread with this lead.
            </div>
          )}
          {!state.mof.leadChannelData[lead.id] && (
            <div style={{ marginTop: 12, fontSize: 12, color: '#d97706', background: '#fef3c7', padding: '8px 12px', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
              <AlertTriangle size={13} />
              {getChannelId(lead)
                ? 'Channel data hasn\'t been collected yet for this lead. It happens automatically in the background, or open Conversation & Data to check on it.'
                : 'No channel ID set for this lead yet. Add one in Conversation & Data so the AI can reference their videos.'}
            </div>
          )}
        </div>

        <div style={{ background: 'var(--bg-card)', borderRadius: 12, border: '1px solid var(--border)', padding: 20, marginBottom: 20 }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}><Settings size={16} style={{ marginRight: 6, verticalAlign: 'middle' }} /> Touch Schedule</h3>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
            Each touch's actual email is written by AI right before it sends, using the thread so far and this lead's channel data &mdash; nothing here is pre-written.
          </div>

          <div style={{ marginBottom: 16, borderBottom: '1px solid var(--border-light)', paddingBottom: 16 }}>
            <h4 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, color: '#22c55e' }}><Zap size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} /> Active (Day 1-21) <span style={{ fontWeight: 400, fontSize: 11 }}>&mdash; Shared thread; Touch #1 gets a subject after "Start New Thread"</span></h4>
            {cfg.phase1Touches.map((t: MofTouchConfig, i: number) => renderTouchRow(cfg.phase1Touches, setPhase1Touches, i, lead.id, 'active', cfg))}
            <button onClick={() => { const ld = cfg.phase1Touches.length ? cfg.phase1Touches[cfg.phase1Touches.length - 1].day + 3 : 3; setPhase1Touches([...cfg.phase1Touches, emptyTouch(Math.min(ld, 21))]); }} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', background: 'transparent', border: '1px dashed var(--border)', borderRadius: 6, cursor: 'pointer', fontSize: 11 }}><Plus size={12} /> Add Touch</button>
          </div>

          <div style={{ marginBottom: 16, borderBottom: '1px solid var(--border-light)', paddingBottom: 16 }}>
            <h4 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, color: '#3b82f6' }}><Zap size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} /> Nurture (Day 22-90) <span style={{ fontWeight: 400, fontSize: 11 }}>&mdash; New thread per touch, unless "Join to previous" is checked</span></h4>
            {cfg.phase2Touches.map((t: MofTouchConfig, i: number) => renderTouchRow(cfg.phase2Touches, setPhase2Touches, i, lead.id, 'nurture', cfg))}
            <button onClick={() => { const ld = cfg.phase2Touches.length ? cfg.phase2Touches[cfg.phase2Touches.length - 1].day + 7 : 35; setPhase2Touches([...cfg.phase2Touches, emptyTouch(Math.min(ld, 90))]); }} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', background: 'transparent', border: '1px dashed var(--border)', borderRadius: 6, cursor: 'pointer', fontSize: 11 }}><Plus size={12} /> Add Touch</button>
          </div>

          <div style={{ marginBottom: 16 }}>
            <h4 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, color: '#8b5cf6' }}><Zap size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} /> Perpetual (Day 91+) <span style={{ fontWeight: 400, fontSize: 11 }}>&mdash; New thread per touch, unless "Join to previous" is checked</span></h4>
            {cfg.phase3Touches.map((t: MofTouchConfig, i: number) => renderTouchRow(cfg.phase3Touches, setPhase3Touches, i, lead.id, 'perpetual', cfg))}
            <button onClick={() => { const ld = cfg.phase3Touches.length ? cfg.phase3Touches[cfg.phase3Touches.length - 1].day + 30 : 120; setPhase3Touches([...cfg.phase3Touches, emptyTouch(ld)]); }} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', background: 'transparent', border: '1px dashed var(--border)', borderRadius: 6, cursor: 'pointer', fontSize: 11 }}><Plus size={12} /> Add Touch</button>
          </div>
        </div>

        {h.length > 0 && (
          <div style={{ background: 'var(--bg-card)', borderRadius: 12, border: '1px solid var(--border)', padding: 20, marginBottom: 20 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>History ({h.length})</h3>
            {h.map((r: any, i: number) => {
              const sentToday = new Date(r.sentAt).toDateString() === new Date().toDateString();
              return (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--border-light)', fontSize: 12 }}>
                  <span>#{r.touchNumber} · {PHASE_LABELS[r.phase] || r.phase}</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {sentToday && <span style={{ fontSize: 10, fontWeight: 700, color: '#16a34a', background: '#16a34a20', padding: '2px 8px', borderRadius: 10 }}>Sent today</span>}
                    <span style={{ color: 'var(--text-muted)' }}>{new Date(r.sentAt).toLocaleString()}</span>
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {dataModalOpen && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={() => setDataModalOpen(false)}>
            <div style={{ background: 'var(--bg-card)', borderRadius: 12, width: '95vw', height: '92vh', maxWidth: 1100, display: 'flex', flexDirection: 'column', overflow: 'hidden' }} onClick={e => (e as any).stopPropagation()}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
                <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>{lead.name || lead.email} &middot; Conversation &amp; Channel Data</h2>
                <button onClick={() => setDataModalOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4, display: 'flex' }}><X size={20} /></button>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
                <div style={{ background: 'var(--bg-page)', borderRadius: 12, border: '1px solid var(--border)', padding: 20, marginBottom: 20 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
                    <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>Conversation</h3>
                    <ThreadExport leadName={lead.name} leadEmail={lead.email} messages={threadMessages} />
                  </div>
                  {threadLoading ? (
                    <div style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)', fontSize: 12 }}>Loading thread...</div>
                  ) : !lead.threadId ? (
                    <div style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)', fontSize: 12 }}>No thread found for this lead yet.</div>
                  ) : threadMessages.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)', fontSize: 12 }}>No messages loaded.</div>
                  ) : (
                    <div style={{ maxHeight: 320, overflowY: 'auto' }}>
                      {threadMessages.map((m, i) => (
                        <div key={i} style={{ padding: '8px 0', borderBottom: '1px solid var(--border-light)', fontSize: 12 }}>
                          <div style={{ fontWeight: 600 }}>{m.from}</div>
                          <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>{new Date(m.date).toLocaleString()}</div>
                          <div style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{(m.body || m.snippet || '').slice(0, 800)}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div style={{ background: 'var(--bg-page)', borderRadius: 12, border: '1px solid var(--border)', padding: 20 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4, flexWrap: 'wrap', gap: 8 }}>
                    <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>Channel Data</h3>
                    <button onClick={() => autoCollectChannelData(lead)} style={{ padding: '4px 10px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', fontSize: 11 }}>Refresh for AI</button>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
                    {state.mof.leadChannelData[lead.id]
                      ? `${state.mof.leadChannelData[lead.id].videos.length} videos on file for the AI, collected ${new Date(state.mof.leadChannelData[lead.id].fetchedAt).toLocaleString()}.`
                      : 'Not collected yet — happens automatically once a channel ID is set.'}
                  </div>
                  <ChannelDataPanel channelId={getChannelId(lead)} onChannelIdChange={(id) => setChannelIdFor(lead, id)} />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  function renderHistoryModal() {
    if (!historyLead) return null;
    const hist = [...(state.mof.followUpHistory[historyLead.id] || [])].reverse();
    return (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={() => setHistoryLead(null)}>
        <div style={{ background: 'var(--bg-card)', borderRadius: 12, padding: 24, minWidth: 380, maxWidth: 480, maxHeight: '70vh', overflowY: 'auto' }} onClick={e => (e as any).stopPropagation()}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <h3 style={{ margin: 0, fontSize: 16 }}>Message History</h3>
            <button onClick={() => setHistoryLead(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 18, lineHeight: 1 }}>&times;</button>
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 0, marginBottom: 16 }}>{historyLead.name || historyLead.email} &middot; {historyLead.email}</p>
          {hist.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: 20 }}>No messages sent yet.</div>
          ) : (
            hist.map((r: any, i: number) => {
              const isToday = new Date(r.sentAt).toDateString() === new Date().toDateString();
              return (
                <div key={i} style={{ padding: '10px 0', borderBottom: '1px solid var(--border-light)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
                    <span style={{ fontWeight: 600 }}>Touch #{r.touchNumber} &middot; {PHASE_LABELS[r.phase] || r.phase}</span>
                    {isToday && <span style={{ fontSize: 10, fontWeight: 700, color: '#16a34a', background: '#16a34a20', padding: '2px 8px', borderRadius: 10 }}>Sent today</span>}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{new Date(r.sentAt).toLocaleString()}</div>
                </div>
              );
            })
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      {sendToast && (
        <div style={{ position: 'fixed', top: 16, right: 16, zIndex: 2000, background: '#16a34a', color: '#fff', padding: '12px 18px', borderRadius: 10, boxShadow: '0 4px 12px rgba(0,0,0,0.2)', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8, maxWidth: 420 }}>
          <CheckCircle size={16} />
          <span>Message sent today to {sendToast.email} from {sendToast.account} (Touch #{sendToast.touchNumber})</span>
          <button onClick={() => setSendToast(null)} style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', marginLeft: 4, fontSize: 16, lineHeight: 1 }}>&times;</button>
        </div>
      )}
      {view === 'board' && renderBoard()}
      {view === 'lead' && renderLeadDetail()}
      <LeadDrawer lead={drawerLead} onClose={() => setDrawerLead(null)} />
      {renderHistoryModal()}
    </div>
  );
}
