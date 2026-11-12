---
name: dsh-plugin-authoring
description: Out-of-repo DeepSeek Harness plugin authoring conventions — styling rules (plain prefixed class names, stable selectors, never hashed class names), package/manifest requirements, red lines (no custom session event types, no localStorage persistence), build hash-root convention, and the mount/update workflow. Use this skill before creating or modifying any dsh plugin.
---

# dsh 插件创作公约

> 给 AI 的开工前规范。本公约通常已由 dsh-plugin-guard 注入到系统提示词中
> （`ctx.sysprompt.section`）；此技能文件是同样的内容，供按需加载或参考。
> 制作/修改任何 dsh 插件前，先通读本文件；与 `src/index.ts` 的
> `CONVENTIONS_TEXT` 保持同步。

## 一、样式三原则

1. 插件自身组件样式：自有前缀普通类名（如 `.pg_*`），禁止 CSS Modules。
2. 样式化产品内部元素：只用稳定选择器——`[data-*]` > `id` > `role`/`aria` > 主题 CSS 变量（`--dsw-*`）。
3. 禁止哈希类名（`._hash_类名`）：按构建机器路径生成，本地重建必失效。

## 二、必须项

1. `package.json`：`name` 匹配 `/^[a-z][a-z0-9-]{0,63}$/`；`exports` 含 `"."`、`"./client"`（有客户端时）。
2. `dsh.client` manifest：`platform: "web"`；`inject` 只列真实使用的 `@deepseek-ai` 包。
3. 客户端：`ctx.slots.inject('settings.section', ...)` 注册设置页；`ctx.locale.register` 双语词典；样式 `<style data-plugin="插件id">`（普通类名）。
4. `lib/client.js`：`window.__ModuleLoader__.load({id: <cordis 行 id>, factory: require => {...}})`，id 与行 id 一致。
5. 构建：esbuild；本地重建前设 `DSH_CSS_HASH_ROOT=/home/runner/work/deepseek-harness/deepseek-harness`。

## 三、红线

1. 不写本构建未知的 `session.append` 事件类型（毒化重放）；要么 `ignorable: true`，要么用标准事件。
2. 不用 localStorage/IndexedDB 存业务数据（换端口即丢）；配置持久化用「条目 Config」（DSH ≥ 0.2.0：导出 `Config` = schemastery schema，`apply(ctx, config)` 第二参数读、`ctx.get('configEditor').edit(ctx.fiber.entry, () => next)` 写），文件型状态放 `$DSH_HOME/storages`。
3. 不改 `document.body`/`window` 全局样式、不挂 body `position:fixed` 覆盖层。

## 四、挂载与更新（DSH ≥ 0.2.0：插件即 bundle）

1. 包放 profile 的 `node_modules/`（junction 指向源码目录），如 `~/.dsh/profiles/desktop/node_modules/<插件名>`。
2. 在 `~/.dsh/profiles/desktop/package.json` 登记：`dependencies` 加本包，`dsh.profile.bundles` 加 `<插件名>`（排在两个内置 bundle 之后）；profile 的 `cordis.patch.yml` 不再负责装载插件。
3. 插件包 `package.json` 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，仓库根的 `cordis.patch.yml` 用 `insert:` 把自己加进 cordis 树。
4. 不用 `ctx.settings.register`（0.2.0 已移除），改用条目 `Config`。
5. 改 `lib` 后重启桌面端并刷新页面。

## 五、用 dsh-plugin-guard 自查

- 「目录体检」：静态检查正在写的插件目录。
- 「创作」：一键生成合规骨架。
- 「规范」：一键复制本公约。
