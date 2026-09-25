const fs = require('fs');
const path = require('path');

const GROQ_MODEL = 'openai/gpt-oss-120b';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

let cachedKeys = null;
// Which key in cachedKeys is currently in use. Persists for the life of the
// server process, once a key's daily quota is exhausted there's no point
// going back to it until the next process restart / day boundary.
let currentKeyIndex = 0;

function getApiKeys() {
  if (cachedKeys) return cachedKeys;
  // GROQ_API_KEYS (comma-separated) takes priority; server/keys/groq-api-key.json is the fallback.
  if (process.env.GROQ_API_KEYS) {
    cachedKeys = process.env.GROQ_API_KEYS.split(',').map(k => k.trim()).filter(Boolean);
  } else {
    const keyPath = path.join(__dirname, 'keys', 'groq-api-key.json');
    const raw = fs.existsSync(keyPath) ? JSON.parse(fs.readFileSync(keyPath, 'utf8')) : {};
    cachedKeys = raw.apiKeys || (raw.apiKey ? [raw.apiKey] : []);
  }
  if (cachedKeys.length === 0) throw new Error('No Groq API key configured — set GROQ_API_KEYS in .env');
  return cachedKeys;
}

function isDailyLimitError(errText) {
  return /tokens per day \(TPD\)/i.test(errText) || /requests per day \(RPD\)/i.test(errText);
}

// Business context handed to the model on every call so it understands what's
// actually being sold and doesn't invent a generic pitch. Sourced directly from
// Khubaib's real outreach threads and his own description of the service.
const BUSINESS_CONTEXT = [
  'The business is "Channel Intelligence": Khubaib finds the specific structural reason a creator\'s best video',
  'outperformed, then shows the gap between that and their recent uploads. The free "mini report" leads with that',
  'observation: their single best-performing video with its real numbers, the gap versus recent uploads, and the',
  'structural reason behind it. There is a guarantee behind it: if the system doesn\'t find a high-probability idea',
  'within a month, the full service is free until it does, but that guarantee is a closing detail, not something',
  'to lead with.',
  '',
  'The paid engagement that follows is a weekly brief built on a minute-by-minute retention analysis of the',
  'creator\'s own videos (where viewers stay, where they click away, which specific words and phrasing hold them),',
  'which then feeds the idea, title, thumbnail and full script for each upcoming video. CTR (click-through rate)',
  'sometimes comes up as a concrete before-and-after result from past clients, real threads mention things like',
  '"moved CTR from 5.6% to 7%", but that is a specific number from a specific case, never invent a CTR percentage',
  'for the current lead\'s own channel unless one is explicitly given to you. The data you\'re actually handed about',
  'THIS lead\'s videos is view counts and outlier status, describe their own channel using exactly those terms,',
  'views, an outlier hit, underperforming, never relabel a view gap as a "CTR drop".',
].join(' ');

// Per-angle instructions handed to the model. The client picks which angle
// applies (via src/utils/mofAngles.ts) so the same "don't repeat yourself"
// rotation logic lives in one place and is easy to reason about/test. Each one
// spells out roughly what the email should actually say, not just a mood, so
// the model has a concrete shape to write toward instead of guessing.
// The one soft closing line that's allowed to invite a reply. Used sometimes,
// not glued onto every single email, see the hard rules below.
const INTEREST_CLOSER = '"Let me know if you\'d be interested."';

// The offer that closes most angles: never state it with no reason attached.
// The reason has to come from something actually TRUE about the specific numbers
// in this email, not a stock line bolted on regardless of what those numbers say.
const OFFER_LINE = [
  "Close with an offer to share a few pointers, for free, and word it so the reason is built into the sentence itself,",
  "for example \"Happy to share a few pointers so your next video doesn't run into the same thing\" if the numbers show a real drop,",
  "or \"Happy to share a few pointers on what would make that repeatable\" if the numbers show something that's working but isn't consistent.",
  "Lead with \"Happy to share\" rather than \"I can share\", it reads warmer and less transactional.",
  "Never write a bare offer with no reason attached like \"let me know if you want a few pointers\", that reads like a stranger asking a random favor.",
  "Do not say what the pointers actually are, and do not describe or list anything else (no mention of the weekly brief, script, thumbnail, or retention breakdown), that turns it into a pitch.",
].join(' ');

