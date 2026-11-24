'use strict';

const TurndownService = require('turndown');
const { gfm } = require('turndown-plugin-gfm');

let service = null;

function getService() {
  if (service) return service;

  const td = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
  });

  td.use(gfm);
  td.remove(['script', 'style', 'noscript', 'iframe', 'svg', 'button', 'form', 'input']);

  // Цитаты XenForo: <blockquote class="bbCodeBlock bbCodeBlock--expandable ...">
  td.addRule('xfQuote', {
    filter: (node) => node.nodeName === 'BLOCKQUOTE',
    replacement: (content) => {
      const body = content.trim().replace(/\n{3,}/g, '\n\n');
      if (!body) return '';
      return `\n\n> ${body.split('\n').join('\n> ')}\n\n`;
    },
  });

  // Спойлеры: сохраняем текст, помечаем.
  td.addRule('xfSpoiler', {
    filter: (node) =>
      node.nodeName === 'DIV' && typeof node.className === 'string' && node.className.includes('bbCodeBlock--spoiler'),
    replacement: (content) => {
      const body = content.trim();
      return body ? `\n\n**Спойлер:**\n\n${body}\n\n` : '';
    },
  });

  // Код: <pre class="bbCodeBlock ..."><code>...
  td.addRule('xfCode', {
    filter: (node) => node.nodeName === 'PRE',
    replacement: (content) => `\n\n\`\`\`\n${content.replace(/\n+$/, '')}\n\`\`\`\n\n`,
  });

  // Смайлы не превращаем в огромные img-ссылки.
  td.addRule('smilie', {
    filter: (node) => node.nodeName === 'IMG' && typeof node.className === 'string' && node.className.includes('smilie'),
    replacement: (content, node) => node.getAttribute('alt') || node.getAttribute('title') || '',
  });

  td.addRule('image', {
    filter: 'img',
    replacement: (content, node) => {
      const src = node.getAttribute('src') || '';
      const alt = (node.getAttribute('alt') || '').trim();
      if (!src) return alt;
      return `![${alt}](${src})`;
    },
  });

  service = td;
  return td;
}

function htmlToMarkdown(html) {
  if (!html) return '';
  try {
    return getService()
      .turndown(html)
      .replace(/\\\./g, '.')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } catch (err) {
    return String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

module.exports = { htmlToMarkdown };
