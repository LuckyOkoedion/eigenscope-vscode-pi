'use strict';

const { spawnSync } = require('node:child_process');
const { constants } = require('node:fs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_ENDPOINT = 'https://eigenscope.guardianai.network';
const LOOPBACK_IPV4_RE = /^127(?:\.\d{1,3}){3}$/;

function lstatSafe(target) {
  try {
    return fs.lstatSync(target);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

function isMacSystemSymlinkPrefix(cursor, resolvedTarget) {
  if (process.platform !== 'darwin') return false;
  if (cursor === '/tmp' && (resolvedTarget === '/tmp' || resolvedTarget.startsWith('/tmp/'))) return true;
  if (cursor === '/var' && (resolvedTarget === '/var' || resolvedTarget.startsWith('/var/'))) return true;
  return false;
}

function assertNoSymlinkPath(targetPath) {
  const resolved = path.resolve(targetPath);
  const parsed = path.parse(resolved);
  let cursor = parsed.root;
  for (const segment of path.relative(parsed.root, resolved).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const st = lstatSafe(cursor);
    if (!st) continue;
    if (st.isSymbolicLink()) {
      if (isMacSystemSymlinkPrefix(cursor, resolved)) {
        const dest = fs.readlinkSync(cursor);
        if (dest === 'private/tmp' || dest === '/private/tmp' || dest === 'private/var' || dest === '/private/var') {
          continue;
        }
      }
      throw new Error(`Refusing symlink path component: ${cursor}`);
    }
  }
  return resolved;
}

function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost' || host === '::1' || host === '[::1]' || LOOPBACK_IPV4_RE.test(host);
}

function normalizeEndpointUrl(rawUrl) {
  const candidate = String(rawUrl || DEFAULT_ENDPOINT).trim();
  if (!candidate || /[\r\n\0]/.test(candidate)) {
    throw new Error('Endpoint URL cannot be empty or contain control characters.');
  }
  const parsed = new URL(candidate);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Endpoint URL cannot contain credentials, queries, or fragments.');
  }
  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== 'https:' && !(scheme === 'http:' && isLoopbackHost(parsed.hostname))) {
    throw new Error(`Endpoint requires HTTPS or loopback HTTP (got ${parsed.protocol}//${parsed.hostname}).`);
  }
  return candidate.replace(/\/+$/, '');
}

function defaultCredentialsPath() {
  return path.join(os.homedir(), '.config', 'eigenscope', 'credentials.json');
}

function readCredentialsFile(credentialsPath = defaultCredentialsPath()) {
  if (!fs.existsSync(credentialsPath)) return null;
  const st = fs.lstatSync(credentialsPath);
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`Refusing symlink or non-regular credentials file: ${credentialsPath}`);
  }
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
    throw new Error(`Credentials file must have mode 0600: ${credentialsPath}`);
  }
  return JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
}

