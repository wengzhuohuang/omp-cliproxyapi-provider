# 移植方案：pi-cliproxyapi-provider → omp 原生 plugin

> **实施状态（2026-10-20）**：P0–P3 已实现并验证（包骨架、CPA 目录抓取与缓存、omp 模型映射、
> `/login` 流程、`/cliproxyapi-refresh`、`/cliproxyapi-pause` `/cliproxyapi-continue`、
> Fast（复用 omp 原生 `/fast` + 目录门控）、Elapsed/TPS 状态行）。42 个 `bun:test` 用例通过，
> `tsc --noEmit` 无错；已用真实 CPA 验证模型列表、推理、工具调用，并用 mock 代理验证
> `service_tier` 注入。P4（自研 codex WS 传输）按决定暂不做。
>
> **按用户要求移除**：models.dev 价格查询（原 `src/pricing.ts` 已删除，模型一律零成本），
> 以及随之失效的 `loadMappedCatalog({ pricingCatalog, fastMode })` 参数。
>
> **实现中发现的两个硬约束（已写入 README）**：
> 1. omp 的扩展事件处理器有 **30 秒硬预算**（`runner.ts: EXTENSION_HANDLER_TIMEOUT_MS`），
>    且 handler 抛错是 fail-open（`handlerFailure` 被吞、payload 不变）。因此“把请求挂起等待”
>    无法在事件层实现 → pause 改为 fail-fast 语义（拒绝新 prompt + 在下一个请求边界 abort 当前轮）。
> 2. omp **已内置** `/fast`（OpenAI `service_tier=priority`）与 `/pause`（冻结全部 agent），
>    自定义同名命令会被跳过 → 插件不再注册 `/fast`，改为复用原生 `/fast` 并只做“目录门控”
>    （仅 `service_tiers` 非空的模型才带 `service_tier`）；pause 命令改名 `/cliproxyapi-pause`。

目标：把 `E:/050-ai/pi-cliproxyapi-provider`（pi 扩展，8 个模块 ≈ 3.5k 行）移植为 omp 原生插件
（`package.json#omp.extensions`），在 omp 18.12.3 上提供同等能力：CLIProxyAPI 动态模型目录、
`/login` 登录、`/fast`、`/pause` `/continue`、`/cliproxyapi-refresh`、Elapsed/TPS 状态行。

## 0. 结论（推荐）

**方案 A（推荐）**：omp 原生插件 + 复用 omp 内置 `openai-responses` 传输。
保留 CPA 目录抓取、模型映射、配置/凭据、命令、TPS；**放弃** pi 私有 Codex WebSocket 传输
（`codex-stream.ts` 1290 行运行时改写 pi-ai 源码的 hack）与已被 omp 原生能力覆盖的功能
（重试、主动压缩、footer patch）。

理由（已实测 CPA）：`http://<host>:8317/v1/responses` 与 `/backend-api/codex/responses`
都接受**普通 API key**并正常返回；omp 内置 `openai-responses` 传输 + `pi.registerProvider`
已能覆盖推理、工具、思考等级、service tier、prompt cache。
方案 B（自研 codex 方言传输）留作 P4 可选项，仅当实测 `/v1/responses` 在 gpt-6 codex 模型上
出现协议差异（freeform apply_patch、previous_response_id、steering）时才做。

## 1. 现状调研（证据）

### 1.1 pi 侧（源）

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `extensions/index.ts` | 1131 | provider 注册、`/login` OAuth 流程、模型刷新协调、命令装配 |
| `extensions/lib.ts` | 1095 | baseUrl 归一化、配置读写、目录抓取、models.dev 价格、模型映射、缓存合并 |
| `extensions/codex-stream.ts` | 1290 | 运行时改写 pi-ai 的 `openai-codex-responses` 源码，产出 patched 模块 |
| `extensions/auto-compact.ts` | 286 | 主动压缩（合成 overflow 错误）+ 压缩后关闭 Codex WS |
| `extensions/fast-footer.ts` | 209 | 改写 pi `FooterComponent.prototype.render` 注入 `fast`/`paused` 标签 |
| `extensions/tps.ts` | 174 | Elapsed 计时 + TPS toast（`ctx.ui.setStatus`） |
| `extensions/fast.ts` / `pause.ts` / `retry.ts` | 28 / 65 / 35 | Fast 状态、暂停闸门、瞬时网络错误归一化 |

