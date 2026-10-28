// Render a bounded Markdown subset using DOM nodes only. Release HTML stays text.
function textNode(value) { return document.createTextNode(value); }
function safeLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
function inline(parent, source, depth = 0) {
  if (depth > 3) { parent.append(textNode(source)); return; }
  const tokens = /(`+)([^`\n]+?)\1|(!?)\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|~~([^~\n]+)~~/g;
  let offset = 0;
  for (const match of source.matchAll(tokens)) {
    parent.append(textNode(source.slice(offset, match.index)));
    if (match[1]) {
      const code = document.createElement('code'); code.textContent = match[2]; parent.append(code);
    } else if (match[4]) {
      const href = !match[3] && safeLink(match[5]);
      if (href) {
        const link = document.createElement('a'); link.href = href; link.rel = 'noopener noreferrer';
        inline(link, match[4], depth + 1); parent.append(link);
      } else parent.append(textNode(match[4]));
    } else {
      const element = document.createElement(match[6] || match[7] ? 'strong' : match[8] ? 'em' : 's');
      inline(element, match[6] || match[7] || match[8] || match[9], depth + 1); parent.append(element);
    }
    offset = match.index + match[0].length;
  }
  parent.append(textNode(source.slice(offset)));
}
function cleanSource(source) {
  return String(source || '').slice(0, 100000).replace(/\r\n?/g, '\n');
}
export function renderReleaseNotes(source, depth = 0) {
  const fragment = document.createDocumentFragment();
  const lines = cleanSource(source).split('\n');
  let index = 0;
  const append = (tag, text) => { const node = document.createElement(tag); inline(node, text); fragment.append(node); return node; };
  const blockStart = line => /^\s*(?:#{1,6}\s|```|~~~|[-+*]\s|\d+[.)]\s|>|---+$|\*\*\*+$)/.test(line);
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    if (/^\s*<!--/.test(line)) {
      while (index < lines.length && !lines[index].includes('-->')) index++;
      index++; continue;
    }
    const fence = line.match(/^\s*(`{3,}|~{3,})([^\s]*)\s*$/);
    if (fence) {
      const content = []; index++;
      while (index < lines.length && !lines[index].trim().startsWith(fence[1])) content.push(lines[index++]);
      index++;
      const pre = document.createElement('pre'); const code = document.createElement('code');
      code.textContent = content.join('\n'); pre.append(code); pre.tabIndex = 0;
      pre.setAttribute('aria-label', fence[2] ? `${fence[2]} code` : 'Code example'); fragment.append(pre); continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) { append(`h${Math.min(Math.max(heading[1].length + 1, 3), 6)}`, heading[2]); index++; continue; }
    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) { fragment.append(document.createElement('hr')); index++; continue; }
    if (/^\s*>/.test(line) && depth < 2) {
      const quote = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) quote.push(lines[index++].replace(/^\s*>\s?/, ''));
      const block = document.createElement('blockquote'); block.append(renderReleaseNotes(quote.join('\n'), depth + 1)); fragment.append(block); continue;
    }
    const list = line.match(/^\s*([-+*]|\d+[.)])\s+(.*)$/);
    if (list) {
      const ordered = /^\d/.test(list[1]); const node = document.createElement(ordered ? 'ol' : 'ul');
      if (ordered && parseInt(list[1], 10) > 1) node.start = parseInt(list[1], 10);
      while (index < lines.length) {
        const item = lines[index].match(/^\s*([-+*]|\d+[.)])\s+(.*)$/);
        if (!item || /^\d/.test(item[1]) !== ordered) break;
        const li = document.createElement('li'); inline(li, item[2]); node.append(li); index++;
      }
      fragment.append(node); continue;
    }
    const paragraph = [line]; index++;
    while (index < lines.length && lines[index].trim() && !blockStart(lines[index])) paragraph.push(lines[index++]);
    append('p', paragraph.join(' '));
  }
  return fragment;
}
function plainText(source) {
  return source.replace(/!?\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[`*_~]/g, '').replace(/\s+/g, ' ').trim();
}
export function releaseSummary(source) {
  const body = cleanSource(source);
  const changes = body.split(/^## Changes since previous channel release\s*$/m)[1];
  const bullets = changes?.split('\n').filter(line => /^\s*[-*+]\s/.test(line)).slice(0, 2).map(line => plainText(line.replace(/^\s*[-*+]\s+/, '').replace(/\s+\([a-f0-9]{7,40}\)\s*$/, '')));
  const firstParagraph = body.split(/\n\s*\n/).find(part => !/^\s*(?:#|Channel:|Source:|[-*+]|```|<!--)/.test(part));
  const text = bullets?.length ? bullets.join('. ') : plainText(firstParagraph || 'Read the release notes for changes and known limitations.');
  return text.length > 260 ? `${text.slice(0, 257).replace(/\s+\S*$/, '')}…` : text;
}
export function releaseId(tag) { return `release-${tag}`; }
