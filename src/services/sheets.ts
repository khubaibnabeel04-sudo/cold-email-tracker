const API_BASE = 'http://localhost:3006';

export interface ReasonedLead {
  rowIndex: number;
  email: string;
  name: string;
  page: 'new' | 'old';
  status: string;
  customData: Record<string, string>;
  createdAt: string;
  id?: string;
}

export interface SheetSummary {
  [key: string]: {
    name: string;
    count: number;
    error?: string;
  };
}

export interface AcceptedItem {
  rowIndex: number;
  data: string[];
  headers: string[];
}

/**
 * Get summary of all sheets.
 */
export async function getSheetSummary(): Promise<SheetSummary> {
  const res = await fetch(`${API_BASE}/api/sheets/summary`);
  if (!res.ok) throw new Error('Failed to get sheet summary');
  return res.json();
}

/**
 * Get accepted leads from Needs Email sheet.
 */
export async function getAcceptedNeedsEmail(): Promise<{ headers: string[]; rows: AcceptedItem[]; totalRows: number }> {
  const res = await fetch(`${API_BASE}/api/sheets/needs-email/accepted`);
  if (!res.ok) throw new Error('Failed to get accepted leads');
  return res.json();
}

/**
 * Move accepted Needs Email leads to new_leads_reason sheet.
 */
export async function moveAcceptedToReasoning(): Promise<{ moved: number }> {
  const res = await fetch(`${API_BASE}/api/sheets/move-to-reasoning`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error('Failed to move accepted to reasoning');
  return res.json();
}

/**
 * Move N rows from No Reply to old_leads_reason sheet.
 */
export async function moveNoReplyToReasoning(count: number = 50): Promise<{ moved: number }> {
  const res = await fetch(`${API_BASE}/api/sheets/move-from-no-reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count }),
  });
  if (!res.ok) throw new Error('Failed to move from No Reply');
  return res.json();
}

/**
 * Get reasoned new leads that are ready to transfer.
 */
export async function getReasonedNewLeads(): Promise<{ headers: string[]; rows: AcceptedItem[]; totalRows: number; pendingRows: number }> {
  const res = await fetch(`${API_BASE}/api/sheets/reasoned/new`);
  if (!res.ok) throw new Error('Failed to get reasoned new leads');
  return res.json();
}

/**
 * Get reasoned old leads that are ready to transfer.
 */
export async function getReasonedOldLeads(): Promise<{ headers: string[]; rows: AcceptedItem[]; totalRows: number; pendingRows: number }> {
  const res = await fetch(`${API_BASE}/api/sheets/reasoned/old`);
  if (!res.ok) throw new Error('Failed to get reasoned old leads');
  return res.json();
}

/**
 * Transfer reasoned leads to the app.
 * Returns the leads in app-ready format plus count.
 */
export async function transferToApp(
  leads: ReasonedLead[],
  page: 'new' | 'old'
): Promise<{ transferred: number; leads: ReasonedLead[]; failed?: { id?: string; email: string; error: string }[]; skippedDuplicates?: { id?: string; email: string }[] }> {
  const res = await fetch(`${API_BASE}/api/sheets/transfer-to-app`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leads, page }),
  });
  if (!res.ok) {
    const errData = await res.json();
    throw new Error(errData.error || 'Transfer failed');
  }
  return res.json();
}

/**
 * Trigger a manual refresh of Google Sheet data.
 */
export async function refreshSheets(): Promise<{ refreshed: boolean; summary: SheetSummary }> {
  const res = await fetch(`${API_BASE}/api/sheets/refresh`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error('Refresh failed');
  return res.json();
}

/**
 * Run the reasoning workflow on a reasoning sheet (new or old).
 * Returns logs and counts from the backend.
 */
export async function startReasoning(
  page: 'new' | 'old'
): Promise<{
  processed: number;
  updated: number;
  errors: number;
  transcripts: number;
  logs: string[];
}> {
  const res = await fetch(`${API_BASE}/api/sheets/start-reasoning`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page }),
  });
  if (!res.ok) {
    let errMsg = 'Reasoning failed';
    try {
      const errData = await res.json();
      errMsg = errData.error || errMsg;
    } catch {
      const text = await res.text().catch(() => '');
      errMsg = `Server returned ${res.status}: ${text.slice(0, 200)}`;
    }
    throw new Error(errMsg);
  }
  return res.json();
}