pi 侧特殊依赖：`@earendil-works/pi-ai`（含 `isRetryableAssistantError`、`@earendil-works/pi-ai/compat`
的 `registerApiProvider`）、`@earendil-works/pi-coding-agent`（`FooterComponent`、`SettingsManager`、
`readStoredCredential`）、`agent_settled` 事件、`message_end` 可返回 `{ message }`。

### 1.2 omp 侧（目标，已核对 v18.12.3 源码）

- npm 上有 `@oh-my-pi/pi-ai|pi-coding-agent|pi-catalog@18.12.3` 且**随包发布 TS 源码**
  （`packages/ai/src/...`），已本地安装用于比对（`E:/050-ai/.ref-omp`，仅参考，不进产物）。
- 扩展 API 高度同源：`ExtensionAPI`（`src/extensibility/extensions/types.ts:1624`）含
  `registerProvider/unregisterProvider/registerCommand/on/sendMessage/setServiceTier/setModel/...`。
- `ProviderConfig`（同文件 `:1972`）字段：`baseUrl/api/apiKey/models/oauth/fetchDynamicModels/
  streamSimple/usage/headers/authHeader/compat` —— 与 pi 基本一致。
- 事件表（同文件 `:1648+`）**没有** `agent_settled`；`message_end` 处理器返回 `void`
  → pi 的 `retry.ts` 无法平移。
- `pi-ai` 导出 `AssistantMessageEventStream` / `createAssistantMessageEventStream`
  （`src/utils/event-stream.ts:218/271`）—— 与 pi 同名，可直接复用。
- omp **没有** `isRetryableAssistantError`（仅 legacy shim 里有），也没有 `FooterComponent`
  （用 StatusLine / `ctx.ui.setStatus`）。
- 模型思考模型不是 pi 的 `thinkingLevelMap`，而是 `ThinkingConfig`
  （`pi-catalog/src/types.ts:135`）：`{ mode, efforts, defaultLevel, effortMap, ... }`；
  `Effort` 枚举仅 `minimal|low|medium|high|xhigh|max`（`pi-catalog/src/effort.ts`），**无 ultra**。
- 扩展 provider 模型字段（`ProviderModelConfig`）没有 `serviceTiers`，只有 `compat` 稀疏覆盖。
- `fetchDynamicModels` 原生支持（15s 超时 + 24h SQLite 模型缓存，`model-provider-discovery.ts`）。
- service tier：自定义 OpenAI 兼容中转也会被判为 openai 家族
  （`pi-ai/src/types.ts:180-215`：`isOpenAIServiceTierModel` + `serviceTierFamily`），
  故 `pi.setServiceTier("openai","priority")` 可直接落地 Fast。
- 导入解析：扩展里的 `@oh-my-pi/*`、`@earendil-works/*`、`@mariozechner/*` 全部重写到
  **宿主二进制内置副本**（`legacy-pi-compat.ts:800-830`）→ 插件不需要自带 host 依赖副本，
  拿到的就是宿主同一个 `AssistantMessageEventStream` 类（避免 `instanceof` 断裂）。
- 能力覆盖：omp 原生有重试分类（含 “closed network connection”、WebSocket 提前关闭，
  见 `omp://non-compaction-retry-policy.md`）、原生阈值/中轮主动压缩
  （`omp://compaction.md`，`compaction.reserveTokens/midTurnEnabled`）、
  原生 `configuration_update`（cache-preserving 思考等级切换，`supportsConfigurationUpdate`，
  见 `omp://provider-compat-reference.md`）→ pi 插件里三块自研逻辑可以整体删除。

### 1.3 CPA 实测（`http://192.168.30.21:8317`，key 来自 `~/.omp/.env` 的 `CPA_API_KEY`）

- `GET /v1/models` → OpenAI 精简目录（仅 id/owned_by），**没有**上下文/思考/tier 元数据。
- `GET /v1/models?client_version=pi` → 完整 codex 目录，22 个模型，字段含
  `slug/display_name/context_window(872000)/max_tokens/input_modalities/supported_reasoning_levels/
  service_tiers[{id:"priority"}]/default_reasoning_level/prefer_websockets/visibility`。
  - `supported_reasoning_levels` 含 `low|medium|high|xhigh|max|ultra` → omp 无 `ultra`，
    需映射策略（建议 `ultra→max`，并在 README 说明）。
  - `service_tiers` 非空 = Fast 可用（与 pi 插件判据一致）。
