// Prompt fragments as data (modelled on FlyRank's config/social-prompts.config.ts).
// A caption prompt is ALWAYS   brandVoice + platform rules + content summary  -
// three reusable pieces, never a copy-pasted prompt per platform. The same fragments
// also drive the offline template generator, so the default path needs no AI at all.

export const brandVoice = {
  prompt: 'Brand voice: clear, warm and practical. Plain words, no hype, no jargon. Say one useful thing well.',
  hashtag: '#SocialMediaStudio',
};

export const platformFragments = {
  instagram: {
    rules:
      'Platform: Instagram. Open with a hook line. Short lines, conversational, at most one emoji. ' +
      'No links in the caption; point to the link in bio. Up to 5 hashtags at the end.',
    summaryChars: 320,
    hashtagCount: 5,
    includeBrandTag: true,
    layout: ['hook', 'summary', 'cta', 'hashtags'],
    cta: () => 'Link in bio for the full read.',
  },
  x: {
    rules:
      'Platform: X. One sharp idea. Hard limit 280 characters including the link (a link counts as 23). ' +
      'At most 2 hashtags. No exclamation spam.',
    summaryChars: 140,
    hashtagCount: 2,
    includeBrandTag: false,
    layout: ['hook', 'summary', 'cta', 'hashtags'],
    cta: (post) => post.url,
  },
  linkedin: {
    rules:
      'Platform: LinkedIn. Professional but human. State the takeaway in the first two lines, then a short ' +
      'paragraph of context, then the link. At most 5 hashtags, no emoji walls.',
    summaryChars: 600,
    hashtagCount: 3,
    includeBrandTag: true,
    layout: ['hook', 'summary', 'cta', 'hashtags'],
    cta: (post) => `Read the full post: ${post.url}`,
  },
};

export const contentSummaryFragment = (post, summary) =>
  `Blog post title: ${post.title}\nBlog post URL: ${post.url}\nKey content: ${summary}`;
