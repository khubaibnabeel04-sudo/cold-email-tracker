import { Lead, followUpSentStatus } from '../types';

export interface Fu2StaleCheckResult {
  /** True if this lead should be swept into the Stale Leads page. */
  shouldMoveToStale: boolean;
  /** Days since lastContactDate, if it was computed (null when the check didn't apply). */
  daysSince: number | null;
  /** The final configured follow-up "sent" status this check is comparing against (e.g. "fu2_sent"). */
  lastFuStatus: string;
}

/**
 * Decide whether a lead that just went through a sync/analysis pass should be swept into
 * the Stale Leads page.
 *
 * Conditions (all must hold):
 *  - The lead has already been through the sync pipeline at least once before this run
 *    (`lead.syncedOnce`) — so a lead's very first-ever sync can never immediately land it
 *    in Stale Leads.
 *  - After this sync, its status is the final configured follow-up "sent" stage (e.g.
 *    fu2_sent when there are 2 configured follow-ups) — i.e. the follow-up sequence has
 *    been fully exhausted and there's nothing left to send.
 *  - It isn't an active conversation (replied/draft are always excluded, same as the
 *    existing old-lead reset-to-new rule).
 *  - There's been no contact or reply activity (lastContactDate) for more than 60 days.
 */
export function checkFu2Stale(
  lead: Lead,
  updates: Partial<Lead>,
  followUpsCount: number
): Fu2StaleCheckResult {
  const lastFuStatus = followUpSentStatus(followUpsCount || 1);
  const resultStatus = updates.status || lead.status;
  const isActiveConversation = resultStatus === 'replied' || resultStatus === 'draft';

  if (
    lead.syncedOnce &&
    !isActiveConversation &&
    resultStatus === lastFuStatus &&
    updates.lastContactDate
  ) {
    const daysSince = (Date.now() - new Date(updates.lastContactDate).getTime()) / (1000 * 60 * 60 * 24);
    return { shouldMoveToStale: daysSince > 60, daysSince, lastFuStatus };
  }

  return { shouldMoveToStale: false, daysSince: null, lastFuStatus };
}
