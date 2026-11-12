> **已停止维护**：本插件仅适配 DSH 0.2 系列早期公测版本（最后验证 `0.2.0-rc.2`），后续版本不再跟进。代码已合并到 [dsh-plugins](../README.md)，原独立仓库已归档。

# dsh-plugin-guard（插件创作公约）

面向 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness)（dsh）
的**纯宿主**极简插件。

**只做一件事**：挂载时把「dsh 插件创作公约」以带标记的托管段落**幂等合并**进
`$DSH_HOME/AGENTS.md`（默认 `~/.dsh/AGENTS.md`）。DSH 的 agent-instructions
机制会在每次会话启动时自动读取该文件，因此**装了这个插件，所有会话的 AI
都会自动遵循公约**——普通会话、创造模式、子代理，制作/修改插件时一律生效。
没有设置页、没有复制按钮、没有任何检查器；卸载时移除托管段落，文件其余内容
保持不变。

## 注入的公约内容

1. 样式三原则（自有前缀普通类名；稳定选择器；禁止哈希类名）。
2. 必须项（`dsh.client` manifest、exports、loader 包装身份、esbuild 构建、`DSH_CSS_HASH_ROOT`）。
3. 红线（不写自定义会话事件；不用 localStorage 持久化；不改 body/window 全局样式）。
4. 挂载与更新流程（profile junction + patch 行 + 重启）。

权威文本在 `src/index.ts`（它才是真正写进 AGENTS.md 的文本）。
`CONVENTIONS.md` / `CONVENTIONS.en.md` / `SKILL.md` 是仓库可读版，编辑源码
文本时请同步。

## 目录结构

```
src/index.ts          宿主半区：AGENTS.md 托管段落合并/移除（全部逻辑）
scripts/build.mjs     esbuild 宿主构建
CONVENTIONS.md        公约（中文）
CONVENTIONS.en.md     公约（英文）
SKILL.md              技能版公约（供 AI 直接引用）
lib/                  构建产物（已 gitignore）
```

## 安装（DSH ≥ 0.2.0：插件即 bundle）

1. junction 到桌面端 profile 的插件目录：

   ```powershell
   New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-plugin-guard" -Target (Get-Location).Path
   ```

2. 在 `~/.dsh/profiles/desktop/package.json` 里把插件加入 `dependencies` 与
   `dsh.profile.bundles`（0.2.0 起 profile 的 cordis.patch.yml 不再负责装载插件；
   本包自带 `dsh.bundle.patch`，无需再写用户层 insert）：

   ```json
   "dependencies": { "dsh-plugin-guard": "0.1.2" }
   ```

   ```json
   "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-plugin-guard"] } }
   ```

3. 重启桌面端即生效：插件会把公约合并进 AGENTS.md，此后每个会话自动携带公约
   （纯宿主、无客户端，也无需刷新页面）。

## 构建

```sh
node scripts/build.mjs
```

产出 `lib/index.js`（宿主、esm、外部化 `@deepseek-ai/*` 与 `node:*`）。

## 备注

- 托管段落以 `<!-- dsh-plugin-guard:start -->` / `<!-- dsh-plugin-guard:end -->`
  标记包裹，重复挂载/更新不会重复写入。
- 卸载（或更新重挂）时只移除自己的托管段落，文件其他内容不动。
- License: MIT。
