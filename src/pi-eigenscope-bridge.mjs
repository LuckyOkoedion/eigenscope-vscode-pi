import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const BRIDGE_VERSION = '0.2.16';
const CONTRACT_VERSION = '2026-10-18.v1';
const MAX_DECOMPOSE_UTF8_BYTES = 131_072;
const LOOPBACK_IPV4_RE = /^127(?:\.\d{1,3}){3}$/;

const CODING_AGENT_FIREWALL_POLICY = {
  clamp_private: 1,
  clamp_style: 1,
  drop_noise: true,
  target_task_equivalencefloor: 0.995,
  max_mi_leakage_bits: 0.01,
};

const UNTRUSTED_TOOL_IPI_FIREWALL_POLICY = {
  clamp_private: 1,
  clamp_style: 1,
  drop_noise: true,
  target_task_equivalencefloor: 0.995,
  max_mi_leakage_bits: 0.01,
};

// Post-inference CoT observability only; never used for sensitive span detection or redaction.
const CONFUSION_RULES = [
  {
    kind: 'placeholder_confusion',
    label: 'Model questioned an opaque EigenScope placeholder',
    regex:
      /\b(?:what (?:is|does)|meaning of|decode|interpret|unclear what)\s+\[[A-Z][A-Z0-9_]{1,48}\]|\bplaceholder(?:s)?\s+(?:is|are|look)\s+(?:opaque|unclear|ambiguous|missing|confusing)\b/i,
  },
  {
    kind: 'missing_context_complaint',
    label: 'Model noted missing raw value behind protected span',
    regex:
      /\b(?:i don['’]t have|without seeing|cannot see|do not have|was withheld|not provided|redacted out)\b[^.\n]{0,48}\b(?:actual|real|original|exact|underlying)\s+(?:value|key|token|name|email|id|identifier|string|secret|credential|number|context)\b/i,
  },
  {
    kind: 'redaction_refusal',
    label: 'Model paused or refused due to redacted values',
    regex:
      /\b(?:cannot (?:complete|answer|proceed|verify)|unable to (?:complete|solve|determine|proceed))\b[^.\n]{0,48}\b(?:redacted|masked|placeholder|vaulted|tokenized)\b/i,
  },
  {
    kind: 'shortcut_or_bypass_claim',
    label: 'Model attempted guesswork, shortcutting, or check bypass',
    regex:
      /\b(?:i['’]?ll guess|let['’]?s assume|fabricate a value|skip (?:verification|the check|running tests)|bypass(?:ing)? (?:the )?(?:check|guard|firewall)|pretend it passed)\b/i,
  },
];

export function analyzeReasoningForConfusion(thinkingText, symbolKeys = []) {
  if (typeof thinkingText !== 'string' || !thinkingText) {
    return { flagged: false, flags: [], observedSymbolMentions: [] };
  }
  const flags = [];
  for (const rule of CONFUSION_RULES) {
    const match = rule.regex.exec(thinkingText);
    if (match) {
      const start = Math.max(0, match.index - 24);
      const end = Math.min(thinkingText.length, match.index + match[0].length + 32);
      flags.push({
        kind: rule.kind,
        label: rule.label,
        excerpt: thinkingText.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, 120),
      });
    }
  }
  const observedSymbolMentions = [];
  for (const key of symbolKeys) {
    if (typeof key === 'string' && key && thinkingText.includes(key)) {
      observedSymbolMentions.push(key);
    }
  }
  return { flagged: flags.length > 0, flags, observedSymbolMentions };
}

function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost' || host === '::1' || host === '[::1]' || LOOPBACK_IPV4_RE.test(host);
}

function normalizeEndpoint(rawUrl) {
  const candidate = String(rawUrl || 'https://eigenscope.guardianai.network').trim();
  const parsed = new URL(candidate);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('EigenScope endpoint cannot contain credentials, query strings, or fragments.');
  }
  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== 'https:' && !(scheme === 'http:' && isLoopbackHost(parsed.hostname))) {
    throw new Error(`EigenScope endpoint requires HTTPS or loopback HTTP (got ${parsed.protocol}//${parsed.hostname}).`);
  }
  return candidate.replace(/\/+$/, '');
}

