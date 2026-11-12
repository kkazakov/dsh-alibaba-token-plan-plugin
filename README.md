# dsh-alibaba-token-plan

Alibaba Cloud **Token Plan** monthly usage inside DeepSeek Harness: an ambient
strip under the composer, a settings page, and an `alibaba_token_plan_usage`
tool the agent can call.

This is the DeepSeek Harness port of the Paseo `alibaba-usage` plugin, rebuilt
on the same bundle/slot/route pattern as `dsh-opencode-usage` and
`dsh-deepseek-balance`.

## What it gives you

| Surface | Behaviour |
|---|---|
| **Composer strip** | `Token Plan · Monthly [bar] 5% · resets in 29d` under the composer. Polls every 60s, forcing a fresh read each time. Goes amber at `warnPercent` and red at 100%. |
| **Model-aware visibility** | The strip appears **only while the session's selected model belongs to an Alibaba provider** (`providerMatch: 'alibaba'`). The per-session selection wins over the global default. |
| **Settings page** | *Settings → Alibaba Token Plan*: the monthly percentage as a large meter, the reset time as local clock + countdown, the plan label, the credential source, the endpoint, the warn threshold, and a manual **Refresh**. Always available, independent of the selected model. |
| **`alibaba_token_plan_usage` tool** | The same reading as text so the agent can check headroom before a long tool loop. Pass `credits: true` to also try the plan's seat-based credit totals. |
| **Threshold notice** | Once the monthly window crosses `warnPercent`, one short line is added to the prompt asking the model to stay lean until the month resets. Silent below the threshold. |
| **Seat credits** | When the plan reports them, used / remaining / total Credits appear beside the meters and on the settings page. Personal Token Plan subscriptions often report a percentage only; the page says so instead of inventing totals. |

The number is a **percentage of the subscription month's limit**, straight from
Alibaba. If the strip shows `5%`, 5% of the month's Token Plan Credits have been
used. The window is a **subscription month**, not a calendar month; the reset
countdown comes from the API's `per1MonthResetTime`.

## The three usage plugins never collide

DeepSeek Harness lets several bundles add a composer strip. Each of the three
usage plugins decides for itself whether to render, using the **provider id of
the model currently selected in the session** — never the model name:

| Selected provider id | Alibaba Token Plan | DeepSeek balance | OpenCode Go |
|---|---|---|---|
| `alibaba` | **shown** | hidden | hidden |
| `deepseek-account` | hidden | **shown** | hidden |
| `opencode-go` | hidden | hidden | **shown** |

The rules are ordinary substring matches:

| Plugin | `providerMatch` | Why it is disjoint |
|---|---|---|
| `@wasp/dsh-alibaba-token-plan` | `alibaba` | The profile's Alibaba route is `alibaba`. |
| `@wasp/dsh-deepseek-balance` | `deepseek` | The DeepSeek account route reports `deepseek-account`. |
| `@wasp/dsh-opencode-usage` | `opencode` | The OpenCode route reports `opencode-go`. |

This matters because Alibaba also serves models whose ids start with
`deepseek-` (`deepseek-v4.1-flash-1017`, `deepseek-v4-pro`, ...). On those
models the provider is still `alibaba`, so **only the Alibaba strip shows** — the
DeepSeek balance strip watches the provider, not the model name. The optional
`providerExclude` list is a second guard for deployments that rename routes.

Keep `showForAllProviders: false` on the DeepSeek balance row (the default) if
you want this exclusivity: setting it to `true` deliberately opts that strip out
of provider matching and makes it render beside the Alibaba strip.

## Requirements

- DeepSeek Harness with the Web UI (Desktop, or a `web` profile).
- An Aliyun **AccessKey** for a RAM user that can read the Model Studio
  subscription. The plugin does **not** use the `sk-sp-...` Token Plan model key
  for usage: that key only authorizes inference.

The credential is taken from the first source that has a complete ID/secret pair:

1. the `accessKeyId` + `accessKeySecret` settings;
2. the environment (`ALIBABA_CLOUD_ACCESS_KEY_ID` / `ALIBABA_CLOUD_ACCESS_KEY_SECRET`,
   also accepting `ALIBABA_*`, `ALIYUN_*`, and `BAILIAN_*` spellings);
3. the Harness credential store — `refs.ALIBABA_CLOUD_ACCESS_KEY_ID` and
   `refs.ALIBABA_CLOUD_ACCESS_KEY_SECRET` in `~/.dsh/.credentials.yaml`;
4. `$DSH_HOME/.env`;
5. the current profile in `~/.aliyun/config.json`.

Source 3 is the one to want: it keeps the usage AccessKey beside the model
keys the profile already resolves, so there is one place to rotate.

