import React, { createContext, useContext, useReducer, useEffect, useState, useRef } from 'react';
import { AppState, Lead, Account, Template, FollowUpConfig, MofLeadConfig, MofPhase, MofFollowUpRecord, IndividualMofLead, GoalState, MofLeadChannelData } from './types';

// API server URL (the Express server on port 3006)
const API_BASE = 'http://localhost:3006';

// Generate default templates for a lead type based on follow-up count
function generateDefaultTemplates(leadType: 'new' | 'old', followUpCount: number): Template[] {
  const templates: Template[] = [];
  const label = leadType === 'new' ? 'New Leads' : 'Old Leads';

  // Initial template
  templates.push({
    id: crypto.randomUUID(),
    name: `${label} - Initial`,
    type: 'initial',
    leadType,
    subject: leadType === 'new'
      ? 'Collaboration with {{channelName}}'
      : 'Reconnecting: Collaboration with {{channelName}}',
    body: leadType === 'new'
      ? 'Hey {{name}},\n\nLove your content on {{channelName}} — especially "{{videoTitle}}".\n\nI think we could collaborate...\n\nBest,\nMe'
      : 'Hey {{name}},\n\nIt\'s been a while since we last chatted regarding {{channelName}}.\n\nHope everything is going great with your recent video "{{videoTitle}}".\n\nWould love to sync up again...\n\nBest,\nMe'
  });

  // Follow-up templates
  for (let i = 1; i <= followUpCount; i++) {
    const fuType = `fu${i}`;
    const messages = [
      'Hey {{name}},\n\nJust bumping this up in case you missed it.\n\nWould love to hear your thoughts.\n\nBest,\nMe',
      'Hey {{name}},\n\nJust checking in again on my last message.\n\nLet me know if you\'d be open to catching up.\n\nBest,\nMe',
      'Hey {{name}},\n\nFollowing up once more — would be great to hear back from you.\n\nBest,\nMe',
    ];
    const body = messages[i - 1] || `Hey {{name}},\n\nFollow-up #${i} — just checking in.\n\nBest,\nMe`;

    templates.push({
      id: crypto.randomUUID(),
      name: `${label} - FU${i}`,
      type: fuType,
      leadType,
      subject: '',
      body,
    });
  }

  return templates;
}

const DEFAULT_FOLLOW_UPS: FollowUpConfig[] = [
  { delayDays: 4 },
  { delayDays: 10 },
];

const defaultMofState = {
  leadConfigs: {} as Record<string, MofLeadConfig>,
  leadPhases: {} as Record<string, MofPhase>,
  followUpHistory: {} as Record<string, MofFollowUpRecord[]>,
  individualLeads: [] as IndividualMofLead[],
  leadChannelData: {} as Record<string, MofLeadChannelData>,
};

// Local-date (not UTC) so the day boundary matches the user's own timezone.
function localDateStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const defaultGoalsState: GoalState = {
  taskName: '',
  totalDays: 30,
  startDate: localDateStr(),
  checkIns: {},
};

const defaultState: AppState = {
  accounts: [],
  newLeads: [],
  oldLeads: [],
  staleLeads: [],
  templates: [
    ...generateDefaultTemplates('new', DEFAULT_FOLLOW_UPS.length),
    ...generateDefaultTemplates('old', DEFAULT_FOLLOW_UPS.length),
  ],
  columns: ['name', 'email', 'channelName', 'videoTitle'],
  settings: {
    defaultDailyLimit: 50,
    followUps: DEFAULT_FOLLOW_UPS,
    dateCutoff: '2025-11-01',
    theme: 'light'
  },
  mof: { ...defaultMofState },
  goals: { ...defaultGoalsState },
};

