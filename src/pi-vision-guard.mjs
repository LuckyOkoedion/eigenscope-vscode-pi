export default function eigenscopeVisionGuard(pi) {
  if (typeof pi?.on !== 'function') return;
  pi.on('context', (event) => event);
}
