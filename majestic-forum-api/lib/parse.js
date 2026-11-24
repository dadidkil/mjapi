'use strict';

const cheerio = require('cheerio');
const { htmlToMarkdown } = require('./markdown');
const { threadMarkdown } = require('./thread-markdown');

const clean = (s) => String(s == null ? '' : s).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

function abs(href, base) {
  if (!href) return '';
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

function parseCount(value) {
  const s = clean(value).replace(/\u00a0/g, ' ').toLowerCase();
  const num = parseFloat(s.replace(',', '.').replace(/[^\d.]/g, ''));
  if (Number.isNaN(num)) return null;
  if (/тыс|k\b/.test(s)) return Math.round(num * 1000);
  if (/млн|m\b/.test(s)) return Math.round(num * 1000000);
  return Math.round(num);
}

function isoDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  const fixed = s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const t = Date.parse(fixed);
  return Number.isNaN(t) ? s : new Date(t).toISOString();
}

function pageTitle($) {
  const clone = $('.p-title-value').first().clone();
  if (clone.length) {
    clone.find('.label, .p-title-value-prefix').remove();
    const t = clean(clone.text());
    if (t) return t;
  }
  const title = clean($('title').first().text());
  return title.replace(/\s*[|•].*$/, '').trim();
}

function breadcrumbs($) {
  const out = [];
  const block = $('.p-breadcrumbs').first();
  block.find('li').each((i, el) => {
    const a = $(el).find('a').first();
    const name = clean($(el).text());
    if (name && !out.some((b) => b.name === name)) out.push({ name, url: abs(a.attr('href'), '') || null });
  });
  return out;
}

function pagination($, baseUrl) {
  const pages = [];
  $('.pageNav-page a, .pageNav a').each((i, el) => {
    const href = $(el).attr('href');
    const label = clean($(el).text());
    if (href && /^\d+$/.test(label)) pages.push({ page: Number(label), url: abs(href, baseUrl) });
  });
  // XenForo renders the same navigation above and below the content. Concatenating
  // both current labels turns page 1 into 11 and page 2 into 22.
  const currentRaw = clean($('.pageNav-page--current').first().text());
  const current = /^\d+$/.test(currentRaw) ? Number(currentRaw) : 1;
  const nums = pages.map((p) => p.page);
  const total = nums.length ? Math.max(...nums, current) : current;
  return {
    page: current,
    pages: total,
    hasPrev: current > 1,
    hasNext: current < total || $('.pageNav-jump--next').length > 0,
    prevUrl: pages.find((p) => p.page === current - 1)?.url || null,
    nextUrl: pages.find((p) => p.page === current + 1)?.url || null,
  };
}

function parseThreadItem($, el, baseUrl) {
  const $el = $(el);
  const titleLink = $el.find('.structItem-title a[href*="/threads/"]').first();
  const href = titleLink.attr('href') || $el.find('a[href*="/threads/"]').first().attr('href') || '';
  const dataContent = $el.attr('data-content') || '';
  const idMatch = dataContent.match(/thread-(\d+)/) || String(href).match(/\/threads\/(?:[^/]*\.)?(\d+)\/?/);
  const metaDd = $el.find('.structItem-cell--meta dd');
  const latest = $el.find('.structItem-cell--latest');
  const title = clean(titleLink.text()) || clean($el.find('.structItem-title').text());
  if (!title) return null;
  return {
    id: idMatch ? Number(idMatch[1]) : null,
    title,
    url: abs(href, baseUrl),
    prefix: clean($el.find('.structItem-title .label').first().text()) || null,
    author: $el.attr('data-author') || clean($el.find('.structItem-minor .username').first().text()) || null,
    createdAt: isoDate($el.find('.structItem-startDate time').first().attr('datetime') || $el.find('.structItem-minor time').first().attr('datetime')),
    replies: metaDd.length > 0 ? parseCount(metaDd.eq(0).text()) : null,
    views: metaDd.length > 1 ? parseCount(metaDd.eq(1).text()) : null,
    lastPostAt: isoDate(latest.find('time').first().attr('datetime')),
    lastPostBy: clean(latest.find('.username').first().text()) || null,
    isSticky: /structItem--sticky/.test($el.attr('class') || ''),
    isUnread: /unread/i.test($el.attr('class') || '') || $el.find('.structItem-status--unread').length > 0,
  };
}

function parseThreadList($, baseUrl) {
  const threads = [];
  $('.structItem[data-content^="thread-"], .structItem--thread').each((i, el) => {
    const item = parseThreadItem($, el, baseUrl);
    if (item && item.title) threads.push(item);
  });
  return threads;
}