type Action =
  | { type: 'LOAD_STATE'; payload: AppState }
  | { type: 'ADD_ACCOUNT'; payload: Account }
  | { type: 'REMOVE_ACCOUNT'; payload: string }
  | { type: 'UPDATE_ACCOUNT'; payload: Account }
  | { type: 'ADD_LEADS'; payload: { leads: Lead[]; page: 'new' | 'old' | 'stale' } }
  | { type: 'UPDATE_LEAD'; payload: Lead }
  | { type: 'REMOVE_LEAD'; payload: { id: string; page: 'new' | 'old' | 'stale' } }
  | { type: 'SET_LEADS'; payload: { leads: Lead[]; page: 'new' | 'old' | 'stale' } }
  | { type: 'MOVE_TO_STALE'; payload: { id: string; sourcePage: 'new' | 'old'; updates?: Partial<Lead> } }
  | { type: 'ADD_TEMPLATE'; payload: Template }
  | { type: 'UPDATE_TEMPLATE'; payload: Template }
  | { type: 'REMOVE_TEMPLATE'; payload: string }
  | { type: 'SET_COLUMNS'; payload: string[] }
  | { type: 'UPDATE_SETTINGS'; payload: Partial<AppState['settings']> }
  // MoF actions
  | { type: 'MOF_UPDATE_LEAD_CONFIG'; payload: { leadId: string; config: MofLeadConfig } }
  | { type: 'MOF_SET_PHASE'; payload: { leadId: string; phase: MofPhase } }
  | { type: 'MOF_ADD_FOLLOW_UP_RECORD'; payload: { leadId: string; record: MofFollowUpRecord } }
  | { type: 'MOF_ADD_INDIVIDUAL_LEAD'; payload: IndividualMofLead }
  | { type: 'MOF_UPDATE_INDIVIDUAL_LEAD'; payload: IndividualMofLead }
  | { type: 'MOF_REMOVE_INDIVIDUAL_LEAD'; payload: string } // id
  | { type: 'MOF_PROMOTE_INDIVIDUAL_LEAD'; payload: string } // id
  | { type: 'MOF_SET_THREAD_OVERRIDE'; payload: { leadId: string; threadId: string } }
  | { type: 'MOF_SET_CHANNEL_DATA'; payload: { leadId: string; data: MofLeadChannelData } }
  // Goal tracker actions
  | { type: 'GOAL_SET_CONFIG'; payload: { taskName: string; totalDays: number; startDate: string } }
  | { type: 'GOAL_TOGGLE_DAY'; payload: { date: string } }
  | { type: 'GOAL_RESET' };

function getLeadScore(lead: Lead): number {
  let score = 0;
  if (lead.status === 'replied') score += 100;

  // Check follow-up sent statuses in reverse order (higher FU = higher score)
  const followUpCount = DEFAULT_FOLLOW_UPS.length; // use default count for scoring
  for (let i = followUpCount; i >= 1; i--) {
    if (lead.status === `fu${i}_sent`) {
      score += 80 + (i * 5); // fu1_sent=85, fu2_sent=90, fu3_sent=95, etc.
      break;
    }
    if (lead.status === `needs_fu${i}`) {
      score += 70 + (i * 5); // needs_fu1=75, needs_fu2=80, needs_fu3=85, etc.
      break;
    }
  }

  if (score === 0) {
    if (lead.status === 'initial_sent') score += 50;
    else if (lead.status === 'draft') score += 40;
    else if (lead.status === 'new') score += 10;
  }

  if (lead.threadId) score += 5;
  if (lead.sentFromAccount) score += 5;
  if (lead.lastContactDate) score += 5;
  if (lead.lastAnalyzed) score += 2;

  const customDataCount = Object.values(lead.customData || {}).filter(val => val !== '').length;
  score += customDataCount * 0.1;

  return score;
}

