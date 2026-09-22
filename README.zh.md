# dsh-subscription-hub

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的统一订阅插件。

[English](README.md) | 中文

一个 **设置 → 订阅** 页面覆盖十个订阅路由：

| 路由 | 订阅 | 说明 |
| --- | --- | --- |
| `codex` | ChatGPT Plus/Pro | 实时目录、用量、Fast 通道 |
| `claude` | Claude Pro/Max | OAuth，或从 Claude Code 导入 |
| `grok` | SuperGrok / X Premium | 实时目录、用量、Imagine 生图生视频 |
| `agy` | Google Antigravity | **纯 HTTP OAuth**，不调用 `agy` CLI，不闪 `cmd.exe` |
| `commandcode` | Command Code Go | 导入 `~/.commandcode/auth.json` 或粘贴 key（Studio 可选） |
| `cline` | Cline（ClinePass） | 粘贴 `sk_…` Key；实时额度窗口，**分模型钉住上游渠道** |
| `codebuddy` | 腾讯 CodeBuddy | 浏览器 OAuth，每日自动签到 |
| `trae` | Trae（国内版） | 导入本机已登录的 **TRAE SOLO CN** 与 **Trae CN IDE**；实时目录、积分、每日自动签到 |
| `copilot` | GitHub Copilot | 设备码登录 |
| `zed` | Zed Pro | Windows 从凭据管理器导入，或粘贴 userId + token |

此外还包含：

- **累计 Token 统计与省钱看板** —— 汇总你在订阅渠道消耗的全部 Token，按
  按量付费 API 价格折算成人民币，展示你因此省下的钱（含各订阅明细条形图）。
- **多账号池** —— 按额度感知轮换、逐账号用量条、生图请求账号级故障转移。
- **模型显示勾选**（只影响对话选择器）+ **手动刷新模型列表** 按钮（清掉服务端
  目录缓存并重新拉取实时列表）。
- **输入框用量胶囊** —— 只显示**当前模型**所用订阅的余量：CodeBuddy 显示剩余
  积分，其余订阅显示剩余百分比与重置倒计时。
- **工具**：`image_generate`（文生图 **与** 通过 `referenceImages` 图生图/改图）、
  `video_generate`、`x_search`。

## 设置页排版

1. **省钱看板**（最上方）—— 累计 Token、节省金额（¥）、对话轮次，以及各订阅
   占比条，并带 **重新统计** 按钮（真的会重扫全部会话历史）。数值按每种模型
   自己那行**已公布**的按量单价计算，含波峰/波谷时段、上下文长度分档与缓存写入
   价；两种会话转录格式都会读（用量有的记在流式 usage chunk 上，有的记在落定的
   assistant 消息上，一个会话只用其中一种）；价表查不到的模型会标为「近似」而不是
   拿一个像的名字顶替。
2. **全局卡片** —— 多账号调用模式与代理配置。
3. **已添加的订阅** —— 所有已登录的服务商，含账号、用量窗口、默认思考档位与
   模型显示列表。
4. **添加订阅** —— 所有尚未登录的服务商，展示相同的登录按钮。给已登录的服务商
   增加第二个账号，直接用它卡片里的登录按钮即可，不存在另一套样式不同的
   「新增账号」流程。

## 图生图 / 图片编辑

`image_generate` 支持可选的 `referenceImages` 数组（1–5 个完整的 DSH 附件引用），
用于在已有图片上编辑或继续创作：

- 引用可直接复制图片旁的引用文本，或结构化工具结果
  （`read_image.image` / `image_generate.images`）；
- 来源可以是上传的图片、`read_image` 的结果，或之前生成的图片；本地文件需先调用
  `read_image`，文件路径不算引用；
- 不传 `referenceImages` 时保持原有文生图行为。

编辑请求会走服务商自己的 edits 端点（ChatGPT 走
`/backend-api/codex/images/edits`，Grok 走 `/v1/images/edits`）。WebP 与 GIF
引用会在发送前转码（带透明通道转 PNG，不透明转 JPEG），避免上游拒收。空数组、
重复引用、超附件限制都会明确报错，而不会静默降级为文生图。

## 工具

