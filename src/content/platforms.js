// Platform specs as DATA: image geometry + the constraint profile enforced by code.
// Adding a platform's content rules = adding an entry here (and a fragment in
// social-prompts.config.js); no logic changes.
export const PLATFORMS = {
  instagram: {
    label: 'Instagram',
    image: { width: 1080, height: 1080, safeMargin: 0.1 }, // 1:1 square
    constraints: {
      maxLength: 2200,
      maxHashtags: 10,
      allowUrls: false, // links are not clickable in captions
      requireUrl: false,
      maxExclamations: 2,
      maxAllCapsWords: 1,
      bannedPhrases: ['click here', 'buy now', 'follow for follow'],
    },
  },
  x: {
    label: 'X',
    image: { width: 1600, height: 900, safeMargin: 0.1 }, // 16:9 landscape
    constraints: {
      maxLength: 280,
      urlWeight: 23, // X counts every URL as 23 characters
      maxHashtags: 2,
      allowUrls: true,
      requireUrl: true,
      maxExclamations: 1,
      maxAllCapsWords: 1,
      bannedPhrases: ['click here', 'buy now', 'follow for follow'],
    },
  },
  linkedin: {
    label: 'LinkedIn',
    image: { width: 1200, height: 627, safeMargin: 0.1 }, // 1.91:1
    constraints: {
      maxLength: 3000,
      maxHashtags: 5,
      allowUrls: true,
      requireUrl: true,
      maxExclamations: 1,
      maxAllCapsWords: 0,
      bannedPhrases: ['click here', 'buy now', 'follow for follow', 'like and share'],
    },
  },
};

export const PLATFORM_IDS = Object.keys(PLATFORMS);
export const isPlatform = (p) => Object.hasOwn(PLATFORMS, p);
