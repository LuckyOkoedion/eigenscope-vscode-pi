'use strict';

const maxLines = 50000;
const maxWork = 200000;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function decodeText(bytes) {
  if (!bytes || bytes.includes(0)) return null;
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

function lines(text) {
  const out = [];
  for (let start = 0; start < text.length;) {
    if (out.length === maxLines) return null;
    const next = text.indexOf('\n', start);
    const end = next < 0 ? text.length : next + 1;
    out.push(text.slice(start, end));
    start = end;
  }
  return out;
}

function countLines(before, after) {
  if (before === after) return { added: 0, removed: 0 };
  const a = lines(before);
  const b = lines(after);
  if (!a || !b) return null;
  let start = 0;
  let endA = a.length;
  let endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) start++;
  while (start < endA && start < endB && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  if (!n || !m) return { added: m, removed: n };

  const limit = Math.min(n + m, Math.floor(Math.sqrt(2 * maxWork)));
  const center = limit + 1;
  const furthest = new Int32Array(2 * limit + 3);
  let steps = 0;
  for (let distance = 0; distance <= limit; distance++) {
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      if (++steps > maxWork) return null;
      const i = center + diagonal;
      let x = diagonal === -distance || (diagonal !== distance && furthest[i - 1] < furthest[i + 1])
        ? furthest[i + 1]
        : furthest[i - 1] + 1;
      let y = x - diagonal;
      while (x < n && y < m && a[start + x] === b[start + y]) {
        if (++steps > maxWork) return null;
        x++;
        y++;
      }
      if (x >= n && y >= m) {
        const added = (distance + m - n) / 2;
        return { added, removed: distance - added };
      }
      furthest[i] = x;
    }
  }
  return null;
}

module.exports = { decodeText, countLines };
