'use strict';

function buildEvidenceSummary(traceEvents = []) {
  const list = Array.isArray(traceEvents) ? traceEvents : [];
  let protectedSymbols = 0;
  let scrubbedTickets = 0;
  let confusionCount = 0;
  for (const ev of list) {
    if (ev.stage === 'decompose' || ev.stage === 'tool_result') {
      protectedSymbols += Number(ev.symbol_count || 0);
    }
    if (ev.vault_ticket_scrubbed) {
      scrubbedTickets += 1;
    }
    if (Array.isArray(ev.confusion_flags)) {
      confusionCount += ev.confusion_flags.length;
    }
  }
  return {
    turnsObserved: list.filter((e) => e.stage === 'rehydrate').length,
    protectedSymbols,
    scrubbedTickets,
    confusionCount,
  };
}

module.exports = { buildEvidenceSummary };
