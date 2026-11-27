/* global acquireVsCodeApi, renderMarkdown */
const host = acquireVsCodeApi();
const byId = (id) => document.getElementById(id);
const prompt = byId('prompt');
const transcript = byId('transcript');
const traceDrawer = byId('trace-drawer');
const traceToggle = byId('trace-toggle');
const agentsDrawer = byId('agents-drawer');
const agentsToggle = byId('agents-toggle');
const protectionToggle = byId('protection-toggle');
const eigenscopeStatusEl = byId('eigenscope-status');
const liveDialogs = new Map();
let previousMessages = [];
let fileState = '';
let copyId = 0;
const copyRequests = new Map();
let latestTraceEvents = [];
let latestCotSteps = [];
let cotActiveFilter = 'all';
let cotCollapsedIds = new Set();
let cotRefreshTimer = null;
let latestIdeAgents = null;
let agentsAutoOpened = false;

function syncCotRefreshTimer() {
  const shouldPoll = Boolean(traceDrawer && !traceDrawer.hidden && !document.hidden);
  if (shouldPoll && !cotRefreshTimer) {
    cotRefreshTimer = setInterval(() => {
      if (traceDrawer && !traceDrawer.hidden && !document.hidden) {
        host.postMessage({ type: 'refresh-cot-stream' });
      }
    }, 2500);
  } else if (!shouldPoll && cotRefreshTimer) {
    clearInterval(cotRefreshTimer);
    cotRefreshTimer = null;
  }
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(text, handler, disabled = false, description = '') {
  const node = element('button', text);
  node.type = 'button';
  node.disabled = disabled;
  if (description) node.setAttribute('aria-label', description);
  node.addEventListener('click', handler);
  return node;
}

function copyResponse(text, control) {
  const id = ++copyId;
  control.disabled = true;
  const timer = setTimeout(() => {
    copyRequests.delete(id);
    control.disabled = false;
    control.textContent = 'Retry copy';
  }, 3000);
  copyRequests.set(id, { control, timer });
  host.postMessage({ type: 'copy-message', id, text });
}

function renderTraceDrawer() {
  const body = byId('trace-stages');
  const capBadge = byId('trace-capability');
  if (!body || !capBadge) return;
  body.replaceChildren();

  const fmtNum = (val, digits = 4) => (typeof val === 'number' && Number.isFinite(val) ? val.toFixed(digits) : 'n/a');
  const fmtTime = (ts) => {
    if (!ts) return '';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts).slice(0, 19);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const steps = Array.isArray(latestCotSteps) ? latestCotSteps : [];
  const pipelineEvents = latestTraceEvents.filter(
    (ev) => ev && ev.protection_mode !== 'observed_external' && ev.protection_mode !== 'external_store'
  );
  const numericTurns = latestTraceEvents.filter((ev) => ev && Number.isFinite(ev.turn_index));
  const latestTurn = numericTurns.length ? numericTurns[numericTurns.length - 1].turn_index : null;
  const turnEvents =
    latestTurn !== null
      ? latestTraceEvents.filter((ev) => ev && ev.turn_index === latestTurn)
      : pipelineEvents.length
        ? pipelineEvents
        : latestTraceEvents;
  const decomposeEv = [...turnEvents].reverse().find((ev) => ev.stage === 'decompose' || ev.stage === 'tool_result');
  const rehydrateEv = [...turnEvents].reverse().find((ev) => ev.stage === 'rehydrate' || ev.stage === 'blocked' || ev.stage === 'scrub');

  const cotStepCount = steps.filter((s) => Boolean(s.cotText)).length;
  const toolTotalCount = steps.reduce((acc, s) => acc + (Array.isArray(s.toolCalls) ? s.toolCalls.length : 0), 0);
  const flagTotalCount = steps.reduce((acc, s) => acc + (Array.isArray(s.flags) ? s.flags.length : 0), 0);

  capBadge.textContent = `${steps.length} steps / ${cotStepCount} cot / ${toolTotalCount} tools / ${flagTotalCount} flags`;

  const filterBar = element('div', undefined, 'cot-filter-bar');
  const filterDefs = [
    ['all', 'All Steps'],
    ['cot', 'CoT Only'],
    ['tools', 'Tool Calls'],
    ['flags', 'Flags'],
  ];
  for (const [id, label] of filterDefs) {
    const btn = element('button', label, cotActiveFilter === id ? 'cot-filter-pill active' : 'cot-filter-pill');
    btn.type = 'button';
    btn.addEventListener('click', () => {
      cotActiveFilter = id;
      renderTraceDrawer();
    });
    filterBar.append(btn);
  }
  const spacer = element('div', undefined, 'cot-filter-spacer');
  const refreshBtn = element('button', 'Refresh', 'cot-filter-pill');
  refreshBtn.type = 'button';
  refreshBtn.addEventListener('click', () => host.postMessage({ type: 'refresh-cot-stream' }));
  const jumpBtn = element('button', '↓ Jump to latest', 'cot-filter-pill');
  jumpBtn.type = 'button';
  jumpBtn.addEventListener('click', () => {
    traceDrawer.scrollTop = traceDrawer.scrollHeight;
  });
  spacer.append(refreshBtn, jumpBtn);
  filterBar.append(spacer);
  body.append(filterBar);

  if (decomposeEv || rehydrateEv) {
    const stripParts = [];
    if (decomposeEv) {
      stripParts.push(
        `Stage 1 Guard: ${decomposeEv.status} (${decomposeEv.symbol_count ?? 0} sym · eta=${fmtNum(decomposeEv.task_sufficiency_eta, 4)} · MI=${fmtNum(decomposeEv.mi_leakage_bound_bits, 4)} bits)`
      );
    }
    if (rehydrateEv) {
      stripParts.push(
        `Stage 3 Rehydrate: ${rehydrateEv.status} (resolved=${rehydrateEv.symbols_resolved ?? 0} · scrubbed=${rehydrateEv.vault_ticket_scrubbed ? 'YES' : 'pending'})`
      );
    }
    body.append(element('div', stripParts.join('  |  '), 'cot-summary-strip'));
  }

  const filteredSteps = steps.filter((step) => {
    if (cotActiveFilter === 'cot') return Boolean(step.cotText || step.encryptedOnly);
    if (cotActiveFilter === 'tools') return Array.isArray(step.toolCalls) && step.toolCalls.length > 0;
    if (cotActiveFilter === 'flags') return Array.isArray(step.flags) && step.flags.length > 0;
    return true;
  });

  if (!filteredSteps.length) {
    body.append(
      element(
        'p',
        steps.length
          ? `No steps match the '${cotActiveFilter}' filter. Click 'All Steps' or 'Refresh'.`
          : 'No agent CoT steps discovered yet. Start a Pi, Claude Code, Codex, Gemini CLI, Cursor, or Antigravity session in this workspace and CoT Explorer streams reasoning in RAM without saving content to disk.',
        'trace-kv'
      )
    );
    return;
  }

  for (const step of filteredSteps) {
    const hasFlags = Array.isArray(step.flags) && step.flags.length > 0;
    const card = element('article', undefined, hasFlags ? 'cot-stream-card' : 'cot-stream-card clear');
    const head = element('div', undefined, 'cot-stream-head');
    head.append(
      element('span', `#${step.stepNumber}`, 'cot-step-num'),
      element('span', step.surface || 'agent', 'cot-kind-badge'),
      element('span', step.kind || 'CHAIN OF THOUGHT', 'cot-kind-badge')
    );
    const tcCount = Array.isArray(step.toolCalls) ? step.toolCalls.length : 0;
    if (tcCount > 0) {
      head.append(element('span', `${tcCount} ${tcCount === 1 ? 'tool' : 'tools'}`, 'cot-tool-badge'));
    }
    const metaRight = [];
    if (step.timestamp) metaRight.push(fmtTime(step.timestamp));
    if (step.tokensIn !== null || step.tokensOut !== null) {
      metaRight.push(`${step.tokensIn ?? 0} in / ${step.tokensOut ?? 0} out`);
    }
    if (metaRight.length) {
      head.append(element('span', metaRight.join(' · '), 'cot-meta-right'));
    }
    card.append(head);

    if (hasFlags) {
      const warn = element('div', undefined, 'cot-warning-banner');
      warn.append(element('span', `${step.flags[0].label}:`));
      for (const flag of step.flags) {
        if (flag.keyword) {
          warn.append(element('span', flag.keyword, 'cot-keyword-chip'));
        }
      }
      card.append(warn);
    }

    if (step.cotText || step.encryptedOnly) {
      const box = element('div', undefined, 'cot-thought-box');
      const thHead = element('div', undefined, 'cot-thought-head');
      thHead.append(element('span', 'CHAIN OF THOUGHT'));
      if (hasFlags) {
        thHead.append(element('span', 'HEDGING', 'cot-hedging-pill'));
      }
      const isCollapsed = cotCollapsedIds.has(step.id);
      const colBtn = element('button', isCollapsed ? 'expand' : 'collapse', 'cot-collapse-btn');
      colBtn.type = 'button';
      colBtn.addEventListener('click', () => {
        if (cotCollapsedIds.has(step.id)) cotCollapsedIds.delete(step.id);
        else cotCollapsedIds.add(step.id);
        renderTraceDrawer();
      });
      thHead.append(colBtn);
      box.append(thHead);
      if (!isCollapsed) {
        const txt = step.cotText || '[Provider emitted encrypted reasoning tokens without plaintext summary]';
        box.append(element('pre', txt, 'cot-thought-body'));
      }
      card.append(box);
    }

    if (tcCount > 0) {
      for (const tc of step.toolCalls) {
        const tBox = element('div', undefined, 'cot-tool-box');
        const tHead = element('div', undefined, 'cot-tool-head');
        tHead.append(element('span', tc.name || 'tool'));
        if (tc.target) {
          tHead.append(element('span', tc.target, 'cot-tool-target'));
        }
        tBox.append(tHead);
        if (tc.argsPreview) {
          const det = document.createElement('details');
          det.className = 'cot-tool-details';
          const sum = element('summary', 'ARGUMENTS');
          det.append(sum, element('pre', tc.argsPreview, 'trace-pre'));
          tBox.append(det);
        }
        card.append(tBox);
      }
    }

    body.append(card);
  }
}

function renderAgentsDrawer(ideAgents) {
  if (!agentsToggle || !agentsDrawer) return;
  const list = byId('agents-list');
  const summary = byId('agents-summary');
  if (!ideAgents || !Array.isArray(ideAgents.agents)) {
    agentsToggle.textContent = 'In-IDE Agents';
    return;
  }
  const agents = ideAgents.agents;
  const unprot = Number(ideAgents.unprotectedCount || 0);
  const extUnprot = Number(ideAgents.externalUnprotected || 0);
  agentsToggle.textContent = unprot > 0 ? `In-IDE Agents (${unprot} setup)` : `In-IDE Agents (${agents.length} OK)`;
  agentsToggle.className = unprot > 0 ? 'quiet es-pill warn' : 'quiet es-pill ok';
  if (summary) summary.textContent = ideAgents.summary || '';
  if (!agentsAutoOpened && extUnprot > 0) {
    agentsAutoOpened = true;
    agentsDrawer.hidden = false;
    agentsToggle.setAttribute('aria-expanded', 'true');
  }
  if (!list) return;
  list.replaceChildren();
  for (const ag of agents) {
    const card = element('section', undefined, 'agent-card');
    const head = element('div', undefined, 'agent-card-head');
    head.append(
      element('strong', ag.displayName || ag.id),
      element('span', ag.protected ? 'Protected' : 'Needs Setup', ag.protected ? 'agent-badge ok' : 'agent-badge warn')
    );
    card.append(
      head,
      element('div', `${ag.source} · ${ag.distributionClient}`, 'trace-kv'),
      element('div', ag.mechanism, 'trace-kv'),
      element('div', ag.detail, 'trace-kv')
    );
    list.append(card);
  }
}

function renderEigenScopeHeader(status) {
  if (!protectionToggle || !eigenscopeStatusEl) return;
  const mode = status?.mode || 'protected';
  protectionToggle.textContent =
    mode === 'protected'
      ? 'Protected (EigenScope)'
      : mode === 'audit'
        ? 'Audit (Observe)'
        : 'Standard (Unprotected)';
  protectionToggle.className = `es-pill ${mode}`;
  const keyBadge = status?.hasApiKey ? 'Connected' : 'Not signed in';
  const piBadge = status?.piReady ? 'Pi ready' : 'Pi setup needed';
  eigenscopeStatusEl.textContent = `${keyBadge} · ${piBadge} · ${status?.endpointUrl || 'https://eigenscope.guardianai.network'}`;
}

function renderMessages(messages) {
  const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 48;
  let i = 0;
  for (; i < messages.length && i < previousMessages.length; i++) {
    if (messages[i].text !== previousMessages[i].text || messages[i].role !== previousMessages[i].role) break;
  }
  while (transcript.children.length > i) transcript.lastElementChild.remove();
  for (; i < messages.length; i++) {
    const { role, text } = messages[i];
    const node = element('article', undefined, 'message' + (role.toLowerCase().includes('error') ? ' error' : ''));
    const heading = element('div', undefined, 'message-heading');
    heading.append(element('strong', role));
    node.append(heading);
    if (role === 'Pi') {
      const control = button('Copy', () => copyResponse(text, control), false, 'Copy response as Markdown');
      control.className = 'quiet copy-response';
      heading.append(control);
      const body = element('div', undefined, 'markdown-body');
      renderMarkdown(text, body, (href) => host.postMessage({ type: 'open-link', href }));
      node.append(body);
    } else if (role === 'Tool' || role === 'Tool error') {
      const newline = text.indexOf('\n');
      if (newline < 0) {
        node.append(element('div', text, 'message-text'));
      } else {
        const details = element('details', undefined, 'tool-output');
        details.open = role === 'Tool error';
        details.append(element('summary', text.slice(0, newline)), element('pre', text.slice(newline + 1)));
        node.append(details);
      }
    } else {
      node.append(element('div', text, 'message-text'));
    }
    transcript.append(node);
  }
  previousMessages = messages;
  if (atBottom) transcript.scrollTop = transcript.scrollHeight;
}

function renderFiles(rows, busy, refreshFailed) {
  const next = JSON.stringify([rows, busy, refreshFailed]);
  if (fileState === next) return;
  fileState = next;
  const list = byId('files');
  const focused = document.activeElement?.dataset?.fileAction;
  list.replaceChildren();
  for (const row of rows) {
    const item = element('li', undefined, 'file');
    const top = element('div', undefined, 'file-header');
    if (row.onDisk) {
      top.append(element('span', row.relative, 'file-name'));
    } else {
      const diff = button(row.relative, () => host.postMessage({ type: 'diff', relative: row.relative }), !row.diff, 'Open diff for ' + row.relative);
      diff.className = 'file-name';
      diff.dataset.fileAction = 'diff:' + row.relative;
      const revert = button('Revert', () => host.postMessage({ type: 'revert', relative: row.relative }),
        busy || refreshFailed || !row.revert, 'Revert Pi changes to ' + row.relative);
      revert.dataset.fileAction = 'revert:' + row.relative;
      top.append(diff, revert);
    }
    const meta = element('div', row.kind, 'meta');
    if (row.counts) {
      meta.append(document.createTextNode(' · '), element('span', '+' + row.counts.added, 'add'),
        document.createTextNode(' '), element('span', '−' + row.counts.removed, 'remove'));
    }
    item.append(top, meta);
    if (row.reason) item.append(element('div', row.reason, 'reason'));
    list.append(item);
  }
  if (focused) {
    for (const item of list.querySelectorAll('[data-file-action]')) {
      if (item.dataset.fileAction === focused && !item.disabled) item.focus();
    }
  }
}

function renderDialogs(dialogs) {
  const ids = new Set(dialogs.map((item) => item.id));
  for (const [id, node] of liveDialogs) {
    if (!ids.has(id)) {
      node.remove();
      liveDialogs.delete(id);
    }
  }
  for (const item of dialogs) {
    if (liveDialogs.has(item.id)) continue;
    const node = element('section', undefined, item.approval?.highRisk ? 'dialog high-risk' : 'dialog');
    const actions = element('div', undefined, 'dialog-actions');
    const reply = (response) => {
      for (const control of actions.querySelectorAll('button')) control.disabled = true;
      host.postMessage({ type: 'reply', id: item.id, ...response });
    };
    const title = element('h3', item.approval?.title || item.title || 'Pi needs your input');
    node.append(title);
    if (item.approval) {
      if (item.approval.context) node.append(element('p', item.approval.context, 'dialog-context'));
      node.append(element('pre', item.approval.detail, 'dialog-detail'));
    }
    if (item.message) node.append(element('p', item.message));
    const addAction = (label, response, primary = false) => {
      const control = button(label, () => reply(response));
      control.className = primary ? 'dialog-primary' : 'quiet';
      actions.append(control);
    };
    if (item.approval) {
      addAction('Block', { index: 1 }, item.approval.highRisk);
      addAction('Allow', { index: 0 }, !item.approval.highRisk);
    } else if (item.method === 'select') {
      item.options.forEach((option, index) => addAction(option, { index }));
    } else if (item.method === 'confirm') {
      addAction('No', { confirmed: false });
      addAction('Yes', { confirmed: true }, true);
    } else {
      const input = element(item.method === 'editor' ? 'textarea' : 'input');
      input.setAttribute('aria-label', 'Reply to Pi');
      input.value = item.prefill;
      input.placeholder = item.placeholder;
      node.append(input);
      const control = button('Reply', () => reply({ value: input.value }));
      control.className = 'dialog-primary';
      actions.append(control);
    }
    addAction('Cancel', { cancelled: true });
    node.append(actions);
    byId('dialogs').append(node);
    liveDialogs.set(item.id, node);
  }
}

const composer = byId('composer');
const limits = JSON.parse(composer.dataset.limits);
const picker = byId('file-picker');
const contextToggle = byId('context-toggle');
const contextActions = byId('context-actions');
const toggleChanges = byId('toggle-changes');
const attachmentList = byId('attachments');
const send = byId('send');
const followUps = byId('follow-ups');
const stop = byId('stop');
const supportedImage = /\.(png|jpe?g|gif|webp)$/i;
const attachments = [];
const queued = [];
const parkedDrafts = new Map();
const queueLimit = 5;
const queuedBytesLimit = 12 * 1024 * 1024;
const stagedBytesLimit = 2 * queuedBytesLimit;
let composerState = {};
let nextSend = 0;
let pendingSend;
let queuePaused = false;
let selecting = false;
let chatActionPending = false;
let changeCount = 0;
let changesExpanded;

function updateChanges() {
  toggleChanges.setAttribute('aria-expanded', String(changesExpanded ?? changeCount > 0));
}

function showContext(open) {
  contextActions.hidden = !open;
  contextToggle.setAttribute('aria-expanded', String(open));
  if (open) byId('attach').focus();
}

function showComposerError(text = '') {
  const error = byId('composer-error');
  error.hidden = !text;
  error.textContent = text;
}

function updateComposer() {
  const unavailable = composerState.chooseFolder || composerState.ready !== true;
  const switching = chatActionPending || composerState.switchingChat;
  const draftLocked = unavailable || switching || Boolean(pendingSend && !pendingSend.queued);
  const needsImageModel = composerState.canSendImages !== true && attachments.some((item) => item.kind === 'image');
  const note = byId('attachment-note');
  note.hidden = !attachments.length;
  note.textContent = needsImageModel
    ? 'Pi can read screenshots first and include the details with your message.'
    : 'Attachments go to the model when you send.';
  prompt.readOnly = draftLocked;
  contextToggle.disabled = draftLocked;
  byId('attach').disabled = draftLocked;
  if (draftLocked && !contextActions.hidden) showContext(false);
  byId('selection').disabled = draftLocked || selecting;
  byId('model').disabled = draftLocked || composerState.busy || composerState.choosingModel || composerState.choosingApproval;
  for (const id of ['sessions', 'new-chat']) {
    const action = byId(id);
    action.hidden = Boolean(composerState.chooseFolder);
    action.disabled = byId('model').disabled || Boolean(pendingSend) || selecting || composerState.hasDialog;
    action.title = composerState.busy ? 'Wait for Pi to finish or stop the current turn before switching chats.' : '';
  }
  const approval = byId('approval');
  approval.hidden = Boolean(composerState.chooseFolder);
  approval.disabled = byId('model').disabled;
  approval.textContent = composerState.approval && composerState.approval !== 'inherit'
    ? 'Approval · ' + composerState.approval[0].toUpperCase() + composerState.approval.slice(1)
    : 'Approval';
  byId('model-label').textContent = composerState.model || 'Pi model';
  byId('model').title = composerState.model
    ? composerState.model + (composerState.canSendImages ? ' · text and images' : ' · text')
    : 'Choose a Pi model';
  const queueMode = Boolean(composerState.busy || queued.length);
  send.disabled = draftLocked || Boolean(pendingSend) || selecting || composerState.choosingModel || composerState.choosingApproval ||
    (!prompt.value.trim() && !attachments.length);
  const sendLabel = pendingSend ? 'Sending message' : queueMode ? 'Queue follow-up' : 'Send message';
  send.title = sendLabel + (pendingSend ? '…' : ' (Command or Control + Enter)');
  send.setAttribute('aria-label', sendLabel);
  send.classList.toggle('queue-mode', queueMode);
  byId('queue-label').hidden = !queueMode;
  send.querySelector('.send-icon').hidden = queueMode;
  stop.hidden = !composerState.canStop;
  for (const control of attachmentList.querySelectorAll('button')) control.disabled = draftLocked;
  updateFollowUps();
}

function renderAttachments(focusIndex) {
  attachmentList.replaceChildren();
  attachmentList.hidden = !attachments.length;
  for (const [index, item] of attachments.entries()) {
    const chip = element('li', undefined, 'attachment');
    const label = element('span', item.name);
    label.title = item.name;
    const size = element('span', item.size < 1024 ? item.size + ' B' : Math.ceil(item.size / 1024) + ' KiB', 'attachment-size');
    const remove = button('×', () => {
      attachments.splice(index, 1);
      showComposerError();
      renderAttachments(index);
    }, false, 'Remove ' + item.name);
    chip.append(label, size, remove);
    attachmentList.append(chip);
  }
  updateComposer();
  if (focusIndex !== undefined) {
    const index = Math.min(focusIndex, attachmentList.children.length - 1);
    (attachmentList.children[index]?.lastElementChild ?? contextToggle).focus();
  }
}

function attachmentBytes(drafts) {
  return drafts.reduce((sum, draft) => sum + draft.attachments.reduce((bytes, file) => bytes + file.size, 0), 0);
}

function stage(item) {
  if (attachments.length >= limits.count) throw new Error('Attach up to six files per message.');
  const total = attachments.reduce((bytes, entry) => bytes + (entry.kind === item.kind ? entry.size : 0), item.size);
  const isImage = item.kind === 'image';
  if (!item.size || item.size > limits[item.kind] || total > (isImage ? limits.totalImage : limits.totalText)) {
    throw new Error(isImage
      ? 'Images must be up to 4 MiB each and 6 MiB total.'
      : 'Text files must contain text and fit within 64 KiB each and 96 KiB total.');
  }
  const activeBytes = attachmentBytes([{ attachments }, ...queued]);
  const parkedBytes = [...parkedDrafts.values()].reduce((sum, draft) => sum + attachmentBytes([draft, ...draft.queued]), 0);
  if (activeBytes + parkedBytes + item.size > stagedBytesLimit) {
    throw new Error('Keep attachments under 24 MiB across this window’s drafts.');
  }
  attachments.push(item);
}

function stageFiles(files) {
  if (byId('attach').disabled) return;
  showComposerError();
  for (const file of files) {
    try {
      const isImage = supportedImage.test(file.name) || /^image\/(png|jpeg|gif|webp)$/i.test(file.type);
      if (!isImage && file.type.startsWith('image/') && file.type !== 'image/svg+xml') {
        throw new Error('Use a PNG, JPEG, GIF or WebP image.');
      }
      stage({ file, name: file.name, kind: isImage ? 'image' : 'text', size: file.size });
    } catch (error) {
      showComposerError(file.name + ' · ' + error.message);
      if (attachments.length >= limits.count) break;
    }
  }
  renderAttachments();
}

async function readAttachment(item) {
  const { name, kind, file } = item;
  if (!file) return { name, kind, text: item.text };
  try {
    if (kind === 'text') {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      return { name, kind, text };
    }
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',', 2)[1]);
      reader.onerror = () => reject(reader.error);
      reader.onabort = () => reject(new Error('File read was cancelled.'));
      reader.readAsDataURL(file);
    });
    return { name, kind, data };
  } catch {
    throw new Error('Could not read ' + name + (kind === 'text' ? ' as UTF-8 text.' : '. Choose the image again.'));
  }
}

