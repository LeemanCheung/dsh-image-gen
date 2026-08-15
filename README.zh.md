# dsh-image-gen

[![CI](https://github.com/LeemanCheung/dsh-image-gen/actions/workflows/ci.yml/badge.svg)](https://github.com/LeemanCheung/dsh-image-gen/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

在 DeepSeek Harness 会话中使用 OpenAI `gpt-image-2` 生成图片，并提供真实渐进预览和精致的 Codex 风格显影动画。

[English](./README.md)

<p align="center"><img src="./assets/demo.svg" width="760" alt="dsh-image-gen 渐进预览动画" /></p>

上图对应插件实际卡片状态；实时草图来自服务端流式响应。

## 亮点

- 注册与 Codex 兼容的模型工具名 `image_gen`。
- 最多流式展示 3 张服务端真实局部图，而不是模拟进度条。
- 局部图在同一显影画布上交叉淡入、逐步对焦，最终自然过渡到成图。
- 最终图片保存在 DSH 不可变附件仓库中，支持会话回放、灯箱预览和下载。
- 给模型返回纯文本，避免生成图片后让不支持视觉的文本模型拒绝后续会话历史。
- 原生工具调用和 Code Mode 嵌套调用都能回放同一张图片卡片。
- 每次请求单独解析凭据；拒绝重定向；限制响应大小；通过 DSH 校验图片字节；只重试临时故障。
- 提供中英文界面，并支持 `prefers-reduced-motion`。

## 对 Codex 的复刻与改进

OpenAI Codex 内置的 `image_gen` 固定使用 `gpt-image-2`，公开源码显示 `in_progress`、`completed` 和 `failed` 三种状态，并将成图保存到 Codex 的 generated-images 目录；公开实现并未提供独特的扩散显影动画。

本插件保留相同工具名和模型，同时增强生成体验：

| 体验 | Codex | dsh-image-gen |
| --- | --- | --- |
| GPT Image 2 | 支持 | 支持 |
| 服务端真实渐进图 | 工具支持，默认界面较通用 | 卡片中最多实时展示 3 张 |
| 首张局部图前 | 通用工作状态 | 显影画布、扫描光和动态光场 |
| 局部图切换 | 通用活动状态 | 原位交叉淡入并逐步对焦 |
| 最终结果 | 保存图片 | DSH 持久附件、会话回放、灯箱、下载 |
| 纯文本模型兼容 | 不涉及 DSH 历史 | 模型只收到文本，图片引用保存在界面元数据中 |
| 减少动态效果 | 取决于平台 | 明确支持 |

主要调研来源：

- [Codex 图片生成工具](https://github.com/openai/codex/blob/main/codex-rs/ext/image-generation/src/tool.rs)
- [OpenAI 图片生成 Skill](https://github.com/openai/skills/blob/main/skills/.system/imagegen/SKILL.md)
- [GPT Image 2 模型](https://developers.openai.com/api/docs/models/gpt-image-2)
- [图片生成指南](https://developers.openai.com/api/docs/guides/image-generation)

## 兼容性

已验证环境：

- DeepSeek Harness `0.1.0-rc.6`
- Node.js `24.15.0`
- Windows 11 上的 DSH Web profile

验证日期：2026-08-15。

## 安装

安装第三方插件前请先审查源码，并固定提交版本：

```powershell
dsh plugin --profile web add github:LeemanCheung/dsh-image-gen#<commit-sha>
```

本地开发安装：

```powershell
git clone https://github.com/LeemanCheung/dsh-image-gen.git
cd dsh-image-gen
npm install
npm run check
dsh plugin --profile web add .
```

仓库会提交 `lib/index.js` 和 `lib/client.js`，因此固定提交的 Git 安装不需要执行依赖构建脚本。安装后重启 DSH Host，并刷新 Web 页面。

## 配置凭据

默认凭据引用是 `OPENAI_API_KEY`。请通过 DSH 凭据仓库或 Host 进程环境提供它。不要把原始密钥写入 `cordis.patch.yml`、聊天消息、Git 或截图。

PowerShell 单次进程示例：

```powershell
$env:OPENAI_API_KEY = 'sk-...'
dsh --profile web
```

插件会在每次生成时重新解析凭据。轮换凭据不需要修改插件配置。

## 使用

在 DSH 会话里直接描述需求，例如：

> 生成一张电影感 16:9 产品摄影：半透明机械键盘放在深色玻璃桌面上，紫色轮廓光，不要文字。

模型会调用 `image_gen`。生成期间，卡片先播放显影动画，再用服务端真实局部图替换预览。DSH 原有的中断操作会取消请求。完成后可预览和下载。

工具参数：

- `prompt`：详细提示词，1–32,000 个字符，且不超过 64,000 个 UTF-8 字节。
- `size`：`auto` 或 GPT Image 2 支持的任意 `宽x高`；两边必须能被 16 整除，单边不超过 3840，宽高比在 1:3–3:1，总像素为 655,360–8,294,400。
- `quality`：`auto`、`low`、`medium` 或 `high`。
- `output_format`：`png`、`jpeg` 或 `webp`。
- `output_compression`：JPEG/WebP 的 0–100 压缩质量。
- `background`：`auto` 或 `opaque`。GPT Image 2 不支持透明背景。

## 配置

Bundle 默认插入 `image-gen` 行。可以在所选 profile 的 `cordis.patch.yml` 中覆盖：

```yaml
- id: image-gen
  name: dsh-image-gen
  config:
    apiKeyEnv: OPENAI_API_KEY
    baseUrl: https://api.openai.com/v1
    model: gpt-image-2
    defaultSize: auto
    defaultQuality: auto
    defaultOutputFormat: png
    defaultOutputCompression: 90
    defaultBackground: auto
    moderation: auto
    partialImages: 3
    requestTimeoutMs: 120000
    maxRetries: 2
    retryBaseMs: 1000
    maxConcurrent: 2
```

Provider URL 或默认尺寸无效时，插件会在加载阶段直接失败。只有 `localhost`、`127.0.0.1` 和 `[::1]` 开发地址允许普通 HTTP。携带凭据的请求使用 `redirect: "error"`。

### 成本说明

OpenAI 会按尺寸和质量收取图片生成费用。根据服务端指南，每张渐进局部图还会消耗 100 个图片输出 token。将 `partialImages` 设为 `0` 可减少预览成本；设置为 `1`–`3` 可以用成本换取更丰富的实时体验。

## 数据、网络和权限

- **网络**：把提示词和所选参数发送到 `baseUrl`；默认是 OpenAI Images API。
- **凭据**：每次请求只读取配置的 DSH 凭据引用。解析后的密钥不会进入插件状态、日志、元数据或会话历史。
- **存储**：只有最终成图会通过 DSH 附件服务保存。局部图只在调用期间保留于受限 Host 内存，随后丢弃。
- **浏览器访问**：使用仅回环可用的私有 RPC。Host 必须先在指定会话和调用记录中找到完全匹配的附件引用，才会返回最终图片。
- **工作区文件**：不会读取或写入会话工作区。
- **用户数据**：提示词和工具参数会遵循 DSH 的常规会话日志规则。OpenAI 会根据所配置 API 账户适用的条款接收提示词。

## 故障排查

### `No credential is configured for OPENAI_API_KEY`

为 DSH Host 进程配置凭据后重试。不要在聊天中发送密钥。

### 图片被安全策略拦截

修改提示词后重试。插件不会盲目重试服务端审核或用户输入错误。

### 已成功但预览不可用

先刷新页面。如果仍无法加载，请查看 Host 日志，并确认 profile 仍挂载了 `dsh-image-gen`，附件仓库可用。

```powershell
dsh plugin --profile web why dsh-image-gen
dsh --profile web --dump-config
```

### 请求超时

在 10–300 秒范围内调大 `requestTimeoutMs`，降低质量，或改用 JPEG。DSH 的中断仍会终止上游请求。

### 回滚或卸载

修改生产 profile 前，可在安装了 undo 插件时创建 DSH 配置快照。卸载命令：

```powershell
dsh plugin --profile web remove dsh-image-gen
```

随后重启 DSH Host 并刷新页面。图片记录仍在会话历史中，但自定义卡片需要安装本插件才能显示。

## 开发

```powershell
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

测试使用确定性的模拟 SSE 流和本地重定向服务，不需要密钥。由于当前环境没有 `OPENAI_API_KEY`，本次没有执行真实 OpenAI API 冒烟测试。

构建产物：

- `lib/index.js`：Host Cordis 插件。
- `lib/client.js`：浏览器模块加载器 Bundle。
- `lib/client.js.map`：浏览器 source map。

## 已知限制

- 0.1 版生成全新图片。参考图编辑尚未开放，因为这需要安全的 DSH 附件选择器和明确的外部上传授权。
- 最终预览刻意限制为回环访问。远程 Web 客户端只会看到明确的不可用状态，不会收到图片字节。
- 当前 DSH 凭据解析和附件保存服务不接收取消信号。插件会在这些阶段前后检查取消，并在卸载时等待它们结束，但无法中断卡死在服务内部的 Provider 实现。
- OpenAI 可能调整任意尺寸限制或事件字段。遇到不兼容响应时，插件会安全失败，而不是猜测。

## 安全

私密报告方式见 [SECURITY.md](./SECURITY.md)。不要在公开 Issue 中附带 API key、私密提示词或私密成图。

## 许可证

[MIT](./LICENSE)