// Every angle that compares two numbers shares this instruction: work out what's
// actually true before deciding what to say. Forcing a "decline" story onto numbers
// that don't show one is exactly what made earlier drafts read as nonsense, e.g.
// calling 24,062 views versus 25,000 views a worrying drop when they're basically
// the same number. The conclusion has to follow from the actual numbers given.
const COMPARE_HONESTLY = [
  "Before writing, actually work out which number is bigger and which is smaller, and by how much. Only draw a conclusion the numbers actually support.",
  "If the more recent video is clearly and substantially lower than the reference video, that's a real drop, and it's fair to say something plain like this could keep happening if nothing changes.",
  "If the two numbers are close, similar, or the more recent one is doing fine or better, do NOT invent a decline, there isn't one. Instead the honest observation is that they clearly know how to make a video hit big, and the interesting open question is why it doesn't happen on every upload.",
  "Never use hedging language like \"similar or lower\" to cover for numbers that don't actually support a decline claim, that reads as meaningless. Say only what's true.",
].join(' ');

const ANGLE_INSTRUCTIONS = {
  bump: [
    "This is a quick, early nudge, the mini report went out recently and there's been no reply yet.",
    "Roughly what to say: nothing new, just surface the existing conversation again so it doesn't get lost.",
    "One or two sentences total. No pitch, no recap of what the report said, no new observation, almost no content.",
    "Something like the energy of \"didn't want this to get buried, let me know if you got a chance to look\", in your own words.",
  ].join(' '),
  mini_report_recap: [
    "Roughly what to say: state ONE specific, concrete comparison the mini report already made, using the exact real video or episode titles in quotes and their exact view numbers, for example \"video A\" got X views while \"video B\" got Y.",
    "The mini report exists specifically because that comparison showed a real, substantial gap, so here it's safe to treat it as a genuine pattern worth a plain, calm line like this could keep happening if nothing changes.",
    "Do not explain why one did better, do not name the reason or the technique behind it, that's exactly what stays unsaid, the unanswered question is what makes them want to reply.",
    "Do not offer to send the report or ask if they want it, they already have it.",
    OFFER_LINE,
  ].join(' '),
  new_video: [
    "Roughly what to say: name their new video by its exact real title in quotes, with its real view count. If an earlier reference video and its real view count are given (from the thread or report), name that too for a side by side comparison.",
    COMPARE_HONESTLY,
    OFFER_LINE,
  ].join(' '),
  decline_help: [
    "Roughly what to say: name a specific, real, recent video or episode (exact title, exact view number) next to an older one, the same side by side comparison, using only the data you're given (never call it a CTR trend unless an actual CTR number was given to you).",
    "This angle is only used when the data actually shows a real decline, so state it as a plain fact, not a warning, not generic concern, not a pitch, and it's fair to add a calm line that this could keep happening if nothing changes. Do not explain the reason behind the difference.",
    OFFER_LINE,
  ].join(' '),
  value_tip: [
    "Roughly what to say: point out one specific, real detail about their channel or a real recent video (its exact title and a real number) that's worth a second look.",
    "State only the observation, not the explanation. Do not say what's wrong with it or what to change, that's exactly the part that stays unsaid. Do not invent a decline or a problem that the number you were given doesn't actually show.",
    OFFER_LINE,
  ].join(' '),
  case_study: [
    "Roughly what to say: mention this real result, worded in your own way: a past client Khubaib worked with moved their click-through rate from 5.6% to 7% within a few weeks, by changing one specific thing about how their videos opened. Use those exact numbers, they're real, don't change them.",
    "Frame it as a similar kind of pattern to what's going on with this lead's channel, not a guarantee it'll happen for them specifically, something like \"a similar kind of thing happened with someone else I worked with\" rather than \"this will happen to you too\".",
    "Do not say what the one specific thing was that the other creator changed, that's exactly what stays unsaid.",
    OFFER_LINE,
  ].join(' '),
  guarantee: [
    "Roughly what to say: bring up the guarantee behind this, plainly, as a fact about how the work is structured: if the system doesn't find a genuinely promising video idea for their channel within a month, the work is free until it does.",
    "Say it like you're just explaining how this works, not selling it or making a big deal of it.",
    "This removes the risk of saying yes, so the close here isn't the usual \"happy to share a few pointers\" line, it's simpler: since there's no real downside, ask a plain, low pressure question about whether they'd want to give it a shot. The guarantee itself is the offer, don't also tack on a pointers offer.",
  ].join(' '),
  stepping_back: [
    "Roughly what to say: let them know, plainly and without guilt-tripping, that you're wrapping up work on their channel for now and moving on to other creators. It's simply true that time is limited, said as a fact, not a threat.",
    "End with a low key door left open, something like being happy to pick it back up if they ever want to look at it, genuinely no pressure either way, this is a real option they can take or leave.",
    "No numbers, no comparison, no offer of pointers here, this angle is entirely about the relationship, not the data.",
  ].join(' '),
  time_elapsed: [
    "Roughly what to say: nothing about videos, numbers, or the channel at all. Just plainly note how much time has passed in total since the mini report first went out.",
    "Use the touch's day number for this, the one stated as \"day X of the phase since the mini report was sent\", converted into a natural unit, day 240 is about 8 months, day 90 is about 3 months. Do NOT use the days-since-last-message number for this, that one is much smaller and only covers the gap since the previous email, not the whole relationship, using it here would understate how long this has actually been going on.",
    "Said as a simple, honest fact, not a guilt trip. Close with a simple, low pressure question about whether it's still something they'd want to look at. No offer of pointers here, there's no new observation to attach one to.",
  ].join(' '),
  check_in: [
    "Roughly what to say: nothing new, just a simple, warm, low key check in, staying on their radar.",
    "No pitch, no recap of the report, no new data point. Just ask, casually, if they've had a chance to look at things.",
  ].join(' '),
};

