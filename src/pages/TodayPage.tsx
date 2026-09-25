import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useStore } from '../store';
import { analyzeLead, createDraft, getDraftDetails } from '../services/gmail';
import { Lead, Account } from '../types';
import { RefreshCw, CheckCircle, Clock, X, AlertCircle, RotateCcw } from 'lucide-react';
import LeadDrawer from '../components/LeadDrawer';
import { checkFu2Stale } from '../utils/staleLogic';
import { getMofEligibleForDraft, resolveThreadPlan, daysSince, DEFAULT_PHASE1_TOUCHES, DEFAULT_PHASE2_TOUCHES, DEFAULT_PHASE3_TOUCHES } from '../utils/mofSchedule';
import { generateFollowUp } from '../services/groqFollowup';

export default function TodayPage() {
  const { state, dispatch } = useStore();
  const [syncing, setSyncing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [drawerLead, setDrawerLead] = useState<Lead | null>(null);
  const [sendingSingleLeads, setSendingSingleLeads] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState('');
  const [logs, setLogs] = useState<string[]>([]);
  const consoleRef = useRef<HTMLDivElement>(null);

  // Modal specific states for Leads Needing Attention (sequencing issues)
  const [showAttentionModal, setShowAttentionModal] = useState(false);
  const [modalSyncingLeads, setModalSyncingLeads] = useState<Set<string>>(new Set());
  const [modalLogs, setModalLogs] = useState<string[]>([]);
  const [modalSyncingAll, setModalSyncingAll] = useState(false);

  useEffect(() => {
    if (consoleRef.current) {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
    }
  }, [logs]);

  // Reset daily counters if needed
  const today = new Date().toDateString();
  state.accounts.forEach(acc => {
    if (acc.lastResetDate !== today) {
      dispatch({
        type: 'UPDATE_ACCOUNT',
        payload: { ...acc, sentToday: 0, lastResetDate: today }
      });
    }
  });

  const allLeads = [...state.newLeads, ...state.oldLeads];
  
  // Filter leads that need action and sort
  const actionableLeads = useMemo(() => {
    const needsAction = allLeads.filter(l => {
      if (l.status === 'new') return true;
      // Match any needs_fuX status dynamically
      return /^needs_fu\d+$/.test(l.status);
    });

    const priority: Record<string, number> = { new: 99 };
    allLeads.forEach(l => {
      const m = l.status.match(/^needs_fu(\d+)$/);
      if (m) priority[l.status] = parseInt(m[1]);
    });

    return needsAction.sort((a, b) => {
      const pa = priority[a.status] ?? 99;
      const pb = priority[b.status] ?? 99;
      return pa - pb;
    });
  }, [allLeads]);

  // Filter leads that have ACTUAL sequencing issues/problems that need attention
  const leadsWithIssues = useMemo(() => {
    return allLeads.filter(l => {
      // 1. Invalid or empty email
      if (!l.email || !l.email.includes('@')) {
        return true;
      }

      // 2. Follow-up status but missing threadId or sentFromAccount
      const isFollowupStage = /^(needs_)?fu\d+(_sent)?$/.test(l.status);
      if (isFollowupStage && (!l.threadId || !l.sentFromAccount)) {
        return true;
      }

      // 3. Sender account disconnected
      if (l.sentFromAccount) {
        const accExists = state.accounts.some(a => a.email === l.sentFromAccount);
        if (!accExists) {
          return true;
        }
      }

      return false;
    });
  }, [allLeads, state.accounts]);

  // Leads that need syncing (never synced or last synced more than 24 hours ago)
  const leadsNeedingSync = useMemo(() => {
    const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;
    return allLeads.filter(lead => {
      if (!lead.lastAnalyzed) return true;
      return new Date(lead.lastAnalyzed).getTime() < twentyFourHoursAgo;
    });
  }, [allLeads]);

  // Helper: Get specific error description for each issue
  function getLeadIssueDescription(lead: Lead, accounts: Account[]) {
    if (!lead.email || !lead.email.includes('@')) {
      return 'Invalid or empty email address.';
    }
    const isFollowupStage = /^(needs_)?fu\d+(_sent)?$/.test(lead.status);
    if (isFollowupStage && !lead.threadId && !lead.sentFromAccount) {
      return 'Missing both Gmail thread ID and sender account for follow-up.';
    }
    if (isFollowupStage && !lead.threadId) {
      return 'Missing Gmail thread ID for follow-up threading.';
    }
    if (isFollowupStage && !lead.sentFromAccount) {
      return 'Missing assigned sender account for follow-up.';
    }
    if (lead.sentFromAccount) {
      const accExists = accounts.some(a => a.email === lead.sentFromAccount);
      if (!accExists) {
        return `Assigned sender account (${lead.sentFromAccount}) is no longer connected.`;
      }
    }
    return '';
  }

  const followUpCount = state.settings.followUps.length;
  const statusGroups: Record<string, Lead[]> = {
    new: actionableLeads.filter(l => l.status === 'new'),
  };
  for (let i = 1; i <= followUpCount; i++) {
    const key = `needs_fu${i}`;
    statusGroups[key] = actionableLeads.filter(l => l.status === key);
  }

  // Middle-of-funnel leads whose next touch is due today AND already have a
  // personalized message written for it. Mirrors the MOF board's own "due" +
  // "message written" checks, so this only ever surfaces what MOF itself would
  // consider ready to send.
  const mofEligible = useMemo(() => getMofEligibleForDraft(state), [state]);

  const logsRef = useRef<string[]>([]);
  const progressRef = useRef('');
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const LOG_FLUSH_INTERVAL = 400; // flush logs to DOM every 400ms
  const PROGRESS_THROTTLE = 5;    // update progress text every N leads
  const MAX_DISPLAYED_LOGS = 200;

  /** Batched addLog — pushes to a ref array, flushes to state periodically */
  const createBatchedLog = useCallback(() => {
    logsRef.current = [];
    progressRef.current = '';

    if (flushTimerRef.current) clearInterval(flushTimerRef.current);

    flushTimerRef.current = setInterval(() => {
      if (logsRef.current.length > 0) {
        // Capture and clear the ref synchronously (outside the updater) so the
        // setLogs updater stays pure — React may invoke it more than once
        // (StrictMode, batched re-renders), and a side effect inside the
        // updater would silently drop logs on the extra invocation.
        const batch = logsRef.current;
        logsRef.current = [];
        setLogs(prev => {
          const combined = [...prev, ...batch];
          // Cap at MAX_DISPLAYED_LOGS to keep DOM small
          return combined.length > MAX_DISPLAYED_LOGS
            ? combined.slice(combined.length - MAX_DISPLAYED_LOGS)
            : combined;
        });
      }
      if (progressRef.current) {
        setProgress(progressRef.current);
        progressRef.current = '';
      }
    }, LOG_FLUSH_INTERVAL);

    return {
      addLog: (msg: string) => {
        logsRef.current.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
      },
      setProgressThrottled: (msg: string, leadIndex: number) => {
        if (leadIndex % PROGRESS_THROTTLE === 0) {
          progressRef.current = msg;
        }
      },
      flushNow: () => {
        if (flushTimerRef.current) clearInterval(flushTimerRef.current);
        flushTimerRef.current = null;
        if (logsRef.current.length > 0) {
          const batch = logsRef.current;
          logsRef.current = [];
          setLogs(prev => {
            const combined = [...prev, ...batch];
            return combined.length > MAX_DISPLAYED_LOGS
              ? combined.slice(combined.length - MAX_DISPLAYED_LOGS)
              : combined;
          });
        }
        if (progressRef.current) {
          setProgress(progressRef.current);
          progressRef.current = '';
        }
      },
    };
  }, []);


  function handleResetDailyLimits() {
    if (!state.accounts.length) return;
    if (!window.confirm('Reset today\'s sent count to 0 for all Gmail accounts?')) return;
    const today = new Date().toDateString();
    state.accounts.forEach(acc => {
      dispatch({
        type: 'UPDATE_ACCOUNT',
        payload: { ...acc, sentToday: 0, lastResetDate: today }
      });
    });
  }

  async function handleSync(force: boolean = false) {
    if (!state.accounts.length) {
      alert('Add Gmail accounts first in the Accounts page');
      return;
    }
    setSyncing(true);
    setLogs([]);
    setProgress('Starting server-side sync...');

    const batched = createBatchedLog();
    const { addLog, flushNow } = batched;

    try {
      addLog(`=== Starting Server-Side Sync Pipeline ${force ? '(FORCE MODE)' : ''} ===`);

      // 1. Start the sync on the backend
      const startRes = await fetch('http://localhost:3006/api/sync/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force }),
      });
      const startData = await startRes.json();
      if (!startRes.ok) throw new Error(startData.error || 'Failed to start sync');

      const syncId = startData.syncId;
      addLog(`Sync started with ID: ${syncId}`);

      // 2. Poll for progress
      let done = false;
      let lastLogCount = 0;
      while (!done) {
        await new Promise(r => setTimeout(r, 1500));

        const statusRes = await fetch(`http://localhost:3006/api/sync/status/${syncId}`);
        if (!statusRes.ok) {
          addLog(`Warning: Status poll failed (${statusRes.status}), retrying...`);
          continue;
        }

        const status = await statusRes.json();

        // Pipe new server logs to the UI
        if (status.logs && status.logs.length > lastLogCount) {
          const newLogs = status.logs.slice(lastLogCount);
          for (const logLine of newLogs) {
            addLog(logLine);
          }
          lastLogCount = status.logs.length;
          flushNow();
        }

        // Update progress display
        if (status.status === 'running' || status.status === 'starting') {
          if (status.currentLead) {
            setProgress(`Syncing: ${status.currentLead} (${status.done}/${status.total})`);
          } else {
            setProgress(`Processing... ${status.done}/${status.total}`);
          }
        }

        if (status.status === 'completed') {
          addLog(`=== Sync Complete! ${status.done} leads scanned ===`);
          done = true;
        } else if (status.status === 'error') {
          addLog(`=== Sync Failed: ${status.error} ===`);
          done = true;
        }
      }

      // 3. Reload the full state from the server to get all updates
      flushNow();
      setProgress('Reloading updated data...');
      
      const stateRes = await fetch('http://localhost:3006/api/state');
      if (stateRes.ok) {
        const freshState = await stateRes.json();
        dispatch({ type: 'LOAD_STATE', payload: freshState });
        addLog('State reloaded from server with latest sync results.');
      } else {
        addLog('Warning: Could not reload state from server.');
      }

      flushNow();
      setSyncing(false);
      setProgress('Sync complete!');
      addLog('=== Ready ===');
      flushNow();
    } catch (err: any) {
      console.error('[Sync] Error:', err);
      addLog(`SYNC ERROR: ${err?.message || err}`);
      flushNow();
      setSyncing(false);
      setProgress(`Sync failed: ${err?.message || 'Unknown error'}`);
    }
  }
  // Individual Sync from inside the Attention popup modal
  async function handleSyncLead(lead: Lead) {
    if (!state.accounts.length) {
      alert('Add Gmail accounts first in the Accounts page');
      return;
    }

    setModalSyncingLeads(prev => {
      const next = new Set(prev);
      next.add(lead.id);
      return next;
    });
    
    const addLog = (msg: string) => {
      setModalLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
    };
    
    addLog(`Scanning lead: ${lead.email}...`);
    try {
      const updates = await analyzeLead(
        lead,
        state.accounts,
        state.settings.dateCutoff,
        state.settings.followUps,
        (msg) => addLog(`  ${msg}`),
        (updatedAcc) => dispatch({ type: 'UPDATE_ACCOUNT', payload: updatedAcc }),
        state.settings
      );
      // Mark this lead as having been through the sync pipeline at least once.
      updates.syncedOnce = true;

      let movedToStale = false;

      // Highest-priority rule: lead has exhausted the follow-up sequence (sitting at the
      // final fuN_sent status) and has gone dark (no contact/reply) for 60+ days → stale.
      const fu2Check = checkFu2Stale(lead, updates, (state.settings.followUps || []).length);
      if (fu2Check.shouldMoveToStale && (lead.page === 'new' || lead.page === 'old')) {
        dispatch({ type: 'MOVE_TO_STALE', payload: { id: lead.id, sourcePage: lead.page, updates } });
        movedToStale = true;
        addLog(`  -> Lead at ${fu2Check.lastFuStatus}, no contact/reply for ${Math.floor(fu2Check.daysSince!)} day(s) (> 60 day cutoff). Moving to Stale Leads.`);
      } else {
        // For old leads > 30 days, reset to new (skip replied/draft — active conversations)
        const resetStatus = updates.status || lead.status;
        if (lead.page === 'old' && updates.lastContactDate && resetStatus !== 'replied' && resetStatus !== 'draft') {
          const daysSince = (Date.now() - new Date(updates.lastContactDate).getTime()) / (1000 * 60 * 60 * 24);
          if (daysSince > 30) {
            addLog(`  -> Old Lead last contacted ${Math.floor(daysSince)} day(s) ago (> 30 days cutoff). Resetting status to: new.`);
            updates.status = 'new';
            updates.threadId = undefined;
            updates.sentFromAccount = undefined;
            updates.lastContactDate = undefined;
          } else {
            addLog(`  -> Old Lead last contacted ${Math.floor(daysSince)} day(s) ago (< 30 days). Keeping status: ${updates.status}.`);
          }
        } else if (lead.page === 'old' && !updates.lastContactDate && updates.status === 'new') {
          addLog(`  -> Old Lead was never contacted. Treating as: new.`);
        }
      }

      if (!movedToStale) {
        dispatch({
          type: 'UPDATE_LEAD',
          payload: { ...lead, ...updates }
        });
      }
      addLog(`SUCCESS: Sync complete for ${lead.email}! Status: ${updates.status}`);
    } catch (err) {
      addLog(`ERROR: Failed to sync lead ${lead.email}: ${err}`);
    } finally {
      setModalSyncingLeads(prev => {
        const next = new Set(prev);
        next.delete(lead.id);
        return next;
      });
    }
  }

  // Batch Sync for only leads with issues from inside the popup modal
  async function handleSyncAllActionable() {
    if (!state.accounts.length) {
      alert('Add Gmail accounts first in the Accounts page');
      return;
    }
    
    setModalSyncingAll(true);
    setModalLogs([]);
    
    const addLog = (msg: string) => {
      setModalLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
    };
    
    addLog(`=== Starting Sync for ${leadsWithIssues.length} Leads with Issues ===`);
    
    for (let i = 0; i < leadsWithIssues.length; i++) {
      const lead = leadsWithIssues[i];
      addLog(`[${i + 1}/${leadsWithIssues.length}] Syncing: ${lead.email}`);
      
      try {
        const updates = await analyzeLead(
          lead,
          state.accounts,
          state.settings.dateCutoff,
          state.settings.followUps,
          (msg) => addLog(`  ${msg}`),
          (updatedAcc) => dispatch({ type: 'UPDATE_ACCOUNT', payload: updatedAcc }),
          state.settings
        );
        
        // Mark this lead as having been through the sync pipeline at least once.
        updates.syncedOnce = true;

        let movedToStale2 = false;

        // Highest-priority rule: lead has exhausted the follow-up sequence (sitting at the
        // final fuN_sent status) and has gone dark (no contact/reply) for 60+ days → stale.
        const fu2Check2 = checkFu2Stale(lead, updates, (state.settings.followUps || []).length);
        if (fu2Check2.shouldMoveToStale && (lead.page === 'new' || lead.page === 'old')) {
          dispatch({ type: 'MOVE_TO_STALE', payload: { id: lead.id, sourcePage: lead.page, updates } });
          movedToStale2 = true;
          addLog(`  -> Lead at ${fu2Check2.lastFuStatus}, no contact/reply for ${Math.floor(fu2Check2.daysSince!)} day(s) (> 60 day cutoff). Moving to Stale Leads.`);
        } else {
          // For old leads > 30 days, reset to new (skip replied/draft — active conversations)
          const resetStatus2 = updates.status || lead.status;
          if (lead.page === 'old' && updates.lastContactDate && resetStatus2 !== 'replied' && resetStatus2 !== 'draft') {
            const daysSince = (Date.now() - new Date(updates.lastContactDate).getTime()) / (1000 * 60 * 60 * 24);
            if (daysSince > 30) {
              addLog(`  -> Old Lead last contacted ${Math.floor(daysSince)} day(s) ago (> 30 days cutoff). Resetting status to: new.`);
              updates.status = 'new';
              updates.threadId = undefined;
              updates.sentFromAccount = undefined;
              updates.lastContactDate = undefined;
            } else {
              addLog(`  -> Old Lead last contacted ${Math.floor(daysSince)} day(s) ago (< 30 days). Keeping status: ${updates.status}.`);
            }
          } else if (lead.page === 'old' && !updates.lastContactDate && updates.status === 'new') {
            addLog(`  -> Old Lead was never contacted. Treating as: new.`);
          }
        }

        if (!movedToStale2) {
          dispatch({
            type: 'UPDATE_LEAD',
            payload: { ...lead, ...updates }
          });
        }

        addLog(`  -> SUCCESS: Status resolved to ${updates.status}\n`);
      } catch (err) {
        addLog(`  -> ERROR: ${err}\n`);
      }
    }
    
    setModalSyncingAll(false);
    addLog(`=== Batch Sync Completed! ===`);
  }

  function escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function substituteTemplate(template: { subject: string; body: string }, lead: Lead) {
    let subject = template.subject;
    let body = template.body;

    // Helper to normalize a key (lowercase, strip whitespace, underscores, dashes)
    const normalizeKey = (k: string) => k.toLowerCase().replace(/[\s_-]/g, '');

    // Map of normalized keys to actual values in customData/lead
    const valueMap: Record<string, string> = {
      name: lead.name || '',
      email: lead.email || '',
    };

    Object.entries(lead.customData || {}).forEach(([key, value]) => {
      const normKey = normalizeKey(key);
      const strVal = String(value || '').trim();
      
      // Keep exact match or write if not present
      if (!valueMap[normKey] || key === 'videoTitle' || key === 'channelName') {
        valueMap[normKey] = strVal;
      }
    });

    // Regex to match {{variable}} placeholders
    const placeholderRegex = /{{([^}]+)}}/g;

    const replacePlaceholders = (text: string, isSubject: boolean) => {
      if (!text) return '';
      return text.replace(placeholderRegex, (match, p1) => {
        const placeholderName = p1.trim();
        const normPlaceholder = normalizeKey(placeholderName);
        
        let value = '';
        if (normPlaceholder in valueMap) {
          value = valueMap[normPlaceholder];
        } else {
          const foundEntry = Object.entries(lead.customData || {}).find(([k]) => normalizeKey(k) === normPlaceholder);
          if (foundEntry) {
            value = String(foundEntry[1] || '').trim();
          } else {
            return match; // keep original placeholder
          }
        }

        const safe = escapeHtml(value);

        if (normPlaceholder === 'videotitle') {
          if (isSubject) {
            const words = value.split(/\s+/);
            const truncated = words.slice(0, 5).join(' ');
            return escapeHtml(truncated + (words.length > 5 ? '...' : ''));
          } else {
            return `<b>${safe}</b>`;
          }
        }

        return safe;
      });
    };

    subject = replacePlaceholders(subject, true);
    body = replacePlaceholders(body, false);

    return { subject, body };
  }

  async function handleCreateDraftsBatch(stage: string) {
    if (!state.accounts.length) {
      alert('Add Gmail accounts first in the Accounts page');
      return;
    }

    let eligibleLeads: Lead[] = [];
    if (stage === 'initial') {
      // 80/20 split: 80% new leads, 20% old leads
      const newInitial = statusGroups.new.filter(l => l.page === 'new');
      const oldInitial = statusGroups.new.filter(l => l.page === 'old');

      // Calculate total capacity across all accounts
      const totalCapacity = state.accounts.reduce((sum, a) => sum + Math.max(0, a.dailyLimit - a.sentToday), 0);
      const totalAvailable = Math.min(newInitial.length + oldInitial.length, totalCapacity);

      const newSlots = Math.min(newInitial.length, Math.ceil(totalAvailable * 0.8));
      const oldSlots = Math.min(oldInitial.length, totalAvailable - newSlots);

      const selectedNew = newInitial.slice(0, newSlots);
      const selectedOld = oldInitial.slice(0, oldSlots);

      // Interleave: 4 new, 1 old, repeat for natural distribution
      const interleaved: Lead[] = [];
      let ni = 0, oi = 0;
      while (ni < selectedNew.length || oi < selectedOld.length) {
        // Add up to 4 new leads
        for (let k = 0; k < 4 && ni < selectedNew.length; k++) {
          interleaved.push(selectedNew[ni++]);
        }
        // Add 1 old lead
        if (oi < selectedOld.length) {
          interleaved.push(selectedOld[oi++]);
        }
      }
      eligibleLeads = interleaved;
    } else {
      // Dynamic follow-up stage
      eligibleLeads = statusGroups[stage] || [];
    }

    if (eligibleLeads.length === 0) {
      alert('No eligible leads for this stage');
      return;
    }

    setCreating(true);
    setLogs([]);
    setProgress(`Starting batch draft creation for ${stage}...`);

    const batched = createBatchedLog();
    const { addLog, setProgressThrottled, flushNow } = batched;

    addLog(`=== Starting Draft Batch: ${stage.toUpperCase()} (${eligibleLeads.length} leads) ===`);
    if (stage === 'initial') {
      const newCount = eligibleLeads.filter(l => l.page === 'new').length;
      const oldCount = eligibleLeads.filter(l => l.page === 'old').length;
      addLog(`80/20 Split Applied: ${newCount} new leads (80%) + ${oldCount} old leads (20%) = ${eligibleLeads.length} total`);
    }

    // Load templates for this stage.
    // Stage comes in as 'needs_fu1', 'needs_fu2', etc. Template types are 'fu1', 'fu2', etc.
    const templateType = stage.replace(/^needs_/, '');
    const templates = state.templates.filter(t => t.type === templateType);
    const newTemplates = templates.filter(t => t.leadType === 'new');
    const oldTemplates = templates.filter(t => t.leadType === 'old');

    addLog(`Found ${newTemplates.length} new templates and ${oldTemplates.length} old templates for this stage.`);

    let newTempIdx = 0;
    let oldTempIdx = 0;

    let localAccounts = [...state.accounts];
    let initialAccountIdx = 0;
    let createdCount = 0;
    let skippedCount = 0;

    for (let i = 0; i < eligibleLeads.length; i++) {
      const lead = eligibleLeads[i];
      addLog(`[${i + 1}/${eligibleLeads.length}] Processing lead: ${lead.email}`);
      setProgressThrottled(`Creating draft ${i + 1} of ${eligibleLeads.length}...`, i);

      // Determine template for the lead
      const leadTemplates = lead.page === 'new' ? newTemplates : oldTemplates;
      if (leadTemplates.length === 0) {
        addLog(`  -> ERROR: No template found for lead type '${lead.page}' at stage '${stage}'. Skipping.`);
        skippedCount++;
        continue;
      }
      
      const templateIdx = lead.page === 'new' ? newTempIdx : oldTempIdx;
      const template = leadTemplates[templateIdx % leadTemplates.length];
      
      // Advance template index
      if (lead.page === 'new') {
        newTempIdx++;
      } else {
        oldTempIdx++;
      }

      // Substitute variables
      let subject = '';
      if (stage === 'initial') {
        const subbed = substituteTemplate(template, lead);
        subject = subbed.subject;
      } else {
        // Automatically generate follow-up subject: Re: <initial_template_subject>
        const initialTemplates = state.templates.filter(t => t.type === 'initial' && t.leadType === template.leadType);
        if (initialTemplates.length > 0) {
          const subbedInitial = substituteTemplate(initialTemplates[0], lead);
          subject = `Re: ${subbedInitial.subject}`;
        } else {
          subject = 'Re: Collaboration';
        }
      }
      
      const subbedTemplate = substituteTemplate(template, lead);
      const body = subbedTemplate.body;

      // Select Account to send from
      let targetAccount: Account | undefined;
      
      if (stage === 'initial') {
        // Distribute round-robin across all accounts with remaining capacity
        const accountsWithCapacity = localAccounts.filter(a => a.dailyLimit - a.sentToday > 0);
        if (accountsWithCapacity.length === 0) {
          addLog(`  -> ERROR: All accounts have hit their daily limits! Skipping remaining leads.`);
          skippedCount += (eligibleLeads.length - i);
          break;
        }
        
        targetAccount = accountsWithCapacity[initialAccountIdx % accountsWithCapacity.length];
        initialAccountIdx++;
      } else {
        // Follow-up drafts: only use account stored in lead.sentFromAccount
        if (!lead.sentFromAccount) {
          addLog(`  -> WARNING: Lead has no sentFromAccount recorded. Falling back to round-robin.`);
          const accountsWithCapacity = localAccounts.filter(a => a.dailyLimit - a.sentToday > 0);
          if (accountsWithCapacity.length === 0) {
            addLog(`  -> ERROR: No accounts with capacity available. Skipping.`);
            skippedCount++;
            continue;
          }
          targetAccount = accountsWithCapacity[initialAccountIdx % accountsWithCapacity.length];
          initialAccountIdx++;
        } else {
          targetAccount = localAccounts.find(a => a.email === lead.sentFromAccount);
          if (!targetAccount) {
            addLog(`  -> ERROR: Assigned sender account '${lead.sentFromAccount}' not found in connected accounts. Skipping.`);
            skippedCount++;
            continue;
          }
          
          if (targetAccount.dailyLimit - targetAccount.sentToday <= 0) {
            addLog(`  -> LIMIT REACHED: Account '${targetAccount.email}' has no quota left today. Lead skipped to carry over tomorrow.`);
            skippedCount++;
            continue;
          }
        }
      }

      addLog(`  -> Selected account: ${targetAccount.email} (Remaining quota: ${targetAccount.dailyLimit - targetAccount.sentToday})`);
      addLog(`  -> Using template: "${template.name}"`);
      addLog(`  -> Subject: "${subject}"`);

      try {
        await createDraft(
          targetAccount, 
          lead.email, 
          subject, 
          body, 
          lead.threadId, 
          (updatedAcc) => {
            dispatch({ type: 'UPDATE_ACCOUNT', payload: updatedAcc });
            localAccounts = localAccounts.map(a => a.id === updatedAcc.id ? updatedAcc : a);
          }, 
          state.settings
        );

        const updatedAcc = { ...targetAccount, sentToday: targetAccount.sentToday + 1 };
        dispatch({ type: 'UPDATE_ACCOUNT', payload: updatedAcc });
        localAccounts = localAccounts.map(a => a.id === updatedAcc.id ? updatedAcc : a);

        const newStatus = stage === 'initial' ? 'initial_sent' : `${templateType}_sent`;
                          
        dispatch({
          type: 'UPDATE_LEAD',
          payload: {
            ...lead,
            status: newStatus,
            sentFromAccount: targetAccount.email,
            lastContactDate: new Date().toISOString(),
            templateId: template.id
          }
        });

        addLog(`  -> SUCCESS: Draft created successfully! Status updated to ${newStatus}.`);
        createdCount++;
      } catch (err) {
        addLog(`  -> ERROR: Failed to create draft: ${err}`);
        skippedCount++;
      }
      
      addLog('');
    }

    flushNow();
    setCreating(false);
    setProgress(`Batch complete! Created ${createdCount} drafts, skipped ${skippedCount}.`);
    addLog(`=== Draft Batch Completed: ${createdCount} Created, ${skippedCount} Skipped ===`);
    flushNow();
  }

  async function handleSendSingleLead(lead: Lead) {
    if (!state.accounts.length) {
      alert('Add Gmail accounts first in the Accounts page');
      return;
    }

    // Determine stage from lead status
    const stage = lead.status === 'new' ? 'initial' : lead.status; // e.g. 'needs_fu1', 'needs_fu2'

    setSendingSingleLeads(prev => {
      const next = new Set(prev);
      next.add(lead.id);
      return next;
    });

    setProgress(`Creating draft for ${lead.email}...`);
    const addLog = (msg: string) => {
      setLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
    };

    addLog(`Creating individual draft for: ${lead.email}`);

    // Load templates for this stage
    const templateType = stage.replace(/^needs_/, '');
    const templates = state.templates.filter(t => t.type === templateType);
    const leadTemplates = templates.filter(t => t.leadType === lead.page);

    if (leadTemplates.length === 0) {
      addLog(`  -> ERROR: No template found for lead type '${lead.page}' at stage '${stage}'.`);
      setSendingSingleLeads(prev => {
        const next = new Set(prev);
        next.delete(lead.id);
        return next;
      });
      return;
    }

    const template = leadTemplates[0];

    // Substitute variables
    let subject = '';
    if (stage === 'initial') {
      const subbed = substituteTemplate(template, lead);
      subject = subbed.subject;
    } else {
      const initialTemplates = state.templates.filter(t => t.type === 'initial' && t.leadType === template.leadType);
      if (initialTemplates.length > 0) {
        const subbedInitial = substituteTemplate(initialTemplates[0], lead);
        subject = `Re: ${subbedInitial.subject}`;
      } else {
        subject = 'Re: Collaboration';
      }
    }

    const subbedTemplate = substituteTemplate(template, lead);
    const body = subbedTemplate.body;

    // Select Account to send from
    let targetAccount: Account | undefined;

    if (stage === 'initial') {
      const accountsWithCapacity = state.accounts.filter(a => a.dailyLimit - a.sentToday > 0);
      if (accountsWithCapacity.length === 0) {
        addLog(`  -> ERROR: All accounts have hit their daily limits!`);
        setSendingSingleLeads(prev => {
          const next = new Set(prev);
          next.delete(lead.id);
          return next;
        });
        return;
      }
      // Simple round-robin starting from the first available
      targetAccount = accountsWithCapacity[0];
    } else {
      if (!lead.sentFromAccount) {
        const accountsWithCapacity = state.accounts.filter(a => a.dailyLimit - a.sentToday > 0);
        if (accountsWithCapacity.length === 0) {
          addLog(`  -> ERROR: No accounts with capacity available.`);
          setSendingSingleLeads(prev => {
            const next = new Set(prev);
            next.delete(lead.id);
            return next;
          });
          return;
        }
        targetAccount = accountsWithCapacity[0];
        addLog(`  -> WARNING: Lead has no sentFromAccount recorded. Falling back to ${targetAccount.email}.`);
      } else {
        targetAccount = state.accounts.find(a => a.email === lead.sentFromAccount);
        if (!targetAccount) {
          addLog(`  -> ERROR: Assigned sender account '${lead.sentFromAccount}' not found.`);
          setSendingSingleLeads(prev => {
            const next = new Set(prev);
            next.delete(lead.id);
            return next;
          });
          return;
        }
        if (targetAccount.dailyLimit - targetAccount.sentToday <= 0) {
          addLog(`  -> LIMIT REACHED: Account '${targetAccount.email}' has no quota left today.`);
          setSendingSingleLeads(prev => {
            const next = new Set(prev);
            next.delete(lead.id);
            return next;
          });
          return;
        }
      }
    }

    addLog(`  -> Selected account: ${targetAccount.email} (Remaining quota: ${targetAccount.dailyLimit - targetAccount.sentToday})`);
    addLog(`  -> Using template: "${template.name}"`);
    addLog(`  -> Subject: "${subject}"`);

    try {
      await createDraft(
        targetAccount,
        lead.email,
        subject,
        body,
        lead.threadId,
        (updatedAcc) => {
          dispatch({ type: 'UPDATE_ACCOUNT', payload: updatedAcc });
        },
        state.settings
      );

      const updatedAcc = { ...targetAccount, sentToday: targetAccount.sentToday + 1 };
      dispatch({ type: 'UPDATE_ACCOUNT', payload: updatedAcc });

      const newStatus = stage === 'initial' ? 'initial_sent' : `${templateType}_sent`;

      dispatch({
        type: 'UPDATE_LEAD',
        payload: {
          ...lead,
          status: newStatus,
          sentFromAccount: targetAccount.email,
          lastContactDate: new Date().toISOString(),
          templateId: template.id
        }
      });

      addLog(`  -> SUCCESS: Draft created! Status updated to ${newStatus}.`);
      setProgress(`Draft created for ${lead.email}`);
    } catch (err) {
      addLog(`  -> ERROR: Failed to create draft: ${err}`);
    } finally {
      setSendingSingleLeads(prev => {
        const next = new Set(prev);
        next.delete(lead.id);
        return next;
      });
    }
  }

  async function handleCreateMofDrafts() {
    if (!state.accounts.length) {
      alert('Add Gmail accounts first in the Accounts page');
      return;
    }

    const eligible = mofEligible;
    if (eligible.length === 0) {
      alert('No MOF leads are due right now');
      return;
    }

    setCreating(true);
    setLogs([]);
    setProgress('Starting batch draft creation for MOF...');

    const batched = createBatchedLog();
    const { addLog, setProgressThrottled, flushNow } = batched;

    addLog(`=== Starting Draft Batch: MOF (${eligible.length} leads) ===`);

    let localAccounts = [...state.accounts];
    let createdCount = 0;
    let skippedCount = 0;

    for (let i = 0; i < eligible.length; i++) {
      const { lead, phase, touch, touchIdx, touchNumber, cfg, touches, hist } = eligible[i];
      addLog(`[${i + 1}/${eligible.length}] Processing lead: ${lead.email}`);
      setProgressThrottled(`Creating draft ${i + 1} of ${eligible.length}...`, i);

      if (!lead.sentFromAccount) {
        addLog(`  -> ERROR: Lead has no sentFromAccount recorded. Skipping.`);
        skippedCount++;
        continue;
      }
      const targetAccount = localAccounts.find(a => a.email === lead.sentFromAccount);
      if (!targetAccount) {
        addLog(`  -> ERROR: Assigned sender account '${lead.sentFromAccount}' not found in connected accounts. Skipping.`);
        skippedCount++;
        continue;
      }
      if (targetAccount.dailyLimit - targetAccount.sentToday <= 0) {
        addLog(`  -> LIMIT REACHED: Account '${targetAccount.email}' has no quota left today. Lead skipped to carry over tomorrow.`);
        skippedCount++;
        continue;
      }

      const plan = resolveThreadPlan(lead, cfg, phase, touches, touchIdx, hist);
      const tid = plan.tid;

      addLog(`  -> Selected account: ${targetAccount.email} (Remaining quota: ${targetAccount.dailyLimit - targetAccount.sentToday})`);
      addLog(`  -> Touch #${touchNumber} (Day ${touch.day})`);

      let generated;
      try {
        generated = await generateFollowUp({
          leadName: lead.name || lead.email,
          channelName: lead.customData?.channelName,
          miniReportThreadId: lead.threadId,
          account: targetAccount,
          onAccountUpdated: (updatedAcc) => {
            dispatch({ type: 'UPDATE_ACCOUNT', payload: updatedAcc });
            localAccounts = localAccounts.map(a => a.id === updatedAcc.id ? updatedAcc : a);
          },
          channelData: state.mof.leadChannelData[lead.id],
          history: hist,
          phase,
          touchNumber,
          day: touch.day,
          daysSinceLastContact: daysSince(hist.length > 0 ? hist[hist.length - 1].sentAt : lead.customData?.miniReportSentDate),
          needsSubject: plan.ownsNewThread,
        });
      } catch (genErr: any) {
        addLog(`  -> AI generation failed: ${genErr.message || genErr}. Skipping.`);
        skippedCount++;
        continue;
      }
      if (!generated.body) {
        addLog(`  -> AI returned an empty body. Skipping.`);
        skippedCount++;
        continue;
      }
      const subj = plan.ownsNewThread ? generated.subject : '';
      addLog(`  -> Angle: ${generated.angle} · Subject: "${subj}"`);

      try {
        const draftId = await createDraft(
          targetAccount,
          lead.email,
          subj,
          generated.body,
          tid,
          (updatedAcc) => {
            dispatch({ type: 'UPDATE_ACCOUNT', payload: updatedAcc });
            localAccounts = localAccounts.map(a => a.id === updatedAcc.id ? updatedAcc : a);
          },
          state.settings
        );

        const updatedAcc = { ...targetAccount, sentToday: targetAccount.sentToday + 1 };
        dispatch({ type: 'UPDATE_ACCOUNT', payload: updatedAcc });
        localAccounts = localAccounts.map(a => a.id === updatedAcc.id ? updatedAcc : a);

        let resultThreadId = '';
        try {
          const details = await getDraftDetails(draftId, targetAccount, undefined, state.settings);
          resultThreadId = details?.message?.threadId || '';
        } catch { /* record keeps an empty threadId; a later join/override just falls back to a new thread */ }

        dispatch({
          type: 'MOF_ADD_FOLLOW_UP_RECORD',
          payload: {
            leadId: lead.id,
            record: {
              sentAt: new Date().toISOString(),
              phase,
              touchNumber,
              templateType: 'personalized',
              threadId: resultThreadId,
              miniReportThreadId: lead.threadId || resultThreadId,
              angle: generated.angle,
            },
          },
        });

        const cp = state.mof.leadPhases[lead.id] || { phase: 'active' as const, enteredAt: new Date().toISOString(), lastTouchAt: '', silenceMonths: 0 };
        dispatch({ type: 'MOF_SET_PHASE', payload: { leadId: lead.id, phase: { ...cp, lastTouchAt: new Date().toISOString(), silenceMonths: 0 } } });

        if (cfg?.activeThreadOverride === '' && resultThreadId) {
          dispatch({ type: 'MOF_SET_THREAD_OVERRIDE', payload: { leadId: lead.id, threadId: resultThreadId } });
        }

        const sd = lead.customData?.miniReportSentDate;
        if (sd) {
          const ds = daysSince(sd);
          const gap = ds - touch.day;
          if (gap > 0) {
            const newTouches = touches.map((t, idx) => (idx > touchIdx ? { ...t, day: t.day + gap } : { ...t }));
            const cfgBase = cfg || { defaultPersonalizedSubject: '', defaultPersonalizedBody: '', phase1Touches: DEFAULT_PHASE1_TOUCHES, phase2Touches: DEFAULT_PHASE2_TOUCHES, phase3Touches: DEFAULT_PHASE3_TOUCHES };
            if (phase === 'active') dispatch({ type: 'MOF_UPDATE_LEAD_CONFIG', payload: { leadId: lead.id, config: { ...cfgBase, phase1Touches: newTouches } } });
            else if (phase === 'nurture') dispatch({ type: 'MOF_UPDATE_LEAD_CONFIG', payload: { leadId: lead.id, config: { ...cfgBase, phase2Touches: newTouches } } });
            else dispatch({ type: 'MOF_UPDATE_LEAD_CONFIG', payload: { leadId: lead.id, config: { ...cfgBase, phase3Touches: newTouches } } });
          }
        }

        addLog(`  -> SUCCESS: Draft created for touch #${touchNumber}!`);
        createdCount++;
      } catch (err) {
        addLog(`  -> ERROR: Failed to create draft: ${err}`);
        skippedCount++;
      }

      addLog('');
    }

    flushNow();
    setCreating(false);
    setProgress(`Batch complete! Created ${createdCount} drafts, skipped ${skippedCount}.`);
    addLog(`=== Draft Batch Completed: ${createdCount} Created, ${skippedCount} Skipped ===`);
    flushNow();
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 4 }}>Today</h1>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
            <p style={{ color: 'var(--text-secondary)', margin: 0, fontWeight: 500 }}>
              {actionableLeads.length} leads ready for outreach today
            </p>
            <span style={{
              fontSize: 12,
              padding: '4px 10px',
              borderRadius: 16,
              fontWeight: 600,
              background: leadsNeedingSync.length > 0 ? 'var(--accent-light)' : 'var(--bg-hover)',
              color: leadsNeedingSync.length > 0 ? 'var(--accent)' : 'var(--text-secondary)',
              border: '1px solid',
              borderColor: leadsNeedingSync.length > 0 ? 'var(--border-focus)' : 'var(--border)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4
            }}>
              <RefreshCw size={12} />
              {leadsNeedingSync.length} need sync{leadsNeedingSync.length > 0 && ` (${allLeads.length - leadsNeedingSync.length} synced <24h ago)`}
            </span>
            {leadsWithIssues.length > 0 && (
              <span 
                onClick={() => {
                  setShowAttentionModal(true);
                  setModalLogs([]);
                }}
                style={{ 
                  color: 'var(--red-text)', 
                  cursor: 'pointer', 
                  fontWeight: 600, 
                  display: 'inline-flex', 
                  alignItems: 'center', 
                  gap: 6,
                  background: 'var(--red-bg)',
                  padding: '4px 10px',
                  borderRadius: 16,
                  fontSize: 12,
                  transition: 'all 0.2s',
                  border: '1px solid var(--red-bg)'
                }}
              >
                <AlertCircle size={14} />
                {leadsWithIssues.length} leads need attention (issues found)
              </span>
            )}
          </div>
        </div>
        <button
          onClick={() => handleSync(false)}
          disabled={syncing}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 20px',
            background: syncing ? 'var(--text-muted)' : 'var(--accent)',
            color: 'var(--text-inverse)',
            border: 'none',
            borderRadius: 8,
            cursor: syncing ? 'not-allowed' : 'pointer',
            fontWeight: 600
          }}
        >
          <RefreshCw size={18} style={{ animation: syncing ? 'spin 1s linear infinite' : 'none' }} />
          {syncing ? 'Syncing...' : 'Sync Emails'}
        </button>
        <button
          onClick={() => handleSync(true)}
          disabled={syncing}
          title="Force-sync all leads, bypassing the 24-hour cooldown"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 20px',
            background: syncing ? 'var(--text-muted)' : 'var(--red-bg)',
            color: syncing ? 'var(--text-muted)' : 'var(--red-text)',
            border: '1px solid',
            borderColor: syncing ? 'var(--border)' : 'var(--red-text)',
            borderRadius: 8,
            cursor: syncing ? 'not-allowed' : 'pointer',
            fontWeight: 600
          }}
        >
          <RefreshCw size={18} style={{ animation: syncing ? 'spin 1s linear infinite' : 'none' }} />
          {syncing ? 'Syncing...' : 'Force Sync All'}
        </button>
        <button
          onClick={handleResetDailyLimits}
          title="Reset today's sent count to 0 for all Gmail accounts"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 20px',
            background: 'var(--bg-secondary)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            cursor: 'pointer',
            fontWeight: 600
          }}
        >
          <RotateCcw size={18} />
          Reset Daily Limits
        </button>
      </div>

      {progress && (
        <div style={{ 
          padding: 12, 
          background: 'var(--accent-light)', 
          borderRadius: 8, 
          marginBottom: 16,
          fontSize: 14,
          color: 'var(--blue-text)',
          fontWeight: 500
        }}>
          {progress}
        </div>
      )}

      {(progress || logs.length > 0) && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ 
            background: '#1e293b', 
            borderRadius: '8px 8px 0 0', 
            padding: '8px 16px', 
            color: '#94a3b8', 
            fontSize: 12, 
            fontWeight: 600,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            borderBottom: '1px solid #334155'
          }}>
            <span>Live Activity Console</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--red-text)' }}></span>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#eab308' }}></span>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#22c55e' }}></span>
            </div>
          </div>
          <div 
            ref={consoleRef}
            style={{ 
              height: 200, 
              background: '#0f172a', 
              color: '#38bdf8', 
              fontFamily: 'monospace', 
              fontSize: 13, 
              padding: 16, 
              borderRadius: '0 0 8px 8px', 
              overflowY: 'auto',
              whiteSpace: 'pre-wrap',
              boxShadow: 'inset 0 2px 8px rgba(0,0,0,0.8)'
            }}
          >
            {logs.length === 0 ? (
              <span style={{ color: '#64748b' }}>Waiting for activity...</span>
            ) : (
              logs.map((log, idx) => (
                <div key={idx} style={{ 
                  marginBottom: 4, 
                  color: log.includes('SUCCESS') ? '#34d399' :
                         log.includes('ERROR') ? '#f87171' :
                         log.includes('LIMIT REACHED') ? '#fbbf24' :
                         log.includes('Selected account') ? '#a78bfa' : '#cbd5e1'
                }}>
                  {log}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Account Grid */}
      <div style={{ marginBottom: 28 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 12 }}>Gmail Account Quotas</h2>
        {state.accounts.length === 0 ? (
          <div style={{ padding: 16, background: 'var(--bg-muted)', borderRadius: 8, border: '1px solid var(--border)', color: 'var(--text-secondary)', fontSize: 14 }}>
            No Gmail accounts connected. Add accounts in the Accounts page.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
            {state.accounts.map(acc => {
              const remaining = acc.dailyLimit - acc.sentToday;
              const percent = Math.min(100, Math.max(0, (acc.sentToday / acc.dailyLimit) * 100));
              const isFull = remaining <= 0;
              
              return (
                <div key={acc.id} style={{
                  padding: 16,
                  background: 'var(--bg-card)',
                  borderRadius: 10,
                  border: '1px solid var(--border)',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  opacity: isFull ? 0.75 : 1
                }}>
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                      <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }} title={acc.email}>
                        {acc.email}
                      </span>
                      <span style={{
                        fontSize: 11,
                        padding: '2px 8px',
                        borderRadius: 20,
                        fontWeight: 600,
                        background: isFull ? 'var(--red-bg)' : 'var(--green-bg)',
                        color: isFull ? 'var(--red-text)' : 'var(--green-text)'
                      }}>
                        {isFull ? 'Limit Reached' : `${remaining} left`}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                      Sent today: <strong>{acc.sentToday}</strong> / {acc.dailyLimit}
                    </div>
                  </div>
                  
                  <div>
                    <div style={{ width: '100%', height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{
                        width: `${percent}%`,
                        height: '100%',
                        background: isFull ? 'var(--red-text)' : 'var(--accent)',
                        borderRadius: 3,
                        transition: 'width 0.3s ease'
                      }} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* One-Click Action Panel */}
      <div style={{ 
        background: 'var(--bg-muted)', 
        border: '1px solid var(--border)', 
        borderRadius: 12, 
        padding: 20, 
        marginBottom: 28 
      }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>One-Click Draft Creation</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>
          Automatically generate drafts for all eligible leads. Initial emails use an 80/20 split (80% new, 20% old leads). Follow-ups are locked to their original sender accounts.
        </p>
        
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          <button
            onClick={() => handleCreateDraftsBatch('initial')}
            disabled={creating || syncing || statusGroups.new.length === 0}
            style={{
              flex: 1,
              minWidth: 200,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '12px 16px',
              background: statusGroups.new.length === 0 ? 'var(--border)' : 'var(--accent)',
              color: statusGroups.new.length === 0 ? 'var(--text-muted)' : 'var(--accent-text)',
              border: 'none',
              borderRadius: 8,
              cursor: (creating || syncing || statusGroups.new.length === 0) ? 'not-allowed' : 'pointer',
              fontWeight: 600,
              transition: 'all 0.2s',
            }}
          >
            <span style={{ fontSize: 14 }}>Create Drafts for Initial</span>
            <span style={{ fontSize: 11, opacity: 0.8, marginTop: 2 }}>
              {statusGroups.new.length} eligible ({statusGroups.new.filter(l => l.page === 'new').length} new / {statusGroups.new.filter(l => l.page === 'old').length} old — 80/20)
            </span>
          </button>

          {state.settings.followUps.map((fu, i) => {
            const key = `needs_fu${i + 1}`;
            const count = statusGroups[key]?.length || 0;
            const colors = ['var(--yellow-text)', 'var(--pink-text)', 'var(--blue-text)', 'var(--green-text)', 'var(--red-text)'];
            const color = colors[i % colors.length];
            return (
              <button
                key={key}
                onClick={() => handleCreateDraftsBatch(key)}
                disabled={creating || syncing || count === 0}
                style={{
                  flex: 1,
                  minWidth: 200,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '12px 16px',
                  background: count === 0 ? 'var(--border)' : color,
                  color: count === 0 ? 'var(--text-muted)' : 'var(--text-inverse)',
                  border: 'none',
                  borderRadius: 8,
                  cursor: (creating || syncing || count === 0) ? 'not-allowed' : 'pointer',
                  fontWeight: 600,
                  transition: 'all 0.2s',
                }}
              >
                <span style={{ fontSize: 14 }}>Create Drafts for FU{i + 1}</span>
                <span style={{ fontSize: 11, opacity: 0.8, marginTop: 2 }}>
                  {count} leads eligible (delay: {fu.delayDays}d)
                </span>
              </button>
            );
          })}

          {mofEligible.length > 0 && (
            <button
              onClick={handleCreateMofDrafts}
              disabled={creating || syncing}
              style={{
                flex: 1,
                minWidth: 200,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '12px 16px',
                background: 'var(--accent)',
                color: 'var(--accent-text)',
                border: 'none',
                borderRadius: 8,
                cursor: (creating || syncing) ? 'not-allowed' : 'pointer',
                fontWeight: 600,
                transition: 'all 0.2s',
              }}
            >
              <span style={{ fontSize: 14 }}>Create Drafts for MOF</span>
              <span style={{ fontSize: 11, opacity: 0.8, marginTop: 2 }}>
                {mofEligible.length} leads eligible (due today, AI writes each one)
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Lead Groups */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
        {(() => {
          const statusKeys = ['new', ...state.settings.followUps.map((_, i) => `needs_fu${i + 1}`)];
          return statusKeys.map((status, idx) => {
            const leads = statusGroups[status];
            const labels: Record<string, string> = { new: 'Needs Initial Email' };
            state.settings.followUps.forEach((_, i) => {
              labels[`needs_fu${i + 1}`] = `Needs Follow-up ${i + 1}`;
            });
            const stageColors = ['var(--accent)', 'var(--yellow-text)', 'var(--pink-text)', 'var(--blue-text)', 'var(--green-text)', 'var(--red-text)'];
            const colors: Record<string, string> = { new: 'var(--accent)' };
            state.settings.followUps.forEach((_, i) => {
              colors[`needs_fu${i + 1}`] = stageColors[(i + 1) % stageColors.length];
            });

            if (!leads.length) return null;

            return (
            <div key={status}>
              <div style={{ 
                display: 'flex', 
                alignItems: 'center', 
                justifyContent: 'space-between',
                marginBottom: 12 
              }}>
                <h2 style={{ 
                  fontSize: 16, 
                  fontWeight: 700, 
                  color: colors[status],
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8
                }}>
                  <Clock size={18} />
                  {labels[status]} ({leads.length})
                </h2>
              </div>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {leads.map(lead => (
                  <div
                    key={lead.id}
                    onClick={() => setDrawerLead(lead)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '12px 16px',
                      borderRadius: 8,
                      border: '1px solid var(--border)',
                      cursor: 'pointer',
                      background: 'var(--bg-card)',
                      boxShadow: '0 1px 2px rgba(0,0,0,0.02)',
                      transition: 'all 0.2s'
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = colors[status];
                      e.currentTarget.style.boxShadow = '0 2px 5px rgba(0,0,0,0.05)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = 'var(--border)';
                      e.currentTarget.style.boxShadow = '0 1px 2px rgba(0,0,0,0.02)';
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' }}>
                        {lead.name || lead.email}
                        <span style={{
                          fontSize: 10,
                          padding: '2px 6px',
                          borderRadius: 4,
                          marginLeft: 8,
                          background: lead.page === 'new' ? 'var(--accent-light)' : 'var(--bg-hover)',
                          color: lead.page === 'new' ? 'var(--accent)' : 'var(--text-secondary)',
                          fontWeight: 600
                        }}>
                          {lead.page === 'new' ? 'New Lead' : 'Old Lead'}
                        </span>
                      </div>
                      <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>{lead.email}</div>
                      {lead.customData.channelName && (
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                          {lead.customData.channelName} • {lead.customData.videoTitle || ''}
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
                      <button
                        disabled={creating || syncing || sendingSingleLeads.has(lead.id)}
                        onClick={e => {
                          e.stopPropagation();
                          handleSendSingleLead(lead);
                        }}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                          padding: '6px 12px',
                          borderRadius: 6,
                          border: 'none',
                          background: (creating || syncing || sendingSingleLeads.has(lead.id)) ? 'var(--border)' : 'var(--accent)',
                          color: (creating || syncing || sendingSingleLeads.has(lead.id)) ? 'var(--text-muted)' : 'var(--accent-text)',
                          cursor: (creating || syncing || sendingSingleLeads.has(lead.id)) ? 'not-allowed' : 'pointer',
                          fontWeight: 600,
                          fontSize: 12,
                          whiteSpace: 'nowrap',
                          transition: 'all 0.15s ease'
                        }}
                      >
                        {sendingSingleLeads.has(lead.id) ? 'Sending...' : 'Send'}
                      </button>
                      {lead.sentFromAccount && (
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 500 }}>{lead.sentFromAccount}</div>
                      )}
                      {lead.lastContactDate && (
                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                          {Math.ceil((Date.now() - new Date(lead.lastContactDate).getTime()) / (1000 * 60 * 60 * 24))}d ago
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        });
      })()}
      </div>

      {actionableLeads.length === 0 && !syncing && (
        <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-muted)' }}>
          <CheckCircle size={48} style={{ marginBottom: 16, opacity: 0.5, color: 'var(--green-text)' }} />
          <h3 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8, color: 'var(--text-primary)' }}>All caught up!</h3>
          <p>No leads need emails right now. Click Sync Emails to check for updates.</p>
        </div>
      )}

      {/* POPUP MODAL: Leads Requiring Attention (Sequencing Issues) */}
      {showAttentionModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(15, 23, 42, 0.6)',
          backdropFilter: 'blur(4px)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 1000,
          padding: 20
        }}>
          <div style={{
            background: 'var(--bg-card)',
            borderRadius: 12,
            width: '100%',
            maxWidth: 800,
            maxHeight: '90vh',
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04)',
            overflow: 'hidden'
          }}>
            {/* Modal Header */}
            <div style={{
              padding: '16px 24px',
              borderBottom: '1px solid var(--border)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}>
              <div>
                <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <AlertCircle size={20} style={{ color: 'var(--red-text)' }} />
                  Leads Requiring Attention ({leadsWithIssues.length})
                </h2>
                <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '4px 0 0' }}>
                  The following leads have critical sequencing issues (e.g. missing thread IDs or disconnected senders).
                </p>
              </div>
              <button
                onClick={() => {
                  setShowAttentionModal(false);
                  setModalLogs([]);
                }}
                disabled={modalSyncingAll}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: modalSyncingAll ? 'not-allowed' : 'pointer',
                  padding: 4
                }}
              >
                <X size={20} />
              </button>
            </div>

            {/* Modal Content */}
            <div style={{ padding: '20px 24px', overflowY: 'auto', flex: 1 }}>
              {/* Sync Actions Bar */}
              <div style={{ 
                display: 'flex', 
                justifyContent: 'space-between', 
                alignItems: 'center', 
                marginBottom: 16,
                background: 'var(--red-bg)',
                padding: '12px 16px',
                borderRadius: 8,
                border: '1px solid var(--red-bg)'
              }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--red-text)' }}>
                  Resolve Issues for {leadsWithIssues.length} flagged leads
                </span>
                <button
                  onClick={handleSyncAllActionable}
                  disabled={modalSyncingAll || leadsWithIssues.length === 0}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '8px 16px',
                    background: (modalSyncingAll || leadsWithIssues.length === 0) ? 'var(--red-bg)' : 'var(--red-text)',
                    color: 'var(--text-inverse)',
                    border: 'none',
                    borderRadius: 6,
                    cursor: (modalSyncingAll || leadsWithIssues.length === 0) ? 'not-allowed' : 'pointer',
                    fontWeight: 600,
                    fontSize: 13,
                    boxShadow: '0 2px 4px rgba(239,68,68,0.2)'
                  }}
                >
                  <RefreshCw size={14} style={{ animation: modalSyncingAll ? 'spin 1s linear infinite' : 'none' }} />
                  Sync Flagded Leads Only
                </button>
              </div>

              {/* Table List of Actionable Leads */}
              <div style={{ 
                border: '1px solid var(--border)', 
                borderRadius: 8, 
                overflow: 'hidden', 
                marginBottom: 20 
              }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, textAlign: 'left' }}>
                  <thead>
                    <tr style={{ background: 'var(--bg-muted)', borderBottom: '1px solid var(--border)' }}>
                      <th style={{ padding: '10px 12px', fontWeight: 600, color: 'var(--text-primary)' }}>Lead</th>
                      <th style={{ padding: '10px 12px', fontWeight: 600, color: 'var(--text-primary)' }}>Type</th>
                      <th style={{ padding: '10px 12px', fontWeight: 600, color: 'var(--text-primary)' }}>Sequencing Issue</th>
                      <th style={{ padding: '10px 12px', fontWeight: 600, color: 'var(--text-primary)' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leadsWithIssues.map(lead => {
                      const isSyncing = modalSyncingLeads.has(lead.id);
                      const issueText = getLeadIssueDescription(lead, state.accounts);
                      return (
                        <tr key={lead.id} style={{ borderBottom: '1px solid var(--border-light)' }}>
                          <td style={{ padding: '10px 12px' }}>
                            <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{lead.name || '—'}</div>
                            <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{lead.email}</div>
                          </td>
                          <td style={{ padding: '10px 12px' }}>
                            <span style={{
                              fontSize: 10,
                              padding: '2px 6px',
                              borderRadius: 4,
                              background: lead.page === 'new' ? 'var(--accent-light)' : 'var(--bg-hover)',
                              color: lead.page === 'new' ? 'var(--accent)' : 'var(--text-secondary)',
                              fontWeight: 600
                            }}>
                              {lead.page === 'new' ? 'New' : 'Old'}
                            </span>
                          </td>
                          <td style={{ padding: '10px 12px', color: 'var(--red-text)', fontWeight: 500, fontSize: 12 }}>
                            {issueText}
                          </td>
                          <td style={{ padding: '10px 12px' }}>
                            <button
                              onClick={() => handleSyncLead(lead)}
                              disabled={isSyncing || modalSyncingAll}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 4,
                                padding: '6px 10px',
                                background: (isSyncing || modalSyncingAll) ? 'var(--border)' : 'var(--accent-light)',
                                color: (isSyncing || modalSyncingAll) ? 'var(--text-muted)' : 'var(--accent)',
                                border: '1px solid',
                                borderColor: (isSyncing || modalSyncingAll) ? 'var(--border)' : 'var(--border-focus)',
                                borderRadius: 6,
                                cursor: (isSyncing || modalSyncingAll) ? 'not-allowed' : 'pointer',
                                fontSize: 11,
                                fontWeight: 600
                              }}
                            >
                              <RefreshCw size={12} style={{ animation: isSyncing ? 'spin 1s linear infinite' : 'none' }} />
                              Sync Lead
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Console Logs */}
              <div>
                <div style={{
                  background: '#1e293b',
                  borderRadius: '6px 6px 0 0',
                  padding: '6px 12px',
                  color: '#94a3b8',
                  fontSize: 11,
                  fontWeight: 600,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center'
                }}>
                  <span>Sync Output Console</span>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--red-text)' }}></span>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#eab308' }}></span>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e' }}></span>
                  </div>
                </div>
                <div style={{
                  height: 120,
                  background: '#0f172a',
                  color: '#38bdf8',
                  fontFamily: 'monospace',
                  fontSize: 12,
                  padding: 12,
                  borderRadius: '0 0 6px 6px',
                  overflowY: 'auto',
                  whiteSpace: 'pre-wrap'
                }}>
                  {modalLogs.length === 0 ? (
                    <span style={{ color: '#64748b' }}>Logs will display here as sync runs...</span>
                  ) : (
                    modalLogs.map((log, idx) => (
                      <div key={idx} style={{
                        marginBottom: 2,
                        color: log.includes('SUCCESS') ? '#34d399' :
                               log.includes('ERROR') ? '#f87171' :
                               log.includes('Scanning') ? '#a78bfa' : '#cbd5e1'
                      }}>
                        {log}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div style={{
              padding: '12px 24px',
              borderTop: '1px solid var(--border)',
              display: 'flex',
              justifyContent: 'flex-end',
              background: 'var(--bg-muted)'
            }}>
              <button
                onClick={() => {
                  setShowAttentionModal(false);
                  setModalLogs([]);
                }}
                disabled={modalSyncingAll}
                style={{
                  padding: '8px 16px',
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  cursor: modalSyncingAll ? 'not-allowed' : 'pointer',
                  fontWeight: 600,
                  fontSize: 13,
                  color: 'var(--text-primary)'
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {drawerLead && <LeadDrawer lead={drawerLead} onClose={() => setDrawerLead(null)} />}
    </div>
  );
}