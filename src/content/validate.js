import { PLATFORMS } from './platforms.js';

const URL_RE = /https?:\/\/[^\s]+/gi;
const HASHTAG_RE = /(^|\s)#[\p{L}\p{N}_]+/gu;
const len = (s) => [...s].length; // code points, not UTF-16 units

/** Length as the platform counts it (X counts every URL as a fixed weight). */
export function weightedLength(text, constraints) {
  if (constraints.urlWeight) {
    const urls = text.match(URL_RE) ?? [];
    const stripped = urls.reduce((t, u) => t.replace(u, ''), text);
    return len(stripped) + urls.length * constraints.urlWeight;
  }
  return len(text);
}

export function countHashtags(text) {
  return (text.match(HASHTAG_RE) ?? []).length;
}

/**
 * Enforce a platform's constraint profile. Returns violations, each naming the broken
 * rule: [{ rule, message }]. Empty array = valid. This runs at generation time AND on
 * every edit, so a rule-breaking variant can never reach review.
 */
export function validateCaption(platform, caption) {
  const profile = PLATFORMS[platform];
  if (!profile) return [{ rule: 'unknown_platform', message: `Unknown platform "${platform}"` }];
  const c = profile.constraints;
  const v = [];
  const text = String(caption ?? '');

  if (!text.trim()) return [{ rule: 'empty', message: 'Caption is empty' }];

  const length = weightedLength(text, c);
  if (length > c.maxLength) {
    v.push({ rule: 'max_length', message: `Caption is ${length} characters; ${profile.label} allows at most ${c.maxLength}` });
  }
  const tags = countHashtags(text);
  if (tags > c.maxHashtags) {
    v.push({ rule: 'max_hashtags', message: `Caption has ${tags} hashtags; ${profile.label} allows at most ${c.maxHashtags}` });
  }
  const hasUrl = new RegExp(URL_RE.source, 'i').test(text);
  if (hasUrl && !c.allowUrls) {
    v.push({ rule: 'urls_not_allowed', message: `${profile.label} captions must not contain links (use "link in bio")` });
  }
  if (!hasUrl && c.requireUrl) {
    v.push({ rule: 'url_required', message: `${profile.label} captions must include the post link` });
  }
  const bangs = (text.match(/!/g) ?? []).length;
  if (bangs > c.maxExclamations) {
    v.push({ rule: 'max_exclamations', message: `Caption has ${bangs} exclamation marks; ${profile.label} tone allows at most ${c.maxExclamations}` });
  }
  const shouting = (text.replace(URL_RE, '').match(/\b[A-Z]{3,}\b/g) ?? []).length;
  if (shouting > c.maxAllCapsWords) {
    v.push({ rule: 'max_all_caps_words', message: `Caption has ${shouting} ALL-CAPS words; ${profile.label} tone allows at most ${c.maxAllCapsWords}` });
  }
  const lower = text.toLowerCase();
  for (const phrase of c.bannedPhrases) {
    if (lower.includes(phrase)) v.push({ rule: 'banned_phrase', message: `Caption contains the banned phrase "${phrase}"` });
  }
  return v;
}
