'use strict';

function supportsImageInput(modelMeta) {
  if (!modelMeta || typeof modelMeta !== 'object') return false;
  if (modelMeta.canSendImages === true || modelMeta.vision === true) return true;
  if (Array.isArray(modelMeta.input) && modelMeta.input.includes('image')) return true;
  return false;
}

module.exports = { supportsImageInput };
