/**
 * dsh-media-understanding — host half (0.2.0, 纯插件实现).
 *
 * 会话里拖入的图片/视频/音频在 DSH 里会变成 `file` 块（只带 attachmentId /
 * name / bytes，不带内容）。0.1.x 是靠改内核 + 重编译来实现"先转述再喂模型"，
 * 新版改用公开接口，一行内核都不用改：
 *
 * 1. 挂在 `agent/pre-step` 瀑布上（prepend，先跑），`await next()` 拿到本步最终
 *    消息列表后再重写 —— 此刻媒体块还是原始的 `file` 块（运行时的
 *    projectFilesToText 是在更晚构造模型请求时才把文件块换成路径文本的）。
 * 2. 用 `attachments.fileHostPath(ref)` 拿到本地绝对路径读字节（插件与宿主
 *    同进程，直接读盘）。
 * 3. 自己发 HTTP 给配置好的 OpenAI 兼容端点（视频用 video_url、音频用
 *    input_audio、图片用 image_url），拿回文字描述。不走 DSH 的模型通道，
 *    所以不必也不能去改 pi-ai 那套"只认 text/image"的模态枚举。
 * 4. 把媒体块替换成描述文本；失败/超限时保留原块（运行时会给模型一个
 *    只读副本路径的提示文本），绝不打断本轮。
 *
 * 结果按 attachmentId 缓存（该 id 是内容寻址的），同一步/后续轮次不会重复付费。
 *
 * 端点（给客户端半区）：
 *   GET  /dsh-media-understanding/config  → 配置快照
 *   POST /dsh-media-understanding/config  → 合并并持久化
 *   GET  /dsh-media-understanding/status  → 缓存条数 / 最近一次失败
 */
import sm from "@deepseek-ai/schemastery";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { homedir } from "node:os";

const SETTINGS_NS = "media-understanding";
const PLUGIN = "dsh-media-understanding";

/** 凭据引用名的语法（与 @deepseek-ai/dsh-credentials 的 REF_PATTERN 一致；
    就地判定，免得为一个小正则再依赖一个服务包）。 */
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/* ── 模态判定：FileAttachmentRef 不带 mediaType，只能按扩展名 ───────── */

