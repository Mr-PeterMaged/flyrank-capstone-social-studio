import fs from 'node:fs';
import path from 'node:path';
import { PLATFORMS, PLATFORM_IDS } from '../content/platforms.js';
import { composeCaption } from '../content/captions.js';
import { validateCaption } from '../content/validate.js';
import { createPlaceholderSource, renderVariant } from '../content/images.js';
import { conflict, notFound, unprocessable } from '../lib/errors.js';

/**
 * Content + review workflow. Rules enforced here (not in the HTTP layer):
 *   - generation reads ONLY the stored post (the single source of truth);
 *   - every variant is checked against its platform's constraint profile, at creation
 *     and on every edit; a violating variant is 'blocked' and cannot be approved;
 *   - review_status moves draft -> approved | rejected through conditional updates.
 */
export function createCampaignService({ repos, config }) {
  const view = (variant, socialPost = null) => ({
    ...variant,
    imageUrl: `/artifacts/${variant.imagePath}`,
    socialPost,
  });

  function requireVariant(id) {
    const v = repos.variants.get(id);
    if (!v) throw notFound('Variant');
    return v;
  }

  return {
    createPost: (input) => repos.posts.create(input),

    getPost(id) {
      const p = repos.posts.get(id);
      if (!p) throw notFound('Post');
      return p;
    },

    listPosts: () => repos.posts.list(),

    /** @param captionOverrides optional {platform: caption} supplied by a human author */
    async createCampaign(postId, { platforms = PLATFORM_IDS, captionOverrides = {} } = {}) {
      const post = repos.posts.get(postId);
      if (!post) throw notFound('Post');

      const drafts = platforms.map((platform) => {
        const caption = captionOverrides[platform] ?? composeCaption(platform, post);
        return { platform, caption, violations: validateCaption(platform, caption) };
      });
      // A caption the human wrote themselves that breaks a rule is refused outright,
      // naming every broken rule. (Auto-composed captions that violate become 'blocked'.)
      const refused = drafts.filter((d) => captionOverrides[d.platform] !== undefined && d.violations.length);
      if (refused.length) {
        throw unprocessable('constraint_violation', 'Caption breaks platform rules', {
          violations: Object.fromEntries(refused.map((d) => [d.platform, d.violations])),
        });
      }

      const source = await createPlaceholderSource(post.title);
      const rendered = new Map();
      for (const { platform } of drafts) {
        rendered.set(platform, await renderVariant(source, PLATFORMS[platform].image, config.brandName));
      }

      const campaign = repos.tx(() => {
        const c = repos.campaigns.create(post.id);
        const dir = path.join(config.artifactDir, `campaign-${c.id}`);
        fs.mkdirSync(dir, { recursive: true });
        for (const d of drafts) {
          const img = rendered.get(d.platform);
          fs.writeFileSync(path.join(dir, `${d.platform}.png`), img.buffer);
          repos.variants.create({
            campaignId: c.id,
            platform: d.platform,
            caption: d.caption,
            imagePath: `campaign-${c.id}/${d.platform}.png`,
            imageWidth: img.width,
            imageHeight: img.height,
            reviewStatus: d.violations.length ? 'blocked' : 'draft',
            validationErrors: d.violations,
          });
        }
        return c;
      });
      return this.getCampaign(campaign.id);
    },

    getCampaign(id) {
      const campaign = repos.campaigns.get(id);
      if (!campaign) throw notFound('Campaign');
      const post = repos.posts.get(campaign.post_id);
      const entries = new Map(repos.socialPosts.listByCampaign(id).map((s) => [s.variantId, s]));
      const variants = repos.variants.listByCampaign(id).map((v) => view(v, entries.get(v.id) ?? null));
      return {
        id: campaign.id,
        post: { id: post.id, title: post.title, url: post.url },
        createdAt: campaign.created_at,
        status: summarise([...entries.values()]),
        variants,
      };
    },

    listCampaigns() {
      return repos.campaigns.list().map((c) => this.getCampaign(c.id));
    },

    editVariant(id, caption) {
      const v = requireVariant(id);
      const violations = validateCaption(v.platform, caption);
      if (violations.length) {
        throw unprocessable('constraint_violation', 'Caption breaks platform rules', { violations });
      }
      const updated = repos.variants.updateCaption(id, caption, 'draft', []);
      if (!updated) throw conflict('variant_locked', `Variant is ${v.reviewStatus}; only draft or blocked variants can be edited`);
      return view(updated);
    },

    approveVariant(id) {
      const v = requireVariant(id);
      // Defence in depth: re-validate at the gate, do not trust the stored status alone.
      const violations = validateCaption(v.platform, v.caption);
      if (v.reviewStatus === 'blocked' || violations.length) {
        throw unprocessable('constraint_violation', 'Blocked variants cannot be approved; edit the caption first', { violations });
      }
      const updated = repos.variants.transition(id, ['draft'], 'approved');
      if (updated) return view(updated);
      if (v.reviewStatus === 'approved') return view(v); // idempotent approve
      throw conflict('invalid_transition', `Cannot approve a ${v.reviewStatus} variant`);
    },

    rejectVariant(id) {
      const v = requireVariant(id);
      if (repos.socialPosts.getByVariant(id)) throw conflict('already_scheduled', 'A scheduled variant cannot be rejected');
      const updated = repos.variants.transition(id, ['draft', 'blocked', 'approved'], 'rejected');
      if (updated) return view(updated);
      if (v.reviewStatus === 'rejected') return view(v);
      throw conflict('invalid_transition', `Cannot reject a ${v.reviewStatus} variant`);
    },
  };
}

function summarise(entries) {
  if (!entries.length) return 'draft';
  if (entries.every((e) => e.status === 'published')) return 'published';
  if (entries.some((e) => e.status === 'queued' || e.status === 'publishing')) return 'in_progress';
  return entries.some((e) => e.status === 'published') ? 'partially_published' : 'failed';
}