function parsePosts($, baseUrl) {
  const posts = [];
  const nodes = $('article.message--post, article.message');
  nodes.each((i, el) => {
    const $el = $(el);
    const contentEl = $el.find('.message-body .bbWrapper').first().length
      ? $el.find('.message-body .bbWrapper').first()
      : $el.find('.bbWrapper').first();
    const html = contentEl.html() || '';
    if (!html && !$el.find('.message-body').length) return;
    const dataContent = $el.attr('data-content') || $el.attr('id') || '';
    const idMatch = String(dataContent).match(/(?:post-)?(\d+)/);
    const authorLink = $el.find('.message-name a, .message-userDetails a.username').first();
    const authorHref = authorLink.attr('href') || '';
    const authorIdMatch = authorHref.match(/\/members\/[^/]*\.(\d+)\/?/);
    const attribution = $el.find('.message-attribution time').first();
    const dateAttr = attribution.attr('datetime');
    const postNumber = clean($el.find('.message-attribution-opposite a').first().text()).replace('#', '');
    const reactionLink = $el.find('.reactionsBar-link').first();
    const reactionText = clean(reactionLink.text());
    const extra = reactionText.match(/ещ[её]\s+(\d+)/i);
    const reactionsCount = reactionLink.length
      ? (extra ? Number(extra[1]) + (reactionText.split(',').length || 1) : reactionText.split(',').filter(Boolean).length)
      : 0;
    posts.push({
      id: idMatch ? Number(idMatch[1]) : null,
      postNumber: postNumber ? Number(postNumber) : i + 1,
      author: $el.attr('data-author') || clean(authorLink.text()) || null,
      authorId: authorIdMatch ? Number(authorIdMatch[1]) : null,
      authorUrl: authorHref ? abs(authorHref, baseUrl) : null,
      date: isoDate(dateAttr),
      url: idMatch ? new URL(`/posts/${idMatch[1]}/`, baseUrl).toString() : null,
      contentHtml: html,
      content: htmlToMarkdown(html),
      reactions: reactionText || null,
      reactionsCount,
      isFirst: i === 0,
    });
  });
  return posts;
}

function parseThread($, baseUrl) {
  const notices = [];
  $('.blockMessage--error, .error').each((i, el) => {
    const t = clean($(el).text());
    if (t) notices.push(t.slice(0, 300));
  });
  const crumbs = breadcrumbs($);
  const posts = parsePosts($, baseUrl);
  const data = {
    type: 'thread',
    title: pageTitle($),
    url: baseUrl,
    forum: crumbs.length > 1 ? crumbs[crumbs.length - 1].name : null,
    breadcrumbs: crumbs,
    tags: $('.tagItem').map((i, el) => clean($(el).text())).get().filter(Boolean),
    pagination: pagination($, baseUrl),
    posts,
    notices,
  };
  // Если разметка изменилась и постов не нашлось — отдаём хотя бы текст страницы.
  if (!posts.length) {
    const generic = parseGeneric($, baseUrl);
    data.fallbackMarkdown = generic.markdown;
    data.parserWarning = 'Посты не распознаны, вернул текст страницы (fallbackMarkdown)';
  }
  return data;
}

function parseForum($, baseUrl) {
  const subforums = [];
  $('.node--forum, .node--link').each((i, el) => {
    const a = $(el).find('.node-title a').first();
    if (!a.length) return;
    subforums.push({
      title: clean(a.text()),
      url: abs(a.attr('href'), baseUrl),
      description: clean($(el).find('.node-description').text()) || null,
    });
  });
  const threads = parseThreadList($, baseUrl);
  const data = {
    type: 'forum',
    title: pageTitle($),
    url: baseUrl,
    description: clean($('.p-description').first().text()) || null,
    breadcrumbs: breadcrumbs($),
    pagination: pagination($, baseUrl),
    subforums,
    threads,
  };
  if (!threads.length) {
    const generic = parseGeneric($, baseUrl);
    data.fallbackMarkdown = generic.markdown;
    data.parserWarning = 'Темы не распознаны, вернул текст страницы (fallbackMarkdown)';
  }
  return data;
}

function parseIndex($, baseUrl) {
  const categories = [];
  $('.block--category, .block--section').each((i, el) => {
    const $el = $(el);
    const name = clean($el.find('.block-header').first().text());
    const forums = [];
    $el.find('.node--forum, .node--link').each((j, node) => {
      const $n = $(node);
      const a = $n.find('.node-title a').first();
      if (!a.length) return;
      forums.push({
        title: clean(a.text()),
        url: abs(a.attr('href'), baseUrl),
        description: clean($n.find('.node-description').text()) || null,
        stats: clean($n.find('.node-stats').text()) || null,
        lastPost: clean($n.find('.node-extra, .node-lastpost').first().text()) || null,
      });
    });
    if (forums.length) categories.push({ category: name || null, forums });
  });
  return { type: 'index', title: pageTitle($), url: baseUrl, categories };
}