const EXT_MODALITY = new Map();
for (const e of [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif"]) EXT_MODALITY.set(e, "image");
for (const e of [".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi", ".ogv", ".3gp"]) EXT_MODALITY.set(e, "video");
for (const e of [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".oga", ".flac", ".opus", ".wma"]) EXT_MODALITY.set(e, "audio");

const MIME_BY_EXT = {
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
	".webp": "image/webp", ".bmp": "image/bmp", ".avif": "image/avif",
	".mp4": "video/mp4", ".m4v": "video/x-m4v", ".mov": "video/quicktime", ".webm": "video/webm",
	".mkv": "video/x-matroska", ".avi": "video/x-msvideo", ".ogv": "video/ogg", ".3gp": "video/3gpp",
	".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac",
	".ogg": "audio/ogg", ".oga": "audio/ogg", ".flac": "audio/flac", ".opus": "audio/opus", ".wma": "audio/x-ms-wma"
};

const DEFAULT_PROMPTS = {
	image: "详细描述这张图片的内容：主体、场景、可见文字（逐字转写）、以及任何对理解任务有用的细节。用中文回答。",
	video: "详细描述这段视频：场景、人物、动作过程、屏幕或画面中出现的文字（逐字转写）、以及关键时间点。用中文回答。",
	audio: "把这段音频的内容详细转述出来：若是语音请逐字转写；若是音乐或环境声请描述其类型、情绪与显著事件。用中文回答。"
};

/** 按文件名扩展名判定模态；不认识返回 null。 */
export function modalityOf(name) {
	const ext = extname(String(name ?? "")).toLowerCase();
	return EXT_MODALITY.get(ext) ?? null;
}

/* ── 配置 schema ────────────────────────────────────────────────────── */

const providerSchema = sm.object({
	baseURL: sm.string().default(""),
	api: sm.string().default("openai-completions"),
	apiKey: sm.string().default(""),
	apiKeyEnv: sm.string().default("")
});

const routeSchema = sm.object({
	provider: sm.string().default(""),
	model: sm.string().default(""),
	backupProvider: sm.string().default(""),
	backupModel: sm.string().default(""),
	prompt: sm.string().default("")
});

const settingsSchema = sm.object({
	enabled: sm.boolean().default(true),
	maxBytes: sm.number().min(0).default(20 * 1024 * 1024),
	timeoutMs: sm.number().min(1000).default(120000),
	maxOutputTokens: sm.number().min(1).default(1500),
	providers: sm.dict(providerSchema).default({}),
	image: routeSchema.default({}),
	video: routeSchema.default({}),
	audio: routeSchema.default({})
});

/** 把任意来源的配置摊平成 schema 形状（缺项走默认值）。 */
export function normalizeConfig(raw) {
	const src = raw && typeof raw === "object" ? raw : {};
	const str = (v) => (typeof v === "string" ? v : "");
	const num = (v, dflt, min) => {
		const n = Number(v);
		return Number.isFinite(n) && n >= min ? n : dflt;
	};
	const providers = {};
	const rawProviders = src.providers && typeof src.providers === "object" ? src.providers : {};
	for (const [id, p] of Object.entries(rawProviders)) {
		if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) continue;
		const row = p && typeof p === "object" ? p : {};
		providers[id] = {
			baseURL: str(row.baseURL),
			api: str(row.api) || "openai-completions",
			apiKey: str(row.apiKey),
			apiKeyEnv: str(row.apiKeyEnv)
		};
	}
	const route = (v, modality) => {
		const row = v && typeof v === "object" ? v : {};
		return {
			provider: str(row.provider),
			model: str(row.model),
			backupProvider: str(row.backupProvider),
			backupModel: str(row.backupModel),
			prompt: str(row.prompt) || DEFAULT_PROMPTS[modality]
		};
	};
	return {
		enabled: src.enabled !== false,
		maxBytes: num(src.maxBytes, 20 * 1024 * 1024, 0),
		timeoutMs: num(src.timeoutMs, 120000, 1000),
		maxOutputTokens: num(src.maxOutputTokens, 1500, 1),
		providers,
		image: route(src.image, "image"),
		video: route(src.video, "video"),
		audio: route(src.audio, "audio")
	};
}

/* ── 路径与缓存 ─────────────────────────────────────────────────────── */

function dshHome() {
	return process.env.DSH_HOME || join(homedir(), ".dsh");
}

function cacheFile() {
	return join(dshHome(), "storages", "media-understanding", "cache.json");
}

/** attachmentId 是内容寻址的，可直接当缓存键。 */
export function loadCache() {
	try {
		const raw = JSON.parse(readFileSync(cacheFile(), "utf8"));
		return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	} catch {
		return {};
	}
}

function saveCache(cache) {
	try {
		const dir = join(dshHome(), "storages", "media-understanding");
		mkdirSync(dir, { recursive: true });
		writeFileSync(cacheFile(), JSON.stringify(cache, null, 1), "utf8");
	} catch {
		/* 缓存写不进去不影响本轮 */
	}
}

/* ── 凭证解析：显式 key → credentials 服务（官方接缝）→ 进程环境 ───── */

async function resolveApiKey(ctx, provider) {
	if (provider.apiKey !== "") return provider.apiKey;
	const name = provider.apiKeyEnv;
	if (name === "" || !CREDENTIAL_REF_PATTERN.test(name)) return "";
	try {
		const creds = ctx.get("credentials");
		if (creds !== void 0 && typeof creds.resolve === "function") {
			const hit = await creds.resolve(name);
			if (hit !== void 0 && typeof hit.value === "string" && hit.value !== "") return hit.value;
		}
	} catch {
		/* 服务不可用，落到环境变量 */
	}
	const env = process.env[name];
	return typeof env === "string" ? env : "";
}

/* ── 组装理解请求 / 解析回复 ────────────────────────────────────────── */

/** 把一种模态的字节拼成 OpenAI 兼容的 content 片段。 */
export function buildContentParts(modality, ext, base64, prompt) {
	const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
	const parts = [{ type: "text", text: prompt }];
	if (modality === "image") {
		parts.push({ type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } });
	} else if (modality === "video") {
		parts.push({ type: "video_url", video_url: { url: `data:${mime};base64,${base64}` } });
	} else {
		parts.push({ type: "input_audio", input_audio: { data: base64, format: (ext.replace(/^\./, "") || "mp3") } });
	}
	return parts;
}