// Subject lines only get generated when a touch starts a brand new thread. Left
// unguided, the model defaults to interchangeable filler like "Quick thought" or
// "Quick update" for every angle, which defeats the point of a fresh thread, it
// should hint at what's actually different about THIS email without giving away
// the observation itself. One line per angle, in the same spirit as the body
// instructions above: what the subject should hint at, not a subject to copy.
const SUBJECT_HINTS = {
  bump: 'Casual and minimal, barely a subject at all, like "quick one" or their name.',
  mini_report_recap: "Hint at their channel or a video without stating the number, something like referencing 'your numbers' or a video title, not a generic phrase.",
  new_video: "Reference their new video (by feel, not necessarily the full title) so it's clear this is about something specific they just posted.",
  decline_help: "Hint that something changed or is worth a look, without saying what or using alarming words like 'warning' or 'declining'.",
  value_tip: 'Hint at a specific small thing worth noticing, not a generic "quick note".',
  case_study: "Hint at a result or a story, something like referencing another creator or a number, without giving the actual number away.",
  guarantee: "Hint at how the offer or the risk works, something like referencing there being no downside, without explaining the guarantee itself.",
  stepping_back: 'Hint at wrapping up or closing the loop, honestly, not dramatic.',
  time_elapsed: 'Hint at time passing, something like referencing "it\'s been a while" in your own words, not a generic "checking in".',
  check_in: 'Simple and warm, can be as plain as "checking in" here, this angle has nothing to hint at.',
};

