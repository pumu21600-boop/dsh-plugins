/**
 * dsh-media-understanding client half — 设置页「媒体理解」分区。
 *
 * 只做一件事：编辑宿主半区 settings 命名空间 `media-understanding` 的配置
 * （开关、各模态的主/备路由、供应商端点与凭据引用、体积与超时上限），
 * 通过同源端点 /dsh-media-understanding/config 读写；另从 /status 显示
 * 缓存条数与最近一次失败。
 *
 * 不用 localStorage：配置属于宿主持久化（settings.yaml），换端口/主机不丢。
 */
window.__ModuleLoader__.load({
	id: "dsh-media-understanding",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const jsxRuntime = require("react/jsx-runtime");
		const { jsx, jsxs, Fragment } = jsxRuntime;
		const { useState, useEffect, useCallback } = react;

		const NS = "media-understanding";
		const CSS_NS = "mu";
		const CONFIG_URL = "/dsh-media-understanding/config";
		const STATUS_URL = "/dsh-media-understanding/status";
		const MODALITIES = ["image", "video", "audio"];

		/* 主题令牌取自本仓库其它插件已用过的、确实存在的变量
		   （--dsw-alias-border-light / text-secondary 这类名字并不存在，
		   写了只会落到兜底色，深色/浅色主题下就会出对比度问题）。 */
		const CSS = `
.${CSS_NS}_section{display:flex;flex-direction:column;gap:14px;max-width:760px}
.${CSS_NS}_hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.${CSS_NS}_card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:10px}
.${CSS_NS}_cardTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.${CSS_NS}_row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.${CSS_NS}_row label{font-size:12px;min-width:92px;color:var(--dsw-alias-label-secondary)}
.${CSS_NS}_row input[type=text],.${CSS_NS}_row input[type=number]{flex:1;min-width:120px;color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:5px 8px;font-size:13px;font-family:inherit}
.${CSS_NS}_row textarea{flex:1;min-height:52px;color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:6px 8px;font-size:13px;font-family:inherit;resize:vertical}
.${CSS_NS}_btn{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:5px 12px;font-size:12px;font-family:inherit;cursor:pointer}
.${CSS_NS}_btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.${CSS_NS}_btnPrimary{color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-button-primary-fill);border-color:transparent}
.${CSS_NS}_btn[disabled]{opacity:.5;cursor:default}
.${CSS_NS}_status{font-size:12px;color:var(--dsw-alias-label-tertiary);min-height:18px}
.${CSS_NS}_err{color:var(--dsw-alias-state-error-primary)}
.${CSS_NS}_switch{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--dsw-alias-label-primary)}
`;

		const zh = {
			nav: "媒体理解",
			hint: "会话里拖入的图片/视频/音频，会先交给下面配置的多模态模型转成文字描述，再把描述交给当前会话模型 —— 纯文本模型也能「看到」媒体。主模型失败会自动切备份；结果按附件内容缓存，同一文件不重复付费。",
			enable: "启用媒体理解",
			providers: "供应商端点",
			providersHint: "OpenAI 兼容端点。凭据填引用名（如 AGNES_API_KEY），值放在环境变量或 ~/.dsh/.credentials.yaml；也可直接填 apiKey（会明文写进 settings.yaml）。",
			providerId: "标识",
			baseURL: "Base URL",
			apiKeyEnv: "凭据引用名",
			addProvider: "新增供应商",
			remove: "删除",
			routes: "各模态路由",
			provider: "供应商",
			model: "模型",
			backupProvider: "备份供应商",
			backupModel: "备份模型",
			prompt: "提示词",
			limits: "限额",
			maxMB: "单文件上限 (MB)",
			timeoutMs: "超时 (ms)",
			maxOutputTokens: "理解输出上限 (tokens)",
			save: "保存",
			reload: "重新载入",
			saving: "保存中…",
			saved: "已保存",
			saveFailed: "保存失败",
			loadFailed: "读取配置失败",
			status: "状态",
			cacheEntries: "缓存条目",
			lastError: "最近失败",
			none: "（无）",
			image: "图片",
			video: "视频",
			audio: "音频"
		};

		const en = {
			nav: "Media understanding",
			hint: "Images/videos/audio dropped into a conversation are first described by the multimodal model configured below; the description is then handed to the current (possibly text-only) session model. A failing primary falls back to its backup, and results are cached by attachment content so the same file is never billed twice.",
			enable: "Enable media understanding",
			providers: "Provider endpoints",
			providersHint: "OpenAI-compatible endpoints. Reference credentials by name (e.g. AGNES_API_KEY) — the value lives in the environment or ~/.dsh/.credentials.yaml; a literal apiKey is also accepted (stored in plain text in settings.yaml).",
			providerId: "Id",
			baseURL: "Base URL",
			apiKeyEnv: "Credential ref",
			addProvider: "Add provider",
			remove: "Remove",
			routes: "Per-modality routes",
			provider: "Provider",
			model: "Model",
			backupProvider: "Backup provider",
			backupModel: "Backup model",
			prompt: "Prompt",
			limits: "Limits",
			maxMB: "Max file size (MB)",
			timeoutMs: "Timeout (ms)",
			maxOutputTokens: "Max output tokens",
			save: "Save",
			reload: "Reload",
			saving: "Saving…",
			saved: "Saved",
			saveFailed: "Save failed",
			loadFailed: "Could not load configuration",
			status: "Status",
			cacheEntries: "Cache entries",
			lastError: "Last failure",
			none: "(none)",
			image: "Image",
			video: "Video",
			audio: "Audio"
		};

		/* 注入自有样式（普通类名 + data-plugin 标记，符合仓库公约）。 */
		const STYLE_ID = "dsh-media-understanding-css";
		if (document.getElementById(STYLE_ID) === null) {
			const tag = document.createElement("style");
			tag.id = STYLE_ID;
			tag.dataset.plugin = "dsh-media-understanding";
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/** 空草稿（与服务端默认值一致）。providers 用数组：列表项以数组下标作
		    React key，改名不会导致重挂载，输入即写。 */
		function emptyDraft() {
			return {
				enabled: true,
				maxBytes: 20 * 1024 * 1024,
				timeoutMs: 120000,
				maxOutputTokens: 1500,
				providers: [],
				image: routeDraft(),
				video: routeDraft(),
				audio: routeDraft()
			};
		}
		function routeDraft() {
			return { provider: "", model: "", backupProvider: "", backupModel: "", prompt: "" };
		}

		/** 服务端快照 → 草稿。 */
		function toDraft(cfg) {
			const d = emptyDraft();
			if (cfg === null || typeof cfg !== "object") return d;
			d.enabled = cfg.enabled !== false;
			if (Number.isFinite(Number(cfg.maxBytes))) d.maxBytes = Number(cfg.maxBytes);
			if (Number.isFinite(Number(cfg.timeoutMs))) d.timeoutMs = Number(cfg.timeoutMs);
			if (Number.isFinite(Number(cfg.maxOutputTokens))) d.maxOutputTokens = Number(cfg.maxOutputTokens);
			d.providers = Object.entries(cfg.providers ?? {}).map(([id, p]) => ({
				id,
				baseURL: String(p?.baseURL ?? ""),
				api: String(p?.api ?? "openai-completions"),
				apiKey: String(p?.apiKey ?? ""),
				apiKeyEnv: String(p?.apiKeyEnv ?? "")
			}));
			for (const m of MODALITIES) {
				const r = cfg[m] ?? {};
				d[m] = {
					provider: String(r.provider ?? ""),
					model: String(r.model ?? ""),
					backupProvider: String(r.backupProvider ?? ""),
					backupModel: String(r.backupModel ?? ""),
					prompt: String(r.prompt ?? "")
				};
			}
			return d;
		}

		/** 草稿 → 提交给宿主的结构；标识非法/重复时返回错误信息。 */
		function toPayload(draft) {
			const providers = {};
			for (const row of draft.providers) {
				const id = String(row.id ?? "").trim();
				if (id === "") return { error: "供应商标识不能为空" };
				if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) return { error: `供应商标识「${id}」不合法（字母数字与 . _ -）` };
				if (providers[id] !== void 0) return { error: `供应商标识「${id}」重复` };
				providers[id] = {
					baseURL: row.baseURL,
					api: row.api || "openai-completions",
					apiKey: row.apiKey,
					apiKeyEnv: row.apiKeyEnv
				};
			}
			return {
				payload: {
					enabled: draft.enabled,
					maxBytes: draft.maxBytes,
					timeoutMs: draft.timeoutMs,
					maxOutputTokens: draft.maxOutputTokens,
					providers,
					image: draft.image,
					video: draft.video,
					audio: draft.audio
				}
			};
		}

		function Field(props) {
			const { label, value, onChange, type } = props;
			return jsxs("div", {
				className: CSS_NS + "_row",
				children: [
					jsx("label", { children: label }),
					jsx("input", {
						type: type ?? "text",
						value: String(value ?? ""),
						onChange: (e) => onChange(e.target.value)
					})
				]
			});
		}

		function ProviderCard({ row, onPatch, onRemove, t }) {
			return jsxs("div", {
				className: CSS_NS + "_card",
				children: [
					jsxs("div", {
						className: CSS_NS + "_row",
						children: [
							jsx("label", { children: t("providerId") }),
							jsx("input", {
								type: "text",
								value: row.id,
								onChange: (e) => onPatch({ id: e.target.value })
							}),
							jsx("button", {
								type: "button",
								className: CSS_NS + "_btn",
								onClick: onRemove,
								children: t("remove")
							})
						]
					}),
					jsx(Field, { label: t("baseURL"), value: row.baseURL, onChange: (v) => onPatch({ baseURL: v }) }),
					jsx(Field, {
						label: t("apiKeyEnv"),
						value: row.apiKeyEnv,
						onChange: (v) => onPatch({ apiKeyEnv: v })
					}),
					jsx(Field, {
						label: "apiKey",
						value: row.apiKey,
						onChange: (v) => onPatch({ apiKey: v })
					})
				]
			});
		}

		function RouteCard({ modality, route, onPatch, t }) {
			return jsxs("div", {
				className: CSS_NS + "_card",
				children: [
					jsx("div", { className: CSS_NS + "_cardTitle", children: t(modality) }),
					jsxs("div", {
						className: CSS_NS + "_row",
						children: [
							jsx("label", { children: t("provider") }),
							jsx("input", {
								type: "text",
								value: route.provider,
								onChange: (e) => onPatch({ provider: e.target.value })
							}),
							jsx("label", { children: t("model") }),
							jsx("input", {
								type: "text",
								value: route.model,
								onChange: (e) => onPatch({ model: e.target.value })
							})
						]
					}),
					jsxs("div", {
						className: CSS_NS + "_row",
						children: [
							jsx("label", { children: t("backupProvider") }),
							jsx("input", {
								type: "text",
								value: route.backupProvider,
								onChange: (e) => onPatch({ backupProvider: e.target.value })
							}),
							jsx("label", { children: t("backupModel") }),
							jsx("input", {
								type: "text",
								value: route.backupModel,
								onChange: (e) => onPatch({ backupModel: e.target.value })
							})
						]
					}),
					jsxs("div", {
						className: CSS_NS + "_row",
						children: [
							jsx("label", { children: t("prompt") }),
							jsx("textarea", {
								value: route.prompt,
								onChange: (e) => onPatch({ prompt: e.target.value })
							})
						]
					})
				]
			});
		}

		function ConfigSection({ t }) {
			const [draft, setDraft] = useState(null);
			const [status, setStatus] = useState("");
			const [err, setErr] = useState("");
			const [busy, setBusy] = useState(false);
			const [stat, setStat] = useState(null);

			const load = useCallback(async () => {
				try {
					const r = await fetch(CONFIG_URL, { headers: { accept: "application/json" } });
					if (!r.ok) throw new Error("HTTP " + r.status);
					setDraft(toDraft(await r.json()));
					setErr("");
				} catch (e) {
					setErr(t("loadFailed") + ": " + String(e && e.message ? e.message : e));
				}
				try {
					const s = await fetch(STATUS_URL, { headers: { accept: "application/json" } });
					if (s.ok) setStat(await s.json());
				} catch {}
			}, [t]);

			useEffect(() => {
				void load();
			}, [load]);

			const patchRoute = (modality, patch) =>
				setDraft((d) => ({ ...d, [modality]: { ...d[modality], ...patch } }));
			const patchProvider = (index, patch) =>
				setDraft((d) => ({
					...d,
					providers: d.providers.map((row, i) => (i === index ? { ...row, ...patch } : row))
				}));
			const removeProvider = (index) =>
				setDraft((d) => ({ ...d, providers: d.providers.filter((_, i) => i !== index) }));
			const addProvider = () =>
				setDraft((d) => ({
					...d,
					providers: [...d.providers, { id: "", baseURL: "", api: "openai-completions", apiKey: "", apiKeyEnv: "" }]
				}));

			const save = async () => {
				const built = toPayload(draft);
				if (built.error !== void 0) {
					setStatus("");
					setErr(built.error);
					return;
				}
				setBusy(true);
				setStatus(t("saving"));
				try {
					const r = await fetch(CONFIG_URL, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(built.payload)
					});
					if (!r.ok) throw new Error("HTTP " + r.status);
					setDraft(toDraft(await r.json()));
					setStatus(t("saved"));
					setErr("");
				} catch (e) {
					setStatus(t("saveFailed") + ": " + String(e && e.message ? e.message : e));
				} finally {
					setBusy(false);
				}
			};

			if (draft === null) {
				return jsx("div", {
					className: CSS_NS + "_section",
					children: jsx("p", { className: CSS_NS + "_hint", children: err !== "" ? err : "…" })
				});
			}

			return jsxs("div", {
				className: CSS_NS + "_section",
				children: [
					jsx("p", { className: CSS_NS + "_hint", children: t("hint") }),
					jsxs("div", {
						className: CSS_NS + "_row",
						children: [
							jsxs("span", {
								className: CSS_NS + "_switch",
								children: [
									jsx("input", {
										type: "checkbox",
										checked: draft.enabled,
										onChange: (e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))
									}),
									jsx("span", { children: t("enable") })
								]
							})
						]
					}),
					jsxs("div", {
						className: CSS_NS + "_card",
						children: [
							jsx("div", { className: CSS_NS + "_cardTitle", children: t("providers") }),
							jsx("p", { className: CSS_NS + "_hint", children: t("providersHint") }),
							...draft.providers.map((row, index) =>
								jsx(
									ProviderCard,
									{
										row,
										t,
										onPatch: (patch) => patchProvider(index, patch),
										onRemove: () => removeProvider(index)
									},
									index
								)
							),
							jsx("div", {
								className: CSS_NS + "_row",
								children: jsx("button", {
									type: "button",
									className: CSS_NS + "_btn",
									onClick: addProvider,
									children: t("addProvider")
								})
							})
						]
					}),
					jsxs("div", {
						className: CSS_NS + "_card",
						children: [
							jsx("div", { className: CSS_NS + "_cardTitle", children: t("routes") }),
							...MODALITIES.map((m) =>
								jsx(
									RouteCard,
									{
										modality: m,
										route: draft[m],
										t,
										onPatch: (patch) => patchRoute(m, patch)
									},
									m
								)
							)
						]
					}),
					jsxs("div", {
						className: CSS_NS + "_card",
						children: [
							jsx("div", { className: CSS_NS + "_cardTitle", children: t("limits") }),
							jsx(Field, {
								label: t("maxMB"),
								type: "number",
								value: Math.round(draft.maxBytes / 1048576),
								onChange: (v) => setDraft((d) => ({ ...d, maxBytes: Math.max(0, Number(v) || 0) * 1048576 }))
							}),
							jsx(Field, {
								label: t("timeoutMs"),
								type: "number",
								value: draft.timeoutMs,
								onChange: (v) => setDraft((d) => ({ ...d, timeoutMs: Math.max(1000, Number(v) || 1000) }))
							}),
							jsx(Field, {
								label: t("maxOutputTokens"),
								type: "number",
								value: draft.maxOutputTokens,
								onChange: (v) => setDraft((d) => ({ ...d, maxOutputTokens: Math.max(1, Number(v) || 1) }))
							})
						]
					}),
					jsxs("div", {
						className: CSS_NS + "_row",
						children: [
							jsx("button", {
								type: "button",
								className: CSS_NS + "_btn " + CSS_NS + "_btnPrimary",
								disabled: busy,
								onClick: save,
								children: t("save")
							}),
							jsx("button", {
								type: "button",
								className: CSS_NS + "_btn",
								disabled: busy,
								onClick: () => void load(),
								children: t("reload")
							}),
							jsx("span", {
								className: CSS_NS + "_status" + (err !== "" ? " " + CSS_NS + "_err" : ""),
								children: err !== "" ? err : status
							})
						]
					}),
					stat !== null
						? jsxs("p", {
								className: CSS_NS + "_hint",
								children: [
									t("status") + ": " + t("cacheEntries") + " " + String(stat.cacheEntries ?? 0),
									" · " + t("lastError") + ": " + (stat.lastError ? String(stat.lastError) : t("none"))
								]
						  })
						: null
				]
			});
		}

		/* ── 插件体 ─────────────────────────────────────────────────── */

		const inject = ["slots", "locale"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-media-understanding: dict");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: "media-understanding",
						order: 103,
						label: () => t("nav"),
						locale: NS
					},
					ConfigSection
				)
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