function writeCredentialsFile(payload, credentialsPath = defaultCredentialsPath()) {
  const safePath = assertNoSymlinkPath(credentialsPath);
  const parent = path.dirname(safePath);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const existing = lstatSafe(safePath);
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new Error(`Refusing to overwrite symlink or non-regular credentials file: ${safePath}`);
  }
  const body = `${JSON.stringify({ schema_version: 1, ...payload, saved_at_utc: new Date().toISOString() }, null, 2)}\n`;
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | noFollow;
  const fd = fs.openSync(safePath, flags, 0o600);
  try {
    const fstat = fs.fstatSync(fd);
    if (!fstat.isFile()) {
      throw new Error(`Refusing non-regular credentials file descriptor: ${safePath}`);
    }
    fs.writeFileSync(fd, body, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  if (process.platform !== 'win32') {
    fs.chmodSync(safePath, 0o600);
  }
  return safePath;
}

function isExecutableCandidate(filePath) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return false;
    if (process.platform !== 'win32') {
      fs.accessSync(filePath, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

function collectNodeManagerBins(homeDir, env, platform) {
  const dirs = [];
  const push = (d) => {
    if (d && !dirs.includes(d)) dirs.push(d);
  };
  if (platform === 'win32') {
    const appData = (env && env.APPDATA) || path.join(homeDir, 'AppData', 'Roaming');
    const localApp = (env && env.LOCALAPPDATA) || path.join(homeDir, 'AppData', 'Local');
    push(path.join(appData, 'npm'));
    push(path.join(homeDir, '.volta', 'bin'));
    push(path.join(localApp, 'Volta', 'bin'));
    push(path.join(homeDir, '.bun', 'bin'));
    return dirs;
  }
  const nvmDir = (env && env.NVM_DIR) || path.join(homeDir, '.nvm');
  const nvmNodes = path.join(nvmDir, 'versions', 'node');
  try {
    const versions = fs.readdirSync(nvmNodes).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions.slice(0, 12)) {
      push(path.join(nvmNodes, v, 'bin'));
    }
  } catch {}
  const fnmDir = path.join(homeDir, '.local', 'share', 'fnm', 'node-versions');
  try {
    const versions = fs.readdirSync(fnmDir).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions.slice(0, 12)) {
      push(path.join(fnmDir, v, 'installation', 'bin'));
    }
  } catch {}
  push(path.join(homeDir, '.volta', 'bin'));
  push(path.join(homeDir, '.npm-global', 'bin'));
  push(path.join(homeDir, '.bun', 'bin'));
  push(path.join(homeDir, '.local', 'bin'));
  push('/opt/homebrew/bin');
  push('/usr/local/bin');
  return dirs;
}

function resolvePiCommand(
  piCommand = 'pi',
  { homeDir = os.homedir(), env = process.env, platform = process.platform } = {}
) {
  const raw = String(piCommand || 'pi').trim() || 'pi';
  if (raw.includes('/') || raw.includes('\\')) {
    return path.resolve(raw);
  }
  const binNames = platform === 'win32' ? [`${raw}.cmd`, `${raw}.exe`, raw] : [raw];
  const envPath = String((env && env.PATH) || '');
  const searchDirs = [...envPath.split(path.delimiter).filter(Boolean), ...collectNodeManagerBins(homeDir, env, platform)];
  for (const dir of searchDirs) {
    for (const name of binNames) {
      const candidate = path.join(dir, name);
      if (isExecutableCandidate(candidate)) {
        return candidate;
      }
    }
  }
  return raw;
}

function buildPiSpawnEnv(resolvedCmd, baseEnv = process.env) {
  if (!path.isAbsolute(resolvedCmd)) return { ...baseEnv };
  const binDir = path.dirname(resolvedCmd);
  const currentPath = String(baseEnv.PATH || '');
  const parts = currentPath.split(path.delimiter).filter(Boolean);
  if (parts.includes(binDir)) return { ...baseEnv };
  return { ...baseEnv, PATH: [binDir, ...parts].join(path.delimiter) };
}

function probePiCli(piCommand = 'pi', options = {}) {
  const cmd = resolvePiCommand(piCommand, options);
  const res = spawnSync(cmd, ['--version'], {
    encoding: 'utf8',
    timeout: 5000,
    env: buildPiSpawnEnv(cmd, (options && options.env) || process.env),
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  if (res.error || res.status !== 0) {
    return {
      available: false,
      command: cmd,
      versionText: '',
      installCommand: 'npm install -g @earendil-works/pi-coding-agent',
      error: res.error ? res.error.message : (res.stderr || `exit ${res.status}`),
    };
  }
  return {
    available: true,
    command: cmd,
    versionText: String(res.stdout || '').trim(),
    installCommand: 'npm install -g @earendil-works/pi-coding-agent',
  };
}

function safeJsonParse(rawText) {
  try {
    return rawText ? JSON.parse(rawText) : null;
  } catch {
    return null;
  }
}

function combinedSignal(timeoutMs, externalSignal) {
  const timeoutSig = AbortSignal.timeout(timeoutMs);
  if (externalSignal && typeof AbortSignal.any === 'function') {
    return AbortSignal.any([timeoutSig, externalSignal]);
  }
  return timeoutSig;
}

function abortableSleep(ms, signal) {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  if (signal.aborted) {
    return Promise.reject(new Error('EigenScope sign-in cancelled.'));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error('EigenScope sign-in cancelled.'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const VERIFICATION_LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function validateVerificationUri(rawUri, expectedOrigin) {
  const text = typeof rawUri === 'string' ? rawUri.trim() : '';
  if (!text) {
    throw new Error('Verification URI missing from onboarding response.');
  }
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error('Verification URI is not a valid URL.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Verification URI must not include embedded credentials.');
  }
  const host = parsed.hostname.toLowerCase();
  const isLoopback = VERIFICATION_LOOPBACK_HOSTS.has(host) || /^127(?:\.\d{1,3}){3}$/.test(host);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
    throw new Error('Verification URI must use HTTPS or loopback HTTP.');
  }
  if (expectedOrigin && parsed.origin !== expectedOrigin) {
    throw new Error('Untrusted cross-origin verification URI rejected.');
  }
  return parsed.href;
}

async function requestDeviceCode(baseUrl, fetchImpl = fetch) {
  const endpoint = normalizeEndpointUrl(baseUrl);
  const res = await fetchImpl(`${endpoint}/api/onboarding/device-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json' },
    body: JSON.stringify({ surface: 'vscode_pi', client_version: '0.2.19' }),
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  const json = safeJsonParse(await res.text());
  if (!res.ok || !json?.device_code || !json?.user_code || !json?.verification_uri) {
    throw new Error(`Device code request failed (${res.status})`);
  }
  const verificationUri = validateVerificationUri(json.verification_uri, endpoint);
  const verificationUriComplete = json.verification_uri_complete
    ? validateVerificationUri(json.verification_uri_complete, endpoint)
    : undefined;
  return {
    ...json,
    verification_uri: verificationUri,
    ...(verificationUriComplete !== undefined ? { verification_uri_complete: verificationUriComplete } : {}),
  };
}

async function pollDeviceCode(baseUrl, deviceCode, opts = {}) {
  const endpoint = normalizeEndpointUrl(baseUrl);
  const fetchImpl = opts.fetchImpl || fetch;
  const maxAttempts = opts.maxAttempts ?? 60;
  const intervalMs = opts.intervalMs ?? 1500;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (opts.signal?.aborted) throw new Error('EigenScope sign-in cancelled.');
    const res = await fetchImpl(
      `${endpoint}/api/onboarding/device-poll?device_code=${encodeURIComponent(deviceCode)}`,
      { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error', signal: combinedSignal(10000, opts.signal) }
    );
    const json = safeJsonParse(await res.text());
    const apiKey = typeof json?.api_key === 'string' && json.api_key.trim()
      ? json.api_key.trim()
      : (typeof json?.access_token === 'string' && json.access_token.trim() ? json.access_token.trim() : '');
    if (res.ok && (json?.status === 'approved' || json?.status === 'authorized') && apiKey) {
      return { ...json, api_key: apiKey };
    }
    if (res.status === 404 || res.status === 410 || json?.status === 'expired' || json?.status === 'denied') {
      throw new Error(`EigenScope device login ${json?.status || 'expired'}.`);
    }
    await abortableSleep(intervalMs, opts.signal);
  }
  throw new Error('Timed out waiting for browser authorization.');
}

module.exports = {
  DEFAULT_ENDPOINT,
  normalizeEndpointUrl,
  defaultCredentialsPath,
  readCredentialsFile,
  writeCredentialsFile,
  resolvePiCommand,
  buildPiSpawnEnv,
  probePiCli,
  validateVerificationUri,
  requestDeviceCode,
  pollDeviceCode,
};
