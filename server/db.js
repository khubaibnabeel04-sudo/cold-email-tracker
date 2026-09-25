/**
 * Persistent JSON file database for the Lead Tracker.
 * Replaces browser localStorage with server-side storage.
 * Data survives browser clears, laptop reboots, and device changes.
 */

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data.json');

function getDefaultState() {
  return {
    accounts: [],
    newLeads: [],
    oldLeads: [],
    templates: [
      {
        id: '1',
        name: 'New Leads - Initial',
        type: 'initial',
        leadType: 'new',
        subject: 'Collaboration with {{channelName}}',
        body: 'Hey {{name}},\n\nLove your content on {{channelName}} — especially "{{videoTitle}}".\n\nI think we could collaborate...\n\nBest,\nMe'
      },
      {
        id: '2',
        name: 'New Leads - FU1',
        type: 'fu1',
        leadType: 'new',
        subject: '',
        body: 'Hey {{name}},\n\nJust bumping this up in case you missed it.\n\nWould love to hear your thoughts.\n\nBest,\nMe'
      },
      {
        id: '3',
        name: 'New Leads - FU2',
        type: 'fu2',
        leadType: 'new',
        subject: '',
        body: 'Hey {{name}},\n\nLast follow-up — totally understand if now isn\'t the right time.\n\nIf things change, feel free to reach out.\n\nBest,\nMe'
      },
      {
        id: '4',
        name: 'Old Leads - Initial',
        type: 'initial',
        leadType: 'old',
        subject: 'Reconnecting: Collaboration with {{channelName}}',
        body: 'Hey {{name}},\n\nIt\'s been a while since we last chatted regarding {{channelName}}.\n\nHope everything is going great with your recent video "{{videoTitle}}".\n\nWould love to sync up again...\n\nBest,\nMe'
      },
      {
        id: '5',
        name: 'Old Leads - FU1',
        type: 'fu1',
        leadType: 'old',
        subject: '',
        body: 'Hey {{name}},\n\nJust checking in again on my last message.\n\nLet me know if you\'d be open to catching up.\n\nBest,\nMe'
      },
      {
        id: '6',
        name: 'Old Leads - FU2',
        type: 'fu2',
        leadType: 'old',
        subject: '',
        body: 'Hey {{name}},\n\nLast try reconnecting — let me know if you\'re interested down the road!\n\nBest,\nMe'
      }
    ],
    columns: ['name', 'email', 'channelName', 'videoTitle'],
    settings: {
      defaultDailyLimit: 50,
      fu1DelayDays: 4,
      fu2DelayDays: 10,
      dateCutoff: '2025-11-01',
      theme: 'light'
    }
  };
}

function read() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      if (!raw || raw.trim().length === 0) return null;
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error('[DB] Error reading data file:', err.message);
    try {
      const backupPath = DATA_FILE.replace('.json', `.corrupted.${Date.now()}.json`);
      fs.renameSync(DATA_FILE, backupPath);
      console.error('[DB] Corrupted data backed up to ' + backupPath);
    } catch (_) {}
  }
  return null;
}

function write(data) {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmpFile = DATA_FILE + '.tmp';
    const json = JSON.stringify(data, null, 2);
    fs.writeFileSync(tmpFile, json, 'utf-8');
    fs.renameSync(tmpFile, DATA_FILE);
  } catch (err) {
    console.error('[DB] Error writing data file:', err.message);
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (fallbackErr) {
      console.error('[DB] Fallback write also failed:', fallbackErr.message);
      throw fallbackErr;
    }
  }
}

module.exports = { getDefaultState, read, write };
