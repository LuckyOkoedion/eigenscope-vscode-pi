'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readSessionTail(sessionFilePath, maxEntries = 200) {
  if (!sessionFilePath || !fs.existsSync(sessionFilePath)) return [];
  const st = fs.lstatSync(sessionFilePath);
  if (st.isSymbolicLink() || !st.isFile()) return [];
  const raw = fs.readFileSync(sessionFilePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const tail = lines.slice(-maxEntries);
  const parsed = [];
  for (const line of tail) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      // Ignore partial line while writer is flushing
    }
  }
  return parsed;
}

function listWorkspaceSessions(sessionDir) {
  if (!sessionDir || !fs.existsSync(sessionDir)) return [];
  const entries = fs.readdirSync(sessionDir, { withFileTypes: true });
  return entries
    .filter((e) => !e.isSymbolicLink() && e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => {
      const full = path.join(sessionDir, e.name);
      const st = fs.lstatSync(full);
      return { id: e.name, path: full, mtimeMs: st.mtimeMs, size: st.size };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 50);
}

module.exports = { readSessionTail, listWorkspaceSessions };
