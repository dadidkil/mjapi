'use strict';

// Компактный Markdown темы для чтения моделью: без HTML, с номером поста,
// ссылкой и временем МСК. Модуль без зависимостей, его подключает и MCP.

const FORUM = 'https://forum.majestic-rp.ru';
const INVISIBLE = /[​-‍⁠﻿]/g;
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

function mskTime(value) {
  if (!value) return '';
  const time = Date.parse(value);
  if (Number.isNaN(time)) return String(value);
  const d = new Date(time + MSK_OFFSET_MS);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} МСК`;
}

function tidy(text) {
  return String(text || '').replace(INVISIBLE, '').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

function postUrl(post) {
  if (post.url) return post.url;
  return post.id ? `${FORUM}/posts/${post.id}/` : '';
}

function threadMarkdown(data) {
  const lines = [`# ${tidy(data.title) || 'Тема'}`];
  const meta = [`URL: ${data.url || '?'}`];
  if (data.forum) meta.push(`Раздел: ${data.forum}`);
  const pages = data.pagination;
  if (pages && pages.pages > 1) meta.push(`Стр. ${pages.page}/${pages.pages}${pages.hasNext ? `, следующая page=${pages.page + 1}` : ''}`);
  if (data.cached) meta.push(`из кэша${data.fetchedAt ? ' от ' + mskTime(data.fetchedAt) : ''}`);
  lines.push(meta.join(' · '));
  for (const notice of data.notices || []) lines.push(`> Уведомление форума: ${tidy(notice)}`);
  const posts = data.posts || [];
  if (!posts.length) {
    if (data.parserWarning) lines.push(`> ${data.parserWarning}`);
    lines.push('', tidy(data.fallbackMarkdown) || 'Пустая тема.');
    return lines.join('\n') + '\n';
  }
  for (const post of posts) {
    const head = [`## #${post.postNumber}`, post.author || '?'];
    if (post.date) head.push(mskTime(post.date));
    const url = postUrl(post);
    if (url) head.push(url);
    lines.push('', head.join(' · '), '', tidy(post.content) || '(пустой пост)');
    if (post.reactionsCount) lines.push(`_Реакции: ${post.reactionsCount}_`);
  }
  return lines.join('\n').trim() + '\n';
}

// JSON-вариант темы без HTML каждого поста: Markdown-поле content уже содержит текст.
function stripThreadHtml(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.posts)) return data;
  return { ...data, posts: data.posts.map(({ contentHtml, ...post }) => ({ ...post, content: tidy(post.content) })) };
}

module.exports = { threadMarkdown, stripThreadHtml, mskTime };