- **`image_generate`** —— 经 Codex 订阅调用 `gpt-image-2`，或经
  `api.x.ai/v1/images/generations` 调用 `grok-imagine-image-2.0`。`provider`
  参数指定首选方（默认 `gpt`，可选 `grok`）；首选方未登录时自动回退另一方。
  图片保存到 `~/.dsh/plugins/subscriptions/images/`。
- **`video_generate`** —— 经 `api.x.ai/v1/videos` 调用
  `grok-imagine-video-1.5`（异步提交 + 轮询）。MP4 保存到
  `~/.dsh/plugins/subscriptions/videos/` 并在对话内联播放。支持时长（1–15 秒）、
  宽高比、分辨率，以及通过 `image_url` 做图生视频。
- **`x_search`** —— xAI 托管的 X 搜索，返回 `{ answer, citations }`。

## Cline 上游渠道

Cline 的网关在同一个地址后面藏着两套不同的后端 —— 一套 OpenRouter 风格的路由器，
一套 Vercel AI Gateway 风格的规划器。是哪一套在服务某个模型，同时决定了「谁能服务它」
和「钉住该如何拼写」，因此本插件在运行时探测流水线，并写入对应的字段：

| 流水线 | 判定依据 | 钉住字段 |
| --- | --- | --- |
| `direct`（OpenRouter） | 顶层 `provider` 字符串 | `provider.only` / `.order` / `.sort` |
| `planner`（Vercel AI Gateway） | `provider_metadata.gateway.routing` | `providerOptions.gateway.only` / `.order` / `.sort` |

在探测出流水线之前，请求会**同时带上两套拼写** —— 两套流水线都会忽略对方的字段，因此仍然正确路由。

在 **设置 → 订阅 → Cline → 上游渠道** 中：

- **探测渠道**：分两步探测该模型可用的渠道列表。先发一次真实 ping，读取返回里的
  `provider_metadata.gateway.routing`，它同时给出流水线、**实际服务本次请求的渠道**，以及完整的
  `fallbacksAvailable` 候选顺序；再按已确定的流水线拼写下发不可能的渠道（`only: ['__probe__']`），
  让路由在**消耗任何 Token 之前**失败并报出自己的渠道清单。最后取两者的并集。
  第一阶段的真实 ping 很关键：有些模型只由单一上游服务，而网关对它们根本没有 `only` 过滤清单
  （Vercel 的 `openai-compatible-private`，以及直连管道下的 `InferenceNet` / `Xiaomi`），
  真实响应是唯一能拿到这些渠道名的地方。
- **点击渠道**即可钉住；点击顺序就是尝试顺序（渠道上的数字即序号）。再点一次取消钉住。
- **⊘** 排除渠道。排除项会被编译成 `only` 白名单，因为网关会静默忽略 exclude/ignore 字段。
- **严格**只发钉住的渠道；**优先**按顺序尝试，并在**首个 token 之前**失败时自动切换。
  一旦内容已经返回给调用方，那一次流就是最终答案 —— 中途失败绝不会静默换渠道重试。
- **排序指标**会按各流水线自己的词汇翻译（`cost`/`ttft`/`tps` → `price`/`latency`/`throughput`）。
  空值会被丢弃而不是发送，因为 `sort: ""` 会直接被网关以 HTTP 400 拒绝。

`AUTH` 或额度失败会立即终止整条候选链：所有候选都会以同样方式失败，继续轮换渠道只会掩盖真正的问题。

渠道发现是**内存态**（属于任何一次探测都能重建的派生数据），而钉住配置会**持久化**到
`~/.dsh/plugins/subscriptions/cline-pins.json`。

## Trae 模型清单

CN 目录读取自官方 remote 目录（`solo.trae.cn/api/remote/v1/models`），并对**所有**目录 function
取并集 —— `solo_agent_remote`、`solo_work_remote`、`solo_work_lite`、`solo_agent`、`solo_coder`。
原因是每个 function 只列自己的那份清单：agent 目录才带 `Doubao-Seed-Code`、`glm-5.1`、
`glm-5v-turbo`、`qwen-3.5`、`qwen-3.6-plus`；coder 目录才带遗留的 `glm-5`、`kimi-k2.5`、
`minimax-m2.7`、`DeepSeek-V4-Flash/Pro`、`Doubao-Seed-2.0-Code`。只读单个目录会把这些全部静默隐藏。