function buildSystemPrompt() {
  return [
    'You ghostwrite short cold-outreach follow-up emails for Khubaib, who reaches out to YouTube creators personally.',
    'The recipient was ALREADY sent a personalized "mini report" about their channel (it usually appears in the thread',
    'below, or is summarized in the notes you\'re given) and has not replied since. This report has already landed in',
    'their inbox. Never offer to send it, never ask if they want it, never say you\'ll send it "over" or "again", and',
    'never write as if it hasn\'t been delivered yet, that report is done and sitting there. You may reference what it',
    'said, or bring something new, but the act of sending it is already in the past.',
    '',
    'Business context (use only what\'s relevant to the current angle, never dump all of it into one email):',
    BUSINESS_CONTEXT,
    '',
    'The single most important thing: you are not selling anything in these emails, and you are not a free',
    'consultant either. When you notice something (a comparison, a trend, a detail), state the plain fact and',
    'stop there, never explain why it happened or what the fix would be. The unanswered question is what makes',
    'someone want to reply, answering it for free in the email removes their only reason to. Never itemize what',
    'they\'d get from working with Khubaib (the weekly brief, script, thumbnail, retention breakdown), that reads',
    'as a pitch and pushes people away. Selling closes people off, curiosity opens them up, always choose the',
    'sentence that creates curiosity over the one that explains an answer or an offer.',
    '',
    'Hard rules:',
    '- Use extremely simple, plain language. Short sentences. Everyday words a twelve year old would understand.',
    '  No metaphors, no clever phrasing, no words like "gap", "hit different", "compounding", nothing that makes',
    '  the reader stop and figure out what you mean. State facts and numbers directly, one idea per sentence.',
    '- When you reference a specific video or episode, always use its exact real title in quotes, exactly as given',
    '  to you. Never describe it vaguely as "your best video ever" or "your top video", name it.',
    '- Sound like Khubaib casually typing an email himself, not a marketer or a template. Contractions, plain',
    '  words, no jargon, no hype, no exclamation marks, no flattery that isn\'t backed by a specific detail.',
    '- NEVER use an em dash or en dash character anywhere in the output. Use a period, comma, or "and" instead.',
    '- Keep it brief: 2 to 5 short sentences for the body. No walls of text.',
    '- Do not always mention their "next video". Only do that when the given angle calls for it.',
    '- Never repeat the exact wording or structure of a previous email to this same person (previous emails are listed below if any).',
    '- No corporate phrases like "I wanted to reach out", "circling back", "just following up to see", "touching base", "I hope this email finds you well".',
    '- Only mention specific numbers or video titles that were actually given to you below. Never invent stats, view counts, or retention data that weren\'t provided. You are not given transcripts, don\'t refer to anything a video actually says.',
    `- The line ${INTEREST_CLOSER} is a good, low pressure way to end an email that closes with an offer, but do not use it in every single email, that would look scripted. Use it sometimes, and other times just leave the offer as its own sentence with no extra closing line, or use a different simple, low key closer like "no worries if not". Vary it.`,
    '- You\'re told how many days it\'s been since the last message to this person. If that gap is a lot longer than what the angle would normally expect (e.g. this was supposed to be a quick nudge but it\'s actually been a month or more of silence), it\'s natural to briefly acknowledge that in passing, the way a real busy person would (something honest and light, not a formal apology, one phrase is enough), instead of writing as if no time passed. If the gap is roughly normal for the angle, don\'t mention it at all.',
    '- Only include a subject line when told the email needs one (starting a new thread). Otherwise leave subject as an empty string, since it will be sent as a reply in the same thread.',
    '- Do not sign off with a formal block like "Best regards," followed by a name. If you sign off, use just "Khubaib" on its own line, or nothing at all.',
    '- Respond with ONLY a JSON object: {"subject": string, "body": string}. No other text.',
  ].join('\n');
}

function stripEmDashes(text) {
  if (!text) return text;
  return text
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/,\s*,/g, ',')
    .replace(/,\s*\./g, '.')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function buildUserPrompt(ctx) {
  const {
    leadName, channelName, angle, needsSubject,
    phase, touchNumber, day, daysSinceLastContact,
    threadContext, videos, previousAngleSummaries,
  } = ctx;

  const lines = [];
  lines.push(`Recipient: ${leadName || 'the creator'}${channelName ? ` (channel: ${channelName})` : ''}`);
  lines.push(`This is follow-up touch #${touchNumber}, day ${day} of the "${phase}" phase since the mini report was sent.`);
  if (typeof daysSinceLastContact === 'number' && Number.isFinite(daysSinceLastContact)) {
    lines.push(`It has been ${daysSinceLastContact} day${daysSinceLastContact === 1 ? '' : 's'} since the last message (the mini report, or the previous follow-up, whichever was more recent) went to this person.`);
  }
  lines.push(`Angle to use for this email: ${angle}`);
  lines.push(ANGLE_INSTRUCTIONS[angle] || ANGLE_INSTRUCTIONS.check_in);
  lines.push(needsSubject
    ? `This email starts a brand new thread, so include a short, casual, non-salesy subject line. ${SUBJECT_HINTS[angle] || SUBJECT_HINTS.check_in} Avoid generic filler like "Quick thought", "Quick update", or "Quick check in", make it specific to this email, not interchangeable with any other angle's subject.`
    : 'This email replies inside an existing thread, so subject must be "".');

  if (previousAngleSummaries && previousAngleSummaries.length) {
    lines.push('\nPrevious follow-ups already sent to this person (do not repeat these angles or phrasing):');
    previousAngleSummaries.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  }

  if (threadContext) {
    lines.push('\nEmail thread so far (most recent last, may include the mini report content):');
    lines.push(threadContext.slice(0, 6000));
  }

  if (videos && videos.length) {
    lines.push('\nRecent video data for this channel (use only if the angle calls for it):');
    videos.slice(0, 3).forEach((v, i) => {
      const outlierNote = v.outlier === 'high' ? ', an outlier hit above normal' : v.outlier === 'low' ? ', underperforming compared to normal' : '';
      lines.push(`Video ${i + 1}: "${v.title}", ${v.daysSinceUpload} days old, ${v.views} views${outlierNote}.`);
    });
  }

  lines.push('\nWrite the email now as the JSON object described in the system prompt.');
  return lines.join('\n');
}

