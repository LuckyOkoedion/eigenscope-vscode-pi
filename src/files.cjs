'use strict';

const fs = require('node:fs');
const path = require('node:path');

const IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'target',
  '.venv',
  'venv',
  '__pycache__',
]);

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
const MAX_FILES = 1500;

function toPosixRelative(workspaceRoot, absPath) {
  return path.relative(workspaceRoot, absPath).split(path.sep).join('/');
}

function resolveSafeWorkspacePath(workspaceRoot, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim() || relativePath.includes('\0')) {
    throw new Error('Invalid relative path');
  }
  const realRoot = fs.realpathSync(workspaceRoot);
  const normalizedRel = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = normalizedRel.split('/').filter(Boolean);
  if (!segments.length || segments.some((s) => s === '.' || s === '..')) {
    throw new Error(`Unsafe workspace path traversal rejected: ${relativePath}`);
  }
  let cursor = realRoot;
  for (let i = 0; i < segments.length; i++) {
    cursor = path.join(cursor, segments[i]);
    if (fs.existsSync(cursor)) {
      const st = fs.lstatSync(cursor);
      if (st.isSymbolicLink()) {
        throw new Error(`Refusing symlink inside workspace path: ${cursor}`);
      }
      if (i < segments.length - 1 && !st.isDirectory()) {
        throw new Error(`Non-directory parent segment: ${cursor}`);
      }
    }
  }
  const finalRel = path.relative(realRoot, cursor);
  if (!finalRel || finalRel.startsWith('..') || path.isAbsolute(finalRel)) {
    throw new Error(`Resolved path escaped workspace root: ${relativePath}`);
  }
  return { realRoot, absPath: cursor, relative: segments.join('/') };
}

function collectWorkspaceSnapshot(workspaceRoot) {
  const realRoot = fs.realpathSync(workspaceRoot);
  const files = new Map();
  const coverage = { fileSize: 0, budget: 0, restricted: 0, unreadable: 0 };
  let totalBytes = 0;

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      coverage.unreadable += 1;
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.size >= MAX_FILES) {
        coverage.budget += 1;
        continue;
      }
      let stat;
      try {
        stat = fs.lstatSync(full);
      } catch {
        coverage.unreadable += 1;
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) {
        coverage.fileSize += 1;
        continue;
      }
      if (totalBytes + stat.size > MAX_TOTAL_BYTES) {
        coverage.budget += 1;
        continue;
      }
      try {
        const bytes = fs.readFileSync(full);
        totalBytes += bytes.length;
        files.set(toPosixRelative(realRoot, full), bytes);
      } catch {
        coverage.unreadable += 1;
      }
    }
  }

  walk(realRoot);
  return {
    files,
    coverage,
    omitted: coverage.fileSize + coverage.budget + coverage.restricted + coverage.unreadable,
  };
}

module.exports = {
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  resolveSafeWorkspacePath,
  collectWorkspaceSnapshot,
};
