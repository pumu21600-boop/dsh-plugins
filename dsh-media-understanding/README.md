> **已停止维护**：本插件仅适配 DSH 0.2 系列早期公测版本（最后验证 `0.2.0-rc.2`），后续版本不再跟进。代码已合并到 [dsh-plugins](../README.md)，原独立仓库已归档。

# dsh-media-understanding

DeepSeek Harness（DSH）的**媒体理解桥接**：会话里拖入的图片 / 视频 / 音频，先交给
多模态模型转成文字描述，再把描述交给当前会话模型 —— 纯文本模型也能"看到"媒体。

> **0.2.0 是纯插件重写。** 0.1.x 靠改 DSH 内核源码 + 重新编译实现（`patches/`、
> `media-understanding/`、`ui-settings-features/`），在新版上用不了：入口钩子改了名、
> 配置校验不收 `input: [video]`，而当前部署跑的是官方 npm 包、改源码不生效。
> 新版**一行内核代码都不用改**，全部走公开接口。旧的源码级实现已删除，
> 需要的话在 git 历史里（`git show v0.1.0`）仍然完整保留。

## 原理（4 步，都是公开接口）

1. **拦下来** —— 挂在 `agent/pre-step`（waterfall，`prepend`）上，`await next()` 拿到
   本步最终消息后再重写。此刻媒体还是原始的 `file` 块（DSH 把文件块换成
   "只读副本路径"文本，是在更晚构造模型请求时才做的）。
2. **读字节** —— `attachments.fileHostPath(ref)` 给出本地绝对路径，插件与宿主同进程，
   直接读盘。`file` 块只带 `attachmentId / name / bytes`（**没有 mediaType**），
   所以模态按**扩展名**判定。
3. **问多模态模型** —— 插件自己发 HTTP 给配置好的 OpenAI 兼容端点（视频用
   `video_url`、音频用 `input_audio`、图片用 `image_url`）。**不走 DSH 的模型通道**，
   因此不会被"只认 text/image"的适配器与配置校验拦住。
4. **换掉** —— 把媒体块替换成描述文本，本轮继续；失败或超限时**保留原块**（模型仍能
   看到只读副本路径），绝不打断本轮。

结果按附件内容缓存（`attachmentId` 是内容寻址的），同一文件不重复计费。

## 安装（DSH ≥ 0.2.0：插件即 bundle）

1. junction 到桌面端 profile 的插件目录：

   ```powershell
   New-Item -ItemType Junction `
     -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-media-understanding" `
     -Target "C:\path\to\dsh-media-understanding"
   ```

2. 在 `~/.dsh/profiles/desktop/package.json` 里把插件加入 `dependencies` 与
   `dsh.profile.bundles`（0.2.0 起 profile 的 cordis.patch.yml 不再负责装载插件；
   本包自带 `dsh.bundle.patch`，无需再写用户层 insert）：

   ```json
   "dependencies": { "dsh-media-understanding": "0.2.2" }
   ```

   ```json
   "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-media-understanding"] } }
   ```

3. 重启桌面端，然后在**设置 → 媒体理解**里填供应商与各模态模型。

## 配置

见 `settings.example.yaml`。配置持久化在 profile 条目配置里
（`lib/index.js` 导出的 `Config` schema，经 configEditor 落盘），界面或文件都能改。

- `providers.<id>`：`baseURL` + `apiKeyEnv`（凭据引用名，值放环境变量或
  `~/.dsh/.credentials.yaml`）或 `apiKey`（明文）。
- `image` / `video` / `audio`：各一条主路由 + 可选备份路由，另有可覆盖的提示词。
- `maxBytes`（默认 20 MB）：单个媒体上限，超限跳过理解。
- `timeoutMs`（默认 120 s）、`maxOutputTokens`（默认 1500，防理解文本推高会话 token）。

## 已知边界

- **按扩展名判定模态**：`file` 块不带 MIME，所以 `.mp4/.mov/.mp3/...` 这类后缀才认；
  不带后缀或罕见后缀不会被处理（会照旧走"只读副本路径"）。
- **只处理用户消息顶层的文件块**：工具结果内嵌的文件块不动。
- **视频体积**：base64 后约涨 1/3，端点通常也有体积限制；大视频建议先裁剪，
  或调大 `maxBytes` 后自行承担失败回退。
- **不发明会话事件**：结果缓存写在 `~/.dsh/storages/media-understanding/cache.json`，
  不改会话日志格式（公约红线）。

## 测试

```sh
node tests/pre-step.spec.mjs
```

用一个本地 mock 的 OpenAI 兼容端点走完整链路（读盘 → 发请求 → 改写消息），
覆盖：三种模态的线格式、缓存命中、非媒体文件不处理、主备切换、全失败时保留原块、
超限跳过、开关关闭、端点 replace 语义。

## License

MIT
