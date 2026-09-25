/**
 * Pure "which angle should this touch use" rotation logic for AI-generated MOF
 * follow-ups. Kept separate from the AI call itself so the no-repeat rules are easy
 * to read/test on their own: first touch is always a simple bump, later touches
 * rotate through the remaining angles, never repeating the immediately previous
 * one, preferring an angle never used before for this lead, and only reaching for
 * "new video" or "channel declining" when there's actually fresh data to back it up.
 */

export type MofAngle =
  | 'bump' | 'mini_report_recap' | 'new_video' | 'decline_help' | 'value_tip' | 'check_in'
  | 'case_study' | 'guarantee' | 'stepping_back' | 'time_elapsed';

const ROTATION_ORDER: MofAngle[] = [
  'mini_report_recap', 'new_video', 'decline_help', 'value_tip',
  'case_study', 'guarantee', 'time_elapsed', 'stepping_back', 'check_in',
];

/** Angles that only make sense said once per lead — repeating "I'm moving on to
 *  other channels" or re-explaining the guarantee stops meaning anything the
 *  second time. Everything else can come back around in the rotation. */
const ONCE_PER_LEAD: MofAngle[] = ['stepping_back', 'guarantee'];

/** A first touch only gets the plain "bump" if the mini report went out this recently.
 *  Past that, silence has already made a content-free nudge feel out of place — the
 *  first touch should lead with something from the report or the lead's recent data. */
const BUMP_MAX_DAYS = 20;

export interface PickAngleParams {
  /** 1-indexed touch number across the lead's whole MOF history (not per-phase). */
  touchNumber: number;
  /** Angles used on this lead's previous touches, oldest first. */
  usedAngles: string[];
  /** Days since the mini report (or, on later touches, the previous follow-up) was sent. */
  daysSinceLastContact: number;
  /** Whether any channel/video data has been collected for this lead at all. */
  hasVideos: boolean;
  /** A video exists that hasn't been referenced by a previous "new_video" touch yet. */
  hasFreshVideo: boolean;
  /** The collected data shows a genuine downward trend (e.g. a recent "low" outlier). */
  hasDeclineSignal: boolean;
}

export function pickAngle(params: PickAngleParams): MofAngle {
  const { touchNumber, usedAngles, daysSinceLastContact, hasVideos, hasFreshVideo, hasDeclineSignal } = params;

  const isFirstTouch = touchNumber <= 1 || usedAngles.length === 0;
  if (isFirstTouch) {
    if (daysSinceLastContact < BUMP_MAX_DAYS) return 'bump';
    // Too much silence for a content-free nudge — lead with whatever's most likely to
    // land: a real decline in their numbers, a fresh video worth mentioning, or failing
    // that, the report itself, which they've already been given.
    if (hasDeclineSignal && hasVideos) return 'decline_help';
    if (hasFreshVideo) return 'new_video';
    return 'mini_report_recap';
  }

  const lastAngle = usedAngles[usedAngles.length - 1];

  const isEligible = (angle: MofAngle): boolean => {
    if (angle === lastAngle) return false; // never repeat back to back
    if (ONCE_PER_LEAD.includes(angle) && usedAngles.includes(angle)) return false;
    if (angle === 'new_video') return hasFreshVideo;
    if (angle === 'decline_help') return hasVideos && hasDeclineSignal;
    if (angle === 'value_tip') return hasVideos;
    return true;
  };

  let pool = ROTATION_ORDER.filter(isEligible);
  if (pool.length === 0) pool = ROTATION_ORDER.filter(a => a !== lastAngle);
  if (pool.length === 0) pool = ROTATION_ORDER;

  const neverUsed = pool.filter(a => !usedAngles.includes(a));
  if (neverUsed.length > 0) return neverUsed[0];

  // Every eligible angle has been used at least once (normal by month 4-5 of a
  // full year), so fall back to whichever eligible angle was used longest ago,
  // not just the first one in ROTATION_ORDER. Without this, once the "never
  // used" pool empties out, the picker collapses into ping-ponging between
  // just the first one or two angles in the list forever, since it always
  // preferred pool[0] and pool[0] is fixed by list order, not by how recently
  // each one was actually said to this lead.
  const lastUsedIndex = (angle: MofAngle) => {
    for (let i = usedAngles.length - 1; i >= 0; i--) {
      if (usedAngles[i] === angle) return i;
    }
    return -1;
  };
  return pool.reduce((oldest, candidate) => (lastUsedIndex(candidate) < lastUsedIndex(oldest) ? candidate : oldest));
}

/** A video counts as "fresh" for the new_video angle if it was published after the
 *  last time this lead actually got a new_video-angled touch (or if that angle has
 *  never been used on them yet and at least one video is on file). Only title and
 *  view count matter here, not transcripts, the AI generator doesn't use them. */
export function computeHasFreshVideo(
  videos: { publishedAt: string }[] | undefined,
  usedAngles: string[],
  lastNewVideoTouchAt: string | undefined,
): boolean {
  if (!videos || videos.length === 0) return false;
  if (!usedAngles.includes('new_video') || !lastNewVideoTouchAt) return true;
  const cutoff = new Date(lastNewVideoTouchAt).getTime();
  return videos.some(v => new Date(v.publishedAt).getTime() > cutoff);
}

export function computeHasDeclineSignal(videos: { outlier?: string; ratio?: number }[] | undefined): boolean {
  if (!videos || videos.length < 3) return false;
  const recent = videos.slice(0, 5);
  const lowCount = recent.filter(v => v.outlier === 'low' || (typeof v.ratio === 'number' && v.ratio < 0.7)).length;
  return lowCount >= 2;
}
