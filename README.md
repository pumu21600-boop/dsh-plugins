# dsh-media-understanding

DeepSeek Harness（DSH）的媒体理解转接功能集：让纯文本会话模型借助专用多模态模型理解图片、音频、视频。

## 功能

- 会话中发送图片 / 音频 / 视频时，自动把媒体内容转交给「功能配置」里指定的理解模型。
- 理解模型返回的文字描述会替代媒体块，注入会话请求；会话模型（即使纯文本）也能"看到"媒体。
- 图片、音频、视频各自独立配置主模型与备份模型；主模型失败自动切换备份。
- 每个媒体块只理解一次，结果记录为 `media/understanding` 会话事件，重放/续接时复用。

## 原理

1. `agent/request-messages` 阶段收集请求中的媒体块。
2. 预检目标模型声明的 `inputModalities` 是否包含对应媒体类型（image/video/audio）。
3. 支持则调用理解模型，将结果文本替换媒体块；不支持则替换为可操作的提示文本。
4. 视频/音频超出 pi-ai 线格式（仅 text/image），由 llm-pi-ai 适配器直连 OpenAI 兼容端点发送（`video_url` / `input_audio` 内容块 + SSE 流式）。

## 目录

- `patches/0001-core-modality-changes.patch` — 对 DSH 核心包的补丁：
  - `packages/llm/llm/src/types.ts`：`ModelModalityMap` 增加 `video`/`audio`。
  - `packages/llm/llm-pi-ai`：新增 `DECLARED_MODALITIES` 声明模态（video/audio），`declaredModalities` 透传到 modelInfo/listModels；pi-ai 线格式仍只 text/image。
- `patches/new-media.ts` — llm-pi-ai 新增文件 `src/media.ts`：视频/音频直连 OpenAI 兼容端点（SSE）。
- `media-understanding/` — 理解转接插件源码（含理解调用输出上限 1500 tokens）。
- `ui-settings-features/` — 设置页"功能配置"客户端源码（含目录失效订阅，配置变更后自动刷新模型下拉）。

## 安装

以本机 DSH 源码树 `deepseek-harness`（基线 commit `b150a55`）为例：

```powershell
cd deepseek-harness
git apply <本仓库路径>\patches\0001-core-modality-changes.patch
Copy-Item <本仓库路径>\patches\new-media.ts packages\llm\llm-pi-ai\src\media.ts
```

`media-understanding/` 与 `ui-settings-features/` 为完整源码，对应覆盖到 `packages/llm/media-understanding/`、`packages/client/ui-settings-features/` 后重建。

重建宿主：

```powershell
pnpm exec tsc -b packages/llm/llm/tsconfig.json packages/llm/llm-pi-ai/tsconfig.json packages/llm/media-understanding/tsconfig.json
pnpm exec tsdown --env.DSH_BUILD_FACE host
pnpm exec tsc -b packages/client/ui-settings-features/tsconfig.json
cd packages/client/ui-settings-features; pnpm exec tsdown --env.DSH_BUILD_FACE client
```

重启 DSH 后生效。

## 配置

`~/.dsh/settings.yaml` 示例（见 `settings.example.yaml`）：

```yaml
llm-pi-ai:
  providers:
    agnes:
      apiKeyEnv: AGNES_API_KEY
      api: openai-completions
      baseURL: https://api.agnes-ai.cn/v1
      models:
        - id: agnes-2.5-flash
          input: [ text, image, video ]   # 声明该模型支持的媒体类型
    gemini:
      apiKeyEnv: GEMINI_API_KEY
      api: openai-completions
      baseURL: https://api.pie-xian.com/v1
      models:
        - id: gemini-3.1-flash-lite
          input: [ text, audio ]
media-understanding:
  image:  { provider: agnes,  model: "agnes-2.5-flash",     backupProvider: agnes, backupModel: "agnes-2.0-flash" }
  video:  { provider: agnes,  model: "agnes-2.5-flash",     backupProvider: agnes, backupModel: "agnes-2.0-flash" }
  audio:  { provider: gemini, model: "gemini-3.1-flash-lite", backupProvider: "", backupModel: "" }
```

要点：

- **必须在供应商模型上声明 `input`**，否则该模型默认只按纯文本处理，预检会拒绝媒体（"does not accept video/audio input"）。
- 视频/音频模型走 OpenAI 兼容端点，只对 `api: openai-completions` 路由生效。
- 凭证放在 `~/.dsh/.credentials.yaml` 的对应 `API_KEY` 环境引用里。

## 已知坑

- 理解文本注入会话请求会推高网关 TPM（每分钟 token）配额，可能触发 429 `inference tpm exhausted`；为会话模型路由配置长退避重试（见 settings 示例中 `retryPolicy`），并把理解输出上限保持在 1500 tokens。
- pi-ai 库线格式只有 text/image，video/audio 是"声明模态"：pi-ai 不感知，由适配器直连网关。
- 根级 `pnpm run build:lib:host` 在部分环境会因 scripts/website 的 `ImportMeta.dirname` 类型错失败（仓库既有问题），按上面列出的分步构建命令执行。

## 验证

```powershell
pnpm vitest run packages/llm/llm-pi-ai packages/llm/media-understanding
pnpm vitest run packages/client/ui-settings-features
```

## 许可证

MIT
