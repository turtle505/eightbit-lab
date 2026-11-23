// Markdown → sanitized HTML for reports and the report feed.
import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

// External links open in a new tab; relative .md links are tagged so the reports view can open them in place.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName !== 'A') return;
  const href = node.getAttribute('href') ?? '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  } else if (/\.md(#.*)?$/i.test(href)) {
    node.setAttribute('data-md-link', href.replace(/#.*$/, ''));
  }
});

export function renderMd(src: string): string {
  const html = marked.parse(src, { async: false }) as string;
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
}

/** Resolve a relative .md link against the report it appears in ("a/b/c.md" + "../d.md" → "a/d.md"). */
export function resolveMdLink(base: string, href: string): string {
  const parts = href.startsWith('/') ? [] : base.split('/').slice(0, -1);
  for (const seg of decodeURIComponent(href).split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/** One line of inline markdown (bold, code, links); Obsidian [[a|b]] wikilinks show their display text. */
export function renderInline(src: string): string {
  const text = src.replace(/\[\[([^\]|]*\|)?([^\]]+)\]\]/g, '$2');
  return DOMPurify.sanitize(marked.parseInline(text, { async: false }) as string, { ADD_ATTR: ['target'] });
}