- `POST /v1/responses`（普通 API key，stream/non-stream）→ 200 正常。
- `POST /backend-api/codex/responses`（普通 API key，SSE）→ 200 正常（可选 codex 方言）。
- `POST /v1/responses` 带 `service_tier:"priority"` → 200（回显 `default`，由 CPA 侧决定计费）。

### 1.4 用户当前 omp 配置

- `~/.omp/agent/models.yml`：`cpa` provider，`baseUrl http://192.168.30.21:8317/v1`，
  `api: openai-completions`，`discovery.type: proxy` + 一个手写模型覆盖。
- `~/.omp/agent/config.yml`：`modelRoles` 里混用 `cpa/...` 与 `cliproxyapi/gpt-6-luna`
  （后者在 omp 中**不存在**该 provider id，移植后需统一为插件注册的 provider id）。
- 插件落地后，`models.yml` 的 `cpa` 可保留作兜底，或直接改用插件 provider（建议后者，避免双份目录）。

## 2. pi → omp API 差异与处置

| 能力 | pi 实现 | omp 现状 | 移植处置 |
| --- | --- | --- | --- |
| provider 注册 | `pi.registerProvider` + 全局 `pi-ai/compat` `registerApiProvider` | `pi.registerProvider({api, streamSimple, models, oauth, fetchDynamicModels})` | **只保留** `registerProvider`；删掉 compat 全局注册与协调器栈 |
| 思考等级映射 | `thinkingLevelMap` + `compat.supportsMidConvoEffort` | `thinking.efforts/effortMap` + `compat.supportsConfigurationUpdate` | 重写映射：`effort→canonical Effort`，`ultra→max`；mid-convo 交给 omp 原生 |
| 传输 | 运行时改写 pi-ai 源码的 codex 传输 | omp 内置 `openai-responses` | **删除** `codex-stream.ts`（P4 可选自研） |
| Fast | 往 payload 注入 `service_tier:"priority"` | `pi.setServiceTier("openai","priority")` | 改用原生 service tier；保留“仅当模型 `service_tiers` 非空才生效”的门控 |
| 瞬时网络错误重试 | `message_end` 返回 `{message}` 加前缀 | omp 原生重试分类覆盖 | **删除** `retry.ts` |
| 主动压缩 | 合成 overflow 错误 + 压缩后关 WS | omp 原生阈值/中轮压缩 | **删除** 合成错误逻辑；仅保留“压缩后重置 CPA 侧上下文”（若走 codex WS） |
| 状态行 | 改 `FooterComponent.prototype.render` | 无 FooterComponent | 改为 `ctx.ui.setStatus`（Elapsed/fast/paused 三个 key） |
| 事件 | `agent_settled` | 无 | 用 `agent_end` + `turn_end` 组合判定 settle |
| 登录 | OAuth `login(callbacks)` 多字段 prompt | 同样支持 `callbacks.onPrompt({message, secret})` | 平移，`/login CLIProxyAPI` 路径保留 |
| 凭据读取 | `readStoredCredential`（auth.json） | omp 凭据在 `agent.db`；legacy shim 才有 `readStoredCredential` | 不读宿主凭据：登录回调里自行落盘 `cliproxyapi.json`（含 baseUrl+apiKey） |
| 配置 | `~/.pi/agent/cliproxyapi.json` + `settings.json` | `~/.omp/agent/` | 同一目录换成 omp agent dir（`getAgentDir()`） |
| 价格 | models.dev 抓取 + 24h 缓存 | 同（可复用 `lib.ts` 逻辑） | **直接复用** |
| 缓存合并/陈旧模型保留 | `mergeModelsWithExistingCache` | 可保留，但优先用 omp 原生 `fetchDynamicModels` 缓存 | 复用逻辑，降级为兜底 |
| 测试 | vitest | omp 用 `bun:test` | 迁移断言，重写 6 个文件 |

## 3. 方案选型

