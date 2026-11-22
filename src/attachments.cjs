'use strict';

const ATTACHMENT_LIMITS = {
  count: 6,
  text: 64 * 1024,
  totalText: 96 * 1024,
  image: 4 * 1024 * 1024,
  totalImage: 6 * 1024 * 1024,
};

function estimateImageBytes(dataStr) {
  const trimmed = String(dataStr || '').trim();
  const payload = trimmed.startsWith('data:') ? trimmed.slice(trimmed.indexOf(',') + 1) : trimmed;
  if (!payload) return 0;
  return Buffer.from(payload, 'base64').byteLength;
}

function buildPromptWithAttachments(message, attachments = []) {
  const parts = [];
  if (typeof message === 'string' && message.trim()) {
    parts.push(message.trim());
  }
  const items = Array.isArray(attachments) ? attachments : [];
  if (items.length > ATTACHMENT_LIMITS.count) {
    throw new Error(`At most ${ATTACHMENT_LIMITS.count} attachments are allowed per message.`);
  }
  let totalTextBytes = 0;
  let totalImageBytes = 0;
  const images = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (item.kind === 'text' && typeof item.text === 'string') {
      const textBytes = Buffer.byteLength(item.text, 'utf8');
      if (textBytes > ATTACHMENT_LIMITS.text) {
        throw new Error(`Attachment ${item.name || 'text'} exceeds 64 KiB limit.`);
      }
      totalTextBytes += textBytes;
      if (totalTextBytes > ATTACHMENT_LIMITS.totalText) {
        throw new Error(`Combined text attachments exceed ${Math.round(ATTACHMENT_LIMITS.totalText / 1024)} KiB limit.`);
      }
      const header = item.name ? `\n\n[Attached file: ${String(item.name).slice(0, 120)}]\n` : '\n\n';
      parts.push(`${header}${item.text}`);
    } else if (item.kind === 'image' && typeof item.data === 'string') {
      const imageBytes = estimateImageBytes(item.data);
      if (imageBytes > ATTACHMENT_LIMITS.image) {
        throw new Error(`Image ${item.name || 'attachment'} exceeds ${Math.round(ATTACHMENT_LIMITS.image / (1024 * 1024))} MiB limit.`);
      }
      totalImageBytes += imageBytes;
      if (totalImageBytes > ATTACHMENT_LIMITS.totalImage) {
        throw new Error(`Combined image attachments exceed ${Math.round(ATTACHMENT_LIMITS.totalImage / (1024 * 1024))} MiB limit.`);
      }
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