/** 从 OpenAI 兼容回复里取纯文本（content 可能是字符串或分片数组）。 */
export function readCompletionText(payload) {
	const content = payload?.choices?.[0]?.message?.content;
	if (typeof content === "string") return content.trim();
	if (Array.isArray(content)) {
		return content
			.map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
			.join("")
			.trim();
	}
	return "";
}

/** 对一条路由发一次理解请求；失败抛错，由调用方决定是否走备份。 */
export async function callProvider(ctx, cfg, route, providerId, model, modality, bytes, name, signal) {
	const provider = cfg.providers[providerId];
	if (provider === void 0) throw new Error(`unknown provider "${providerId}"`);
	if (provider.baseURL === "") throw new Error(`provider "${providerId}" has no baseURL`);
	const key = await resolveApiKey(ctx, provider);
	if (key === "") throw new Error(`provider "${providerId}" has no usable credential (apiKey / ${provider.apiKeyEnv || "apiKeyEnv"})`);
	const ext = extname(String(name ?? "")).toLowerCase();
	const body = {
		model,
		max_tokens: cfg.maxOutputTokens,
		stream: false,
		messages: [{ role: "user", content: buildContentParts(modality, ext, bytes.toString("base64"), route.prompt) }]
	};
	const url = provider.baseURL.replace(/\/+$/, "") + "/chat/completions";
	const res = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
		body: JSON.stringify(body),
		signal
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new Error(`HTTP ${res.status} ${res.statusText}${detail ? " :: " + detail.slice(0, 300) : ""}`);
	}
	const text = readCompletionText(await res.json());
	if (text === "") throw new Error("empty understanding text");
	return text;
}

/* ── 消息里的媒体块 ─────────────────────────────────────────────────── */

/** 收集 user 消息里顶层、且扩展名可识别的 file 块。 */
export function pickMediaBlocks(messages) {
	const picks = [];
	messages.forEach((message, messageIndex) => {
		if (message?.role !== "user" || !Array.isArray(message.content)) return;
		message.content.forEach((block, blockIndex) => {
			if (block?.type !== "file") return;
			const ref = block.attachment;
			if (ref === void 0 || typeof ref.name !== "string") return;
			const modality = modalityOf(ref.name);
			if (modality === null) return;
			picks.push({ messageIndex, blockIndex, modality, ref });
		});
	});
	return picks;
}

/** 用描述文本替掉被选中的块；返回新的消息数组（原消息是冻结的，只能重建）。 */
export function applyUnderstandings(messages, replacements) {
	if (replacements.size === 0) return messages;
	const out = messages.map((message, messageIndex) => {
		if (message?.role !== "user" || !Array.isArray(message.content)) return message;
		let content = null;
		message.content.forEach((block, blockIndex) => {
			const hit = replacements.get(`${messageIndex}:${blockIndex}`);
			if (hit === void 0) return;
			content ??= message.content.slice();
			content[blockIndex] = Object.freeze({
				type: "text",
				text: `【${hit.label}内容（由 ${hit.model} 转述，原文见附件 ${hit.name}）】\n${hit.text}`
			});
		});
		if (content === null) return message;
		return Object.freeze({ ...message, content: Object.freeze(content) });
	});
	return out;
}

const MODALITY_LABEL = { image: "图片", video: "视频", audio: "音频" };

/**
 * 理解一个媒体块：先查缓存，再走主路由，失败切备份。
 * 缓存命中不算失败；全部路由失败抛最后一个错误。
 */