function renderFollowUps() {
  followUps.replaceChildren();
  followUps.hidden = queued.length === 0;
  for (const draft of queued) {
    const item = element('li', undefined, 'follow-up');
    const preview = (draft.message.trim() || draft.attachments.map(({ name }) => name).join(', ')).slice(0, 300);
    const summary = element('span', preview);
    summary.title = preview;
    const action = button('', () => {
      if (composerState.canSteer) {
        void dispatchDraft(draft, true, true);
      } else {
        queuePaused = false;
        draft.error = undefined;
        void dispatchDraft(draft, true);
      }
    });
    action.className = 'quiet follow-up-action';
    const remove = button('×', () => {
      queued.splice(queued.indexOf(draft), 1);
      if (!queued.length) queuePaused = false;
      renderFollowUps();
      (followUps.querySelector('.follow-up-remove:not(:disabled)') ?? prompt).focus();
      drainFollowUps();
    }, false, 'Remove queued follow-up');
    remove.className = 'quiet follow-up-remove';
    item.append(summary, action, remove);
    followUps.append(item);
  }
  updateFollowUps();
}

function updateFollowUps() {
  for (const [index, item] of [...followUps.children].entries()) {
    const draft = queued[index];
    const active = pendingSend?.draft === draft;
    const steer = composerState.canSteer;
    const action = item.querySelector('.follow-up-action');
    action.textContent = active ? 'Sending…' : steer ? 'Steer' : composerState.busy ? 'Waiting' : draft.error ? 'Retry' : queuePaused ? 'Send' : 'Waiting';
    action.disabled = !composerState.ready || Boolean(pendingSend) || chatActionPending || composerState.switchingChat ||
      composerState.choosingModel || composerState.choosingApproval ||
      (!steer && (composerState.busy || (!draft.error && !queuePaused)));
    action.title = draft.error || (steer ? 'Move to the next Pi tool boundary' : action.textContent);
    item.querySelector('.follow-up-remove').disabled = active || chatActionPending || composerState.switchingChat;
  }
}