| 方案 | 描述 | 工作量 | 风险 | 结论 |
| --- | --- | --- | --- | --- |
| **A** | 原生插件 + omp 内置 `openai-responses` | ~5–6 个模块，1.5k 行 | codex 模型在 `/v1/responses` 上的方言差异（apply_patch freeform、previous_response_id、steering） | **推荐**，P0 先落地并实测差异 |
| **B** | 自研 codex 方言传输（WS + previous_response_id） | +600–900 行 | WS 生命周期、stale chain 恢复、心跳 | 仅当 A 实测出差异时做（P4） |
| **C** | 直接以 legacy 方式挂载 pi 扩展（靠 `@earendil-works` 重写） | 0 行 | 非“原生”、pi 私有 hack 依赖 pi-ai 源码文件在盘 | 仅作对照/应急 |

## 4. 目标架构

```
E:/050-ai/omp-cliproxyapi-provider/
  package.json                 # name/version/license + omp.extensions + scripts(bun)
  README.md                    # 安装、登录、命令、配置、FAQ
  src/
    cliproxyapi.ts             # 扩展入口：注册 provider / 命令 / 事件（对应 pi index.ts）
    config.ts                  # 配置与凭据解析（lib.ts 的 I/O + identity 部分）
    catalog.ts                 # CPA 目录抓取 + 缓存 + 合并（lib.ts 抓取/缓存部分）
    mapping.ts                 # CPA→omp 模型映射（lib.ts toPiModel 改造）
    pricing.ts                 # models.dev 价格匹配（lib.ts 成本部分原样搬）
    commands/fast.ts           # /fast
    commands/pause.ts          # /pause /continue
    commands/refresh.ts        # /cliproxyapi-refresh
    ui/status.ts               # Elapsed / TPS 状态行（tps.ts 改造）
  test/                        # bun:test
```

manifest（omp 原生）：

```json
{
  "name": "omp-cliproxyapi-provider",
  "type": "module",
  "omp": { "extensions": ["./src/cliproxyapi.ts"] },
  "scripts": { "test": "bun test", "typecheck": "tsc --noEmit" }
}
```

- 导入一律用 `@oh-my-pi/pi-ai` / `@oh-my-pi/pi-coding-agent`（宿主重写到二进制内置副本，
  不需 peer 依赖、不产生第二份模块实例）。
- 配置落 `getAgentDir()/cliproxyapi.json`（`baseUrl/apiKey/providerId/providerName/fast/pause`），
  环境变量前缀保持 `CLIPROXYAPI_*`。
- provider id 默认 `cliproxyapi`（与 `config.yml` 里已有的角色 id 对齐），可用
  `CLIPROXYAPI_PROVIDER_ID` 覆盖。

## 5. 代码复用映射（尽量复用）