The RAM user needs `AliyunTokenPlanReadOnlyAccess`, plus
`modelstudio:GenerateCLIAccessToken` for the console path (the console token is
what carries the monthly percentage). The seat endpoints need the Token Plan
read permission as well. A `Team.NotAuthorised` answer means the RAM user is not
a member of the Model Studio workspace; add it in the console under Account
Management with Administrator or Subscribe Plan permission.

## Install

**This checkout (how it is installed in the current profile).** Give
`plugin_manager` the absolute path of the checkout:

```
/home/wasp/Projects/sandbox/dsh-alibaba-token-plan-plugin
```

It links the package into the profile (`link:`), selects the bundle, and applies
its patch row. Installing runs the plugin **in-process with your permissions**;
only install it from a source you trust.

**From GitHub:**

```
github:kkazakov/dsh-alibaba-token-plan-plugin
```

**From npm**, once the package is published:

```
@wasp/dsh-alibaba-token-plan
```

The Web **Plugins → Add plugin** box accepts the published name or the GitHub
spec.

**Manual profile link** (local development) instead of `plugin_manager`:

```jsonc
// ~/.dsh/profiles/<profile>/package.json
"dependencies": { "@wasp/dsh-alibaba-token-plan": "link:/path/to/dsh-alibaba-token-plan-plugin" },
"dsh": { "profile": { "bundles": [ /* … */ "@wasp/dsh-alibaba-token-plan" ] } }
```

### Upgrading

DeepSeek Harness does not auto-update plugins yet: **uninstall and reinstall** to
move to a new version. Pin a version with e.g.
`@wasp/dsh-alibaba-token-plan@1.0.0` if you need reproducibility.

## Configuration

All settings live in the bundle's row and can be overridden in your own profile
patch layer (`~/.dsh/profiles/<profile>/cordis.patch.yml`), which survives plugin
updates:

```yaml
- id: alibaba-token-plan
  name: '@wasp/dsh-alibaba-token-plan'
  config:
    warnPercent: 60
    refreshSeconds: 120
    providerMatch: 'alibaba'
```

| Key | Default | Meaning |
|---|---|---|
| `accessKeyId` | `''` | Use this AccessKey id ahead of every other source. Prefer leaving it empty. |
| `accessKeySecret` | `''` | The matching secret. Prefer leaving it empty. |
| `securityToken` | `''` | Optional STS token for a temporary AccessKey. |
| `credentialsFile` | `''` | Harness credential store to read the refs from. Empty means `~/.dsh/.credentials.yaml`. |
| `openApiHost` | `modelstudio.ap-southeast-1.aliyuncs.com` | Aliyun OpenAPI host for the Singapore / international Token Plan. |
| `consoleHost` | `bailian-singapore-cs.alibabacloud.com` | Console gateway host. |
| `consoleRegion` | `ap-southeast-1` | Console region id. |
| `consoleSite` | `MODELSTUDIO_ALBABACLOUD` | Console site marker. |
| `consoleDomain` | `modelstudio.console.alibabacloud.com` | Console domain used in the request context. |
| `refreshSeconds` | `300` | How often the Host re-reads upstream (minimum 30). |
| `warnPercent` | `80` | Percentage at which the window is flagged and the prompt notice fires. |
| `contextNotice` | `true` | Set `false` to keep the warning out of the model's context entirely. |
| `providerMatch` | `'alibaba'` | The strip shows when the selected provider id contains this substring. |
| `providerExclude` | `[]` | Hide the strip when the provider id contains any of these substrings. |
| `creditsFallback` | `true` | Try the seat endpoints for credit totals when the console reports a percentage only. |
| `creditRefreshSeconds` | `900` | How often the seat credit reading is refreshed (minimum 30). |

## Where the data comes from

A Token Plan **model key cannot read usage**. The plugin therefore signs Aliyun
OpenAPI calls with the AccessKey (ACS3-HMAC-SHA256, computed locally) and mints a
short-lived console token:

```
POST https://modelstudio.ap-southeast-1.aliyuncs.com/modelstudio/cli/generateAccessToken
  x-acs-action: GenerateCLIAccessToken
-> { "cliAccessToken": "…" }
```

That token authenticates the same console gateway the official `bl` CLI uses:

```
POST https://bailian-singapore-cs.alibabacloud.com/cli/api.json
     ?action=IntlBroadScopeAspnGateway&product=sfm_bailian
     &api=zeldaHttp.apikeyMgr.%2Ftokenplan%2Fpersonal%2Fapi%2Fv2%2Fusage
  Authorization: Bearer <console token>
  params={"Api":"zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage", …}
  region=ap-southeast-1
```

