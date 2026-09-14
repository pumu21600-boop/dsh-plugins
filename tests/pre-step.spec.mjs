/**
 * dsh-media-understanding 宿主半区测试（无需真实多模态端点）。
 *
 * 用本地 mock 的 OpenAI 兼容端点走完整链路：
 *   apply(fakeCtx) → 捕获 agent/pre-step 钩子 → 喂含 file 块的 user 消息
 *   → 插件读盘、发 HTTP、改写消息 → 断言内容与请求形状
 *
 * 运行：node tests/pre-step.spec.mjs
 */
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

/* 先隔离 DSH_HOME，避免污染真实缓存 */
const HOME = mkdtempSync(join(tmpdir(), "media-test-"));
process.env.DSH_HOME = HOME;
mkdirSync(join(HOME, "storages"), { recursive: true });

const mod = await import("../lib/index.js");

/* ── 测试用媒体文件 ─────────────────────────────────────────────────── */
const mediaDir = mkdtempSync(join(tmpdir(), "media-files-"));
const files = {
	"clip.mp4": Buffer.from("fake-mp4-bytes-0123456789"),
	"voice.mp3": Buffer.from("fake-mp3-bytes-abcdefghij"),
	"shot.png": Buffer.from("fake-png-bytes-ZZZZZZZZZZ")
};
for (const [name, bytes] of Object.entries(files)) writeFileSync(join(mediaDir, name), bytes);

