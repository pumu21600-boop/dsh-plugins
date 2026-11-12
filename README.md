# DSH Plugins

> **本仓库已停止维护（最后更新于 2026-10-01）。**
>
> 这些插件只适配 DeepSeek Harness（DSH）**0.2 系列早期公测版本**，代码最后验证于 `0.2.0-rc.2`；后续 DSH 版本不保证兼容，也不再跟进修复。
>
> 不再接受 issue / PR。原六个独立仓库已于 2026-11 归档为只读，源码集中到这里保留备查。

## 插件列表

| 目录 | 版本 | 功能 |
| --- | --- | --- |
| [`dsh-context-tamer`](dsh-context-tamer/) | 0.2.1 | 上下文预算预警 + 无缝续接，长会话降本、防截断 |
| [`dsh-memory`](dsh-memory/) | 0.4.3 | 会话记忆库与星际记忆地图，支持全文搜索 |
| [`dsh-token-billing`](dsh-token-billing/) | 0.3.3 | 按模型统计 token 用量与费用 |
| [`dsh-media-understanding`](dsh-media-understanding/) | 0.2.2 | 图片/音频/视频先转文字描述，再交给纯文本模型 |
| [`dsh-css-inject`](dsh-css-inject/) | 0.2.1 | 自定义 CSS、页面背景、悬停检查器、下拉框美化 |
| [`dsh-plugin-guard`](dsh-plugin-guard/) | 0.1.2 | 把 DSH 插件创作公约注入 AGENTS.md |

## 兼容性

- 仅适配 **DSH 0.2 系列早期公测版本**，最后验证版本 `0.2.0-rc.2`。
- 不兼容 0.1.x；0.1.x 的源码级补丁实现只保留在各插件旧仓库的 git 历史里。
- 新版 DSH 的插件接口若有变化，本仓库不会跟进。

## 安装

每个子目录都是独立的 DSH bundle，安装步骤见各自 README。通用流程（以 `dsh-token-billing` 为例）：

1. 把插件目录 junction 到 `~/.dsh/profiles/desktop/node_modules/<插件名>`；
2. 在 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 和 `dsh.profile.bundles` 里加入插件；
3. 重启 DSH。

## 历史

原六个仓库（`dsh-context-tamer`、`dsh-memory`、`dsh-token-billing`、`dsh-media-understanding`、`dsh-css-inject`、`dsh-plugin-guard`）已归档为只读，完整提交历史和旧 tag 仍可查看。

## 许可证

MIT
