/* global markdownit */
const markdownParser = markdownit({ html: false, linkify: false, typographer: false, maxNesting: 20 });
const markdownTags = new Set([
  'p', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'em', 's', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr',
]);

function publicLink(value) {
  try {
    const url = new URL(value);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch {}
  return undefined;
}

function appendMarkdown(tokens, root, openLink) {
  const stack = [root];
  for (const token of tokens) {
    const node = stack.at(-1);
    if (token.hidden) continue;
    if (token.type === 'inline') {
      appendMarkdown(token.children, node, openLink);
    } else if (token.type === 'text' || token.type === 'text_special') {
      node.append(document.createTextNode(token.content));
    } else if (token.type === 'image') {
      node.append(document.createTextNode(token.content || 'Image'));
    } else if (token.type === 'softbreak') {
      node.append(document.createTextNode('\n'));
    } else if (token.type === 'hardbreak') {
      node.append(document.createElement('br'));
    } else if (token.type === 'code_inline') {
      const code = document.createElement('code');
      code.textContent = token.content;
      node.append(code);
    } else if (token.type === 'fence' || token.type === 'code_block') {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = token.content;
      pre.append(code);
      node.append(pre);
    } else if (token.nesting === -1 && stack.length > 1) {
      stack.pop();
    } else if (token.nesting >= 0) {
      if (token.type === 'link_open') {
        const href = publicLink(token.attrGet('href'));
        const link = document.createElement(href ? 'a' : 'span');
        if (href) {
          link.href = href;
          link.addEventListener('click', (event) => {
            event.preventDefault();
            openLink(href);
          });
        }
        node.append(link);
        stack.push(link);
      } else if (markdownTags.has(token.tag)) {
        const child = document.createElement(token.tag);
        if (token.tag === 'ol') {
          const start = Number(token.attrGet('start') || 1);
          if (Number.isInteger(start) && start > 0) child.start = start;
        }
        node.append(child);
        if (token.nesting === 1) stack.push(child);
      }
    }
  }
}

function renderMarkdown(text, root, openLink) {
  appendMarkdown(markdownParser.parse(text, {}), root, openLink);
}
