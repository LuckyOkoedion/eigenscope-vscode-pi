'use strict';

const ATTACHMENT_LIMITS = {
  count: 6,
  text: 64 * 1024,
  totalText: 96 * 1024,
  image: 4 * 1024 * 1024,
  totalImage: 6 * 1024 * 1024,
};

function buildPromptWithAttachments(message, attachments = []) {
  const parts = [];
  if (typeof message === 'string' && message.trim()) {
    parts.push(message.trim());
  }
  const images = [];
  for (const item of Array.isArray(attachments) ? attachments : []) {
    if (!item || typeof item !== 'object') continue;
    if (item.kind === 'text' && typeof item.text === 'string') {
      const textBytes = Buffer.byteLength(item.text, 'utf8');
      if (textBytes > ATTACHMENT_LIMITS.text) {
        throw new Error(`Attachment ${item.name || 'text'} exceeds 64 KiB limit.`);
      }
      const header = item.name ? `\n\n[Attached file: ${String(item.name).slice(0, 120)}]\n` : '\n\n';
      parts.push(`${header}${item.text}`);
    } else if (item.kind === 'image' && typeof item.data === 'string') {
      images.push({
        type: 'image',
        data: item.data,
        mimeType: /^image\/(png|jpeg|gif|webp)$/i.test(String(item.mimeType || ''))
          ? item.mimeType
          : 'image/png',
      });
    }
  }
  return { text: parts.join('\n').trim(), images };
}

module.exports = { ATTACHMENT_LIMITS, buildPromptWithAttachments };
