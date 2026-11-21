'use strict';

let vscode = null;
try {
  vscode = require('vscode');
} catch {
  // Optional outside VS Code Extension Host so pure helpers remain testable in Node
}

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ATTACHMENT_LIMITS, buildPromptWithAttachments } = require('./attachments.cjs');
const { classifyToolApproval } = require('./approval.cjs');
const { buildEvidenceSummary } = require('./evidence.cjs');
const { PiRpcClient } = require('./pi-rpc.cjs');
const { createReviewManager } = require('./review.cjs');
const {
  DEFAULT_ENDPOINT,
  normalizeEndpointUrl,
  pollDeviceCode,
  probePiCli,
  readCredentialsFile,
  requestDeviceCode,
  writeCredentialsFile,
} = require('./setup.cjs');

const SECRET_API_KEY_SLOT = 'eigenscope.apiKey';

function escapeAttr(val) {
  return String(val)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function sanitizeExternalUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ''));
    if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password) {
      return parsed.href;
    }
  } catch {}
  return null;
}

function nextProtectionMode(current) {
  if (current === 'protected') return 'audit';
  if (current === 'audit') return 'standard';
  return 'protected';
}

function renderWebviewHtml({ cspSource, styleUri, markdownItUri, markdownJsUri, reviewJsUri, nonce }) {
  const safeNonce = escapeAttr(nonce || crypto.randomBytes(16).toString('base64'));
  const limitsJson = escapeAttr(JSON.stringify(ATTACHMENT_LIMITS));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${escapeAttr(cspSource)}; img-src ${escapeAttr(cspSource)} data:; script-src 'nonce-${safeNonce}';" />
  <link rel="stylesheet" href="${escapeAttr(styleUri)}" />
  <title>EigenScope for VS Code &amp; Pi</title>
</head>
<body>
  <div class="layout">
    <div class="eigenscope-bar">
      <div class="es-group">
        <button id="protection-toggle" type="button" class="es-pill protected">Protected (EigenScope)</button>
        <span id="eigenscope-status" class="es-status">Initializing...</span>
      </div>
      <div class="es-group">
        <button id="trace-toggle" type="button" class="quiet" aria-expanded="false">3-Stage Trace</button>
        <button id="connect-eigenscope" type="button" class="quiet">Connect EigenScope</button>
        <button id="setup-pi" type="button" class="quiet">Set Up Pi</button>
        <button id="open-pricing" type="button" class="quiet">Upgrade / Credits</button>
      </div>
    </div>

    <header class="session-header">
      <div class="chat-heading">
        <h1 id="chat-title">Pi</h1>
        <div id="status">Ready</div>
      </div>
      <div class="chat-actions">
        <button id="choose-folder" type="button" hidden>Open Folder</button>
        <button id="sessions" type="button" class="quiet">Sessions</button>
        <button id="new-chat" type="button" class="quiet">New Chat</button>
      </div>
    </header>

    <main id="transcript" aria-live="polite"></main>

    <section id="trace-drawer" class="trace-drawer" hidden>
      <div class="trace-drawer-header">
        <strong>3-Stage Protection &amp; Reasoning Trace (Live RAM)</strong>
        <span id="trace-capability" class="es-status">No turns traced yet</span>
      </div>
      <div id="trace-stages" class="trace-stages"></div>
    </section>

    <div id="dialogs"></div>

    <form id="composer" data-limits="${limitsJson}">
      <ul id="attachments" hidden></ul>
      <div id="attachment-note" hidden></div>
      <div id="composer-error" hidden></div>
      <ul id="follow-ups" hidden></ul>
      <textarea id="prompt" rows="3" placeholder="Ask Pi cleanly with EigenScope zero-tag separation..."></textarea>
      <div class="composer-toolbar">
        <div id="context">
          <button id="context-toggle" type="button" class="quiet" aria-expanded="false" aria-label="Add context">
            <span class="plus" aria-hidden="true"></span>
          </button>
          <div id="context-actions" hidden>
            <button id="attach" type="button">
              <span class="context-label">Attach Files</span>
              <span class="context-detail">Text &le;64 KiB or images &le;4 MiB</span>
            </button>
            <button id="selection" type="button">
              <span class="context-label">Current Selection</span>
              <span class="context-detail">Attach highlighted editor lines</span>
            </button>
          </div>
          <input id="file-picker" type="file" multiple hidden />
        </div>
        <button id="approval" type="button" class="quiet">Approval</button>
        <button id="model" type="button" class="quiet model-button">
          <span id="model-label">Pi model</span>
          <span class="chevron" aria-hidden="true"></span>
        </button>
        <button id="stop" type="button" class="send-action" aria-label="Stop" hidden>
          <span class="stop-icon" aria-hidden="true"></span>
        </button>
        <button id="send" type="submit" class="send-action" aria-label="Send message">
          <span class="send-icon" aria-hidden="true"></span>
          <span id="queue-label" hidden>Queue</span>
        </button>
      </div>
    </form>

    <div id="splitter" role="separator" tabindex="0" aria-orientation="vertical" aria-label="Resize panels"></div>

    <aside class="review">
      <header class="review-header">
        <h2>Changes <span id="count"></span></h2>
        <button id="toggle-changes" type="button" aria-expanded="false">Changes <span id="compact-count"></span> <span class="chevron"></span></button>
        <button id="refresh" type="button" class="quiet">Refresh</button>
      </header>
      <div id="change-content">
        <div id="summary">No review in progress.</div>
        <ul id="files"></ul>
      </div>
    </aside>
  </div>
  <script nonce="${safeNonce}" src="${escapeAttr(markdownItUri)}"></script>
  <script nonce="${safeNonce}" src="${escapeAttr(markdownJsUri)}"></script>
  <script nonce="${safeNonce}" src="${escapeAttr(reviewJsUri)}"></script>
</body>
</html>`;
}

function createController(context) {
  const beforeSnapshots = new Map();
  let viewRef = null;
  let rpc = null;
  let busy = false;
  let approvalMode = 'inherit';
  let activeModel = '';
  let canSendImages = false;
  let messages = [];
  let traceEvents = [];
  let dialogs = [];
  let cachedApiKey = '';

  const beforeScheme = 'eigenscope-before';
  const beforeProvider = vscode.workspace.registerTextDocumentContentProvider(beforeScheme, {
    provideTextDocumentContent(uri) {
      return beforeSnapshots.get(uri.toString()) ?? '';
    },
  });
  context.subscriptions.push(beforeProvider);

  function workspaceRoot() {
    return vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || '';
  }

  const reviewManager = {
    impl: null,
    ensure(root) {
      if (!this.impl && root) {
        this.impl = createReviewManager(root);
      }
      return this.impl;
    },
  };

  function readConfig() {
    const cfg = vscode.workspace.getConfiguration('eigenscopePi');
    const rawUrl = cfg.get('endpointUrl', DEFAULT_ENDPOINT);
    let endpointUrl = DEFAULT_ENDPOINT;
    try {
      endpointUrl = normalizeEndpointUrl(rawUrl);
    } catch {
      endpointUrl = DEFAULT_ENDPOINT;
    }
    return {
      endpointUrl,
      protectionMode: cfg.get('protectionMode', 'protected'),
      piCommand: cfg.get('piCommand', 'pi'),
      traceReceiptsEnabled: Boolean(cfg.get('traceReceiptsEnabled', false)),
    };
  }

  async function refreshApiKey() {
    const stored = await context.secrets.get(SECRET_API_KEY_SLOT);
    if (stored) {
      cachedApiKey = stored.trim();
      return cachedApiKey;
    }
    try {
      const creds = readCredentialsFile();
      if (creds?.api_key || creds?.bearer_token) {
        cachedApiKey = String(creds.api_key || creds.bearer_token).trim();
        return cachedApiKey;
      }
    } catch {
      // Ignore unsafe/absent credentials file until connect runs
    }
    cachedApiKey = '';
    return '';
  }

  function postState() {
    if (!viewRef) return;
    const root = workspaceRoot();
    const mgr = reviewManager.ensure(root);
    const review = mgr ? mgr.refresh() : { active: false, rows: [], coverage: {}, omitted: 0, refreshFailed: false };
    const cfg = readConfig();
    const piProbe = probePiCli(cfg.piCommand);

    viewRef.webview.postMessage({
      type: 'state',
      ready: Boolean(root) && piProbe.available,
      busy,
      chooseFolder: !root,
      canStop: busy,
      canSteer: busy,
      model: activeModel,
      canSendImages,
      approval: approvalMode,
      status: busy ? 'Running turn...' : piProbe.available ? 'Ready' : 'Pi CLI not detected (click Set Up Pi)',
      chatTitle: root ? path.basename(root) : 'Pi',
      activeReview: review.active,
      rows: review.rows,
      coverage: review.coverage,
      omitted: review.omitted,
      refreshFailed: review.refreshFailed,
      messageOffset: 0,
      messages,
      dialogs,
      eigenscopeStatus: {
        mode: cfg.protectionMode,
        endpointUrl: cfg.endpointUrl,
        hasApiKey: Boolean(cachedApiKey || process.env.ORTHOCORE_API_KEY || process.env.EIGENSCOPE_API_KEY),
        piReady: piProbe.available,
        evidence: buildEvidenceSummary(traceEvents),
      },
      eigenscopeTraces: traceEvents,
    });
  }

  function ensureRpc() {
    const root = workspaceRoot();
    if (!root) return null;
    if (rpc) return rpc;
    const cfg = readConfig();
    const mgr = reviewManager.ensure(root);
    if (mgr && !mgr.hasBaseline()) mgr.beginBaseline();

    rpc = new PiRpcClient({
      workspaceRoot: root,
      extensionDir: context.extensionPath,
      piCommand: cfg.piCommand,
      envOverrides: {
        ORTHOCORE_BASE_URL: cfg.endpointUrl,
        ...(cachedApiKey ? { ORTHOCORE_API_KEY: cachedApiKey } : {}),
        EIGENSCOPE_PI_MODE: cfg.protectionMode,
        EIGENSCOPE_TRACE_RECEIPTS: cfg.traceReceiptsEnabled ? '1' : '0',
      },
      onEvent: (ev) => {
        if (ev.type === 'extension_ui_request') {
          if (ev.method === 'setStatus' && ev.statusKey === 'eigenscope_trace') {
            try {
              const parsed = JSON.parse(ev.statusText);
              traceEvents.push(parsed);
              if (traceEvents.length > 200) traceEvents.shift();
              viewRef?.webview.postMessage({ type: 'eigenscope-trace', events: traceEvents });
            } catch {}
            return;
          }
          if (ev.method === 'setStatus' && ev.statusKey === 'eigenscope_rehydrated') {
            try {
              const payload = JSON.parse(ev.statusText);
              const lastPi = [...messages].reverse().find((m) => m.role === 'Pi');
              if (lastPi && typeof payload.rehydratedText === 'string') {
                lastPi.text = payload.rehydratedText;
                postState();
              }
            } catch {}
            return;
          }
          dialogs.push(ev);
          postState();
          return;
        }
        if (ev.type === 'message_update' && ev.assistantMessageEvent?.type === 'text_delta') {
          const delta = ev.assistantMessageEvent.delta || '';
          const last = messages[messages.length - 1];
          if (last && last.role === 'Pi') {
            last.text += delta;
          } else {
            messages.push({ role: 'Pi', text: delta });
          }
          postState();
          return;
        }
        if (ev.type === 'turn_end' || ev.type === 'agent_end') {
          busy = false;
          postState();
        }
      },
      onExit: (code) => {
        busy = false;
        rpc = null;
        if (code && code !== 0) {
          messages.push({ role: 'Error', text: `Pi exited cleanly with status ${code}.` });
        }
        postState();
      },
    });
    rpc.start();
    return rpc;
  }

  async function connectAccount() {
    const cfg = readConfig();
    const endpointUrl = await vscode.window.showInputBox({
      prompt: 'EigenScope Gateway URL (HTTPS or loopback orthocore-sidecar)',
      value: cfg.endpointUrl,
    });
    if (!endpointUrl) return;
    const validEndpoint = normalizeEndpointUrl(endpointUrl);
    await vscode.workspace.getConfiguration('eigenscopePi').update('endpointUrl', validEndpoint, vscode.ConfigurationTarget.Global);
    const dc = await requestDeviceCode(validEndpoint);
    const verUrl = sanitizeExternalUrl(dc.verification_uri);
    if (verUrl) {
      await vscode.env.openExternal(vscode.Uri.parse(verUrl));
    }
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `EigenScope sign-in code ${dc.user_code} — finish in browser...`,
        cancellable: true,
      },
      async (_progress, token) => {
        const ac = new AbortController();
        token.onCancellationRequested(() => ac.abort());
        const res = await pollDeviceCode(validEndpoint, dc.device_code, { signal: ac.signal });
        await context.secrets.store(SECRET_API_KEY_SLOT, res.api_key);
        writeCredentialsFile({
          api_key: res.api_key,
          base_url: validEndpoint,
          tenant_id: res.tenant_id,
          key_prefix: res.key_prefix,
        });
        cachedApiKey = res.api_key;
      }
    );
    if (rpc) {
      rpc.dispose();
      rpc = null;
    }
    postState();
    vscode.window.showInformationMessage('EigenScope account connected via VS Code SecretStorage.');
  }

  async function setupPi() {
    const cfg = readConfig();
    const probe = probePiCli(cfg.piCommand);
    if (probe.available) {
      vscode.window.showInformationMessage(`Pi CLI detected (${probe.command}: ${probe.versionText}).`);
      postState();
      return;
    }
    const action = await vscode.window.showWarningMessage(
      `Pi CLI ('${probe.command}') was not found on PATH.`,
      'Copy Install Command',
      'Open Setup Guide'
    );
    if (action === 'Copy Install Command') {
      await vscode.env.clipboard.writeText(probe.installCommand);
      vscode.window.showInformationMessage(`Copied: ${probe.installCommand}`);
    } else if (action === 'Open Setup Guide') {
      await vscode.env.openExternal(vscode.Uri.parse('https://eigenscope.guardianai.network/guide/coding'));
    }
  }

  async function toggleProtection() {
    const cfg = readConfig();
    const next = nextProtectionMode(cfg.protectionMode);
    await vscode.workspace.getConfiguration('eigenscopePi').update('protectionMode', next, vscode.ConfigurationTarget.Workspace);
    if (rpc) {
      rpc.dispose();
      rpc = null;
    }
    postState();
  }

  async function handleWebviewMessage(data) {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'ready') {
      await refreshApiKey();
      postState();
      return;
    }
    if (data.type === 'toggle-protection') {
      await toggleProtection();
      return;
    }
    if (data.type === 'connect-eigenscope') {
      await connectAccount().catch((err) => vscode.window.showErrorMessage(err.message));
      return;
    }
    if (data.type === 'setup-pi') {
      await setupPi();
      return;
    }
    if (data.type === 'open-pricing') {
      const cfg = readConfig();
      await vscode.env.openExternal(vscode.Uri.parse(`${cfg.endpointUrl}/pricing`));
      return;
    }
    if (data.type === 'open-link') {
      const safe = sanitizeExternalUrl(data.href);
      if (safe) await vscode.env.openExternal(vscode.Uri.parse(safe));
      return;
    }
    if (data.type === 'copy-message') {
      await vscode.env.clipboard.writeText(String(data.text || ''));
      viewRef?.webview.postMessage({ type: 'copied', id: data.id, failed: false });
      return;
    }
    if (data.type === 'choose-folder') {
      await vscode.commands.executeCommand('vscode.openFolder');
      return;
    }
    if (data.type === 'refresh') {
      postState();
      return;
    }
    if (data.type === 'diff') {
      const root = workspaceRoot();
      const mgr = reviewManager.ensure(root);
      const entry = mgr?.getEntry(data.relative);
      if (!entry || entry.beforeText === null) return;
      const beforeUri = vscode.Uri.parse(`${beforeScheme}:/${encodeURIComponent(entry.relative)}`);
      beforeSnapshots.set(beforeUri.toString(), entry.beforeText);
      const afterUri = vscode.Uri.file(path.join(root, entry.relative));
      await vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, `${entry.relative} (EigenScope Pi Review)`);
      return;
    }
    if (data.type === 'revert') {
      const root = workspaceRoot();
      const mgr = reviewManager.ensure(root);
      if (!mgr) return;
      mgr.revertFile(data.relative);
      postState();
      return;
    }
    if (data.type === 'attach-selection') {
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.selection.isEmpty) {
        viewRef?.webview.postMessage({ type: 'composer-error', error: 'Select code in an active editor first.' });
        return;
      }
      const name = path.basename(ed.document.fileName || 'selection.txt');
      viewRef?.webview.postMessage({
        type: 'selection',
        attachment: { name, kind: 'text', text: ed.document.getText(ed.selection) },
      });
      return;
    }
    if (data.type === 'stop') {
      await rpc?.abort().catch(() => {});
      busy = false;
      postState();
      return;
    }
    if (data.type === 'new-chat') {
      messages = [];
      traceEvents = [];
      await rpc?.newSession().catch(() => {});
      viewRef?.webview.postMessage({ type: 'chat-action-done' });
      postState();
      return;
    }
    if (data.type === 'reply') {
      dialogs = dialogs.filter((d) => d.id !== data.id);
      rpc?.respondUi(data.id, data);
      postState();
      return;
    }
    if (data.type === 'send') {
      try {
        await refreshApiKey();
        const client = ensureRpc();
        if (!client) throw new Error('Open a workspace folder before running Pi.');
        const { text, images } = buildPromptWithAttachments(data.message, data.attachments);
        if (!text && !images.length) throw new Error('Enter a message or attach a file.');
        messages.push({ role: 'You', text });
        busy = true;
        viewRef?.webview.postMessage({ type: 'sent', id: data.id, busy: true });
        postState();
        if (data.steer) {
          await client.steer(text);
        } else {
          await client.prompt(text, images);
        }
      } catch (err) {
        busy = false;
        viewRef?.webview.postMessage({ type: 'sent', id: data.id, error: err.message, busy: false });
        postState();
      }
    }
  }

  const provider = {
    resolveWebviewView(webviewView) {
      viewRef = webviewView;
      const webview = webviewView.webview;
      webview.options = {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))],
      };
      const media = (rel) => webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media', ...rel)));
      webview.html = renderWebviewHtml({
        cspSource: webview.cspSource,
        styleUri: String(media(['review.css'])),
        markdownItUri: String(media(['vendor', 'markdown-it.min.js'])),
        markdownJsUri: String(media(['markdown.js'])),
        reviewJsUri: String(media(['review.js'])),
        nonce: crypto.randomBytes(16).toString('base64'),
      });
      webview.onDidReceiveMessage((msg) => void handleWebviewMessage(msg));
    },
  };

  return {
    provider,
    connectAccount,
    setupPi,
    toggleProtection,
    toggleTraceDrawer: () => viewRef?.webview.postMessage({ type: 'toggle-trace-drawer' }),
    openPricing: async () => {
      const cfg = readConfig();
      await vscode.env.openExternal(vscode.Uri.parse(`${cfg.endpointUrl}/pricing`));
    },
    dispose: () => rpc?.dispose(),
  };
}

function activate(context) {
  if (!vscode) return;
  const ctrl = createController(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('eigenscopePi.sidebar', ctrl.provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('eigenscopePi.open', () =>
      vscode.commands.executeCommand('workbench.view.extension.eigenscope-pi')
    ),
    vscode.commands.registerCommand('eigenscopePi.connectAccount', ctrl.connectAccount),
    vscode.commands.registerCommand('eigenscopePi.setupPi', ctrl.setupPi),
    vscode.commands.registerCommand('eigenscopePi.toggleProtection', ctrl.toggleProtection),
    vscode.commands.registerCommand('eigenscopePi.toggleTraceDrawer', ctrl.toggleTraceDrawer),
    vscode.commands.registerCommand('eigenscopePi.openPricing', ctrl.openPricing),
    { dispose: ctrl.dispose }
  );
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  renderWebviewHtml,
  nextProtectionMode,
  sanitizeExternalUrl,
  classifyToolApproval,
};