function clearDraft() {
  prompt.value = '';
  attachments.length = 0;
  renderAttachments();
}

function restoreChatDraft(outgoing, incoming) {
  const incomingDraft = parkedDrafts.get(incoming);
  parkedDrafts.delete(incoming);
  if (prompt.value || attachments.length || queued.length) {
    parkedDrafts.set(outgoing, { message: prompt.value, attachments: [...attachments], queued: [...queued] });
  }
  prompt.value = incomingDraft?.message ?? '';
  attachments.splice(0, attachments.length, ...(incomingDraft?.attachments ?? []));
  queued.splice(0, queued.length, ...(incomingDraft?.queued ?? []));
  queuePaused = queued.length > 0;
  renderAttachments();
  renderFollowUps();
}

function completeDraft(error, busy) {
  const pending = pendingSend;
  pendingSend = undefined;
  if (typeof busy === 'boolean') composerState.busy = busy;
  if (error) {
    if (pending.queued) pending.draft.error = error;
    showComposerError(error);
  } else if (pending.queued) {
    queued.splice(queued.indexOf(pending.draft), 1);
    if (!queued.length) queuePaused = false;
  } else {
    clearDraft();
  }
  renderFollowUps();
  updateComposer();
  drainFollowUps();
}

async function dispatchDraft(draft, isQueued = false, steer = false) {
  const id = ++nextSend;
  pendingSend = { id, draft, queued: isQueued };
  showComposerError();
  updateComposer();
  try {
    const content = [];
    for (const item of draft.attachments) content.push(await readAttachment(item));
    host.postMessage({ type: 'send', id, message: draft.message, attachments: content, steer });
  } catch (error) {
    completeDraft(error.message);
  }
}

