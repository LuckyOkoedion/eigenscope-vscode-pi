'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_ENDPOINT = 'https://eigenscope.guardianai.network';
const LOOPBACK_IPV4_RE = /^127(?:\.\d{1,3}){3}$/;

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
  const resolved = path.resolve(credentialsPath);
  const parent = path.dirname(resolved);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
    throw new Error(`Refusing to overwrite symlink credentials file: ${resolved}`);
  }
  fs.writeFileSync(
    resolved,
    `${JSON.stringify({ schema_version: 1, ...payload, saved_at_utc: new Date().toISOString() }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );
  if (process.platform !== 'win32') {
    fs.chmodSync(resolved, 0o600);
  }
  return resolved;
}

function probePiCli(piCommand = 'pi') {
  const cmd = String(piCommand || 'pi').trim() || 'pi';
  const res = spawnSync(cmd, ['--version'], {
    encoding: 'utf8',
    timeout: 5000,
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

async function requestDeviceCode(baseUrl, fetchImpl = fetch) {
  const endpoint = normalizeEndpointUrl(baseUrl);
  const res = await fetchImpl(`${endpoint}/api/onboarding/device-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json' },
    body: JSON.stringify({ surface: 'vscode_pi', client_version: '0.2.16' }),
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  const json = await res.json();
  if (!res.ok || !json?.device_code || !json?.user_code || !json?.verification_uri) {
    throw new Error(`Device code request failed (${res.status})`);
  }
  return json;
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
      { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10000) }
    );
    const json = await res.json();
    if (res.ok && json?.status === 'authorized' && typeof json.api_key === 'string') {
      return json;
    }
    if (res.status === 404 || res.status === 410 || json?.status === 'expired' || json?.status === 'denied') {
      throw new Error(`EigenScope device login ${json?.status || 'expired'}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timed out waiting for browser authorization.');
}

module.exports = {
  DEFAULT_ENDPOINT,
  normalizeEndpointUrl,
  defaultCredentialsPath,
  readCredentialsFile,
  writeCredentialsFile,
  probePiCli,
  requestDeviceCode,
  pollDeviceCode,
};
