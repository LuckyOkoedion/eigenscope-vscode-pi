export default function eigenscopeReviewTool(pi) {
  if (typeof pi?.registerTool !== 'function') return;
  pi.registerTool({
    name: 'eigenscope_review_note',
    label: 'EigenScope Review Note',
    description: 'Record a non-sensitive workspace review summary note for the VS Code changes panel.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Concise workspace change note.' },
      },
      required: ['summary'],
    },
    async execute(_toolCallId, params) {
      const text = typeof params?.summary === 'string' ? params.summary.slice(0, 500) : '';
      return {
        content: [{ type: 'text', text: text || 'Review note recorded.' }],
        details: { ok: true },
      };
    },
  });
}