function drainFollowUps() {
  const next = queued[0];
  if (!next || next.error || queuePaused || pendingSend || !composerState.ready || composerState.busy ||
      composerState.choosingModel || composerState.choosingApproval || chatActionPending || composerState.switchingChat) return;
  void dispatchDraft(next, true);
}

protectionToggle?.addEventListener('click', () => host.postMessage({ type: 'toggle-protection' }));
byId('connect-eigenscope')?.addEventListener('click', () => host.postMessage({ type: 'connect-eigenscope' }));
byId('setup-pi')?.addEventListener('click', () => host.postMessage({ type: 'setup-pi' }));
byId('open-pricing')?.addEventListener('click', () => host.postMessage({ type: 'open-pricing' }));
traceToggle?.addEventListener('click', () => {
  const nextOpen = traceDrawer.hidden;
  traceDrawer.hidden = !nextOpen;
  traceToggle.setAttribute('aria-expanded', String(nextOpen));
  syncCotRefreshTimer();
  if (nextOpen) host.postMessage({ type: 'refresh-cot-stream' });
  renderTraceDrawer();
});
agentsToggle?.addEventListener('click', () => {
  const nextOpen = agentsDrawer.hidden;
  agentsDrawer.hidden = !nextOpen;
  agentsToggle.setAttribute('aria-expanded', String(nextOpen));
  if (latestIdeAgents) renderAgentsDrawer(latestIdeAgents);
});
byId('configure-agents-btn')?.addEventListener('click', () => host.postMessage({ type: 'configure-ide-agents' }));
byId('rescan-agents-btn')?.addEventListener('click', () => host.postMessage({ type: 'rescan-ide-agents' }));
byId('copy-init-btn')?.addEventListener('click', () => host.postMessage({ type: 'copy-init-command' }));
byId('open-agent-guide-btn')?.addEventListener('click', () => host.postMessage({ type: 'open-agent-guide' }));

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  if (send.disabled) return;
  const draft = { message: prompt.value, attachments: [...attachments] };
  if (!composerState.busy && !queued.length) {
    void dispatchDraft(draft);
    return;
  }
  const totalBytes = attachmentBytes([...queued, draft]);
  if (queued.length >= queueLimit || totalBytes > queuedBytesLimit) {
    showComposerError('Keep the queue to five messages and 12 MiB of attachments.');
    return;
  }
  queued.push(draft);
  clearDraft();
  showComposerError();
  renderFollowUps();
  drainFollowUps();
});
prompt.addEventListener('input', updateComposer);
prompt.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) {
    event.preventDefault();
    if (!event.repeat && !send.disabled) composer.requestSubmit();
  }
});
prompt.addEventListener('paste', (event) => {
  if (event.clipboardData?.files.length) {
    event.preventDefault();
    stageFiles(event.clipboardData.files);
  }
});
composer.addEventListener('dragover', (event) => {
  if (event.dataTransfer.types.includes('Files')) {
    event.preventDefault();
    event.dataTransfer.dropEffect = byId('attach').disabled ? 'none' : 'copy';
  }
});
composer.addEventListener('drop', (event) => {
  if (!event.dataTransfer.files.length) return;
  event.preventDefault();
  stageFiles(event.dataTransfer.files);
});
contextToggle.addEventListener('click', () => showContext(contextActions.hidden));
contextActions.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  event.stopPropagation();
  showContext(false);
  contextToggle.focus();
});
byId('context').addEventListener('focusout', ({ relatedTarget }) => {
  if (relatedTarget && !byId('context').contains(relatedTarget)) showContext(false);
});
document.addEventListener('pointerdown', (event) => {
  if (!byId('context').contains(event.target)) showContext(false);
});
byId('attach').addEventListener('click', () => {
  picker.click();
  showContext(false);
  contextToggle.focus();
});
picker.addEventListener('change', () => {
  stageFiles(picker.files);
  picker.value = '';
  prompt.focus();
});
byId('selection').addEventListener('click', () => {
  showContext(false);
  contextToggle.focus();
  selecting = true;
  showComposerError();
  updateComposer();
  host.postMessage({ type: 'attach-selection' });
});
byId('model').addEventListener('click', () => {
  showComposerError();
  host.postMessage({ type: 'choose-model' });
});
byId('approval').addEventListener('click', () => host.postMessage({ type: 'choose-approval' }));
for (const type of ['sessions', 'new-chat']) {
  byId(type).addEventListener('click', () => {
    chatActionPending = true;
    updateComposer();
    const drafts = type === 'sessions'
      ? [...parkedDrafts].reverse().slice(0, 200).map(([id, draft]) => ({
        id,
        title: (draft.message.trim() || draft.queued[0]?.message.trim() || '').slice(0, 120),
      }))
      : undefined;
    host.postMessage({ type, drafts, hasDraft: Boolean(prompt.value || attachments.length || queued.length) });
  });
}
byId('choose-folder').addEventListener('click', () => host.postMessage({ type: 'choose-folder' }));
stop.addEventListener('click', () => {
  if (queued.length) queuePaused = true;
  updateFollowUps();
  host.postMessage({ type: 'stop' });
});
byId('refresh').addEventListener('click', () => host.postMessage({ type: 'refresh' }));
toggleChanges.addEventListener('click', () => {
  changesExpanded = toggleChanges.getAttribute('aria-expanded') !== 'true';
  updateChanges();
});