function lstatSafe(target) {
  try {
    return lstatSync(target);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

function readCredentialsFileSafe() {
  const credPath = path.join(homedir(), '.config', 'eigenscope', 'credentials.json');
  const st = lstatSafe(credPath);
  if (!st) return null;
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`Refusing symlink or non-regular credentials file: ${credPath}`);
  }
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
    throw new Error(`Credentials file must have mode 0600: ${credPath}`);
  }
  return JSON.parse(readFileSync(credPath, 'utf8'));
}

function newUuidV7() {
  const bytes = randomBytes(16);
  let millis = BigInt(Date.now());
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(millis & 0xffn);
    millis >>= 8n;
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isMacSystemSymlinkPrefix(cursor, resolvedTarget) {
  if (process.platform !== 'darwin') return false;
  if (cursor === '/tmp' && (resolvedTarget === '/tmp' || resolvedTarget.startsWith('/tmp/'))) return true;
  if (cursor === '/var' && (resolvedTarget === '/var' || resolvedTarget.startsWith('/var/'))) return true;
  return false;
}

function assertNoSymlinkPath(targetPath) {
  const resolved = path.resolve(targetPath);
  const root = path.parse(resolved).root;
  let cursor = root;
  for (const segment of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const st = lstatSafe(cursor);
    if (!st) continue;
    if (st.isSymbolicLink()) {
      if (isMacSystemSymlinkPrefix(cursor, resolved)) {
        const dest = readlinkSync(cursor);
        if (dest === 'private/tmp' || dest === '/private/tmp' || dest === 'private/var' || dest === '/private/var') {
          continue;
        }
      }
      throw new Error(`Refusing symlink trace receipt path: ${cursor}`);
    }
  }
  return resolved;
}

function writeContentFreeReceipt(receiptPath, event) {
  const safePath = assertNoSymlinkPath(receiptPath);
  const parent = path.dirname(safePath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const existing = lstatSafe(safePath);
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new Error(`Refusing symlink or non-regular trace receipt file: ${safePath}`);
  }
  const contentFree = {
    schema_version: 1,
    surface: 'vscode_pi',
    timestamp_utc: event.timestamp_utc || new Date().toISOString(),
    turn_index: event.turn_index,
    stage: event.stage,
    protection_mode: event.protection_mode,
    ...(event.request_id ? { request_id: event.request_id } : {}),
    status: event.status,
    symbol_count: event.symbol_count ?? 0,
    symbol_keys: Array.isArray(event.symbol_keys) ? event.symbol_keys : [],
    ...(event.task_sufficiency_eta !== undefined ? { task_sufficiency_eta: event.task_sufficiency_eta } : {}),
    ...(event.mi_leakage_bound_bits !== undefined ? { mi_leakage_bound_bits: event.mi_leakage_bound_bits } : {}),
    ...(event.token_compression_ratio_rho !== undefined ? { token_compression_ratio_rho: event.token_compression_ratio_rho } : {}),
    ...(event.latency_ms !== undefined ? { latency_ms: event.latency_ms } : {}),
    thinking_capability: event.thinking_capability,
    thinking_present: Boolean(event.thinking_present),
    thinking_chars: event.thinking_chars ?? 0,
    confusion_flags: (event.confusion_flags || []).map((f) => ({ kind: f.kind, label: f.label })),
    ...(event.symbols_resolved !== undefined ? { symbols_resolved: event.symbols_resolved } : {}),
    ...(event.unresolved_placeholders !== undefined ? { unresolved_placeholders: event.unresolved_placeholders } : {}),
    ...(event.exact_identifier_match !== undefined ? { exact_identifier_match: event.exact_identifier_match } : {}),
    vault_ticket_scrubbed: Boolean(event.vault_ticket_scrubbed),
    ...(event.blocked_reason ? { blocked_reason: String(event.blocked_reason).slice(0, 160) } : {}),
  };
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const fd = openSync(safePath, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | noFollow, 0o600);
  try {
    const fstat = fstatSync(fd);
    if (!fstat.isFile()) {
      throw new Error(`Refusing non-regular trace receipt file descriptor: ${safePath}`);
    }
    writeSync(fd, `${JSON.stringify(contentFree)}\n`, undefined, 'utf8');
  } finally {
    closeSync(fd);
  }
  if (process.platform !== 'win32') chmodSync(safePath, 0o600);
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

function extractThinking(message) {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content
    .filter((b) => b && typeof b === 'object' && b.type === 'thinking' && typeof b.thinking === 'string')
    .map((b) => b.thinking)
    .join('\n');
}

function cloneWithText(msg, nextText) {
  if (typeof msg.content === 'string') return { ...msg, content: nextText };
  if (!Array.isArray(msg.content)) return { ...msg };
  let replaced = false;
  const blocks = [];
  for (const b of msg.content) {
    if (b && typeof b === 'object' && b.type === 'text') {
      if (!replaced) {
        blocks.push({ ...b, text: nextText });
        replaced = true;
      }
      continue;
    }
    blocks.push(b && typeof b === 'object' ? { ...b } : b);
  }
  if (!replaced) blocks.unshift({ type: 'text', text: nextText });
  return { ...msg, content: blocks };
}

export function createBridgeFirewall(options = {}) {
  const env = options.env || process.env;
  const rawMode = String(options.mode ?? env.EIGENSCOPE_PI_MODE ?? 'protected').trim().toLowerCase();
  let mode = rawMode === 'audit' ? 'audit' : (rawMode === 'standard' || rawMode === 'off') ? 'off' : 'protected';
  const fetchImpl = options.fetchImpl || fetch;
  const cwd = path.resolve(options.cwd || process.cwd());

  let creds = null;
  let credError;
  if (!options.apiKey && !env.ORTHOCORE_API_KEY && !env.EIGENSCOPE_API_KEY) {
    try {
      creds = readCredentialsFileSafe();
    } catch (err) {
      credError = err instanceof Error ? err.message : String(err);
    }
  }

  const apiKey = String(
    options.apiKey ?? env.ORTHOCORE_API_KEY ?? env.EIGENSCOPE_API_KEY ?? creds?.api_key ?? creds?.bearer_token ?? ''
  ).trim();

  let baseUrl = 'https://eigenscope.guardianai.network';
  let originError;
  try {
    baseUrl = normalizeEndpoint(
      options.baseUrl ?? env.ORTHOCORE_BASE_URL ?? env.EIGENSCOPE_BASE_URL ?? creds?.base_url ?? baseUrl
    );
  } catch (err) {
    originError = err instanceof Error ? err.message : String(err);
  }

  const receiptsEnabled =
    options.traceReceiptsEnabled ??
    ['1', 'true'].includes(String(env.EIGENSCOPE_TRACE_RECEIPTS ?? '').trim().toLowerCase());
  const receiptPath = options.traceReceiptPath || env.EIGENSCOPE_TRACE_RECEIPT_PATH || path.join(cwd, '.eigenscope', 'trace-receipts.jsonl');

  let turnIndex = 0;
  let thinkingObserved = false;
  let thinkingBuffer = '';
  let assistantBuffer = '';
  let lastThinkingSig = '';
  let latestSymbols = [];
  const activeTickets = [];
  const history = [];

  async function postJson(route, body) {
    const res = await fetchImpl(`${baseUrl}${route}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json; charset=utf-8',
        Accept: 'application/json',
        'X-OrthoCore-Contract-Version': CONTRACT_VERSION,
        'X-OrthoCore-Request-Id': body.request_id,
        'X-OrthoCore-Idempotency-Key': `vsc-${randomBytes(12).toString('hex')}`,
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json };
  }

  async function decompose(text, policy) {
    if (typeof text !== 'string' || text.includes('\u0000')) {
      throw new Error('Input contains NUL bytes and cannot be sent to EigenScope.');
    }
    const normalized = text.normalize('NFC');
    if (Buffer.byteLength(normalized, 'utf8') > MAX_DECOMPOSE_UTF8_BYTES) {
      throw new Error(`Input exceeds EigenScope max UTF-8 payload (${MAX_DECOMPOSE_UTF8_BYTES} bytes).`);
    }
    const request_id = newUuidV7();
    const res = await postJson('/v1/decompose', {
      schema_version: 1,
      request_id,
      execution_mode: 'vpc_sidecar',
      input_payload: { kind: 'raw_text', text: normalized, token_limit: 4096 },
      separation_policy: policy,
      return_token_saliency: false,
    });
    if (
      !res.ok ||
      res.json?.status !== 'DECOMPOSED_OK' ||
      res.json?.request_id !== request_id ||
      typeof res.json.task_core !== 'string' ||
      typeof res.json.vault_ticket !== 'string'
    ) {
      throw new Error(`EigenScope /v1/decompose failed closed (${res.status} ${res.json?.error_code || 'ERROR'}).`);
    }
    return res.json;
  }

  async function rehydrate(vaultTicket, output) {
    const request_id = newUuidV7();
    const normalized = String(output || '').normalize('NFC');
    const res = await postJson('/v1/rehydrate', {
      schema_version: 1,
      request_id,
      vault_ticket: vaultTicket,
      llm_task_output: normalized,
      target_style_register: 'preserve_llm_default',
      consume_and_scrub_vault_ticket: true,
    });
    if (!res.ok || res.json?.status !== 'REHYDRATED_OK' || res.json?.request_id !== request_id) {
      throw new Error(`EigenScope /v1/rehydrate failed (${res.status} ${res.json?.error_code || 'ERROR'}).`);
    }
    return res.json;
  }

  async function scrub(vaultTicket) {
    if (!vaultTicket || !vaultTicket.startsWith('vlt_') || !apiKey || originError) return false;
    try {
      const res = await postJson('/v1/vault/scrub', {
        schema_version: 1,
        request_id: newUuidV7(),
        vault_ticket: vaultTicket,
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  function emit(event, ctx, persist = false) {
    history.push(event);
    if (history.length > 200) history.shift();
    options.onTraceEvent?.(event);
    ctx?.ui?.setStatus?.('eigenscope_trace', JSON.stringify(event));
    if (persist && receiptsEnabled) {
      writeContentFreeReceipt(receiptPath, event);
    }
    return event;
  }

  function configErr() {
    if (originError) return originError;
    if (credError) return credError;
    if (!apiKey) return 'EigenScope API key not configured. Click Connect EigenScope.';
    if (/[\r\n\u0000]/.test(apiKey)) return 'EigenScope API key contains invalid control characters.';
    return undefined;
  }

  function attach(pi) {
    pi.on('context', async (event, ctx) => {
      if (mode === 'off' || !Array.isArray(event?.messages)) return event;
      lastThinkingSig = '';
      const err = configErr();
      if (err) {
        emit({
          turn_index: turnIndex,
          stage: 'blocked',
          timestamp_utc: new Date().toISOString(),
          protection_mode: mode,
          status: mode === 'protected' ? 'BLOCKED_FAIL_CLOSED' : 'AUDIT_UNCONFIGURED',
          symbol_count: 0,
          symbol_keys: [],
          thinking_capability: 'not_requested',
          thinking_present: false,
          thinking_chars: 0,
          confusion_flags: [],
          vault_ticket_scrubbed: true,
          blocked_reason: err,
        }, ctx, true);
        if (mode === 'protected') throw new Error(err);
        return { messages: event.messages.map((m) => ({ ...m })) };
      }

      const cloned = [];
      const newlyCreatedTickets = [];
      try {
        for (const msg of event.messages) {
          if (!msg || typeof msg !== 'object') continue;
          if (msg.role !== 'user') {
            cloned.push({ ...msg, content: Array.isArray(msg.content) ? msg.content.map((b) => ({ ...b })) : msg.content });
            continue;
          }
          const rawText = extractText(msg.content);
          if (!rawText.trim()) {
            cloned.push({ ...msg });
            continue;
          }
          const dec = await decompose(rawText, CODING_AGENT_FIREWALL_POLICY);
          const symbolKeys = Array.isArray(dec.private_symbol_summary?.symbol_keys)
            ? dec.private_symbol_summary.symbol_keys
            : [];
          for (const k of symbolKeys) if (!latestSymbols.includes(k)) latestSymbols.push(k);
          const rec = { vaultTicket: dec.vault_ticket, stage: 'context' };
          activeTickets.push(rec);
          newlyCreatedTickets.push(rec);
          cloned.push(cloneWithText(msg, dec.task_core));
          emit({
            turn_index: turnIndex,
            stage: 'decompose',
            timestamp_utc: new Date().toISOString(),
            protection_mode: mode,
            request_id: dec.request_id,
            status: dec.status,
            symbol_count: dec.private_symbol_summary?.symbol_count ?? symbolKeys.length,
            symbol_keys: symbolKeys,
            task_sufficiency_eta: dec.telemetry?.task_sufficiency_eta,
            mi_leakage_bound_bits: dec.telemetry?.mi_leakage_bound_bits,
            token_compression_ratio_rho: dec.telemetry?.token_compression_ratio_rho,
            latency_ms: dec.telemetry?.latency_ms,
            thinking_capability: 'not_requested',
            thinking_present: false,
            thinking_chars: 0,
            confusion_flags: [],
            vault_ticket_scrubbed: false,
            task_core_preview: dec.task_core.slice(0, 600),
          }, ctx, true);
        }
        return { messages: cloned };
      } catch (errCause) {
        for (const rec of newlyCreatedTickets) {
          const idx = activeTickets.indexOf(rec);
          if (idx >= 0) activeTickets.splice(idx, 1);
          await scrub(rec.vaultTicket);
        }
        emit({
          turn_index: turnIndex,
          stage: 'blocked',
          timestamp_utc: new Date().toISOString(),
          protection_mode: mode,
          status: mode === 'protected' ? 'BLOCKED_FAIL_CLOSED' : 'AUDIT_DECOMPOSE_ERROR',
          symbol_count: latestSymbols.length,
          symbol_keys: [...latestSymbols],
          thinking_capability: 'not_requested',
          thinking_present: false,
          thinking_chars: 0,
          confusion_flags: [],
          vault_ticket_scrubbed: true,
          blocked_reason: errCause instanceof Error ? errCause.message : String(errCause),
        }, ctx, true);
        if (mode === 'protected') throw errCause;
        return { messages: event.messages.map((m) => ({ ...m })) };
      }
    });

    pi.on('tool_call', async (event, ctx) => {
      if (mode !== 'protected') return undefined;
      const err = configErr();
      if (!err) return undefined;
      emit({
        turn_index: turnIndex,
        stage: 'blocked',
        timestamp_utc: new Date().toISOString(),
        protection_mode: mode,
        status: 'BLOCKED_FAIL_CLOSED',
        symbol_count: latestSymbols.length,
        symbol_keys: [...latestSymbols],
        thinking_capability: 'not_requested',
        thinking_present: false,
        thinking_chars: 0,
        confusion_flags: [],
        vault_ticket_scrubbed: true,
        blocked_reason: `Tool call '${event?.toolName || 'tool'}' blocked: ${err}`,
      }, ctx, true);
      return { block: true, reason: err };
    });

    pi.on('tool_result', async (event, ctx) => {
      if (mode === 'off' || !event) return undefined;
      const rawText = extractText(event.content);
      if (!rawText.trim()) return undefined;
      if (configErr()) {
        if (mode === 'protected') {
          return {
            isError: true,
            content: [{ type: 'text', text: `[EigenScope Firewall blocked untrusted tool output: ${configErr()}]` }],
          };
        }
        return undefined;
      }
      try {
        const dec = await decompose(rawText, UNTRUSTED_TOOL_IPI_FIREWALL_POLICY);
        const symbolKeys = Array.isArray(dec.private_symbol_summary?.symbol_keys)
          ? dec.private_symbol_summary.symbol_keys
          : [];
        for (const k of symbolKeys) if (!latestSymbols.includes(k)) latestSymbols.push(k);
        activeTickets.push({ vaultTicket: dec.vault_ticket, stage: 'tool_result' });
        emit({
          turn_index: turnIndex,
          stage: 'tool_result',
          timestamp_utc: new Date().toISOString(),
          protection_mode: mode,
          request_id: dec.request_id,
          status: dec.status,
          symbol_count: dec.private_symbol_summary?.symbol_count ?? symbolKeys.length,
          symbol_keys: symbolKeys,
          task_sufficiency_eta: dec.telemetry?.task_sufficiency_eta,
          mi_leakage_bound_bits: dec.telemetry?.mi_leakage_bound_bits,
          latency_ms: dec.telemetry?.latency_ms,
          thinking_capability: 'not_requested',
          thinking_present: false,
          thinking_chars: 0,
          confusion_flags: [],
          vault_ticket_scrubbed: false,
          task_core_preview: dec.task_core.slice(0, 600),
        }, ctx, true);
        if (typeof event.content === 'string') return { content: dec.task_core, isError: event.isError };
        return { content: [{ type: 'text', text: dec.task_core }], isError: event.isError };
      } catch (err) {
        if (mode === 'protected') {
          return {
            isError: true,
            content: [{ type: 'text', text: `[EigenScope quarantined tool output fail-closed: ${err.message}]` }],
          };
        }
        return undefined;
      }
    });

    pi.on('message_update', (event, ctx) => {
      const inner = event?.assistantMessageEvent ?? event;
      const type = inner?.type;
      const delta = typeof inner?.delta === 'string' ? inner.delta : '';
      if (!delta) return;
      if (type === 'thinking_delta') {
        thinkingObserved = true;
        thinkingBuffer += delta;
        const analysis = analyzeReasoningForConfusion(thinkingBuffer, latestSymbols);
        if (analysis.flagged) {
          const sig = [...new Set(analysis.flags.map((f) => f.kind))].sort().join(',');
          if (sig !== lastThinkingSig) {
            lastThinkingSig = sig;
            emit({
              turn_index: turnIndex,
              stage: 'thinking_observation',
              timestamp_utc: new Date().toISOString(),
              protection_mode: mode,
              status: 'COT_CONFUSION_FLAGGED',
              symbol_count: latestSymbols.length,
              symbol_keys: [...latestSymbols],
              thinking_capability: 'observed',
              thinking_present: true,
              thinking_chars: thinkingBuffer.length,
              confusion_flags: analysis.flags,
              vault_ticket_scrubbed: false,
              thinking_preview: thinkingBuffer.slice(-600),
            }, ctx, false);
          }
        }
      } else if (type === 'text_delta') {
        assistantBuffer += delta;
      }
    });

    pi.on('message_end', (event) => {
      const thinking = extractThinking(event?.message);
      if (thinking) {
        thinkingObserved = true;
        thinkingBuffer = thinking;
      }
      const txt = extractText(event?.message?.content);
      if (txt) assistantBuffer = txt;
    });

    pi.on('turn_end', async (event, ctx) => {
      const msgThinking = extractThinking(event?.message);
      if (msgThinking) {
        thinkingObserved = true;
        if (!thinkingBuffer) thinkingBuffer = msgThinking;
      }
      const rawAssistantText = extractText(event?.message?.content) || assistantBuffer;
      const capability = thinkingObserved ? 'observed' : 'not_emitted_by_provider';
      const analysis = analyzeReasoningForConfusion(thinkingBuffer, latestSymbols);
      const batch = activeTickets.splice(0, activeTickets.length);
      const primary = [...batch].reverse().find((t) => t.stage === 'context') || batch[batch.length - 1];

      let rehydratedText = rawAssistantText;
      let status = batch.length ? 'SCRUBBED_WITHOUT_REHYDRATE' : 'NO_VAULT_TICKET';
      let symbolsResolved = 0;
      let unresolvedPlaceholders = 0;
      let exactMatch = true;
      let scrubbed = batch.length === 0;
      let requestId;
      let latencyMs;
      let rehydrateError = null;

      try {
        if (primary && rawAssistantText && !configErr() && mode !== 'off') {
          const reh = await rehydrate(primary.vaultTicket, rawAssistantText);
          rehydratedText = reh.rehydrated_text;
          status = reh.status;
          requestId = reh.request_id;
          symbolsResolved = reh.round_trip_verification?.symbols_resolved ?? 0;
          unresolvedPlaceholders = reh.round_trip_verification?.unresolved_placeholders ?? 0;
          exactMatch = reh.round_trip_verification?.exact_identifier_match ?? true;
          scrubbed = Boolean(reh.round_trip_verification?.vault_ticket_scrubbed ?? true);
          latencyMs = reh.round_trip_verification?.latency_ms;
        } else if (primary) {
          await scrub(primary.vaultTicket);
          scrubbed = true;
        }
      } catch (errCause) {
        rehydrateError = errCause;
        status = 'REHYDRATE_ERROR_SCRUBBED';
        if (primary) await scrub(primary.vaultTicket);
        scrubbed = true;
      } finally {
        for (const extra of batch) {
          if (extra !== primary) await scrub(extra.vaultTicket);
        }
      }

      emit({
        turn_index: turnIndex,
        stage: rehydrateError ? 'blocked' : 'rehydrate',
        timestamp_utc: new Date().toISOString(),
        protection_mode: mode,
        request_id: requestId,
        status,
        symbol_count: latestSymbols.length,
        symbol_keys: [...latestSymbols],
        latency_ms: latencyMs,
        thinking_capability: capability,
        thinking_present: thinkingObserved,
        thinking_chars: thinkingBuffer.length,
        confusion_flags: analysis.flags,
        symbols_resolved: symbolsResolved,
        unresolved_placeholders: unresolvedPlaceholders,
        exact_identifier_match: exactMatch,
        vault_ticket_scrubbed: scrubbed,
        ...(rehydrateError ? { blocked_reason: rehydrateError instanceof Error ? rehydrateError.message : String(rehydrateError) } : {}),
        thinking_preview: thinkingObserved ? thinkingBuffer.slice(0, 600) : undefined,
      }, ctx, true);

      if (!rehydrateError && rehydratedText && rehydratedText !== rawAssistantText) {
        ctx?.ui?.setStatus?.('eigenscope_rehydrated', JSON.stringify({ turnIndex, rehydratedText }));
      }

      thinkingBuffer = '';
      assistantBuffer = '';
      lastThinkingSig = '';
      latestSymbols = [];
      thinkingObserved = false;
      turnIndex += 1;
      if (rehydrateError && mode === 'protected') {
        throw rehydrateError;
      }
      return { rehydratedText, vaultTicketScrubbed: scrubbed };
    });

    pi.on('session_shutdown', async () => {
      const batch = activeTickets.splice(0, activeTickets.length);
      for (const item of batch) await scrub(item.vaultTicket);
      thinkingBuffer = '';
      assistantBuffer = '';
      latestSymbols = [];
      thinkingObserved = false;
    });
  }

  return {
    attach,
    setMode: (next) => { mode = next; },
    getHistory: () => [...history],
  };
}

export default function eigenscopeVscodePiBridge(pi) {
  createBridgeFirewall().attach(pi);
}
