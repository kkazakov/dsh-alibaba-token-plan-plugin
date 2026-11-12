/**
 * Host half of the Alibaba Cloud Token Plan bundle.
 *
 * It reads the current subscription month of an Alibaba Cloud Model Studio
 * Token Plan — the percentage used and when the window resets — and publishes
 * it three ways: an `alibaba_token_plan_usage` agent tool, an optional prompt
 * notice once the month crosses the warning threshold, and a same-origin JSON
 * route that the Client half polls for its composer strip and settings page.
 *
 * ## Where the number comes from
 *
 * Alibaba does not expose Token Plan usage on the inference endpoint, and a
 * Token Plan model key (`sk-sp-...`) cannot read it. Usage lives behind the
 * Model Studio console, which accepts a short-lived console token minted from an
 * Aliyun AccessKey:
 *
 *   1. `GenerateCLIAccessToken` (ACS3-HMAC-SHA256, signed with the AccessKey)
 *      returns a 36-character console token.
 *   2. That token authenticates a call to the console gateway for
 *      `zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage`, whose payload
 *      carries `per1MonthPercentage` (a ratio in [0, 1]) and
 *      `per1MonthResetTime` (epoch milliseconds).
 *
 * The gateway is the same one the official `bl` CLI talks to; the region and
 * console site below are the Singapore / international Token Plan pair.
 *
 * When the console path is unavailable the plugin falls back to the Token Plan
 * OpenAPI itself — `GetSubscriptionSeatDetails`, then `GetSubscriptionStats` —
 * which reports Credits rather than a percentage. That path is what a team
 * seat-based plan answers, and it also supplies the optional credit totals.
 *
 * ## Which credential
 *
 * The AccessKey is resolved from the freshest source on the machine, in order:
 * plugin config, then the environment, then the Harness credential store
 * (`~/.dsh/.credentials.yaml`, `refs:` block), then `~/.dsh/.env`, then the
 * current profile in `~/.aliyun/config.json`. The credential store comes before
 * the other files because a DSH profile that selects the Alibaba route resolves
 * its model key from that same store; keeping the usage AccessKey beside it
 * means one place to rotate. A `sk-sp-...` model key is never used for usage.
 *
 * No imports from Harness packages: the definition objects below are the exact
 * shapes `ctx.tools.register` and `ctx.webServer.register` consume.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Same-origin route for the Web page; outside `/plugins` so no bundle route can shadow it. */
const USAGE_PATH = '/alibaba-token-plan/usage.json';
/** Prompt-context placement: after the shipped policy contexts (110, 115, 120). */
const CONTEXT_ORDER = 135;
/** Socket timeout for one usage request. */
const REQUEST_TIMEOUT_MS = 20000;

/** Aliyun OpenAPI host for the Singapore / international Token Plan. */
const DEFAULT_OPENAPI_HOST = 'modelstudio.ap-southeast-1.aliyuncs.com';
/** OpenAPI version that carries the Token Plan actions. */
const API_VERSION = '2026-02-10';

/** Console gateway host, action, region and site for the international plan. */
const DEFAULT_CONSOLE_HOST = 'bailian-singapore-cs.alibabacloud.com';
const CONSOLE_ACTION = 'IntlBroadScopeAspnGateway';
const DEFAULT_CONSOLE_REGION = 'ap-southeast-1';
const DEFAULT_CONSOLE_SITE = 'MODELSTUDIO_ALBABACLOUD';
const DEFAULT_CONSOLE_DOMAIN = 'modelstudio.console.alibabacloud.com';
/** The Token Plan personal usage API, called through the console gateway. */
const CONSOLE_USAGE_API = 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage';

/** Harness credential store: `refs:` holds env-var-backed provider keys. */
const DEFAULT_CREDENTIALS_FILE = join(homedir(), '.dsh/.credentials.yaml');

/** AccessKey names accepted, in priority order. */
const KEY_ID_NAMES = [
  'ALIBABA_CLOUD_ACCESS_KEY_ID',
  'ALIBABA_ACCESS_KEY_ID',
  'ALIYUN_ACCESS_KEY_ID',
  'BAILIAN_ACCESS_KEY_ID',
];
const KEY_SECRET_NAMES = [
  'ALIBABA_CLOUD_ACCESS_KEY_SECRET',
  'ALIBABA_ACCESS_KEY_SECRET',
  'ALIYUN_ACCESS_KEY_SECRET',
  'BAILIAN_ACCESS_KEY_SECRET',
];
const SECURITY_TOKEN_NAMES = [
  'ALIBABA_CLOUD_SECURITY_TOKEN',
  'ALIYUN_SECURITY_TOKEN',
  'BAILIAN_SECURITY_TOKEN',
];

/** Required service: the tool registry. `webServer` and `systemPrompt` are optional. */
export const inject = ['tools'];