async function understand(ctx, cfg, pick, signal, cache) {
	const key = String(pick.ref.attachmentId);
	const cached = cache[key];
	if (cached !== void 0 && typeof cached.text === "string" && cached.text !== "") {
		return { text: cached.text, model: cached.model ?? "cache", name: pick.ref.name, label: MODALITY_LABEL[pick.modality], cached: true };
	}
	const route = cfg[pick.modality];
	const attempts = [];
	if (route.provider !== "" && route.model !== "") attempts.push([route.provider, route.model]);
	if (route.backupProvider !== "" && route.backupModel !== "") attempts.push([route.backupProvider, route.backupModel]);
	if (attempts.length === 0) throw new Error(`no ${pick.modality} route configured`);

	const path = ctx.get("attachments")?.fileHostPath?.(pick.ref);
	if (typeof path !== "string" || path === "") throw new Error("attachment has no readable host path");
	const bytes = readFileSync(path);
	if (cfg.maxBytes > 0 && bytes.length > cfg.maxBytes) {
		throw new Error(`media is ${bytes.length} bytes, over maxBytes=${cfg.maxBytes}`);
	}

	let lastError;
	for (const [providerId, model] of attempts) {
		try {
			const text = await callProvider(ctx, cfg, route, providerId, model, pick.modality, bytes, pick.ref.name, signal);
			cache[key] = { text, model: `${providerId}::${model}`, name: pick.ref.name, at: new Date().toISOString() };
			return { text, model: `${providerId}::${model}`, name: pick.ref.name, label: MODALITY_LABEL[pick.modality], cached: false };
		} catch (error) {
			lastError = error;
			ctx.logger?.warn?.(`${PLUGIN}: ${pick.modality} understanding via ${providerId}::${model} failed: ${String(error?.message ?? error)}`);
		}
	}
	throw lastError ?? new Error("understanding failed");
}

/* ── 端点 ───────────────────────────────────────────────────────────── */

function sendJson(res, status, payload) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	const raw = Buffer.concat(chunks).toString("utf8");
	return raw ? JSON.parse(raw) : {};
}

/* ── 插件体 ─────────────────────────────────────────────────────────── */

export const inject = ["settings"];

export function apply(ctx) {
	const scope = ctx.settings.register(SETTINGS_NS, settingsSchema);
	const readConfig = () => normalizeConfig(scope.get());
	const stats = { cacheEntries: 0, lastError: null, lastRunAt: null };

	/* 本步消息里若有媒体块，先转述再让本轮继续。 */
	ctx.on("agent/pre-step", async (payload, next) => {
		const decision = await next();
		if (decision.kind === "reject") return decision;
		const cfg = readConfig();
		if (!cfg.enabled) return decision;
		const picks = pickMediaBlocks(decision.messages ?? []);
		if (picks.length === 0) return decision;

		const cache = loadCache();
		const replacements = /* @__PURE__ */ new Map();
		for (const pick of picks) {
			try {
				const understood = await understand(ctx, cfg, pick, payload?.signal, cache);
				replacements.set(`${pick.messageIndex}:${pick.blockIndex}`, understood);
				ctx.logger?.info?.(
					`${PLUGIN}: ${pick.modality} "${pick.ref.name}" -> ${understood.text.length} chars via ${understood.model}${understood.cached ? " (cache)" : ""}`
				);
			} catch (error) {
				stats.lastError = String(error?.message ?? error);
				stats.lastRunAt = new Date().toISOString();
				ctx.logger?.warn?.(`${PLUGIN}: kept file block for "${pick.ref.name}": ${stats.lastError}`);
			}
		}
		saveCache(cache);
		stats.cacheEntries = Object.keys(cache).length;
		if (replacements.size === 0) return decision;
		return { ...decision, messages: applyUnderstandings(decision.messages, replacements) };
	}, { prepend: true });

	/* 配置与状态端点（设置页读写）。 */
	ctx.inject(["webServer"], (injected) => {
		injected.webServer.register({
			kind: "prefix",
			path: "/dsh-media-understanding",
			handler: async (req, res) => {
				const url = new URL(req.url, "http://localhost");
				const action = url.pathname.split("/").filter(Boolean).pop() || "";
				if (action === "status") {
					sendJson(res, 200, { ok: true, ...stats });
					return;
				}
				if (action !== "config") {
					sendJson(res, 404, { ok: false, reason: "not-found" });
					return;
				}
				if (req.method === "GET") {
					sendJson(res, 200, { ok: true, ...readConfig() });
					return;
				}
				if (req.method !== "POST") {
					sendJson(res, 405, { ok: false, reason: "method" });
					return;
				}
				try {
					/* 用 replace 而不是 update：settings 的 update 会把普通对象
					   递归合并，providers 字典里删掉/改名的条目会一直残留。
					   replace 是整体替换，发什么就是什么。 */
					await scope.replace(normalizeConfig({ ...readConfig(), ...(await readJsonBody(req)) }));
					sendJson(res, 200, { ok: true, ...readConfig() });
				} catch (error) {
					sendJson(res, 400, { ok: false, reason: String(error?.message ?? error) });
				}
			}
		});
	});
}
