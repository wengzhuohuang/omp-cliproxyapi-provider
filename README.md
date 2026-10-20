# omp-cliproxyapi-provider

omp plugin that discovers models from a [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
instance and registers them for use in omp.

The plugin reads the proxy's Codex-style catalog, maps it onto omp models
(context window, reasoning levels, modalities), and serves inference over
the OpenAI Responses API the proxy exposes at `{root}/v1`.

## Install

```bash
# from GitHub
omp plugin install github:wengzhuohuang/omp-cliproxyapi-provider

# or from a local checkout
omp plugin link /absolute/path/to/omp-cliproxyapi-provider
```

The npm name `omp-cliproxyapi-provider` belongs to an unrelated package, so install
from GitHub. `omp plugin install` accepts a git spec (`github:`/`gitlab:`/`codeberg:`/…,
or any `https://…git` URL) and installs the package into `~/.omp/plugins/node_modules/`.

The plugin needs no runtime dependencies: it imports the host packages
(`@oh-my-pi/pi-ai`, `@oh-my-pi/pi-coding-agent`), which omp resolves to the copies
bundled inside the running binary.

## Configuration

Two setup paths are supported.

### 1. `/login`

```text
/login
```

Pick **Sign in with an account** → **CLIProxyAPI**. The plugin then asks for:

1. the proxy base URL (for example `http://127.0.0.1:8317`)
2. the API key (masked input)

The credentials are validated against `{root}/v1/models?client_version=omp`; HTTP 200
succeeds even when the catalog is empty. On success the base URL and key are written to
`cliproxyapi.json` in the agent directory and the models are registered right away.

### 2. Configuration file or environment

`~/.omp/agent/cliproxyapi.json` (named profiles use `~/.omp/profiles/<name>/agent/`):

```json
{
  "baseUrl": "http://127.0.0.1:8317",
  "apiKey": "12345",
  "providerId": "cliproxyapi",
  "providerName": "CLIProxyAPI",
  "fast": false,
  "pause": false
}
```

| Field | Default | Description |
| ----- | ------- | ----------- |
| `baseUrl` | `http://127.0.0.1:8317` | CLIProxyAPI address |
| `apiKey` | _(required unless set through `/login`)_ | Bearer token / CPA API key |
| `providerId` | `cliproxyapi` | Provider id shown in `/model` |
| `providerName` | `CLIProxyAPI` | Display name in `/login` |
| `fast` | `false` | Startup default for omp's fast mode (priority service tier) |
| `pause` | `false` | Hold provider requests back |

Environment variables override the file:

| Variable | Overrides |
| -------- | --------- |
| `CLIPROXYAPI_BASE_URL` | `baseUrl` |
| `CLIPROXYAPI_API_KEY` | `apiKey` |
| `CLIPROXYAPI_PROVIDER_ID` | `providerId` |
| `CLIPROXYAPI_PROVIDER_NAME` | `providerName` |
| `CLIPROXYAPI_FAST` | `fast` (`true`/`false`, also `1`, `0`, `yes`, `no`, `on`, `off`) |

Resolution order: environment → `cliproxyapi.json` → default base URL.

### baseUrl normalization

| Input | Inference base URL | Models URL |
| ----- | ------------------ | ---------- |
| `127.0.0.1:8317` | `http://127.0.0.1:8317/v1` | `http://127.0.0.1:8317/v1/models?client_version=omp` |
| `http://127.0.0.1:8317` | `http://127.0.0.1:8317/v1` | same |
| `http://127.0.0.1:8317/v1` | `http://127.0.0.1:8317/v1` | same |
| `http://127.0.0.1:8317/backend-api` | `http://127.0.0.1:8317/v1` | same |

## Model catalog

The plugin lists the proxy's catalog from `{root}/v1/models?client_version=omp` and maps
each entry onto an omp model:

| CLIProxyAPI field | omp model |
| ----------------- | --------- |
| `slug` | `id` |
| `display_name` | `name` |
| `context_window` | `contextWindow` |
| `max_tokens` | `maxTokens` |
| `input_modalities` | `input` (`text` / `image`) |
| `supported_reasoning_levels[].effort` | `thinking.efforts` (+ `thinking.effortMap`) |
| `default_reasoning_level` | `thinking.defaultLevel` |
| `service_tiers` | Fast capability (non-empty list ⇒ the model supports the priority tier) |
| `visibility: "hide"` | entry skipped |

Reasoning levels use omp's canonical ladder (`minimal`, `low`, `medium`, `high`, `xhigh`,
`max`). CLIProxyAPI's extra `ultra` level is folded onto `max` and stays reachable through
`thinking.effortMap`; a natively supported level always wins over the alias.

The proxy does not publish prices, so every model is registered with zero cost.

The catalog is cached in `<agent dir>/cliproxyapi-models.json` (never the API key). A
model that disappears from one listing is retained for up to seven days, so a transient
proxy hiccup does not empty `/model`.

## Commands

| Command | Effect |
| ------- | ------ |
| `/cliproxyapi-refresh` | Force an immediate catalog refresh and re-register the models |
| `/cliproxyapi-pause` | Stop provider requests: new prompts are refused and a running turn is aborted at its next request boundary |
| `/cliproxyapi-continue` | Resume provider requests |

omp already ships `/pause` (freeze every agent) and `/fast` (service tier), so the
plugin uses distinct names.

## Fast mode

Fast mode uses omp's own `/fast` command, which asks for OpenAI's `service_tier: priority`.
The plugin keeps that tier catalog-driven: only models whose CLIProxyAPI entry advertises
a non-empty `service_tiers` list receive it, every other model keeps its normal request
shape. Set `fast: true` (or `CLIPROXYAPI_FAST=1`) to enable the priority tier at startup.

## Elapsed time and throughput

While the agent runs, the status line shows `Elapsed …`. When the run settles, a
notification reports the approximate tokens per second plus the token usage
(`out` / `in` / cache r/w / total). Only the interactive parent session owns the timer;
subagents and print mode do not.

## Notes and limits

- omp caps extension event handlers at 30 seconds, so a paused request cannot be parked
  open. The pause therefore stops the work instead of holding it: no further tokens are
  spent until the pause is lifted.
- The proxy is not an official OpenAI endpoint, so the plugin disables stateful
  `previous_response_id` chaining, the developer role, strict tool schemas, and encrypted
  reasoning replay for its models.
- Image-generation models are not registered: the plugin only exposes chat models.

## Development

```bash
bun install --omit optional   # skips the host's optional native/onnxruntime deps (~300 MB)
bun test        # unit tests
bun run typecheck
```