/** An Alibaba API failure, classified so the caller can give the right advice. */
class AlibabaError extends Error {
  /** @param {'auth'|'http'|'parse'|'empty'} kind @param {string} message */
  constructor(kind, message) {
    super(message);
    this.name = 'AlibabaError';
    this.kind = kind;
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {number | null} */
function finite(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** @param {unknown} value @returns {string | null} */
function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Convert an epoch (seconds or milliseconds), ISO string, or numeric string to milliseconds. */
function epochMs(value) {
  const numeric = finite(value);
  if (numeric !== null && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Convert a ratio in [0, 1] (or an already-scaled number) to a percentage. */
function percentage(value) {
  const numeric = finite(value);
  if (numeric === null || numeric < 0) return null;
  return numeric <= 1 ? numeric * 100 : Math.min(100, numeric);
}

/** Strip an optional matching pair of YAML quotes from a scalar. */
function unquoteYaml(raw) {
  const value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if (first === last && (first === '"' || first === "'")) return value.slice(1, -1);
  }
  return value;
}

/** Resolve `$DSH_HOME`, falling back to `~/.dsh`. */
function dshHome() {
  const configured = process.env.DSH_HOME?.trim();
  if (!configured) return join(homedir(), '.dsh');
  if (configured === '~') return homedir();
  if (configured.startsWith('~/')) return join(homedir(), configured.slice(2));
  return resolve(configured);
}

/** Read a file, returning undefined when it does not exist. */
async function readOptional(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Read the flat scalars under `refs:` in the Harness credential store. The
 * store is small and written by the Harness itself, so a tiny line scanner
 * avoids a YAML dependency.
 * @param {string} file
 * @returns {Promise<Record<string, string>>}
 */
async function readRefs(file) {
  const body = await readOptional(file);
  if (body === undefined) return {};
  /** @type {Record<string, string>} */
  const refs = {};
  let inRefs = false;
  let refsIndent = -1;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const leading = line.length - line.trimStart().length;
    if (!inRefs) {
      if (trimmed === 'refs:') {
        inRefs = true;
        refsIndent = leading;
      }
      continue;
    }
    // A key at or left of the `refs:` line ends the block.
    if (leading <= refsIndent) break;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    const name = trimmed.slice(0, colon).trim();
    const value = unquoteYaml(trimmed.slice(colon + 1));
    if (name !== '' && value !== '') refs[name] = value;
  }
  return refs;
}

/**
 * Read a dotenv file into a plain object.
 * @param {string} file
 * @returns {Promise<Record<string, string>>}
 */
async function readEnvFile(file) {
  const body = await readOptional(file);
  if (body === undefined) return {};
  /** @type {Record<string, string>} */
  const values = {};
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const withoutExport = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const equals = withoutExport.indexOf('=');
    if (equals <= 0) continue;
    const name = withoutExport.slice(0, equals).trim();
    const value = unquoteYaml(withoutExport.slice(equals + 1));
    if (name !== '' && value !== '') values[name] = value;
  }
  return values;
}

/** Pick the first non-empty value for a list of names. */
function pick(values, names) {
  for (const name of names) {
    const value = text(values[name]);
    if (value !== null) return value;
  }
  return null;
}

/**
 * Turn a name/value bag into a credential, or null when the pair is incomplete.
 * @param {Record<string, unknown>} values
 * @param {string} source
 */
function keysFrom(values, source) {
  const accessKeyId = pick(values, KEY_ID_NAMES);
  const accessKeySecret = pick(values, KEY_SECRET_NAMES);
  if (accessKeyId === null || accessKeySecret === null) return null;
  const securityToken = pick(values, SECURITY_TOKEN_NAMES);
  return {
    accessKeyId,
    accessKeySecret,
    ...(securityToken === null ? {} : { securityToken }),
    source,
  };
}

/**
 * Resolve the Aliyun AccessKey from the first source that has a complete pair.
 * @param {ReturnType<typeof resolveConfig>} config
 * @returns {Promise<{ accessKeyId: string, accessKeySecret: string, securityToken?: string, source: string }>}
 */
async function resolveAccessKeys(config) {
  if (config.accessKeyId !== '' && config.accessKeySecret !== '') {
    return {
      accessKeyId: config.accessKeyId,
      accessKeySecret: config.accessKeySecret,
      ...(config.securityToken === '' ? {} : { securityToken: config.securityToken }),
      source: 'plugin config',
    };
  }

  /** @type {Record<string, unknown>} */
  const fromEnvironment = {};
  for (const name of [...KEY_ID_NAMES, ...KEY_SECRET_NAMES, ...SECURITY_TOKEN_NAMES]) {
    const value = process.env[name];
    if (value !== undefined) fromEnvironment[name] = value;
  }
  const environment = keysFrom(fromEnvironment, 'environment');
  if (environment !== null) return environment;

  const store = config.credentialsFile !== '' ? config.credentialsFile : DEFAULT_CREDENTIALS_FILE;
  const fromStore = keysFrom(await readRefs(store), `${store} (refs)`);
  if (fromStore !== null) return fromStore;

  const envFile = join(dshHome(), '.env');
  const fromEnvFile = keysFrom(await readEnvFile(envFile), envFile);
  if (fromEnvFile !== null) return fromEnvFile;

  const aliyunFile = join(homedir(), '.aliyun', 'config.json');
  const aliyunBody = await readOptional(aliyunFile);
  if (aliyunBody !== undefined) {
    try {
      const parsed = JSON.parse(aliyunBody);
      if (isRecord(parsed) && Array.isArray(parsed.profiles)) {
        const profiles = parsed.profiles.filter(isRecord);
        const current = text(parsed.current);
        const profile =
          profiles.find((entry) => text(entry.name) === current) ??
          profiles.find((entry) => text(entry.name) === 'default') ??
          profiles[0];
        if (profile !== undefined) {
          const fromAliyun = keysFrom(
            {
              ALIBABA_CLOUD_ACCESS_KEY_ID: profile.access_key_id,
              ALIBABA_CLOUD_ACCESS_KEY_SECRET: profile.access_key_secret,
              ALIBABA_CLOUD_SECURITY_TOKEN: profile.sts_token,
            },
            `${aliyunFile} (${text(profile.name) ?? 'default'})`,
          );
          if (fromAliyun !== null) return fromAliyun;
        }
      }
    } catch {
      // A malformed aliyun config simply means this source has nothing.
    }
  }

  throw new AlibabaError(
    'auth',
    'No Alibaba Cloud AccessKey found. Add refs.ALIBABA_CLOUD_ACCESS_KEY_ID and ' +
      'refs.ALIBABA_CLOUD_ACCESS_KEY_SECRET to ~/.dsh/.credentials.yaml, or set ' +
      `ALIBABA_CLOUD_ACCESS_KEY_ID and ALIBABA_CLOUD_ACCESS_KEY_SECRET. Tried: ${store}. ` +
      'A Token Plan model key (sk-sp-...) cannot read plan usage.',
  );
}

/** Percent-encode exactly as ACS3 requires. */
function rfc3986(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** @param {string} value */
function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** @param {string} secret @param {string} value */
function hmacSha256Hex(secret, value) {
  return createHmac('sha256', secret).update(value).digest('hex');
}

/** The signed-header list, in canonical (lexicographic) order. */
function signedHeaderNames(keys) {
  const names = [
    'content-type',
    'host',
    'x-acs-action',
    'x-acs-content-sha256',
    'x-acs-date',
    'x-acs-signature-nonce',
    'x-acs-version',
  ];
  if (keys.securityToken !== undefined) names.splice(5, 0, 'x-acs-security-token');
  return names;
}

/** @param {Record<string, string>} query */
function canonicalQuery(query) {
  return Object.entries(query)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${rfc3986(key)}=${rfc3986(value)}`)
    .join('&');
}

/**
 * Call one Token Plan OpenAPI action with ACS3-HMAC-SHA256. The AccessKey
 * secret never leaves this function's argument.
 * @param {{accessKeyId: string, accessKeySecret: string, securityToken?: string}} keys
 * @param {string} action
 * @param {string} path
 * @param {Record<string, string>} [query]
 * @param {'GET'|'POST'} [method]
 * @param {string} host
 * @returns {Promise<unknown>}
 */
async function callOpenApi(keys, action, path, query = {}, method = 'GET', host = DEFAULT_OPENAPI_HOST) {
  const contentType = 'application/json';
  const body = '';
  const bodyHash = sha256Hex(body);
  const date = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const nonce = randomUUID().replace(/-/g, '');
  const names = signedHeaderNames(keys);

  const headerLines = [
    `content-type:${contentType}`,
    `host:${host}`,
    `x-acs-action:${action}`,
    `x-acs-content-sha256:${bodyHash}`,
    `x-acs-date:${date}`,
    ...(keys.securityToken === undefined ? [] : [`x-acs-security-token:${keys.securityToken}`]),
    `x-acs-signature-nonce:${nonce}`,
    `x-acs-version:${API_VERSION}`,
  ].join('\n');

  const canonicalRequest = [
    method,
    path,
    canonicalQuery(query),
    `${headerLines}\n`,
    names.join(';'),
    bodyHash,
  ].join('\n');
  const stringToSign = `ACS3-HMAC-SHA256\n${sha256Hex(canonicalRequest)}`;
  const signature = hmacSha256Hex(keys.accessKeySecret, stringToSign);

  /** @type {Record<string, string>} */
  const requestHeaders = {
    'content-type': contentType,
    'x-acs-action': action,
    'x-acs-content-sha256': bodyHash,
    'x-acs-date': date,
    'x-acs-signature-nonce': nonce,
    'x-acs-version': API_VERSION,
    Authorization:
      `ACS3-HMAC-SHA256 Credential=${keys.accessKeyId},` +
      `SignedHeaders=${names.join(';')},Signature=${signature}`,
  };
  if (keys.securityToken !== undefined) requestHeaders['x-acs-security-token'] = keys.securityToken;

  const url = new URL(`https://${host}${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

  let response;
  let raw;
  try {
    response = await fetch(url, {
      method,
      headers: requestHeaders,
      ...(method === 'POST' ? { body } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    raw = await response.text();
  } catch (error) {
    throw new AlibabaError(
      'http',
      `could not reach ${host}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    let code = /<Code>([^<]+)<\/Code>/.exec(raw)?.[1] ?? '';
    let message = /<Message>([^<]+)<\/Message>/.exec(raw)?.[1] ?? '';
    let authAction = '';
    try {
      const parsed = JSON.parse(raw);
      if (isRecord(parsed)) {
        code = text(parsed.Code) ?? code;
        message = text(parsed.Message) ?? message;
        const detail = parsed.AccessDeniedDetail;
        if (isRecord(detail)) authAction = text(detail.AuthAction) ?? '';
      }
    } catch {
      // Keep the XML values, if any.
    }
    if (authAction !== '') {
      throw new AlibabaError(
        'auth',
        `Alibaba denied the RAM user permission for ${authAction}. Grant the user ` +
          'AliyunTokenPlanReadOnlyAccess, plus modelstudio:GenerateCLIAccessToken for the console path.',
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new AlibabaError('auth', `Alibaba rejected the AccessKey (HTTP ${response.status}).`);
    }
    if (/InvalidAccessKey|Signature|NoPermission|Forbidden|Unauthorized/i.test(`${code} ${message}`)) {
      throw new AlibabaError(
        'auth',
        `Alibaba rejected the AccessKey (${code || `HTTP ${response.status}`}).`,
      );
    }
    throw new AlibabaError(
      'http',
      `Alibaba returned ${code || `HTTP ${response.status}`}${message === '' ? '' : `: ${message}`}.`,
    );
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new AlibabaError('parse', 'Alibaba returned an unreadable usage response.');
  }
  if (!isRecord(payload)) {
    throw new AlibabaError('parse', 'Alibaba returned an unexpected usage response.');
  }
  if (payload.Success === false) {
    const code = text(payload.Code) ?? 'RequestFailed';
    const message = text(payload.Message) ?? 'Alibaba rejected the usage request.';
    if (/InvalidAccessKey|Signature|NoPermission|Forbidden|Unauthorized/i.test(`${code} ${message}`)) {
      throw new AlibabaError('auth', `Alibaba rejected the AccessKey (${code}).`);
    }
    throw new AlibabaError('http', message);
  }
  return payload;
}

/** Recursively expand stringified JSON, as the console sometimes double-encodes payloads. */
function expandEmbedded(value, depth = 0) {
  if (depth > 12) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
    try {
      return expandEmbedded(JSON.parse(trimmed), depth + 1);
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map((item) => expandEmbedded(item, depth + 1));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, expandEmbedded(nested, depth + 1)]),
  );
}

/** Find the object carrying the Token Plan window fields. */
function findUsagePayload(value, depth = 0) {
  if (depth > 12) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUsagePayload(item, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  if (
    value.per1MonthPercentage !== undefined ||
    value.per1MonthResetTime !== undefined ||
    value.per1WeekPercentage !== undefined ||
    value.per5HourPercentage !== undefined
  ) {
    return value;
  }
  for (const nested of Object.values(value)) {
    const found = findUsagePayload(nested, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

/** Find a `success: false` error envelope anywhere in a console response. */
function findFailure(value, depth = 0) {
  if (depth > 12) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFailure(item, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  if (value.success === false || value.Success === false) return value;
  for (const nested of Object.values(value)) {
    const found = findFailure(nested, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

/** Find the short-lived console token in the GenerateCLIAccessToken response. */
function findCliToken(value, depth = 0) {
  if (depth > 8) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCliToken(item, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  const direct = text(value.cliAccessToken);
  if (direct !== null) return direct;
  for (const nested of Object.values(value)) {
    const found = findCliToken(nested, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Read the subscription-month percentage through the Model Studio console.
 * @param {{accessKeyId: string, accessKeySecret: string, securityToken?: string, source: string}} keys
 * @param {ReturnType<typeof resolveConfig>} config
 * @returns {Promise<{usedPct: number, resetsAt: string | null, totalCredits: null, remainingCredits: null, planLabel: string} | null>}
 */
async function readConsoleUsage(keys, config) {
  const tokenPayload = await callOpenApi(
    keys,
    'GenerateCLIAccessToken',
    '/modelstudio/cli/generateAccessToken',
    {},
    'POST',
    config.openApiHost,
  );
  if (isRecord(tokenPayload) && typeof tokenPayload.Code === 'string' && tokenPayload.Code !== '200') {
    throw new AlibabaError(
      'auth',
      `Alibaba did not issue a console token (${tokenPayload.Code}). Grant the AccessKey Token Plan read access.`,
    );
  }
  const token = findCliToken(tokenPayload);
  if (token === null) {
    throw new AlibabaError(
      'auth',
      'Alibaba did not issue a console token. Grant the AccessKey Token Plan read access.',
    );
  }

  const params = JSON.stringify({
    Api: CONSOLE_USAGE_API,
    V: '1.0',
    Data: {
      cornerstoneParam: {
        feTraceId: randomUUID().toLowerCase(),
        feURL: `https://${config.consoleDomain}/${config.consoleRegion}/?tab=plan`,
        protocol: 'V2',
        console: 'ONE_CONSOLE',
        productCode: 'p_efm',
        switchUserType: 3,
        domain: config.consoleDomain,
        consoleSite: config.consoleSite,
        userNickName: '',
        userPrincipalName: '',
        xsp_lang: 'en-US',
      },
    },
  });
  const form = new URLSearchParams({ params, region: config.consoleRegion }).toString();
  const url =
    `https://${config.consoleHost}/cli/api.json?action=${CONSOLE_ACTION}` +
    `&product=sfm_bailian&api=${encodeURIComponent(CONSOLE_USAGE_API)}`;

  let response;
  let raw;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: '*/*',
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${token}`,
      },
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    raw = await response.text();
  } catch (error) {
    throw new AlibabaError(
      'http',
      `could not reach ${config.consoleHost}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new AlibabaError(
      'auth',
      'Alibaba console rejected the temporary token. Grant the AccessKey Token Plan read access.',
    );
  }
  if (!response.ok) {
    throw new AlibabaError('http', `Alibaba console returned HTTP ${response.status}.`);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new AlibabaError('parse', 'Alibaba console returned an unreadable usage response.');
  }

  const failure = findFailure(payload);
  if (failure !== null) {
    const code = text(failure.errorCode) ?? text(failure.Code) ?? 'RequestFailed';
    const message = text(failure.errorMsg) ?? text(failure.Message) ?? '';
    if (/Team\.NotAuthorised|Workspace\.NotAuthorised/i.test(code)) {
      throw new AlibabaError(
        'auth',
        `Alibaba denied the RAM user access to the Model Studio workspace (${code}). In the Model Studio ` +
          'console, open Account Management, add this RAM user, and grant Administrator or Subscribe Plan permission.',
      );
    }
    if (/NotLogined|NotAuthorised|NotAuthorized|Forbidden|Unauthorized/i.test(`${code} ${message}`)) {
      throw new AlibabaError(
        'auth',
        `Alibaba could not open the Token Plan console (${code}). Add the RAM user to the Model Studio ` +
          'workspace with Administrator or Subscribe Plan permission.',
      );
    }
    throw new AlibabaError('http', message === '' ? code : message);
  }

  const usage = findUsagePayload(expandEmbedded(payload));
  if (usage === null) return null;
  const usedPct = percentage(usage.per1MonthPercentage);
  if (usedPct === null) return null;
  const reset = epochMs(usage.per1MonthResetTime);
  return {
    usedPct,
    resetsAt: reset === null ? null : new Date(reset).toISOString(),
    totalCredits: null,
    remainingCredits: null,
    planLabel: 'Token Plan',
  };
}

/** Sum Credits from the seat-detail response, when the plan reports them. */
function readingFromSeats(payload) {
  if (!isRecord(payload) || !isRecord(payload.Data) || !Array.isArray(payload.Data.Items)) return null;
  const items = payload.Data.Items.filter(isRecord);
  const assigned = items.filter((item) => text(item.AssignedStatus)?.toUpperCase() === 'ASSIGNED');
  const selected = assigned.length > 0 ? assigned : items;
  let total = 0;
  let remaining = 0;
  let resetMs = null;
  let specType = null;

  for (const item of selected) {
    const seatSpec = text(item.SpecType);
    if (specType === null && seatSpec !== null) specType = seatSpec;
    if (!Array.isArray(item.EquityList)) continue;
    for (const equity of item.EquityList) {
      if (!isRecord(equity)) continue;
      const kind = text(equity.EquityType)?.toUpperCase();
      if (kind !== undefined && kind !== 'CREDITS') continue;
      const limit = finite(equity.CycleTotalValue);
      const left = finite(equity.CycleSurplusValue);
      if (limit === null || limit <= 0 || left === null) continue;
      total += limit;
      remaining += Math.max(0, Math.min(limit, left));
      const end = epochMs(equity.CycleEndTime);
      if (end !== null && (resetMs === null || end > resetMs)) resetMs = end;
    }
  }

  if (total <= 0) return null;
  const used = Math.max(0, Math.min(total, total - remaining));
  return {
    usedPct: (used / total) * 100,
    resetsAt: resetMs === null ? null : new Date(resetMs).toISOString(),
    totalCredits: total,
    remainingCredits: Math.max(0, remaining),
    planLabel: specType === null ? 'Token Plan' : `Token Plan ${specType}`,
  };
}

/** Sum Credits from the subscription-stats response, when the plan reports them. */
function readingFromStats(payload) {
  if (!isRecord(payload) || !isRecord(payload.Data) || !Array.isArray(payload.Data.Items)) return null;
  let total = 0;
  let remaining = 0;
  let resetMs = null;
  let specType = null;

  for (const item of payload.Data.Items) {
    if (!isRecord(item)) continue;
    const limit = finite(item.SeatCredits);
    const left = finite(item.SeatRemainingCredits);
    if (limit === null || limit <= 0 || left === null) continue;
    total += limit;
    remaining += Math.max(0, Math.min(limit, left));
    const refresh = epochMs(item.SeatRefreshTime);
    if (refresh !== null && (resetMs === null || refresh > resetMs)) resetMs = refresh;
    const seat = text(item.SeatType);
    if (specType === null && seat !== null) specType = seat;
  }

  if (total <= 0) return null;
  const used = Math.max(0, Math.min(total, total - remaining));
  return {
    usedPct: (used / total) * 100,
    resetsAt: resetMs === null ? null : new Date(resetMs).toISOString(),
    totalCredits: total,
    remainingCredits: Math.max(0, remaining),
    planLabel: specType === null ? 'Token Plan' : `Token Plan ${specType}`,
  };
}

/**
 * Read the plan through the Token Plan OpenAPI seat endpoints. Used when the
 * console path is unavailable and, separately, to enrich a percentage-only
 * console reading with credit totals.
 * @param {Awaited<ReturnType<typeof resolveAccessKeys>>} keys
 * @param {ReturnType<typeof resolveConfig>} config
 */
async function readOpenApiUsage(keys, config) {
  const failures = [];

  try {
    const seats = await callOpenApi(
      keys,
      'GetSubscriptionSeatDetails',
      '/tokenplan/subscription/seat-detail',
      { PageNo: '1', PageSize: '100' },
      'GET',
      config.openApiHost,
    );
    const reading = readingFromSeats(seats);
    if (reading !== null) return reading;
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  try {
    const stats = await callOpenApi(
      keys,
      'GetSubscriptionStats',
      '/tokenplan/subscription/stats',
      {},
      'GET',
      config.openApiHost,
    );
    const reading = readingFromStats(stats);
    if (reading !== null) return reading;
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  const authFailure = failures.find((message) => /AccessKey|permission|Unauthorized|Forbidden/i.test(message));
  if (authFailure !== undefined) throw new AlibabaError('auth', authFailure);
  throw new AlibabaError(
    'empty',
    failures[0] ?? 'Alibaba returned no Token Plan Credits for the current subscription month.',
  );
}

/** Round one percentage for the UI without losing the raw value in the payload. */
function levelOf(percent, warnPercent) {
  if (typeof percent === 'number' && percent >= 100) return 'critical';
  if (typeof percent === 'number' && percent >= warnPercent) return 'warning';
  return 'ok';
}

/** Resolve the plugin configuration against its defaults. */
function resolveConfig(config) {
  const raw = isRecord(config) ? config : {};
  const host = (value, fallback) => {
    if (typeof value !== 'string' || value.trim() === '') return fallback;
    return value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  };
  return {
    accessKeyId: typeof raw.accessKeyId === 'string' ? raw.accessKeyId.trim() : '',
    accessKeySecret: typeof raw.accessKeySecret === 'string' ? raw.accessKeySecret.trim() : '',
    securityToken: typeof raw.securityToken === 'string' ? raw.securityToken.trim() : '',
    credentialsFile: typeof raw.credentialsFile === 'string' ? raw.credentialsFile : '',
    openApiHost: host(raw.openApiHost, DEFAULT_OPENAPI_HOST),
    consoleHost: host(raw.consoleHost, DEFAULT_CONSOLE_HOST),
    consoleRegion:
      typeof raw.consoleRegion === 'string' && raw.consoleRegion !== ''
        ? raw.consoleRegion
        : DEFAULT_CONSOLE_REGION,
    consoleSite:
      typeof raw.consoleSite === 'string' && raw.consoleSite !== '' ? raw.consoleSite : DEFAULT_CONSOLE_SITE,
    consoleDomain:
      typeof raw.consoleDomain === 'string' && raw.consoleDomain !== ''
        ? raw.consoleDomain
        : DEFAULT_CONSOLE_DOMAIN,
    refreshSeconds:
      Number.isFinite(raw.refreshSeconds) && raw.refreshSeconds >= 30 ? raw.refreshSeconds : 300,
    warnPercent:
      Number.isFinite(raw.warnPercent) && raw.warnPercent > 0 && raw.warnPercent <= 100
        ? raw.warnPercent
        : 80,
    contextNotice: raw.contextNotice !== false,
    providerMatch:
      typeof raw.providerMatch === 'string' && raw.providerMatch !== '' ? raw.providerMatch : 'alibaba',
    providerExclude: Array.isArray(raw.providerExclude)
      ? raw.providerExclude.filter((item) => typeof item === 'string' && item !== '')
      : [],
    creditsFallback: raw.creditsFallback !== false,
    creditRefreshSeconds:
      Number.isFinite(raw.creditRefreshSeconds) && raw.creditRefreshSeconds >= 30
        ? raw.creditRefreshSeconds
        : 900,
  };
}

/**
 * Fetch the current monthly window, falling back to the seat endpoints.
 * @param {ReturnType<typeof resolveConfig>} config
 */
async function fetchUsage(config) {
  const keys = await resolveAccessKeys(config);
  const failures = [];

  try {
    const reading = await readConsoleUsage(keys, config);
    if (reading !== null) {
      return {
        reading,
        source: 'console',
        endpoint: `https://${config.consoleHost}/cli/api.json (Token Plan console usage)`,
        credentialSource: keys.source,
      };
    }
    failures.push('the console returned no monthly Token Plan window');
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  try {
    const reading = await readOpenApiUsage(keys, config);
    return {
      reading,
      source: 'openapi',
      endpoint: `https://${config.openApiHost}/tokenplan/subscription (Token Plan OpenAPI)`,
      credentialSource: keys.source,
    };
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  const authFailure = failures.find(
    (message) => message.startsWith('No Alibaba Cloud AccessKey') || /AccessKey|permission|NotLogined|NotAuthorised|Unauthorized|Forbidden/i.test(message),
  );
  throw new AlibabaError(
    authFailure === undefined ? 'empty' : 'auth',
    failures.join(' ') || 'Alibaba Token Plan usage could not be read.',
  );
}

/**
 * Read the optional seat credit totals on their own schedule.
 * @param {ReturnType<typeof resolveConfig>} config
 */
async function fetchCredits(config) {
  const keys = await resolveAccessKeys(config);
  try {
    const seats = await callOpenApi(
      keys,
      'GetSubscriptionSeatDetails',
      '/tokenplan/subscription/seat-detail',
      { PageNo: '1', PageSize: '100' },
      'GET',
      config.openApiHost,
    );
    return readingFromSeats(seats);
  } catch {
    return null;
  }
}

/**
 * Register the Alibaba Token Plan integration.
 * @param {any} ctx - the plugin's Cordis context.
 * @param {unknown} rawConfig - the row's config object.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  /** Last successful reading; kept across failed refreshes so a blip never blanks the UI. */
  const state = {
    monthly: null,
    planLabel: null,
    credits: null,
    source: null,
    endpoint: null,
    credentialSource: null,
    fetchedAt: null,
    error: null,
  };
  let inFlight = null;
  /** Credit state is separate: percentage-only plans need not read it at all. */
  const creditsState = { reading: null, fetchedAt: null, error: null };
  let creditsInFlight = null;

  /**
   * Refresh the cached reading, collapsing concurrent callers onto one request.
   * @param {boolean} force
   */
  const refresh = (force) => {
    const fresh =
      state.fetchedAt !== null && Date.now() - state.fetchedAt < config.refreshSeconds * 1000;
    if (inFlight !== null) return inFlight;
    if (fresh && force !== true) return Promise.resolve(state);
    inFlight = (async () => {
      try {
        const { reading, source, endpoint, credentialSource } = await fetchUsage(config);
        state.monthly = {
          percent: reading.usedPct,
          resetsAt: reading.resetsAt,
          level: levelOf(reading.usedPct, config.warnPercent),
        };
        state.planLabel = reading.planLabel;
        state.credits =
          reading.totalCredits === null || reading.remainingCredits === null
            ? null
            : {
                total: reading.totalCredits,
                remaining: reading.remainingCredits,
                used: Math.max(0, reading.totalCredits - reading.remainingCredits),
              };
        state.source = source;
        state.endpoint = endpoint;
        state.credentialSource = credentialSource;
        state.fetchedAt = Date.now();
        state.error = null;
      } catch (error) {
        state.error = error instanceof Error ? error.message : String(error);
      } finally {
        inFlight = null;
      }
      return state;
    })();
    return inFlight;
  };

  /**
   * Refresh the cached credit reading on its own slower schedule.
   * @param {boolean} force
   */
  const refreshCredits = (force) => {
    if (config.creditsFallback !== true) return Promise.resolve(creditsState);
    const fresh =
      creditsState.fetchedAt !== null &&
      Date.now() - creditsState.fetchedAt < config.creditRefreshSeconds * 1000;
    if (creditsInFlight !== null) return creditsInFlight;
    if (fresh && force !== true) return Promise.resolve(creditsState);
    creditsInFlight = (async () => {
      try {
        creditsState.reading = await fetchCredits(config);
        creditsState.fetchedAt = Date.now();
        creditsState.error = null;
      } catch (error) {
        creditsState.error = error instanceof Error ? error.message : String(error);
      } finally {
        creditsInFlight = null;
      }
      return creditsState;
    })();
    return creditsInFlight;
  };

  /** Build the payload shared by the route, the tool and the prompt notice. */
  const payload = () => {
    const creditsTried = creditsState.fetchedAt !== null;
    const creditsReading = creditsState.reading ?? state.credits;
    const credits = creditsTried
      ? {
          ...(creditsReading ?? {}),
          available: creditsReading !== null,
          fetchedAt: new Date(creditsState.fetchedAt).toISOString(),
          error: creditsState.error,
        }
      : {
          ...(state.credits ?? {}),
          available: state.credits !== null,
          fetchedAt: null,
          error: null,
        };
    return {
      ok: state.monthly !== null && state.error === null,
      stale: state.monthly !== null && state.error !== null,
      fetchedAt: state.fetchedAt === null ? null : new Date(state.fetchedAt).toISOString(),
      credentialSource: state.credentialSource,
      source: state.endpoint,
      planLabel: state.planLabel ?? 'Token Plan',
      monthly: state.monthly,
      credits,
      warnPercent: config.warnPercent,
      refreshSeconds: config.refreshSeconds,
      providerMatch: config.providerMatch,
      providerExclude: config.providerExclude,
      contextNotice: config.contextNotice,
      error: state.error,
    };
  };

  /**
   * Render the reading as the compact text the agent reads.
   * @param {ReturnType<typeof payload>} snapshot
   */
  const format = (snapshot) => {
    const lines = [];
    if (snapshot.monthly === null) {
      lines.push('Alibaba Token Plan monthly usage: no reading yet.');
    } else {
      const percent = `${snapshot.monthly.percent.toFixed(1)}%`;
      const reset =
        snapshot.monthly.resetsAt === null
          ? 'reset time unknown'
          : `resets ${snapshot.monthly.resetsAt}`;
      const level = snapshot.monthly.level === 'ok' ? '' : ` [${snapshot.monthly.level}]`;
      lines.push(`${snapshot.planLabel} monthly: ${percent} used — ${reset}${level}`);
    }
    if (snapshot.fetchedAt !== null) lines.push(`fetched ${snapshot.fetchedAt} from ${snapshot.source ?? 'Alibaba'}`);
    if (snapshot.credentialSource !== null) lines.push(`credential: ${snapshot.credentialSource}`);
    if (snapshot.credits !== null && snapshot.credits.available === true) {
      lines.push(
        `Seat credits: ${snapshot.credits.used.toFixed(2)} used, ` +
          `${snapshot.credits.remaining.toFixed(2)} remaining of ${snapshot.credits.total.toFixed(2)}`,
      );
    } else if (snapshot.credits !== null && snapshot.credits.fetchedAt !== null) {
      lines.push(
        snapshot.credits.error === null
          ? 'Seat credits: none reported for this plan (percentage-only monthly window).'
          : `Seat credits unavailable: ${snapshot.credits.error}`,
      );
    }
    if (snapshot.error !== null) lines.push(`last refresh failed: ${snapshot.error}`);
    return lines.join('\n');
  };

  /** Build the prompt notice: only once the monthly window crosses the threshold. */
  const notice = () => {
    if (config.contextNotice !== true) return '';
    if (state.monthly === null || state.monthly.level === 'ok') return '';
    const percent = `${state.monthly.percent.toFixed(1)}%`;
    const reset = state.monthly.resetsAt === null ? '' : `, resets ${state.monthly.resetsAt}`;
    return `Alibaba Token Plan monthly quota: ${percent} used${reset}. Stay concise and avoid long tool loops until the subscription month resets.`;
  };

  // Poll in the background so the strip, the tool and the notice stay current.
  ctx.effect(() => {
    void refresh(false);
    const timer = setInterval(() => void refresh(false), config.refreshSeconds * 1000);
    return () => clearInterval(timer);
  }, 'alibaba-token-plan: polling');

  // Agent tool: read the monthly window on demand.
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'alibaba_token_plan_usage',
        description:
          'Read Alibaba Cloud Token Plan monthly usage: the current subscription month\'s percentage used and when it resets. Use it before starting long tool loops or when asked how much of the Alibaba quota is left. Pass credits to also try the plan\'s seat-based credit totals.',
        parameters: {
          type: 'object',
          properties: {
            refresh: {
              type: 'boolean',
              description:
                'Force a fresh reading instead of the cached one (the cache lives for the configured refresh interval).',
            },
            credits: {
              type: 'boolean',
              description:
                'Also try the Token Plan OpenAPI for seat-based credit totals. Some personal plans report only a percentage.',
            },
          },
          additionalProperties: false,
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [
            { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) },
          ],
        },
        async execute(args) {
          const requested = args !== null && typeof args === 'object' && args.refresh === true;
          const wantsCredits = args !== null && typeof args === 'object' && args.credits === true;
          await refresh(requested);
          if (wantsCredits) await refreshCredits(requested);
          return format(payload());
        },
        isConcurrencySafe: () => true,
      }),
    'alibaba-token-plan: tool',
  );

  // Optional prompt notice once the month crosses the warning threshold.
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(
      () =>
        promptCtx.systemPrompt.context({
          name: 'alibaba-token-plan',
          order: CONTEXT_ORDER,
          text: () => notice(),
        }),
      'alibaba-token-plan: prompt notice',
    );
  });

  // Same-origin route for the Web page. The browser cannot sign the Aliyun
  // request itself, so the Host serves the reading.
  ctx.inject(['webServer'], (webCtx) => {
    const handler = async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'text/plain' });
        res.end('method not allowed');
        return;
      }
      const url = new URL(req.url ?? USAGE_PATH, 'http://localhost');
      await refresh(url.searchParams.get('refresh') === '1');
      // `credits=1` respects the credit cache; `credits=force` bypasses it.
      const wantCredits = url.searchParams.get('credits');
      if (wantCredits !== null) await refreshCredits(wantCredits === 'force');
      const body = JSON.stringify(payload(), null, 2);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: USAGE_PATH, handler }),
      'alibaba-token-plan: usage route',
    );
  });
}