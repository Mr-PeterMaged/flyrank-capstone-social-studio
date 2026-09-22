import { z } from 'zod';
import { PLATFORM_IDS } from '../content/platforms.js';

const platform = z.enum(PLATFORM_IDS);

export const id = z.coerce.number().int().positive();

export const createPostBody = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(20_000),
  url: z.string().url().max(2000).refine((u) => /^https?:\/\//i.test(u), 'url must be http(s)'),
});

export const createCampaignBody = z.object({
  platforms: z.array(platform).min(1).refine((a) => new Set(a).size === a.length, 'duplicate platforms').optional(),
  captions: z.record(platform, z.string().min(1).max(5000)).optional(),
});

export const editVariantBody = z.object({ caption: z.string().min(1).max(5000) });

export const scheduleBody = z
  .object({
    at: z.string().datetime({ offset: true }).optional(),
    inSeconds: z.number().finite().min(0).max(366 * 86400).optional(),
    platforms: z.array(platform).min(1).optional(),
  })
  .refine((b) => (b.at === undefined) !== (b.inSeconds === undefined), 'provide exactly one of "at" or "inSeconds"');

export const publishBody = z.object({ platforms: z.array(platform).min(1).optional() });

export const advanceClockBody = z.object({ seconds: z.number().finite().min(0).max(366 * 86400) });