| pi 文件/函数 | 处置 | 说明 |
| --- | --- | --- |
| `lib.ts: resolveEndpoints/firstNonEmpty/parseBooleanSetting` | **原样搬** | 与宿主无关的纯函数 |
| `lib.ts: loadConfigFile/saveConfigFile/loadAuthConnection/resolveIdentity/resolveConnection/resolveFastDefault/resolvePauseDefault` | **搬 + 改路径** | `~/.pi/agent` → `getAgentDir()`；`loadAuthConnection` 改为读自有 json |
| `lib.ts: fetchCodexModels/ModelsHttpError/isUnauthorizedModelsError` | **原样搬** | 目录抓取协议不变（实测 `?client_version=pi`） |
| `lib.ts: toPiModel/buildThinkingLevelMap/buildInputModalities/extractReasoningEfforts/codexModelId/supportsFastServiceTier/supportsReasoningEffortUpdates` | **改造** | 产出 omp `thinking.efforts/effortMap`；`ultra→max`；Fast 判据保留 |
| `lib.ts: models.dev 价格族（fetchModelsDevCostMap/matchModelCost/selectModelsDevEntry/别名表）` | **原样搬** | 纯逻辑 + 24h 缓存 |
| `lib.ts: 缓存族（loadModelsCache/saveModelsCache/mergeModelsWithExistingCache/resolveMappedModels）` | **搬 + 让位** | 优先用 omp `fetchDynamicModels` 原生缓存；本缓存保留为兜底/陈旧模型保留 |
| `index.ts: ModelRefreshCoordinator/RecoverySnapshot` | **改造保留** | 退避重试 + stale 恢复；改用 `ctx.setTimeout`（避免裸定时器崩溃会话） |
| `index.ts: registerProvider/configureAndRegister/promptConnection/createOAuthHandlers/buildOAuthCredentials` | **改造保留** | 登录多字段 prompt 在 omp 同样可用；凭据自己落盘 |
| `index.ts: hasLoginCredential` | **删除** | 不读宿主凭据库 |
| `index.ts: compat 全局 API 注册（`pi-ai/compat`）+ 协调器栈` | **删除** | `registerProvider` 已能挂自定义 api/stream |
| `index.ts: registerFastCommand/registerPauseCommands/registerRefreshCommand` | **改造保留** | 命令名保持；fast 改为 `setServiceTier` |
| `codex-stream.ts`（1290 行） | **删除**（P4 备选） | 运行时改写 pi-ai 源码的 hack 在 omp 不可行（宿主是编译后二进制，无源码可改） |
| `codex-stream.ts: reshapeConfigurationUpdates`（~200 行语义） | **删除** | omp 原生 `supportsConfigurationUpdate` 已实现同语义 |
| `auto-compact.ts` | **大部分删除** | omp 原生阈值/中轮压缩覆盖；仅保留“压缩后重置 CPA 侧会话状态”（仅 codex WS 场景需要） |
| `fast-footer.ts` | **重写** | `FooterComponent` 在 omp 不存在 → `ctx.ui.setStatus` 三段式状态行 |
| `tps.ts` | **改造保留** | 事件 `agent_settled` → `agent_end`/`turn_end`；计时器改 `ctx.setInterval` |
| `retry.ts` | **删除** | omp 原生重试分类已覆盖 |
| `pause.ts` | **原样搬 + 改等待点** | 闸门从自定义 stream 钩子改到 `before_provider_request` |
| `test/*.test.ts`（vitest） | **迁移** | 改 `bun:test`；删掉针对 pi 内部行为的用例，保留纯函数与端到端注册用例 |

预计净减 ~1.6k 行（codex-stream 1290 + auto-compact 286 + retry 35 + fast-footer 209 中的一半），
净增 ~400 行（omp 模型映射、状态行、命令、bun 测试）。

## 6. 关键实现要点

1. **模型映射**
   - `id = slug`，`name = display_name`，`contextWindow = context_window`，
     `maxTokens = max_tokens`，`input = input_modalities`。
   - `thinking = { mode: "effort", efforts: [...], defaultLevel }`；
     CPA 的 effort 值过滤到 omp 规范集 `{minimal,low,medium,high,xhigh,max}`，`ultra→max`；
     非标准 wire 值经 `effortMap` 透传。
   - `compat` 建议：`supportsStore:false`（CPA 非官方端点）、`supportsDeveloperRole:false`、
     `supportsReasoningEffort:true`、`supportsStrictMode:false`（CPA 对 strict 工具 schema 宽容度未知，
     先关）、`statefulResponses:false`（避免 previous_response_id 语义差异），
     `supportsConfigurationUpdate` 交由 omp class 规则（gpt-6-* 默认 true）。
   - `service_tiers` 非空 → 该模型可 Fast（`FastModeController` 保留判据）。
2. **Fast**：`pi.setServiceTier("openai","priority")` 开、`setServiceTier("openai", undefined)` 关；
   仅当当前模型 `service_tiers` 非空时生效，否则提示“当前模型不支持 Fast”。
   兜底：若 omp 的 openai 家族判定未命中（`identity.class` 非 openai），改为
   `before_provider_request` 里给 payload 注入 `service_tier:"priority"`（同 pi 做法，实测 CPA 接受）。
3. **Pause**：`before_provider_request` 处理器里轮询 `cliproxyapi.json` 的 `pause` 字段，
   每 200ms 复查直到解除；用 `ctx.setTimeout` 链而非裸 `setTimeout`。
4. **TPS / Elapsed**：`before_agent_start` 起点、`agent_end` 累计 usage、`turn_end`/session idle 收尾；
   `ctx.ui.setStatus("elapsed"|"tps"|"fast", ...)`，`ctx.setInterval` 1s 刷新。
