// OAuth client-credentials exchange against the platform's token endpoint.
export function createOAuthClient({ baseUrl, clientId, clientSecret, timeoutMs = 5000, fetchImpl = fetch }) {
  return {
    /** @returns {Promise<{accessToken: string, expiresInSec: number}>} */
    async requestToken(platform) {
      const res = await fetchImpl(`${baseUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
          scope: platform,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`OAuth token request failed with HTTP ${res.status}`);
      const json = await res.json();
      return { accessToken: json.access_token, expiresInSec: Number(json.expires_in) };
    },
  };
}
