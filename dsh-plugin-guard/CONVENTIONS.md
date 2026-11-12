# dsh 插件创作公约

> 本文件是插件注入文本的仓库可读版。安装 dsh-plugin-guard 后，本公约会通过
> `ctx.sysprompt.section` 自动进入**每个 agent** 的系统提示词，无需手动复制；
> 这里的正文与 `src/index.ts` 中的 `CONVENTIONS_TEXT` 同源，编辑时两者同步。

## 一、样式三原则

1. **插件自身的组件样式**：写自有前缀的普通类名（如 `.pg_*`），禁止使用 CSS Modules。
2. **样式化 DSH 界面内部元素**：只用稳定选择器，优先级 `[data-*]` 属性 > `id` > `role`/`aria` > 主题 CSS 变量（`--dsw-*`）。
3. **绝对禁止写哈希类名**（形如 `._8lIALq_userRow`）：它按构建机器路径生成，本地重建必然失效；官方技能同样禁止 hard-coded product DOM selectors。

## 二、必须项

1. `package.json`：`name` 匹配 `/^[a-z][a-z0-9-]{0,63}$/`；`exports` 包含 `"."` 与 `"./client"`（有客户端时）。
2. `dsh.client` manifest：`platform` 固定 `"web"`；`inject` 只列真实用到的 `@deepseek-ai` 包。
3. 客户端半区：设置页必须用 `ctx.slots.inject('settings.section', ...)` 注册；文案用 `ctx.locale.register` 注册双语词典；样式用 `<style data-plugin="插件id">` 注入（普通类名）。
4. `lib/client.js` 必须形如 `window.__ModuleLoader__.load({id: <cordis 行 id>, factory: require => {...}})`，`id` 与 cordis 行 id 一致。
5. 构建：用 esbuild；本机重建前设置 `DSH_CSS_HASH_ROOT=/home/runner/work/deepseek-harness/deepseek-harness`，保证与官方包类名一致。

## 三、红线（踩了必坏）

1. 不要 `session.append` 本构建未知的事件类型：会毒化会话日志、破坏其它构建的重放；要么加 `ignorable: true`，要么改用标准事件。
2. 持久化不要用 localStorage/IndexedDB：绑定 origin，换端口/主机即丢。配置持久化用「条目 Config」（DSH ≥ 0.2.0：插件模块导出 `Config` = schemastery schema，`apply(ctx, config)` 第二参数读、`ctx.get('configEditor').edit(ctx.fiber.entry, () => next)` 写）；文件型状态放 `$DSH_HOME/storages`。
3. 不要直接改 `document.body` / `window` 的全局样式、不要挂 body 上的 `position:fixed` 覆盖层：与应用外壳冲突。

## 四、挂载与更新（DSH ≥ 0.2.0：插件即 bundle）

1. 包放在 profile 的 `node_modules` 下（junction 指向源码目录），如 `~/.dsh/profiles/desktop/node_modules/<插件名>`。
2. 在 `~/.dsh/profiles/desktop/package.json` 登记：`dependencies` 加本包（版本号），`dsh.profile.bundles` 加 `<插件名>`（排在 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 之后）；profile 的 `cordis.patch.yml` 不再负责装载插件。
3. 插件包 `package.json` 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`；仓库根目录的 `cordis.patch.yml` 用 `insert` 把自己加进 cordis 树：

   ```yaml
   - insert:
       - id: <插件名>
         name: '<插件名>'
   ```

4. 设置项不用 `ctx.settings.register`（0.2.0 已移除）：按上面第三条红线的方式写条目 `Config`。
5. 修改 `lib` 后重启桌面端（客户端刷新页面，rev 查询会变）。

## 五、用 dsh-plugin-guard 自查

- 「插件体检 → 目录体检」：对正在写的插件目录做静态检查（manifest / loader 包装 / 自定义事件 / localStorage / CSS Modules）。
- 「插件体检 → 创作」：一键生成符合本公约的最小骨架。
- 「插件体检 → 规范」：一键复制本公约粘给 AI。