function cleanAndDeduplicate(newLeads: Lead[], oldLeads: Lead[], staleLeads: Lead[] = []): { newLeads: Lead[], oldLeads: Lead[], staleLeads: Lead[] } {
  const all = [...(newLeads || []), ...(oldLeads || []), ...(staleLeads || [])];

  function getChannelId(lead: Lead): string | undefined {
    const keys = ['channelId', 'channel_id', 'channelID', 'channel_Id', 'channelid'];
    for (const key of keys) {
      if (lead.customData?.[key]) return String(lead.customData[key]).trim().toLowerCase();
    }
    return undefined;
  }

  const emailMap: Record<string, string> = {};
  const channelIdMap: Record<string, string> = {};
  const leadsById: Record<string, Lead> = {};

  for (const lead of all) {
    leadsById[lead.id] = lead;
  }

  for (const lead of all) {
    const email = lead.email ? lead.email.trim().toLowerCase() : '';
    const cid = getChannelId(lead);

    let duplicateId: string | undefined = undefined;
    if (email && emailMap[email]) {
      duplicateId = emailMap[email];
    } else if (cid && channelIdMap[cid]) {
      duplicateId = channelIdMap[cid];
    }

    if (duplicateId) {
      const existingLead = leadsById[duplicateId];
      if (existingLead) {
        const existingScore = getLeadScore(existingLead);
        const currentScore = getLeadScore(lead);

        if (currentScore > existingScore) {
          delete leadsById[duplicateId];
          const oldEmail = existingLead.email ? existingLead.email.trim().toLowerCase() : '';
          const oldCid = getChannelId(existingLead);
          if (oldEmail) delete emailMap[oldEmail];
          if (oldCid) delete channelIdMap[oldCid];
          leadsById[lead.id] = lead;
          if (email) emailMap[email] = lead.id;
          if (cid) channelIdMap[cid] = lead.id;
        } else {
          delete leadsById[lead.id];
        }
      } else {
        leadsById[lead.id] = lead;
        if (email) emailMap[email] = lead.id;
        if (cid) channelIdMap[cid] = lead.id;
      }
    } else {
      if (email) emailMap[email] = lead.id;
      if (cid) channelIdMap[cid] = lead.id;
    }
  }

  // Build a set of which IDs were originally in newLeads (for missing page fallback)
  // Build a set of which IDs were originally in newLeads (for missing page fallback)
  const originallyNew = new Set((newLeads || []).map(l => l.id));
  const originallyStale = new Set((staleLeads || []).map(l => l.id));

  const finalLeads = Object.values(leadsById);
  return {
    newLeads: finalLeads.filter(l => l.page === 'new' || (!l.page && originallyNew.has(l.id))),
    oldLeads: finalLeads.filter(l => l.page === 'old' || (!l.page && !originallyNew.has(l.id) && !originallyStale.has(l.id))),
    staleLeads: finalLeads.filter(l => l.page === 'stale' || (!l.page && originallyStale.has(l.id))),
  };
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'LOAD_STATE':
      const cleaned = cleanAndDeduplicate(action.payload.newLeads, action.payload.oldLeads, action.payload.staleLeads);
      return {
        ...action.payload,
        mof: {
          leadConfigs: action.payload.mof?.leadConfigs || {},
          leadPhases: action.payload.mof?.leadPhases || {},
          followUpHistory: action.payload.mof?.followUpHistory || {},
          individualLeads: action.payload.mof?.individualLeads || [],
          leadChannelData: action.payload.mof?.leadChannelData || {},
        },
        goals: {
          taskName: action.payload.goals?.taskName ?? defaultGoalsState.taskName,
          totalDays: action.payload.goals?.totalDays ?? defaultGoalsState.totalDays,
          startDate: action.payload.goals?.startDate ?? defaultGoalsState.startDate,
          checkIns: action.payload.goals?.checkIns || {},
        },
        newLeads: cleaned.newLeads,
        oldLeads: cleaned.oldLeads,
        staleLeads: cleaned.staleLeads,
      };
    case 'ADD_ACCOUNT':
      return { ...state, accounts: [...state.accounts, action.payload] };
    case 'REMOVE_ACCOUNT':
      return { ...state, accounts: state.accounts.filter(a => a.id !== action.payload) };
    case 'UPDATE_ACCOUNT':
      return {
        ...state,
        accounts: state.accounts.map(a => a.id === action.payload.id ? action.payload : a)
      };
    case 'ADD_LEADS':
      // New leads entering the app haven't been through the sync pipeline yet, so default
      // syncedOnce to false. Leads that already carry the field explicitly (e.g. a stale
      // lead being moved back via StaleLeadsPage's moveBackTo, which already has
      // syncedOnce: true) keep their existing value.
      const incomingLeads = action.payload.leads.map(l => (
        l.syncedOnce === undefined ? { ...l, syncedOnce: false } : l
      ));
      const combinedNew = action.payload.page === 'new'
        ? [...state.newLeads, ...incomingLeads]
        : state.newLeads;
      const combinedOld = action.payload.page === 'old'
        ? [...state.oldLeads, ...incomingLeads]
        : state.oldLeads;
      const combinedStale = action.payload.page === 'stale'
        ? [...state.staleLeads, ...incomingLeads]
        : state.staleLeads;
      const cleanedAdd = cleanAndDeduplicate(combinedNew, combinedOld, combinedStale);
      return { ...state, newLeads: cleanedAdd.newLeads, oldLeads: cleanedAdd.oldLeads, staleLeads: cleanedAdd.staleLeads };
    case 'UPDATE_LEAD': {
      const updateKey = action.payload.page === 'new' ? 'newLeads' : action.payload.page === 'old' ? 'oldLeads' : 'staleLeads';
      return {
        ...state,
        [updateKey]: (state[updateKey as keyof AppState] as Lead[]).map(l =>
          l.id === action.payload.id ? action.payload : l
        )
      };
    }
    case 'REMOVE_LEAD': {
      const removeKey = action.payload.page === 'new' ? 'newLeads' : action.payload.page === 'old' ? 'oldLeads' : 'staleLeads';
      return {
        ...state,
        [removeKey]: (state[removeKey as keyof AppState] as Lead[]).filter(l => l.id !== action.payload.id)
      };
    }
    case 'SET_LEADS': {
      const setKey = action.payload.page === 'new' ? 'newLeads' : action.payload.page === 'old' ? 'oldLeads' : 'staleLeads';
      return { ...state, [setKey]: action.payload.leads };
    }
    case 'MOVE_TO_STALE': {
      const { id, sourcePage, updates } = action.payload;
      const sourceKey = sourcePage === 'new' ? 'newLeads' : 'oldLeads';
      const found = (state[sourceKey] as Lead[]).find(l => l.id === id);
      if (!found) return state;
      // Merge in whatever this sync run just resolved (freshest status/threadId/lastContactDate/
      // syncedOnce) before recording it as the "original" state and archiving it, so the Stale
      // Leads drawer reflects the final resolved status rather than stale pre-sync data.
      const lead = { ...found, ...(updates || {}) };
      const staleLead: Lead = {
        ...lead,
        page: 'stale',
        status: 'new',
        customData: {
          ...lead.customData,
          '_movedFromPage': sourcePage,
          '_originalStatus': lead.status,
          '_movedAt': new Date().toISOString(),
        },
      };
      return {
        ...state,
        [sourceKey]: (state[sourceKey] as Lead[]).filter(l => l.id !== id),
        staleLeads: [...state.staleLeads, staleLead],
      };
    }
    case 'ADD_TEMPLATE':
      return { ...state, templates: [...state.templates, action.payload] };
    case 'UPDATE_TEMPLATE':
      return {
        ...state,
        templates: state.templates.map(t => t.id === action.payload.id ? action.payload : t)
      };
    case 'REMOVE_TEMPLATE':
      return { ...state, templates: state.templates.filter(t => t.id !== action.payload) };
    case 'SET_COLUMNS':
      return { ...state, columns: action.payload };
    case 'UPDATE_SETTINGS': {
      const newSettings = { ...state.settings, ...action.payload };
      // Auto-generate templates when follow-ups are added
      if (newSettings.followUps && newSettings.followUps.length !== (state.settings.followUps?.length || 0)) {
        const existingTypes = new Set(state.templates.map(t => t.type));
        const newTemplates = [...state.templates];
        const followUpCount = newSettings.followUps.length;

        for (const leadType of ['new', 'old'] as const) {
          for (let i = 1; i <= followUpCount; i++) {
            const fuType = `fu${i}`;
            if (!existingTypes.has(fuType) || !state.templates.some(t => t.type === fuType && t.leadType === leadType)) {
              const label = leadType === 'new' ? 'New Leads' : 'Old Leads';
              const existingNames = state.templates.filter(t => t.type === fuType && t.leadType === leadType);
              if (existingNames.length === 0) {
                const messages = [
                  'Hey {{name}},\n\nJust bumping this up in case you missed it.\n\nWould love to hear your thoughts.\n\nBest,\nMe',
                  'Hey {{name}},\n\nJust checking in again on my last message.\n\nLet me know if you\'d be open to catching up.\n\nBest,\nMe',
                  'Hey {{name}},\n\nFollowing up once more — would be great to hear back from you.\n\nBest,\nMe',
                ];
                newTemplates.push({
                  id: crypto.randomUUID(),
                  name: `${label} - FU${i}`,
                  type: fuType,
                  leadType,
                  subject: '',
                  body: messages[i - 1] || `Hey {{name}},\n\nFollow-up #${i} — just checking in.\n\nBest,\nMe`,
                });
              }
            }
          }
        }
        return { ...state, settings: newSettings, templates: newTemplates };
      }
      return { ...state, settings: newSettings };
    }
    // ─── MoF Reducer Cases ──────────────────────────────────
    case 'MOF_UPDATE_LEAD_CONFIG': {
      const { leadId, config } = action.payload;
      return {
        ...state,
        mof: {
          ...state.mof,
          leadConfigs: { ...state.mof.leadConfigs, [leadId]: config },
        }
      };
    }
    case 'MOF_SET_PHASE': {
      const { leadId, phase } = action.payload;
      return {
        ...state,
        mof: {
          ...state.mof,
          leadPhases: { ...state.mof.leadPhases, [leadId]: phase },
        }
      };
    }
    case 'MOF_ADD_FOLLOW_UP_RECORD': {
      const { leadId, record } = action.payload;
      const existing = state.mof.followUpHistory[leadId] || [];
      return {
        ...state,
        mof: {
          ...state.mof,
          followUpHistory: { ...state.mof.followUpHistory, [leadId]: [...existing, record] },
        }
      };
    }
    case 'MOF_ADD_INDIVIDUAL_LEAD': {
      return {
        ...state,
        mof: {
          ...state.mof,
          individualLeads: [...state.mof.individualLeads, action.payload],
        }
      };
    }
    case 'MOF_UPDATE_INDIVIDUAL_LEAD': {
      return {
        ...state,
        mof: {
          ...state.mof,
          individualLeads: state.mof.individualLeads.map(l => l.id === action.payload.id ? action.payload : l),
        }
      };
    }
    case 'MOF_REMOVE_INDIVIDUAL_LEAD': {
      return {
        ...state,
        mof: {
          ...state.mof,
          individualLeads: state.mof.individualLeads.filter(l => l.id !== action.payload),
        }
      };
    }
    case 'MOF_PROMOTE_INDIVIDUAL_LEAD': {
      const lead = state.mof.individualLeads.find(l => l.id === action.payload);
      if (!lead) return state;
      const newLead: Lead = {
        id: lead.id,
        email: lead.email,
        name: lead.name,
        page: 'new',
        status: 'new',
        customData: {
          ...(lead.channelId ? { channelId: lead.channelId } : {}),
          ...(lead.channelName ? { channelName: lead.channelName } : {}),
        },
        threadId: lead.threadId,
        sentFromAccount: lead.sentFromAccount,
        createdAt: lead.createdAt,
        syncedOnce: true,
      };
      return {
        ...state,
        newLeads: [...state.newLeads, newLead],
        mof: {
          ...state.mof,
          individualLeads: state.mof.individualLeads.map(l => l.id === action.payload ? { ...l, promotedToMainApp: true } : l),
        }
      };
    }
    case 'MOF_SET_THREAD_OVERRIDE': {
      const { leadId, threadId } = action.payload;
      const existingCfg = state.mof.leadConfigs[leadId];
      const baseCfg = existingCfg || {
        defaultPersonalizedSubject: '', defaultPersonalizedBody: '',
        phase1Touches: [], phase2Touches: [], phase3Touches: [],
      };
      return {
        ...state,
        mof: {
          ...state.mof,
          leadConfigs: {
            ...state.mof.leadConfigs,
            [leadId]: { ...baseCfg, activeThreadOverride: threadId },
          }
        }
      };
    }
    case 'MOF_SET_CHANNEL_DATA': {
      const { leadId, data } = action.payload;
      return {
        ...state,
        mof: {
          ...state.mof,
          leadChannelData: { ...state.mof.leadChannelData, [leadId]: data },
        }
      };
    }
    // ─── Goal Tracker Reducer Cases ─────────────────────────
    case 'GOAL_SET_CONFIG': {
      const { taskName, totalDays, startDate } = action.payload;
      return {
        ...state,
        goals: { ...state.goals, taskName, totalDays, startDate },
      };
    }
    case 'GOAL_TOGGLE_DAY': {
      const { date } = action.payload;
      const current = !!state.goals.checkIns[date];
      return {
        ...state,
        goals: {
          ...state.goals,
          checkIns: { ...state.goals.checkIns, [date]: !current },
        },
      };
    }
    case 'GOAL_RESET': {
      return {
        ...state,
        goals: { ...defaultGoalsState, startDate: localDateStr() },
      };
    }
    default:
      return state;
  }
}

