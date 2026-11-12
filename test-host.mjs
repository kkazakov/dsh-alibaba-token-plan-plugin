/**
 * Offline harness for the Host half: drives `apply` with a fake Cordis context
 * and exercises the tool, the HTTP route, the prompt notice, the method guard,
 * and the provider visibility rule against the live Alibaba endpoints.
 *
 * Run with: node test-host.mjs
 *
 * It reads the AccessKey from the Harness credential store (~/.dsh/.credentials.yaml
 * refs) exactly like the installed plugin. Point the harness at another store with
 *   DSH_ALIBABA_CREDENTIALS_FILE=/path/to/.credentials.yaml node test-host.mjs
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { apply } from './index.js';

const CREDENTIALS_FILE =
  process.env.DSH_ALIBABA_CREDENTIALS_FILE ?? join(homedir(), '.dsh/.credentials.yaml');

let tool = null;
let route = null;
let promptContext = null;

const ctx = {
  effect(fn) {
    return fn();
  },
  inject(_names, callback) {
    callback(ctx);
  },
  tools: {
    register(definition) {
      tool = definition;
      return () => {};
    },
  },
  webServer: {
    register(definition) {
      route = definition;
      return () => {};
    },
  },
  systemPrompt: {
    context(definition) {
      promptContext = definition;
      return () => {};
    },
  },
};

/** Call the registered route and return the parsed payload. */
const callRoute = (url, method = 'GET') =>
  new Promise((resolve) => {
    let status = 200;
    route.handler(
      { method, url },
      {
        writeHead(next) {
          status = next;
        },
        end(body) {
          resolve({ status, body: body === undefined ? null : body });
        },
      },
    );
  });

apply(ctx, {
  credentialsFile: CREDENTIALS_FILE,
  refreshSeconds: 300,
  warnPercent: 80,
  providerMatch: 'alibaba',
});

await new Promise((resolve) => setTimeout(resolve, 4000));

console.log('--- tool definition ---');
console.log({
  name: tool?.name,
  parameters: Object.keys(tool?.parameters?.properties ?? {}),
  hasRender: typeof tool?.output?.render,
});

console.log('\n--- tool execute (refresh: true, credits: true) ---');
console.log(await tool.execute({ refresh: true, credits: true }));

console.log('\n--- prompt notice (empty unless the month is past the threshold) ---');
console.log(JSON.stringify(promptContext.text()));

console.log('\n--- route /alibaba-token-plan/usage.json ---');
const plain = await callRoute('/alibaba-token-plan/usage.json');
const plainBody = JSON.parse(plain.body);
console.log(
  JSON.stringify(
    {
      status: plain.status,
      ok: plainBody.ok,
      stale: plainBody.stale,
      credentialSource: plainBody.credentialSource,
      source: plainBody.source,
      planLabel: plainBody.planLabel,
      monthly: plainBody.monthly,
      credits: plainBody.credits,
      providerMatch: plainBody.providerMatch,
      providerExclude: plainBody.providerExclude,
      error: plainBody.error,
    },
    null,
    2,
  ),
);

console.log('\n--- route ?refresh=1&credits=1 ---');
const fresh = await callRoute('/alibaba-token-plan/usage.json?refresh=1&credits=1');
const freshBody = JSON.parse(fresh.body);
console.log(
  JSON.stringify(
    {
      status: fresh.status,
      ok: freshBody.ok,
      monthly: freshBody.monthly,
      credits: freshBody.credits,
    },
    null,
    2,
  ),
);

console.log('\n--- method guard (POST) ---');
console.log(await callRoute('/alibaba-token-plan/usage.json', 'POST'));

console.log('\n--- HEAD ---');
const head = await callRoute('/alibaba-token-plan/usage.json', 'HEAD');
console.log({ status: head.status, body: head.body });

console.log('\n--- provider visibility (the same substring rule the Client uses) ---');
const providerMatches = (provider, match, exclude) => {
  if (typeof provider !== 'string' || provider === '') return false;
  const value = provider.toLowerCase();
  if (value.indexOf(match.toLowerCase()) === -1) return false;
  return !exclude.some((item) => value.indexOf(item.toLowerCase()) !== -1);
};
const rules = [
  { plugin: 'alibaba', match: 'alibaba', exclude: [] },
  { plugin: 'deepseek-balance', match: 'deepseek', exclude: [] },
  { plugin: 'opencode-go', match: 'opencode', exclude: [] },
];
for (const provider of ['alibaba', 'deepseek-account', 'opencode-go']) {
  const shown = rules.filter((rule) => providerMatches(provider, rule.match, rule.exclude)).map((rule) => rule.plugin);
  console.log(`${provider} -> ${shown.join(', ') || '(none)'}`);
  if (shown.length !== 1) throw new Error(`visibility is not exclusive for ${provider}: ${shown.join(', ')}`);
}
console.log("\n--- done ---");
process.exit(0);