/* ── mock 端点 ──────────────────────────────────────────────────────── */
const seen = [];
const server = createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		const parsed = JSON.parse(body || "{}");
		const content = parsed.messages?.[0]?.content ?? [];
		const mediaPart = content.find((p) => p.type !== "text");
		seen.push({
			url: req.url,
			auth: req.headers.authorization,
			model: parsed.model,
			partTypes: content.map((p) => p.type),
			mediaPartKind: mediaPart?.type ?? null,
			mediaUrlPrefix: String(mediaPart?.image_url?.url ?? mediaPart?.video_url?.url ?? "").slice(0, 30),
			audioFormat: mediaPart?.input_audio?.format ?? null,
			audioHasData: typeof mediaPart?.input_audio?.data === "string" && mediaPart.input_audio.data.length > 0
		});
		if (req.url === "/v1/fail/chat/completions") {
			res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "boom" }));
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: `[描述] ${parsed.model}` } }] }));
	});
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/v1`;

/* ── fake ctx ───────────────────────────────────────────────────────── */
const logs = { warn: [], info: [] };
let hook = null;
let config = mod.normalizeConfig({
	providers: {
		main: { baseURL: base, apiKey: "test-key" },
		backup: { baseURL: base, apiKey: "backup-key" }
	},
	video: { provider: "main", model: "video-model", backupProvider: "backup", backupModel: "video-backup" },
	audio: { provider: "main", model: "audio-model" },
	image: { provider: "main", model: "image-model" },
	maxOutputBytes: void 0
});

const fakeCtx = {
	settings: {
		register: () => ({
			get: () => config,
			update: async () => {
				throw new Error("插件不该用 update：settings 的 update 会递归合并，providers 里删掉的条目会残留");
			},
			replace: async (section) => {
				config = mod.normalizeConfig(section);
			}
		})
	},
	on: (event, handler, options) => {
		if (event === "agent/pre-step") hook = { handler, options };
	},
	inject: (names, cb) => {
		const list = Array.isArray(names) ? names : [names];
		if (list.includes("webServer")) webServerCb = cb;
	},
	get: (name) => {
		if (name === "attachments") {
			return { fileHostPath: (ref) => ref.__path };
		}
		return void 0;
	},
	logger: {
		info: (...a) => logs.info.push(a.join(" ")),
		warn: (...a) => logs.warn.push(a.join(" ")),
		error: (...a) => logs.warn.push(a.join(" "))
	}
};
let webServerCb = null;

mod.apply(fakeCtx);
assert.ok(hook !== null, "apply() 应注册 agent/pre-step 钩子");
assert.equal(hook.options?.prepend, true, "钩子应以 prepend 注册，才能看到本步最终消息");

/* ── 构造含媒体块的 user 消息 ───────────────────────────────────────── */
const userMessage = (name, extraText) => ({
	id: `msg-${name}`,
	role: "user",
	content: [
		{ type: "text", text: extraText },
		{ type: "file", attachment: { attachmentId: `att-${name}`, name, bytes: files[name].length, __path: join(mediaDir, name) } }
	],
	source: { kind: "user" }
});

const runHook = async (messages) => {
	const decision = await hook.handler({ signal: void 0 }, async () => ({ kind: "enter", messages }));
	return decision;
};

/* 1) 视频：走 video_url，主路由成功 */
{
	const decision = await runHook([userMessage("clip.mp4", "看看这个")]);
	const block = decision.messages[0].content[1];
	assert.equal(block.type, "text", "视频块应被替换成文本");
	assert.match(block.text, /描述/, "文本应包含理解结果");
	assert.match(block.text, /clip\.mp4/, "文本应标注来源附件名");
	assert.deepEqual(seen.at(-1).partTypes, ["text", "video_url"]);
	assert.match(seen.at(-1).mediaUrlPrefix, /^data:video\/mp4;base64,/, "视频应以 data URL 发送");
	assert.equal(seen.at(-1).auth, "Bearer test-key");
	assert.equal(seen.at(-1).model, "video-model");
	console.log("✓ 视频走 video_url 并被替换");
}

/* 2) 音频：走 input_audio，format 取扩展名 */
{
	const decision = await runHook([userMessage("voice.mp3", "")]);
	assert.equal(decision.messages[0].content[1].type, "text");
	const last = seen.at(-1);
	assert.deepEqual(last.partTypes, ["text", "input_audio"]);
	assert.equal(last.audioFormat, "mp3");
	assert.ok(last.audioHasData);
	console.log("✓ 音频走 input_audio");
}

/* 3) 图片：走 image_url */
{
	const decision = await runHook([userMessage("shot.png", "")]);
	assert.equal(decision.messages[0].content[1].type, "text");
	assert.deepEqual(seen.at(-1).partTypes, ["text", "image_url"]);
	assert.match(seen.at(-1).mediaUrlPrefix, /^data:image\/png;base64,/);
	console.log("✓ 图片走 image_url");
}

/* 4) 缓存：同一附件再跑不应再发请求 */
{
	const before = seen.length;
	await runHook([userMessage("clip.mp4", "再看一次")]);
	assert.equal(seen.length, before, "缓存命中时不应重复请求");
	const cache = JSON.parse(readFileSync(join(HOME, "storages", "media-understanding", "cache.json"), "utf8"));
	assert.ok(Object.keys(cache).length >= 3, "缓存应记录三种模态");
	console.log("✓ 缓存命中，未重复请求");
}

/* 5) 非媒体扩展名：原样保留，不发请求 */
{
	const before = seen.length;
	const decision = await runHook([{
		id: "m2", role: "user",
		content: [{ type: "file", attachment: { attachmentId: "att-doc", name: "notes.pdf", bytes: 10, __path: join(mediaDir, "clip.mp4") } }],
		source: { kind: "user" }
	}]);
	assert.equal(seen.length, before, "不认识的后缀不应触发理解");
	assert.equal(decision.messages[0].content[0].type, "file", "非媒体块应原样保留");
	console.log("✓ 非媒体文件不处理");
}

/* 6) 主路由失败 → 自动切备份 */
{
	config = mod.normalizeConfig({
		providers: {
			main: { baseURL: `${base}/fail`, apiKey: "test-key" },
			backup: { baseURL: base, apiKey: "backup-key" }
		},
		image: { provider: "main", model: "bad", backupProvider: "backup", backupModel: "good" }
	});
	const decision = await runHook([{
		id: "m3", role: "user",
		content: [{ type: "file", attachment: { attachmentId: "att-2", name: "other.png", bytes: 5, __path: join(mediaDir, "shot.png") } }],
		source: { kind: "user" }
	}]);
	assert.equal(decision.messages[0].content[0].type, "text", "备份成功也应替换");
	assert.equal(seen.at(-1).model, "good", "应使用备份模型");
	assert.match(seen.at(-1).url, /^\/v1\/chat\/completions$/);
	assert.ok(logs.warn.some((l) => l.includes("failed")), "主路由失败应留下 warning");
	console.log("✓ 主路由失败自动切备份");
}

/* 7) 全部路由失败 → 保留原块，不打断本轮 */
{
	config = mod.normalizeConfig({ providers: { main: { baseURL: `${base}/fail`, apiKey: "k" } }, video: { provider: "main", model: "bad" } });
	const decision = await runHook([{
		id: "m4", role: "user",
		content: [{ type: "file", attachment: { attachmentId: "att-3", name: "broken.mp4", bytes: 5, __path: join(mediaDir, "clip.mp4") } }],
		source: { kind: "user" }
	}]);
	assert.equal(decision.kind, "enter");
	assert.equal(decision.messages[0].content[0].type, "file", "失败时应保留 file 块");
	assert.ok(logs.warn.some((l) => l.includes("kept file block")));
	console.log("✓ 全失败时保留原块且不打断");
}

/* 8) maxBytes 超限 → 不发送 */
{
	config = mod.normalizeConfig({ maxBytes: 4, providers: { main: { baseURL: base, apiKey: "k" } }, video: { provider: "main", model: "m" } });
	const before = seen.length;
	const decision = await runHook([{
		id: "m5", role: "user",
		content: [{ type: "file", attachment: { attachmentId: "att-4", name: "big.mp4", bytes: 999, __path: join(mediaDir, "clip.mp4") } }],
		source: { kind: "user" }
	}]);
	assert.equal(seen.length, before, "超限不应发请求");
	assert.equal(decision.messages[0].content[0].type, "file");
	console.log("✓ 超过 maxBytes 时跳过");
}

/* 9) enabled=false → 完全不介入 */
{
	config = mod.normalizeConfig({ enabled: false });
	const decision = await runHook([userMessage("shot.png", "")]);
	assert.equal(decision.messages[0].content[1].type, "file");
	console.log("✓ 关闭开关后不介入");
}

/* 10) 助手消息里的文件块不处理（只动 user） */
{
	assert.deepEqual(mod.pickMediaBlocks([{ role: "assistant", content: [{ type: "file", attachment: { name: "a.mp4" } }] }]), []);
	console.log("✓ 只处理 user 消息");
}

/* 11) 端点：POST /config 必须走 replace（整体替换），GET /config、/status 可用 */
{
	assert.ok(webServerCb !== null, "apply() 应注册 webServer 路由");
	let route = null;
	webServerCb({ webServer: { register: (spec) => { route = spec; } } });
	assert.ok(route !== null && route.kind === "prefix" && route.path === "/dsh-media-understanding");

	const call = async (method, path, body) => {
		const chunks = body === void 0 ? [] : [Buffer.from(JSON.stringify(body))];
		const req = {
			method,
			url: path,
			async *[Symbol.asyncIterator]() {
				for (const c of chunks) yield c;
			}
		};
		let out = "";
		const res = {
			writeHead: () => {},
			end: (s) => {
				out += s;
			}
		};
		await route.handler(req, res);
		return JSON.parse(out);
	};

	const before = await call("GET", "/dsh-media-understanding/config");
	assert.equal(before.ok, true);
	assert.equal(typeof before.video.prompt, "string");

	const posted = await call("POST", "/dsh-media-understanding/config", {
		providers: { only: { baseURL: "http://x/v1", apiKeyEnv: "ONLY_KEY" } }
	});
	assert.deepEqual(Object.keys(posted.providers), ["only"], "POST 应整体替换 providers，残留键必须消失");

	const status = await call("GET", "/dsh-media-understanding/status");
	assert.equal(status.ok, true);
	assert.equal(typeof status.cacheEntries, "number");

	assert.equal((await call("GET", "/dsh-media-understanding/nope")).ok, false, "未知路径应 404");
	console.log("✓ 端点：replace 语义 + config/status");
}

server.close();
console.log("\n全部通过（11 项）· mock 请求数:", seen.length);
