'use strict';

const RISKY_BASH_PATTERNS = [
  { label: 'curl or wget pipe execution', re: /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sh|bash|zsh|pwsh|python)\b/i },
  { label: 'recursive delete command', re: /\brm\s+-[^\n]*r[^\n]*\s+(?:\/|~|\.\.)\b/i },
  { label: 'SSH or credential access', re: /(?:~\/\.ssh|id_rsa|id_ed25519|\.config\/eigenscope\/credentials\.json)/i },
  { label: 'git force push or reset hard', re: /\bgit\s+(?:push\s+[^\n]*--force|reset\s+--hard)\b/i },
];

function classifyToolApproval(toolName, input, policy = 'inherit') {
  if (policy === 'always' || policy === 'allow') {
    return { requirePrompt: false, highRisk: false };
  }
  const command = typeof input?.command === 'string' ? input.command : JSON.stringify(input || '');
  for (const pat of RISKY_BASH_PATTERNS) {
    if (pat.re.test(command)) {
      return {
        requirePrompt: true,
        highRisk: true,
        title: `Approve ${toolName || 'tool'} (${pat.label})?`,
        context: 'High-risk tool invocation flagged before execution.',
        detail: command.slice(0, 800),
      };
    }
  }
  if (policy === 'ask' || policy === 'strict') {
    return {
      requirePrompt: true,
      highRisk: false,
      title: `Allow tool '${toolName || 'tool'}'?`,
      context: 'Tool approval mode is set to prompt before running tools.',
      detail: command.slice(0, 800),
    };
  }
  return { requirePrompt: false, highRisk: false };
}

module.exports = { classifyToolApproval };