function parseRows($, baseUrl) {
  const rows = [];
  const seen = new Set();
  let nodes = $('li.block-row');
  if (!nodes.length) nodes = $('.contentRow');
  nodes.each((i, el) => {
    const $el = $(el);
    const titleLink = $el.find('.contentRow-title a').first();
    const href = titleLink.attr('href') || $el.find('a[href*="/threads/"], a[href*="/posts/"]').first().attr('href');
    if (!href) return;
    const url = abs(href, baseUrl);
    if (seen.has(url)) return;
    const title = clean(titleLink.text());
    if (!title) return;
    seen.add(url);
    rows.push({
      title,
      url,
      snippet: clean($el.find('.contentRow-snippet').text()) || null,
      meta: clean($el.find('.contentRow-minor').text()) || null,
      date: isoDate($el.find('time').first().attr('datetime')),
      unread: /unread/i.test($el.attr('class') || '') || $el.find('.is-unread').length > 0,
    });
  });
  return rows;
}

function parseSearch($, baseUrl) {
  return {
    type: 'search',
    title: pageTitle($),
    url: baseUrl,
    query: clean($('.js-searchResultsHeader, .p-title-value').first().text()) || null,
    results: parseRows($, baseUrl),
    pagination: pagination($, baseUrl),
  };
}

function parseFeed($, baseUrl) {
  return {
    type: 'feed',
    title: pageTitle($),
    url: baseUrl,
    items: parseRows($, baseUrl),
    pagination: pagination($, baseUrl),
  };
}

/** Публичная страница пользователя /members/… */
function parseMember($, baseUrl) {
  const pick = (selectors) => {
    for (const sel of selectors) {
      const value = clean($(sel).first().text());
      if (value) return value;
    }
    return null;
  };

  const name = pick(['.memberHeader-name', '.memberHeader-main h1', '.p-title-value', 'h1']);
  const subtitle = pick(['.memberHeader-blurb', '.memberHeader-userTitle', '.userTitle']);

  const stats = [];
  $('.memberHeader-stats .pairs, .memberHeader-stats dl, .memberHeader-info .pairs, .block-body .pairs').each((i, el) => {
    if (stats.length >= 12) return;
    const label = clean($(el).find('dt, .pairs-key').first().text());
    const value = clean($(el).find('dd, .pairs-value').first().text());
    if (label && value && label.length < 80 && value.length < 160 && !stats.some((s) => s.label === label)) {
      stats.push({ label, value });
    }
  });

  const statusText = clean($('.memberHeader .userStatus, .userStatus').first().text());
  const banner = clean($('.memberHeader-banner').first().text());

  return {
    type: 'member',
    name,
    subtitle,
    url: baseUrl,
    status: statusText || null,
    banner: banner || null,
    stats,
    isStaff: /staff|персонал|администрац/i.test($('.staffBar, .memberHeader').first().text()),
    messageCount: (() => {
      const row = stats.find((s) => /сообщени|messages/i.test(s.label));
      return row ? parseCount(row.value) : null;
    })(),
  };
}

const NOISE_SELECTORS = [
  '.p-body-sidebar',
  '.p-body-header',
  '.block-outer',
  '.pageNavWrapper',
  '.p-breadcrumbs',
  '.js-notices',
  '.notice',
  '.message-actionBar',
  '.message-footer',
  '.message-signature',
  '.message-attribution',
  '.message-userDetails',
  '.message-cell--user',
  'script',
  'style',
  'noscript',
  'form',
  '.bbCodeBlock-expandLink',
];

function parseGeneric($, url, { markdown = true } = {}) {
  const main = $('.p-body-main').first().length ? $('.p-body-main').first() : $('.p-body').first();
  const clone = cheerio.load(main.length ? main.html() : $('body').html());
  NOISE_SELECTORS.forEach((sel) => clone(sel).remove());
  const html = clone.root().html() || '';
  const text = clean(clone.root().text());
  const links = [];
  clone('a[href]').each((i, el) => {
    const href = clone(el).attr('href');
    const label = clean(clone(el).text());
    if (href && label && href.startsWith('/')) {
      const u = abs(href, url);
      if (!links.some((l) => l.url === u)) links.push({ title: label, url: u });
    }
  });
  return {
    type: 'page',
    title: pageTitle($),
    url,
    breadcrumbs: breadcrumbs($),
    text,
    markdown: markdown ? htmlToMarkdown(html) : undefined,
    links: links.slice(0, 200),
    bytes: html.length,
  };
}

function extractToken($) {
  return $('input[name="_xfToken"]').attr('value') || null;
}

/** Тема целиком в Markdown — удобно скармливать модели или читать глазами. */
function threadToMarkdown(data) {
  return threadMarkdown(data);
}

module.exports = {
  load: (html) => cheerio.load(html),
  clean,
  abs,
  parseIndex,
  parseForum,
  parseThread,
  parseThreadList,
  parsePosts,
  parseSearch,
  parseFeed,
  parseMember,
  parseGeneric,
  extractToken,
  threadToMarkdown,
  pageTitle,
  breadcrumbs,
  pagination,
};
