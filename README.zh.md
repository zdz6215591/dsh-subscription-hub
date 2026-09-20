# dsh-subscription-hub

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的统一订阅插件。

[English](README.md) | 中文

一个 **设置 → 订阅** 页面覆盖八个订阅路由：

| 路由 | 订阅 | 说明 |
| --- | --- | --- |
| `codex` | ChatGPT Plus/Pro | 实时目录、用量、Fast 通道 |
| `claude` | Claude Pro/Max | OAuth，或从 Claude Code 导入 |
| `grok` | SuperGrok / X Premium | 实时目录、用量、Imagine 生图生视频 |
| `copilot` | GitHub Copilot | 设备码登录 |
| `agy` | Google Antigravity | **纯 HTTP OAuth**，不调用 `agy` CLI，不闪 `cmd.exe` |
| `commandcode` | Command Code Go | 导入 `~/.commandcode/auth.json` 或粘贴 key（Studio 可选） |
| `codebuddy` | 腾讯 CodeBuddy | 浏览器 OAuth，每日自动签到 |
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
   占比条，并带 **重新统计** 按钮（重扫会话历史）。
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

### 「查看参考项目并更新本仓库」的输出约定

当你要求**检查参考项目并更新本仓库**时，答复固定分成两张清单：

1. **需要修复的相同缺陷** —— 别的项目已修复、本仓库同样存在的具体问题
   （并指明对应的上游提交或 PR）。
2. **值得新增的功能** —— 别的项目具备、本仓库缺失的能力（并评估是否契合
   本仓库的一体化设计）。

每条都写明来源项目、具体改动，以及最终是**采纳 / 改造 / 明确跳过**（含理由）。
不会有任何静默合并。

## 开发提示

- `npm test` —— TypeScript 构建 + 全量离线测试。
- `npm run build` —— 生成 `lib/client.js` 与 `lib/index.js`。
- 运行时加载 `lib/index.js`：Node 侧改动需要重启 DSH，客户端改动刷新浏览器即可。

## 许可证

MIT。上游致谢见 [NOTICE](NOTICE)。