window.addEventListener('message', ({ data }) => {
  if (data?.type === 'eigenscope-status') {
    renderEigenScopeHeader(data.status);
    return;
  }
  if (data?.type === 'eigenscope-trace') {
    latestTraceEvents = Array.isArray(data.events) ? data.events : [];
    renderTraceDrawer();
    return;
  }
  if (data?.type === 'toggle-trace-drawer') {
    const nextOpen = traceDrawer.hidden;
    traceDrawer.hidden = !nextOpen;
    traceToggle.setAttribute('aria-expanded', String(nextOpen));
    syncCotRefreshTimer();
    if (nextOpen) host.postMessage({ type: 'refresh-cot-stream' });
    renderTraceDrawer();
    return;
  }
  if (data?.type === 'chat-action-done') {
    chatActionPending = false;
    if (data.changed) {
      restoreChatDraft(data.changed.outgoing, data.changed.incoming);
      showComposerError();
      prompt.focus();
    }
    updateComposer();
    drainFollowUps();
    return;
  }
  if (data?.type === 'copied') {
    const request = copyRequests.get(data.id);
    if (request) {
      clearTimeout(request.timer);
      copyRequests.delete(data.id);
      request.control.disabled = false;
      request.control.textContent = data.failed ? 'Retry copy' : 'Copied';
      setTimeout(() => { request.control.textContent = 'Copy'; }, 1500);
    }
    return;
  }
  if (data?.type === 'sent' && pendingSend?.id === data.id) {
    completeDraft(data.error, data.busy);
    return;
  }
  if (data?.type === 'selection') {
    selecting = false;
    try {
      const item = data.attachment;
      stage({ ...item, size: new TextEncoder().encode(item.text).length });
      renderAttachments();
      prompt.focus();
    } catch (error) {
      showComposerError(error.message);
      updateComposer();
    }
    return;
  }
  if (data?.type === 'composer-error') {
    selecting = false;
    showComposerError(data.error);
    updateComposer();
    return;
  }
  if (data?.type !== 'state') return;
  const { ready, busy, chooseFolder, canStop, canSteer, model, canSendImages, choosingModel, approval, choosingApproval, switchingChat } = data;
  const next = { ready, busy, chooseFolder, canStop, canSteer, model, canSendImages, choosingModel, approval, choosingApproval,
    switchingChat, hasDialog: data.dialogs.length > 0 };
  if (Object.keys(next).some((key) => next[key] !== composerState[key])) {
    composerState = next;
    updateComposer();
  }
  if (data.eigenscopeStatus) renderEigenScopeHeader(data.eigenscopeStatus);
  if (data.ideAgents) {
    latestIdeAgents = data.ideAgents;
    renderAgentsDrawer(data.ideAgents);
  }
  if (Array.isArray(data.eigenscopeTraces)) {
    latestTraceEvents = data.eigenscopeTraces;
  }
  if (Array.isArray(data.cotSteps)) {
    latestCotSteps = data.cotSteps;
  }
  if ((Array.isArray(data.eigenscopeTraces) || Array.isArray(data.cotSteps)) && !traceDrawer.hidden) {
    renderTraceDrawer();
  }
  byId('status').textContent = data.status;
  byId('chat-title').textContent = data.chatTitle || 'Pi';
  byId('chat-title').title = data.chatTitle || '';
  byId('choose-folder').hidden = !data.chooseFolder;
  byId('refresh').disabled = (!data.activeReview && !data.resumedChanges) || data.switchingChat;
  if (changeCount !== data.rows.length) {
    changeCount = data.rows.length;
    updateChanges();
  }
  for (const id of ['count', 'compact-count']) {
    const count = byId(id);
    count.textContent = String(changeCount);
    count.hidden = changeCount === 0;
  }
  const summary = byId('summary');
  const reasons = { fileSize: 'over 4 MiB', budget: 'over the workspace budget', restricted: 'unsupported file type', unreadable: 'could not be read safely' };
  const coverage = Object.entries(data.coverage || {}).filter(([key, count]) => count && reasons[key]).map(([key, count]) => count + ' ' + reasons[key]).join(' · ');
  summary.textContent = data.refreshFailed ? 'Refresh failed. Reload the file list before reverting.'
    : data.resumedChanges ? (data.resumedChanges.status !== 'available' ? 'Git could not report the files currently on disk.'
      : data.rows.length || data.resumedChanges.omitted
        ? 'Changes already on disk. Use Source Control for diffs.' +
          (data.resumedChanges.omitted ? ' ' + data.resumedChanges.omitted + ' paths excluded or beyond the list limit.' : '')
        : 'Git reports a clean working tree.')
    : !data.activeReview ? 'No review in progress.'
    : data.omitted ? 'Limited diff coverage · ' + coverage
    : data.rows.length ? '' : 'No changes since this Pi review began.';
  summary.hidden = !summary.textContent;
  if (data.messageOffset > previousMessages.length) {
    host.postMessage({ type: 'ready' });
  } else if (data.messages.length || data.messageOffset !== previousMessages.length) {
    renderMessages(previousMessages.slice(0, data.messageOffset).concat(data.messages));
  }
  renderDialogs(data.dialogs);
  renderFiles(data.rows, data.busy, data.refreshFailed);
  drainFollowUps();
});