// -------------------------------------------------------------------
// Context types — now includes `loaded` so pages know when data is ready
// -------------------------------------------------------------------
interface StoreContextType {
  state: AppState;
  dispatch: React.Dispatch<Action>;
  loaded: boolean;
}

const StoreContext = createContext<StoreContextType | null>(null);

/**
 * Migrate old localStorage data to the new structure.
 * This ensures backward compatibility for existing users.
 */
function migrateLegacyData(parsed: any): any {
  if (parsed.templates) {
    parsed.templates = parsed.templates.map((t: any) => ({
      leadType: t.leadType || 'new',
      ...t
    }));
  }

  // Migrate old settings (fu1DelayDays/fu2DelayDays) to new followUps array
  if (parsed.settings) {
    if (parsed.settings.followUps === undefined && parsed.settings.fu1DelayDays !== undefined) {
      parsed.settings.followUps = [
        { delayDays: parsed.settings.fu1DelayDays || 4 },
        { delayDays: parsed.settings.fu2DelayDays || 10 },
      ];
      delete parsed.settings.fu1DelayDays;
      delete parsed.settings.fu2DelayDays;
    }
  }

  // Migrate legacy leads (created before the `syncedOnce` flag existed) — assume they've
  // already been through the sync pipeline at least once, since that's true for every lead
  // that predates this field. Leads added from now on default to `syncedOnce: false` (see
  // the ADD_LEADS reducer case below) and only flip to `true` once a sync actually processes them.
  for (const key of ['newLeads', 'oldLeads', 'staleLeads'] as const) {
    if (Array.isArray(parsed[key])) {
      parsed[key] = parsed[key].map((l: any) => (
        l.syncedOnce === undefined ? { ...l, syncedOnce: true } : l
      ));
    }
  }

  return parsed;
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  // ─── Synchronously load from localStorage FIRST (never lose user data) ───
  const [state, dispatch] = useReducer(reducer, defaultState, (initial) => {
    try {
      const saved = localStorage.getItem('coldEmailTracker');
      if (saved) {
        const parsed = JSON.parse(saved);
        const migrated = migrateLegacyData(parsed);
        // Merge with defaults so new fields are never missing
        const merged = {
          ...initial,
          ...migrated,
          templates: migrated.templates || initial.templates,
          columns: migrated.columns || initial.columns,
          settings: { ...initial.settings, ...migrated.settings },
          accounts: migrated.accounts || [],
          newLeads: migrated.newLeads || [],
          oldLeads: migrated.oldLeads || [],
          staleLeads: migrated.staleLeads || [],
          mof: { ...initial.mof, ...migrated.mof },
          goals: { ...initial.goals, ...migrated.goals },
        };
        const cleaned = cleanAndDeduplicate(merged.newLeads, merged.oldLeads, merged.staleLeads);
        merged.newLeads = cleaned.newLeads;
        merged.oldLeads = cleaned.oldLeads;
        merged.staleLeads = cleaned.staleLeads;
        return merged;
      }
    } catch (e) {
      console.error('[Store] Failed to parse localStorage state:', e);
    }
    return initial;
  });

  // Start unloaded — will set to true after server sync (or fallback)
  const [loaded, setLoaded] = useState(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ─── Sync with server first, THEN render ───
  // NOTE: In React 18+ Strict Mode (dev), this effect runs twice.
  // The `cancelled` flag ensures the first invocation's results are discarded.
  // Both invocations call setLoaded(true) when done, which is idempotent.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    let cancelled = false;

    async function syncWithServer() {
      try {
        const res = await fetch(`${API_BASE}/api/state`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok || cancelled) {
          if (!cancelled) setLoaded(true);
          return;
        }
        const serverData = await res.json();
        // After awaiting JSON parse, check cancellation again
        if (cancelled) {
          setLoaded(true);
          return;
        }

        // Count what the server has
        const serverLeads = (serverData.newLeads?.length || 0) + (serverData.oldLeads?.length || 0);
        const serverHasAccounts = (serverData.accounts?.length || 0) > 0;
        const localLeads = state.newLeads.length + state.oldLeads.length;
        const localHasAccounts = state.accounts.length > 0;

        const serverHasData = serverLeads > 0 || serverHasAccounts;
        const localHasData = localLeads > 0 || localHasAccounts;

        if (serverHasData && localHasData) {
          // The server file is the persistent source of truth (that's the whole point of
          // having it — see server/db.js). Comparing raw lead COUNTS to decide which side
          // "wins" is wrong: background workflows (e.g. AI reasoning) enrich existing leads'
          // customData (like `reason`) without changing how many leads there are, so a stale
          // browser-cached snapshot can easily have an equal-or-greater count while missing
          // that enrichment. Trust the server for every lead it already knows about, and only
          // fold in leads that exist ONLY in the local cache (e.g. added while offline).
          const migrated = migrateLegacyData(serverData);
          const serverAll: Lead[] = [...(migrated.newLeads || []), ...(migrated.oldLeads || []), ...(migrated.staleLeads || [])];
          const serverIds = new Set(serverAll.map(l => l.id));
          const serverEmails = new Set(serverAll.filter(l => l.email).map(l => l.email.toLowerCase()));
          const localOnly = (leads: Lead[]) => (leads || []).filter(
            l => !serverIds.has(l.id) && !(l.email && serverEmails.has(l.email.toLowerCase()))
          );
          const extraNew = localOnly(state.newLeads);
          const extraOld = localOnly(state.oldLeads);
          const extraStale = localOnly(state.staleLeads);
          const extraCount = extraNew.length + extraOld.length + extraStale.length;

          const merged = {
            ...migrated,
            newLeads: [...(migrated.newLeads || []), ...extraNew],
            oldLeads: [...(migrated.oldLeads || []), ...extraOld],
            staleLeads: [...(migrated.staleLeads || []), ...extraStale],
          };

          dispatch({ type: 'LOAD_STATE', payload: merged });
          localStorage.setItem('coldEmailTracker', JSON.stringify(merged));

          if (extraCount > 0) {
            // Push the merged state so the server picks up the local-only leads too.
            await fetch(`${API_BASE}/api/state`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(merged),
              signal: AbortSignal.timeout(5000),
            });
          }
        } else if (serverHasData) {
          // Only server has data
          const migrated = migrateLegacyData(serverData);
          dispatch({ type: 'LOAD_STATE', payload: migrated });
          localStorage.setItem('coldEmailTracker', JSON.stringify(migrated));
        } else if (localHasData) {
          // Only local has data — push to server
          await fetch(`${API_BASE}/api/state`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(state),
            signal: AbortSignal.timeout(5000),
          });
        }
      } catch (err) {
        // Server unreachable — use localStorage data (already loaded)
        console.warn('[Store] Server sync failed, using localStorage:', err);
      }
      if (!cancelled) setLoaded(true);
    }

    syncWithServer();
    return () => { cancelled = true; };
  }, []); // Only run once on mount

  // -------------------------------------------------------------------
  // SYNC THEME: Apply the current theme to <html> element
  // -------------------------------------------------------------------
  useEffect(() => {
    const theme = state.settings.theme || 'light';
    document.documentElement.setAttribute('data-theme', theme);
  }, [state.settings.theme]);

  // -------------------------------------------------------------------
  // ON STATE CHANGE: Save to server API + localStorage backup
  // -------------------------------------------------------------------
  useEffect(() => {
    // Skip saving until we've loaded the initial state
    if (!loaded) return;

    // Debounce saves (300ms) so rapid changes don't flood the server
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(async () => {
      // Always save to localStorage as a reliable backup
      try {
        localStorage.setItem('coldEmailTracker', JSON.stringify(state));
      } catch (_) {}

      // Save to server (fire-and-forget — don't block the UI)
      try {
        const res = await fetch(`${API_BASE}/api/state`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(state),
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) {
          console.warn('[Store] Server save returned', res.status);
        }
      } catch (err) {
        // Silent fail — localStorage backup ensures no data loss
        console.warn('[Store] Server save failed (data is safe in localStorage):', err);
      }
    }, 300);

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [state, loaded]);

  return (
    <StoreContext.Provider value={{ state, dispatch, loaded }}>
      {children}
    </StoreContext.Provider>
  );
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be inside StoreProvider');
  return ctx;
}