5. **登录**：`registerProvider({ oauth: { name, login } })`，`login` 里 `callbacks.onPrompt`
   依次收集 baseUrl、apiKey（`secret:true`），随后用 `{root}/v1/models?client_version=pi` 校验
   （200 即成功，目录为空也算成功），成功后把 baseUrl+apiKey 写入 `cliproxyapi.json`。
6. **凭据优先级**：环境变量 > `cliproxyapi.json` > 宿主 `/login` 保存的凭据（我们自己在登录时落盘）> 默认
   `http://127.0.0.1:8317`。
7. **模型目录刷新**：`fetchDynamicModels` 为主（原生 24h 缓存 + 15s 超时），
   `/cliproxyapi-refresh` 触发强制刷新；保留 `mergeModelsWithExistingCache` 以免上游 503/429 抖动清空目录。
8. **价格**：沿用 models.dev 匹配（`inputTokensAbove` 阈值 → omp `cost.longContext.inputThreshold`，
   需按 omp 的 `TokenCost/LongContextTokenCost` 结构改写）。
9. **打包**：`bun` 打包/发布为 npm 包；本地用 `omp plugin link E:/050-ai/omp-cliproxyapi-provider` 验证。

## 7. 实施阶段与验收

| 阶段 | 内容 | 验收（可执行） |
| --- | --- | --- |
| P0 | 包骨架 + 目录抓取 + 模型映射 + `registerProvider` | `omp plugin link` 后 `omp models cliproxyapi` 列出 22 个模型，`omp models --json` 中 context/thinking 与 CPA 目录一致 |
| P1 | 登录流程 + 配置/凭据 + `/cliproxyapi-refresh` | `omp login cliproxyapi` 走通 baseUrl+apiKey 提示并落盘；`~/.omp/agent/cliproxyapi.json` 正确；`omp models cliproxyapi` 刷新 |
| P2 | `/fast`、`/pause`、`/continue` | `/fast` 后请求体带 `service_tier:"priority"`（用 `omp` 调试日志或代理抓包核对）；`/pause` 时请求挂起、`/continue` 后恢复 |
| P3 | Elapsed/TPS 状态行 | TUI 底部出现 `Elapsed …`；settle 后 toast 显示 TPS 与 token 用量 |
| P4（可选） | 若 A 实测有 codex 方言差异：自研 codex 传输（WS/previous_response_id） | gpt-6 codex 模型工具调用 + 多轮思考等级切换后 prompt cache 命中 |
| P5 | 测试迁移 + README + npm 发布 | `bun test` 全绿；README 与实际行为一致 |

冒烟命令（每阶段都要跑）：

```bash
omp plugin link E:/050-ai/omp-cliproxyapi-provider
omp models cliproxyapi
omp -p "reply with OK" --model cliproxyapi/gpt-6.1-sol
```

## 8. 风险与未决点

1. **codex 模型在 `/v1/responses` 上的方言**（最高风险）：`apply_patch_tool_type:"freeform"`、
   `previous_response_id` 续链、steering、加密 reasoning 回放。P0 必须实测 gpt-6.1-sol +
   工具调用 + 多轮；不通过则升级到 P4。
2. **omp 是否给扩展模型算 `identity.class`**：影响 Fast 的 service tier 家族判定；
   兜底方案是 payload 注入（已实测 CPA 接受 `service_tier:"priority"`）。
3. **`ultra` 思考等级**：omp 无此档；映射到 `max` 并在 README 说明（pi 侧是独立档位）。
4. **CPA 目录字段漂移**：`?client_version=pi` 的返回是 CPA 私有契约，需保留字段缺失的容错
   （缺 `context_window` → 回退 128k；缺 `supported_reasoning_levels` → 关闭思考）。
5. **用户现有 `models.yml` 的 `cpa` provider 与插件 provider 双份目录**：迁移期建议保留
   `models.yml` 不动，验证插件后再切 `modelRoles`（`config.yml` 里 `cliproxyapi/gpt-6-luna`
   现在是无效 id，需要一并修正）。
6. **`/login` 菜单可见性**：omp 的 `/login` 列表由 auth registry 驱动，扩展 provider 需确认
   是否出现在账号登录路径（pi 侧用 OAuth-only 注册强制走多字段 prompt；omp 行为需实测）。
7. **价格 long-context 阈值**：pi 的 `cost.tiers[].tier.size` → omp `cost.longContext.inputThreshold`，
   字段形状不同，需重写而非直拷。
