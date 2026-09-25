/**
 * Persistent store for "top channels" discovered via the Ideas search page.
 * Lives in its own file, completely separate from the search-results list
 * (which gets wiped on every new search) and from the main app db.json.
 */

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'ideas-channels.json');

function readChannels() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      if (!raw || raw.trim().length === 0) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch (err) {
    console.error('[IdeasStore] Error reading channels file:', err.message);
  }
  return [];
}

function writeChannels(channels) {
  const tmpFile = DATA_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(channels, null, 2), 'utf-8');
  fs.renameSync(tmpFile, DATA_FILE);
}

// Merge newly-found channels into the persisted list. Existing channels get
// their stats/lastSeen refreshed and their query history appended; nothing
// is ever removed by this — only removeChannel/clearAll delete entries.
function upsertChannels(newChannels, query) {
  const existing = readChannels();
  const byId = new Map(existing.map(c => [c.channelId, c]));

  for (const nc of newChannels) {
    const prev = byId.get(nc.channelId);
    if (prev) {
      byId.set(nc.channelId, {
        ...prev,
        channelTitle: nc.channelTitle || prev.channelTitle,
        channelUrl: nc.channelUrl || prev.channelUrl,
        thumbnail: nc.thumbnail || prev.thumbnail,
        subscriberCount: nc.subscriberCount ?? prev.subscriberCount,
        lastSeenAt: new Date().toISOString(),
        queries: Array.from(new Set([...(prev.queries || []), query].filter(Boolean))),
        timesFound: (prev.timesFound || 1) + 1,
      });
    } else {
      byId.set(nc.channelId, {
        ...nc,
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        queries: query ? [query] : [],
        timesFound: 1,
      });
    }
  }

  const merged = Array.from(byId.values());
  writeChannels(merged);
  return merged;
}

function removeChannel(channelId) {
  const remaining = readChannels().filter(c => c.channelId !== channelId);
  writeChannels(remaining);
  return remaining;
}

function clearAll() {
  writeChannels([]);
  return [];
}

module.exports = { readChannels, upsertChannels, removeChannel, clearAll };