另外两条规则保证清单诚实：

- **只列可调用的 config。** 目录还会广告 `deepseek-v4.1-flash`、`glm-5.3-flash`、`glm-5.3-flashx`、
  `qwen3.8-flash`、`kimi-k2.8-preview`，但它们经**任何** SOLO function 调用都返回
  `4001 param is invalid`（它们属于 IDE 的 agent task 通道）。列出来只会给选择器一个必然失败的模型，
  因此一律丢弃。而用户熟悉的 `deepseek-v4.1-flash` 仍然保留，映射到已验证可用的
  `DeepSeek-V4-Flash-Official` 线名。
- **元数据取最丰富的那一行。** 只有 agent 目录带 `reasoning_effort_config`（思考等级选择器）和更大的
  Max 上下文窗口，所以先在 work 清单出现的模型保留其归属 function，同时把思考等级与 Max 窗口折进来。
  `max` 只是重复 `dev` 的行不会暴露额外的预算开关。

### 签到

每日签到兼容网页客户端本身就要面对的两类上游行为：

- **今日已签到**算成功，而不是错误；
- 瞬时的 `当前签到人数过多`（签到队列打满）会**带退避重试**（2s → 5s → 10s），并在两次尝试之间
  重新读取今日状态 —— 因此「响应说打满、实际已经签到成功」的情况仍会如实报成功。只有重试预算用尽后
  卡片才显示该消息，并附带「签到是幂等的」提示：稍后再试、或直接在 Trae 客户端签到都安全。

### Cline 模型元数据取自官方目录

Cline 模型的上下文窗口、输出上限、模态与思考等级**不再写死**，一次发现读取会合并两个官方来源：

- **Cline 自家目录** —— `GET {base}/ai/cline/models`（公开、免鉴权），带 `context_length`、
  各家 provider 的 `max_completion_tokens` 上限与 `architecture.input_modalities`，共 443 个模型。
  它的 id 是底层 slug（`z-ai/glm-5.3`），所以 `cline-pass/*` 会按 provider 命名空间映射到它
  （`z-ai`/`zai`、`deepseek`、`moonshotai`、`minimax`、`qwen`、`alibaba`、`xiaomi`、`meta`…），
  对唯一需要特殊处理的 `muse-spark-1.3-contributor` → `meta/…` 用显式覆写。
- **models.dev** —— 参考实现同样读取的社区注册表，也是**唯一**公布逐模型思考等级
  （`reasoning_options[].values`）的来源；两者都有时以它为准。

静态表退化为纯离线兜底：读取失败时仍提供 id 集合，但只要读到线上数据就一律以线上为准。
对于没有任何来源公布等级的三个最新模型，适配器回退到网关全量列表，而不是臆造限制。

### 元数据审计

`scripts/manual/audit-model-metadata.mjs` 会用本插件已存的凭据，把每个 provider 的上下文窗口与
思考等级重新和它自己的端点对一遍。任何时候怀疑清单或窗口有问题就跑它：

```sh
node scripts/manual/audit-model-metadata.mjs
```

它会并排打印 `LIVE`（服务商自己的回答）与 `HUB`（本插件解析出的值），把所有不一致列在
`PROBLEMS` 下，并在发现不一致时以非零码退出。查不了的 provider —— Codex CLI token 过期、
本机没有 Copilot 凭据 —— 会明确报 `SKIPPED`，而不是静默当作通过。

最近一次运行查出并修掉了三个真实错误：

