// Thin client for the FeatureHub Management Repository (Admin) API.
// Spec: https://github.com/featurehub-io/featurehub/tree/main/infra/api-bucket/files/mrapi

export class FeatureHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const STATUS_HINTS = {
  401: 'FeatureHub rejected the credentials. Check them with /plugin configure featurehub.',
  403: 'Your FeatureHub account lacks permission for this. Ask a portfolio admin to add you (or your service account) to a group with the needed role.',
  404: 'Not found. Check the id/key (ids are UUIDs, keys are case-sensitive).',
  409: 'Someone else changed this record first. Re-read it and retry.',
  412: 'FeatureHub rejected the value (e.g. wrong type, or the feature is locked in this environment).',
  422: 'FeatureHub reported a validation failure.',
};

const LOGIN_HINTS = {
  401: 'Wrong email or password.',
  404: 'No FeatureHub user with that email.',
  403: 'Password login is disabled on this FeatureHub (it probably uses SSO). Use an admin service account token instead.',
};

// Authenticates with an admin service account token if given, otherwise logs in with email/password
// and logs in again when the session expires.
export function createClient({ baseUrl, token, email, password, timeoutMs = 15000 }) {
  let sessionToken = null;

  async function send(method, path, { query, body, bearer } = {}) {
    const url = new URL(`${baseUrl}/mr-api${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    try {
      return await fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          ...(bearer && { Authorization: `Bearer ${bearer}` }),
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new FeatureHubError(`Could not reach FeatureHub at ${baseUrl}: ${err.message}`);
    }
  }

  async function login() {
    const res = await send('POST', '/login', { body: { email, password } });
    if (!res.ok) {
      throw new FeatureHubError(`FeatureHub login failed with HTTP ${res.status}. ${LOGIN_HINTS[res.status] ?? ''}`, res.status);
    }
    const { accessToken } = await res.json();
    if (!accessToken) throw new FeatureHubError('FeatureHub login returned no access token.');
    sessionToken = accessToken;
  }

  async function bearer() {
    if (token) return token;
    if (!sessionToken) await login();
    return sessionToken;
  }

  async function request(method, path, { query, body } = {}) {
    if (!baseUrl || !(token || (email && password))) {
      throw new FeatureHubError(
        'FeatureHub is not configured. Run /plugin configure featurehub and set the URL plus either an admin service account token or your email and password.',
      );
    }

    let res = await send(method, path, { query, body, bearer: await bearer() });
    if (res.status === 401 && !token) {
      // The login session expired: log in again once and retry.
      sessionToken = null;
      res = await send(method, path, { query, body, bearer: await bearer() });
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