const splitter = byId('splitter');
const splitLayout = document.querySelector('.layout');
let preferredShare = Number(host.getState()?.conversationShare) || 65;

function shareBounds() {
  const width = splitLayout.clientWidth;
  return [Math.ceil(280 / width * 100), Math.floor((width - 180) / width * 100)];
}

function setShare(share, save = false) {
  if (!splitter.offsetWidth) return;
  const [min, max] = shareBounds();
  const value = Math.max(min, Math.min(max, Math.round(share)));
  if (save) preferredShare = value;
  splitLayout.style.setProperty('--conversation-share', value + '%');
  splitter.setAttribute('aria-valuemin', String(min));
  splitter.setAttribute('aria-valuemax', String(max));
  splitter.setAttribute('aria-valuenow', String(value));
}

function moveSplitter(event) {
  const bounds = splitLayout.getBoundingClientRect();
  setShare((event.clientX - bounds.left) / bounds.width * 100, true);
}
splitter.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  splitter.setPointerCapture(event.pointerId);
  splitter.classList.add('dragging');
  moveSplitter(event);
});
splitter.addEventListener('pointermove', (event) => {
  if (splitter.hasPointerCapture(event.pointerId)) moveSplitter(event);
});
splitter.addEventListener('lostpointercapture', () => {
  splitter.classList.remove('dragging');
  host.setState({ conversationShare: preferredShare });
});
splitter.addEventListener('keydown', (event) => {
  const current = Number(splitter.getAttribute('aria-valuenow'));
  const [min, max] = shareBounds();
  const choices = { ArrowLeft: current - 5, ArrowRight: current + 5, Home: min, End: max };
  if (!Object.hasOwn(choices, event.key)) return;
  event.preventDefault();
  setShare(choices[event.key], true);
  host.setState({ conversationShare: preferredShare });
});
new ResizeObserver(() => setShare(preferredShare)).observe(splitLayout);

host.postMessage({ type: 'ready' });
document.addEventListener('visibilitychange', () => {
  syncCotRefreshTimer();
  if (!document.hidden) host.postMessage({ type: 'ready' });
});