The payload carries the month as a **ratio**, not a percentage:

```json
{
  "data": {
    "DataV2": {
      "data": {
        "data": {
          "per1MonthPercentage": 0.0501323757116975,
          "per1MonthResetTime": 1797004800000
        }
      }
    }
  }
}
```

`0.0501…` is **5.01% used**; `1797004800000` is epoch **milliseconds** and becomes
the reset time. The parser tolerates the several envelope depths the gateway
uses, because a proxy or console build may wrap the payload differently.

If the console path is unavailable, the plugin falls back to the Token Plan
OpenAPI itself:

| Call | Supplies |
|---|---|
| `GetSubscriptionSeatDetails` | `CycleTotalValue`, `CycleSurplusValue`, `CycleEndTime` per CREDITS equity |
| `GetSubscriptionStats` | `SeatCredits`, `SeatRemainingCredits`, `SeatRefreshTime` |

That path is what a team seat-based plan answers, and it also supplies the
optional credit totals shown beside the monthly meter. A personal plan that
reports only a percentage returns no seats, which the settings page states
plainly.

The browser half cannot sign the Aliyun request itself, so the **Host half**
fetches it and republishes the reading on a same-origin route,
`/alibaba-token-plan/usage.json`, on your local Harness server. That route
carries the percentage, reset time, plan label, credential **path**, and optional
credit totals — never the AccessKey or console token.

## Privacy

- The AccessKey is read from disk on each refresh and used only to sign requests
  to the configured Aliyun hosts. It is never logged, cached to disk, or sent
  anywhere else.
- The console token lives only for the duration of one read; it is not stored.
- The local route exposes the percentage, reset time, source path, and plan
  label — never the credential.
- No telemetry, no analytics, no third-party requests.

## Troubleshooting

**`No Alibaba Cloud AccessKey found`.** Add the two refs to
`~/.dsh/.credentials.yaml`:

```yaml
refs:
  ALIBABA_CLOUD_ACCESS_KEY_ID: LTAI…
  ALIBABA_CLOUD_ACCESS_KEY_SECRET: …
```

or export them in the environment that starts the Host. A `sk-sp-...` Token Plan
model key will not work here.

**`Alibaba rejected the AccessKey` / `NoPermission`.** The AccessKey is valid but
the RAM user lacks the read permission. Grant `AliyunTokenPlanReadOnlyAccess`
and `modelstudio:GenerateCLIAccessToken`. If the response names a
`Team.NotAuthorised` or `Workspace.NotAuthorised` code, add the RAM user to the
Model Studio workspace with Administrator or Subscribe Plan permission.

**`Alibaba did not issue a console token`.** The AccessKey authenticated but is
not allowed to mint the console token. That is the
`modelstudio:GenerateCLIAccessToken` permission above.

**The strip shows `Token Plan: not connected`.** The Host has no reading yet:
open *Settings → Alibaba Token Plan* and read the error under **Last error**. The
settings page always works, even when the selected model is not an Alibaba one.

**The strip does not appear at all.** The selected model's provider must contain
`alibaba`. Alibaba's `deepseek-v4.1-flash-1017` model is still provider
`alibaba`, so it shows this strip, not the DeepSeek balance strip. Check
`providerMatch` if your profile renamed the route.

**The month looks wrong.** Token Plan resets on a subscription cycle, not the
calendar month. The reset time on the page is the API's `per1MonthResetTime`;
the countdown is computed from it.

## Development

The Host half can be exercised against the live endpoints without installing
anything:

```bash
node test-host.mjs
```

It drives `apply()` with a fake Cordis context and prints the tool output, the
HTTP route response, the credit read, the method guard, the prompt notice, and
the provider visibility table for the three usage plugins. It reads the AccessKey
from the same credential store the installed plugin uses; point it elsewhere with
`DSH_ALIBABA_CREDENTIALS_FILE=/path/to/.credentials.yaml node test-host.mjs`.

Checking what would be published:

```bash
npm pack --dry-run
```

## Compatibility

Deliberately conservative so it keeps working across Harness releases:

- **No `@deepseek-ai/*` dependencies or peer dependencies.** Install-time
  compatibility checks and version exemptions therefore never apply to it.
- **No build step and no install scripts**, so installation never needs a
  build-script approval.
- Plain ES modules; the client half imports only `react` from the Harness module
  table and resolves everything else through slots and services, with a lazy
  service lookup so activation order cannot silently disable it.

## License

MIT — see [LICENSE](LICENSE). The plugin is a port of the Paseo
`alibaba-usage` plugin's data path; its console and OpenAPI endpoints were
cross-checked against the official Bailian CLI behaviour.