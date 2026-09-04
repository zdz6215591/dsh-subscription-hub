# dsh-subscription-hub

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的统一订阅插件，基于 [V1ki/dsh-plugin-subscriptions](https://github.com/V1ki/dsh-plugin-subscriptions)（MIT）。

[English](README.md) | 中文

一个 **设置 → 订阅** 页面覆盖：Codex、Claude、SuperGrok、Copilot、Antigravity（纯 HTTP OAuth，不弹 `cmd.exe`）、Command Code Go（导入 CLI / 粘贴 key，Studio 可选）、CodeBuddy（含签到）、Zed Pro。

多账号池轮换、用量查询、模型显示勾选（只在对话选择器里选一次）、以及 V1ki 原有的生图 / 生视频 / x_search。

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

## 许可证

MIT。上游致谢见 [NOTICE](NOTICE)。
