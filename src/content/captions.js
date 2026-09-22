import { PLATFORMS } from './platforms.js';
import { brandVoice, platformFragments, contentSummaryFragment } from './social-prompts.config.js';
import { weightedLength } from './validate.js';

const STOP = new Set(
  'about after again also because been before being between both could does doing during each from have here into just like make many more most much only other over same should some such than that their them then there these they this those through very want were what when where which while will with would your'.split(' '),
);

/** Markdown -> plain text. The stored post is the only input to generation. */
export function toPlainText(markdown) {
  return String(markdown)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+.*$/gm, ' ') // headings are dropped: the title is already the hook
    .replace(/^\s*[-*+>]\s+/gm, '')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Truncate at a word boundary (prefer a sentence boundary) and mark the cut.
export function fit(text, maxChars) {
  const chars = [...text];
  if (chars.length <= maxChars) return text;
  const cut = chars.slice(0, Math.max(0, maxChars - 1)).join('');
  const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '));
  if (sentenceEnd > maxChars * 0.5) return cut.slice(0, sentenceEnd + 1);
  const wordEnd = cut.lastIndexOf(' ');
  return (wordEnd > 0 ? cut.slice(0, wordEnd) : cut).replace(/[\s,;:.-]+$/, '') + '…';
}

export function keywordHashtags(title, count) {
  const seen = new Set();
  const tags = [];
  for (const w of title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (w.length < 5 || STOP.has(w) || seen.has(w)) continue;
    seen.add(w);
    tags.push('#' + w[0].toUpperCase() + w.slice(1));
    if (tags.length === count) break;
  }
  return tags;
}

/** The three-fragment prompt (shared voice + platform rules + content summary).
 *  Used verbatim if an LLM provider is plugged in; the default template path below
 *  consumes the same fragments. */
export function buildPrompt(platform, post) {
  const f = platformFragments[platform];
  const summary = fit(toPlainText(post.body), f.summaryChars);
  return [brandVoice.prompt, f.rules, contentSummaryFragment(post, summary)].join('\n\n');
}

/**
 * Deterministic offline caption composer. Layout order and per-platform knobs come from
 * the fragments (data), the character budget from the platform's constraint profile, so
 * the output fits by construction; validateCaption() is still the final gate.
 */
export function composeCaption(platform, post) {
  const f = platformFragments[platform];
  const c = PLATFORMS[platform].constraints;
  const plain = toPlainText(post.body);

  const tags = keywordHashtags(post.title, f.hashtagCount);
  if (f.includeBrandTag && tags.length < c.maxHashtags) tags.push(brandVoice.hashtag);
  const hashtagLine = tags.slice(0, c.maxHashtags).join(' ');
  const cta = f.cta(post);

  const sections = { hook: fit(post.title.trim(), Math.floor(c.maxLength / 2)), cta, hashtags: hashtagLine };
  const build = (summary) =>
    f.layout
      .map((k) => (k === 'summary' ? summary : sections[k]))
      .filter(Boolean)
      .join('\n\n');

  let summary = fit(plain, f.summaryChars);
  let caption = build(summary);
  // Shrink only the flexible part (the summary) until the platform's budget is met.
  while (weightedLength(caption, c) > c.maxLength && summary.length > 0) {
    const over = weightedLength(caption, c) - c.maxLength;
    summary = summary.length <= over + 1 ? '' : fit(summary, summary.length - over - 1);
    caption = build(summary);
  }
  return caption;
}