| Provider | 原值 | 现值 | 原因 |
|---|---|---|---|
| Trae | `Doubao-Seed-Code` = 184000 | 256000 | 同一个 `config_name` 被多个目录用不同窗口广告；"先到先得"让较窄的 `solo_coder` 行锁死了较宽的 `solo_agent` 行。现在取最宽者。 |
| AGY | `gemini-3.1-flash-lite` 带 low/medium/high 选择器 | 无选择器 | id 前缀启发式（`gemini-3*`）覆盖了目录，而该行在目录里并没有 thinking 支持。给它发 `thinkingLevel` 会 400。现在目录对它收录的每一行拥有最终决定权，前缀猜测只兜底目录不认识的新 id。 |
| Grok | 兜底窗口 256000、三个已退役模型 id | 500000 与线上现役四个 id | 线上 CLI 目录提供 `grok-4.5/4.6/4.7` 与 `grok-4.7-build-fast`，窗口均为 500000。旧的兜底会让离线启动低报窗口，并提供没人再服务的 id。 |

另有两条**核查后确认正确、并非 bug**：`gemini-2.5-pro` 会推理但没有等级选择器（Antigravity 的
`thinkingLevel` 轴是 Gemini-3+ 特性，2.5 走固定思考预算）；以及 effort 命名用的
`charAt(0).toUpperCase()` —— `max` 正是各家自己的标签（"Max"），写成 "Maximum" 反而是无谓的偏离。

## 安装

```sh
dsh plugin --profile web add github:zdz6215591/dsh-subscription-hub
```

Git 安装会跑 `prepare`。pnpm ≥10 需在该 profile 的 `pnpm-workspace.yaml` 里写：

```yaml
allowBuilds:
  dsh-subscription-hub: true
```

然后重启 `dsh web`。请先卸掉会抢同一路由的旧插件，否则模型列表会再次变卡，而且要选两处：

```sh
dsh plugin --profile web remove dsh-plugin-subscriptions
dsh plugin --profile web remove dsh-agy-link
dsh plugin --profile web remove dsh-agy
dsh plugin --profile web remove @mars-sea/dsh-commandcode-provider
dsh plugin --profile web remove @shatyuka/dsh-llm-codebuddy
dsh plugin --profile web remove dsh-coding-subscription-oauth
```

## Zed Pro

Zed 没有第三方 OAuth 客户端。先在 Zed 应用里登录，然后：

- 点 **从 Zed 桌面导入**，或
- 手动粘贴 `userId` 与凭据 JSON。

