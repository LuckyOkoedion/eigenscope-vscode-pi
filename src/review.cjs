'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { countLines, decodeText } = require('./line-counts.cjs');
const { collectWorkspaceSnapshot, resolveSafeWorkspacePath } = require('./files.cjs');

function createReviewManager(workspaceRoot) {
  let baseline = null;
  let baselineMeta = { coverage: {}, omitted: 0 };
  const currentEntries = new Map();

  function beginBaseline() {
    const snap = collectWorkspaceSnapshot(workspaceRoot);
    baseline = snap.files;
    baselineMeta = { coverage: snap.coverage, omitted: snap.omitted };
    currentEntries.clear();
  }

  function refresh() {
    if (!baseline) {
      return { active: false, rows: [], coverage: {}, omitted: 0, refreshFailed: false };
    }
    try {
      const snap = collectWorkspaceSnapshot(workspaceRoot);
      const allKeys = new Set([...baseline.keys(), ...snap.files.keys()]);
      const rows = [];
      currentEntries.clear();

      for (const relative of [...allKeys].sort()) {
        const beforeBuf = baseline.get(relative);
        const afterBuf = snap.files.get(relative);
        if (!beforeBuf && !afterBuf) continue;
        if (beforeBuf && afterBuf && Buffer.compare(beforeBuf, afterBuf) === 0) continue;

        const kind = !beforeBuf ? 'created' : !afterBuf ? 'deleted' : 'modified';
        const beforeText = beforeBuf ? decodeText(beforeBuf) : '';
        const afterText = afterBuf ? decodeText(afterBuf) : '';
        const textDiffable = beforeText !== null && afterText !== null;
        const counts = textDiffable ? countLines(beforeText, afterText) : null;

        currentEntries.set(relative, {
          relative,
          kind,
          hadBefore: Boolean(beforeBuf),
          beforeBuffer: beforeBuf ? Buffer.from(beforeBuf) : null,
          afterBuffer: afterBuf ? Buffer.from(afterBuf) : null,
          beforeText: textDiffable ? beforeText : null,
          afterText: textDiffable ? afterText : null,
        });

        rows.push({
          relative,
          kind,
          counts,
          diff: textDiffable,
          revert: true,
          reason: textDiffable ? '' : 'Binary or non-UTF-8 file (revert supported)',
        });
      }

      return {
        active: true,
        rows,
        coverage: { ...baselineMeta.coverage, ...snap.coverage },
        omitted: baselineMeta.omitted + snap.omitted,
        refreshFailed: false,
      };
    } catch {
      return {
        active: Boolean(baseline),
        rows: [],
        coverage: baselineMeta.coverage,
        omitted: baselineMeta.omitted,
        refreshFailed: true,
      };
    }
  }

  function getEntry(relative) {
    return currentEntries.get(relative) || null;
  }

  function pruneEmptyParents(absFile, realRoot) {
    let dir = path.dirname(absFile);
    while (dir.startsWith(realRoot) && dir !== realRoot) {
      const items = fs.readdirSync(dir);
      if (items.length > 0) break;
      fs.rmdirSync(dir);
      dir = path.dirname(dir);
    }
  }

  function revertFile(relative) {
    const entry = currentEntries.get(relative);
    if (!entry) {
      throw new Error(`No tracked review entry for ${relative}`);
    }
    const { absPath, realRoot } = resolveSafeWorkspacePath(workspaceRoot, relative);
    if (!entry.hadBefore) {
      fs.rmSync(absPath, { force: true });
      pruneEmptyParents(absPath, realRoot);
    } else {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, entry.beforeBuffer);
    }
    return refresh();
  }

  return {
    beginBaseline,
    refresh,
    getEntry,
    revertFile,
    hasBaseline: () => Boolean(baseline),
  };
}

module.exports = { createReviewManager };