// This Groq account's on-demand tier caps openai/gpt-oss-120b at a fairly low
// tokens-per-minute limit, and reasoning_effort:high burns through it faster than
// a plain completion would. Run Auto and the Today page's draft creation call this
// for many leads back to back, so a transient 429 is expected under real usage,
// not a bug — retry with backoff (using the server's own suggested wait when it
// gives one) instead of letting one rate-limited lead fail the whole batch.
// This account's 8000 TPM cap on openai/gpt-oss-120b is tight enough that
// processing several overdue leads in one Run Auto pass will routinely hit it.
// Groq's error tells us exactly how long to wait, so it's safe to retry more
// than a couple of times, each wait is short and the eventual success is certain
// once the token window clears.
const MAX_RETRIES = 6;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseRetryDelayMs(errText) {
  const m = errText.match(/try again in ([\d.]+)s/i);
  return m ? Math.ceil(parseFloat(m[1]) * 1000) : null;
}

async function callGroq(body, attempt, triedKeyIndexes) {
  const keys = getApiKeys();
  const apiKey = keys[currentKeyIndex];

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');

    // A key's daily quota, not its per-minute one, is exhausted, and there's
    // another key that hasn't been tried yet this call: switch to it and keep
    // going, this doesn't count against the per-minute retry budget below.
    if (res.status === 429 && isDailyLimitError(errText) && triedKeyIndexes.size < keys.length) {
      triedKeyIndexes.add(currentKeyIndex);
      const nextIndex = (currentKeyIndex + 1) % keys.length;
      if (!triedKeyIndexes.has(nextIndex)) {
        console.log(`[AI Followup] Key ${currentKeyIndex + 1}/${keys.length} hit its daily limit, switching to key ${nextIndex + 1}/${keys.length}.`);
        currentKeyIndex = nextIndex;
        return callGroq(body, attempt, triedKeyIndexes);
      }
    }

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const waitMs = parseRetryDelayMs(errText) ?? 1000 * Math.pow(2, attempt);
      await sleep(waitMs + 250);
      return callGroq(body, attempt + 1, triedKeyIndexes);
    }

    // json_validate_failed means the model ran out of room mid-reasoning and never
    // produced valid JSON, a sampling fluke more than a real error, worth one retry.
    if (res.status === 400 && errText.includes('json_validate_failed') && attempt < MAX_RETRIES) {
      return callGroq(body, attempt + 1, triedKeyIndexes);
    }

    throw new Error(`Groq API error ${res.status}: ${errText.slice(0, 500)}`);
  }

  return res.json();
}

async function generateFollowUpEmail(ctx) {
  const body = {
    model: GROQ_MODEL,
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: buildUserPrompt(ctx) },
    ],
    temperature: 0.85,
    // Reasoning effort lets gpt-oss-120b actually think through the angle and the
    // hard rules before writing, empirically it produced tighter, more natural
    // copy than the default (e.g. picking up the "already sent" and no-em-dash
    // rules more reliably) at the cost of more tokens per call and a bit of latency.
    reasoning_effort: 'high',
    // Without an explicit ceiling, a long thread plus high reasoning effort can burn
    // the whole completion on reasoning tokens and never emit the final JSON, Groq
    // then rejects the empty output as invalid JSON. Give it enough room for both.
    max_completion_tokens: 2048,
    response_format: { type: 'json_object' },
  };

  const data = await callGroq(body, 0, new Set());
  const raw = data?.choices?.[0]?.message?.content || '{}';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Groq returned non-JSON content: ' + raw.slice(0, 300));
  }

  return {
    subject: stripEmDashes((parsed.subject || '').trim()),
    body: stripEmDashes((parsed.body || '').trim()),
  };
}

module.exports = { generateFollowUpEmail, ANGLE_INSTRUCTIONS };
