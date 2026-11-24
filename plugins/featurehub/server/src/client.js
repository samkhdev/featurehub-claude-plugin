// Thin client for the FeatureHub Management Repository (Admin) API.
// Spec: https://github.com/featurehub-io/featurehub/tree/main/infra/api-bucket/files/mrapi

export class FeatureHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const STATUS_HINTS = {
  401: 'The admin token was rejected. It may be wrong or reset — create/reset it on the "Admin Service Accounts" page and update FEATUREHUB_ADMIN_TOKEN.',
  403: 'The admin service account lacks permission. Add it to a group that has the needed role for this portfolio/application/environment.',
  404: 'Not found. Check the id/key (ids are UUIDs, keys are case-sensitive).',
  409: 'Someone else changed this record first. Re-read it and retry.',
  412: 'FeatureHub rejected the value (e.g. wrong type, or the feature is locked in this environment).',
  422: 'FeatureHub reported a validation failure.',
};

export function createClient({ baseUrl, token, timeoutMs = 15000 }) {
  async function request(method, path, { query, body } = {}) {
    if (!baseUrl || !token) {
      throw new FeatureHubError(
        'FeatureHub is not configured. Set the FeatureHub URL and admin service account token in the plugin configuration (or FEATUREHUB_URL / FEATUREHUB_ADMIN_TOKEN).',
      );
    }

    const url = new URL(`${baseUrl}/mr-api${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new FeatureHubError(`Could not reach FeatureHub at ${baseUrl}: ${err.message}`);
    }

    const text = await res.text();
    if (!res.ok) {
      const hint = STATUS_HINTS[res.status] ?? '';
      throw new FeatureHubError(`${method} ${path} failed with HTTP ${res.status}. ${hint}${text ? ` Response: ${text.slice(0, 500)}` : ''}`, res.status);
    }
    return text ? JSON.parse(text) : null;
  }

  return {
    get: (path, query) => request('GET', path, { query }),
    post: (path, body, query) => request('POST', path, { body, query }),
    put: (path, body, query) => request('PUT', path, { body, query }),
  };
}
