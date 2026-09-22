import { HttpPlatformPublisher } from './HttpPlatformPublisher.js';

// One thin class per platform. A real integration would override buildPayload() /
// endpoint() / interpret() to speak that platform's wire format; here the fake platform
// server is uniform, so the subclasses only pin the platform id.
export class FakeInstagramPublisher extends HttpPlatformPublisher {
  constructor(deps) {
    super({ ...deps, platform: 'instagram' });
  }
}
export class FakeXPublisher extends HttpPlatformPublisher {
  constructor(deps) {
    super({ ...deps, platform: 'x' });
  }
}
export class FakeLinkedInPublisher extends HttpPlatformPublisher {
  constructor(deps) {
    super({ ...deps, platform: 'linkedin' });
  }
}

/** Registry: the ONLY place concrete adapters are named. Everything else asks for
 *  `publishers.get(platform)` and sees a SocialPublisher. */
export function createPublisherRegistry(deps) {
  const list = [new FakeInstagramPublisher(deps), new FakeXPublisher(deps), new FakeLinkedInPublisher(deps)];
  const byPlatform = new Map(list.map((p) => [p.platform, p]));
  return {
    get(platform) {
      const p = byPlatform.get(platform);
      if (!p) throw new Error(`No publisher registered for platform "${platform}"`);
      return p;
    },
    platforms: () => [...byPlatform.keys()],
  };
}