插件会从 `https://cloud.zed.dev/client/llm_tokens` 换取 LLM token，并从
`GET /client/users/me` 读取剩余用量（与[账单页](https://dashboard.zed.dev)同源）。

## Antigravity

使用 Google OAuth + `daily-cloudcode-pa.googleapis.com` HTTP 流式接口，
**不会**拉起 `agy` / `cmd.exe`。若 Google 被墙请保持 Clash/TUN 开启。

## 参考项目

本仓库是**聚合衍生项目**：把若干独立社区插件的功能面与缺陷修复合并成一个
bundle，并在其上继续自研。以下项目均已致谢。

### 主要上游

| 项目 | 采纳内容 |
| --- | --- |
| [V1ki/dsh-plugin-subscriptions](https://github.com/V1ki/dsh-plugin-subscriptions) | 本仓库 fork 的原始架构：各家 provider 适配器（Codex/Claude/Grok/Copilot/Antigravity）、OAuth 与设备码流程引擎、协议翻译层、账号 Token 管理、多账号池、用量链路，以及设置页外壳。 |

### 参考了具体修复与功能的社区项目

| 项目 | 采纳内容 |
| --- | --- |
| [yoshino-xiao7/dsh-grok-provider](https://github.com/yoshino-xiao7/dsh-grok-provider) | WebP 引用图转码修复：DSH 会把带透明通道的附件规范化为 `image/webp`，而 Grok 的 Responses 端点拒收；发送前将带 alpha 的 WebP 转 PNG、不透明转 JPEG。 |
| [Mars-Sea/dsh-commandcode-provider](https://github.com/Mars-Sea/dsh-commandcode-provider) | Command Code 模型目录同步（GLM-5.3 FlashX 及后续）、诚实的 429 上报、账号级拒绝轮换，以及用量/计划面板思路。 |
| [amlyczz/dsh-agy-link](https://github.com/amlyczz/dsh-agy-link) | Antigravity 原生工具卡片渲染、思考行过滤、按账号查找 conversation 数据库，以及 `/agy` 工作区透传方案。 |
| [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) | WorkBuddy/CodeBuddy 区域处理、国内企业版计费端点，以及额度展示规则（不把无限额画成满额 100%）。 |
| [HaoyueQin/dsh-better-reasoning-effort](https://github.com/HaoyueQin/dsh-better-reasoning-effort) | 在官方「模型」卡片内编辑逐模型思考档位，含知识库 + 协议推断思路与带凭据探测端点的加固。 |
| [nickhelion/dsh-plugins](https://github.com/nickhelion/dsh-plugins)（`qwen-token-plan-cn-responses`） | Responses 协议的 tool_call_id 处理方式，以及第三方模型的一手思考探测技巧。 |
| [lninghaha/dsh-coding-subscription-oauth](https://github.com/lninghaha/dsh-coding-subscription-oauth) | Grok CLI v2 多账号凭据仓解析与过期 token 刷新，以及区域受限模型的错误映射。 |
| [igormel81/dsh-chat-cost](https://github.com/igormel81/dsh-chat-cost) | 本仓库省钱看板背后的多服务商价格表与按百万 Token 计价模型。 |
| [dingminhua/dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae) | Trae 路由的主参考：本机凭据发现（`storage.json` 与 `iCubeAuthInfo://icube.cloudide` 解密）、`llm_utils_chat` 请求信封、命名 SSE 事件集、工具调用处理，以及只读的积分/签到接口。 |
| [Wang-JQ77/dsh-trae-api](https://github.com/Wang-JQ77/dsh-trae-api) | Trae 次参考：四版本布局（Trae CN / TRAE SOLO CN / Trae / TRAE SOLO）、`tc` 容器格式与端点回退形态。 |
| [yhshzh/dsh-cline-pass](https://github.com/yhshzh/dsh-cline-pass) | Cline 路由的主参考：OpenAI 兼容线协议、SSE → harness 翻译、工具调用与思考处理（`reasoning` / `reasoning_content` / `reasoning_details`），以及最重要的 **分模型上游渠道钉住**：`PinProfile` 结构、两套流水线的不同拼写、排除项转白名单规则、按流水线翻译的排序指标，和零消耗的「不可能渠道」探测法。 |
| [munmunjaklin458-afk/cline-pass-switcher](https://github.com/munmunjaklin458-afk/cline-pass-switcher) | Cline Pass 路由控制器的开山之作：多候选顺序故障转移、单次尝试超时隔离、首块非 SSE / 裸 JSON 错误流探测、真实批量上游可用性校验（`validateUpstreams` 最小请求实测验证），以及错误触发的可用渠道自学习（`learnAvailableProviders`）。 |
| [GooDAnDReaDY/dsh-clinebot](https://github.com/GooDAnDReaDY/dsh-clinebot) | Cline 次参考：`apiKeyEnv` 凭据引用模式、`disabledModels` 白名单思路、`/users/me/plan/usage-limits` 额度窗口（5 小时 / 每周 / 每月，80% 与 95% 阈值）—— 本仓库 Cline 用量条的来源，以及套餐标签解析。 |

### 与参考项目保持同步

**固定约定：每当用户要求「查看参考项目并更新本仓库」时，答复一律分成两张清单**，
每条都写明来源项目，并标注 **采纳 / 改造 / 明确跳过**（含理由）：

1. **需要修复的相同缺陷** —— 别的项目已修复、本仓库同样存在的具体问题（指明上游提交或 PR）。
2. **值得新增的功能** —— 别的项目具备、本仓库缺失的能力（并评估是否契合一体化设计）。

上表中的 Trae 与 Cline 项目是**持续参考对象**，不是一次性致谢：它们的服务商端点、
模型清单与钉住/探测机制会随上游产品变化，因此每次收到此类请求都必须重新核对这两张清单。
不会有任何静默合并。

## 开发提示

- `npm test` —— TypeScript 构建 + 全量离线测试。
- `npm run build` —— 生成 `lib/client.js` 与 `lib/index.js`。
- 运行时加载 `lib/index.js`：Node 侧改动需要重启 DSH，客户端改动刷新浏览器即可。

## 许可证

MIT。上游致谢见 [NOTICE](NOTICE)。
