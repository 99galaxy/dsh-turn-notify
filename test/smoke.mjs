/**
 * Smoke test for the real client bundle.
 *
 * Loads `lib/client.js` inside a VM with fake `window`, `Notification` and
 * `document`, then drives `uiSession.sessionStatus` the way the host page does
 * and asserts which turns raise a toast.
 */
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as hostEntry from "../lib/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

let failures = 0;
let checks = 0;
function assert(condition, label) {
	checks += 1;
	if (condition) {
		console.log("  PASS " + label);
		return;
	}
	failures += 1;
	console.log("  FAIL " + label);
}

/** Build one isolated runtime: bundle, fake page, fake uiSession. */
function createRuntime(options = {}) {
	const shown = [];
	const notificationInstances = [];
	const warnings = [];
	const infos = [];
	const debugMessages = [];
	/** Every interval the bundle registered, so a test can drive the poll. */
	const intervals = new Set();
	const microtasks = [];

	class FakeNotification {
		static permission = options.permission ?? "granted";
		static requestPermission() {
			FakeNotification.permission = "granted";
			return Promise.resolve("granted");
		}
		constructor(title, opts) {
			this.title = title;
			this.opts = opts ?? {};
			shown.push({ title, ...this.opts });
			notificationInstances.push(this);
		}
	}

	const document = {
		visibilityState: options.hidden === true ? "hidden" : "visible",
		hasFocus: () => options.focused !== false,
	};

	let moduleExports;
	const window = {
		// The bundle turns diagnostics on by default; tests opt in explicitly.
		__dshTurnNotifyDiagnostic: options.diagnostic === true,
		__ModuleLoader__: {
			load(definition) {
				moduleExports = definition.factory(() => {
					throw new Error("turn-notify declares no externals");
				});
				moduleExports.id = definition.id;
			},
		},
		focus() {
			document.focusedByPlugin = true;
		},
	};

	const globals = {
		window,
		document,
		Notification: options.notification === false ? undefined : FakeNotification,
		setInterval: (callback, ms) => {
			const handle = { callback, ms };
			intervals.add(handle);
			return handle;
		},
		clearInterval: (handle) => {
			intervals.delete(handle);
		},
		console: {
			log: () => {},
			info: (...args) => infos.push(args.map(String).join(" ")),
			debug: (...args) => debugMessages.push(args.map(String).join(" ")),
			warn: (...args) => warnings.push(args.map(String).join(" ")),
			error: (...args) => warnings.push(args.map(String).join(" ")),
		},
	};
	if (options.fetch) globals.fetch = options.fetch;
	if (options.queueMicrotasks) globals.queueMicrotask = (callback) => microtasks.push(callback);
	if (options.now) {
		globals.Date = class extends Date {
			static now() {
				return options.now();
			}
		};
	}
	const context = createContext(globals);
	runInContext(source, context);

	if (moduleExports === undefined) throw new Error("bundle did not register with the module loader");

	// ---- fake uiSession -------------------------------------------------
	let status = new Map();
	const listeners = new Set();
	let rows = options.rows ?? {};
	const listListeners = new Set();
	const byId = () =>
		Object.fromEntries(
			Object.entries(rows).map(([id, row]) => [id, { retainedBy: { mainView: 0 }, ...row }]),
		);
	const uiSession = {
		sessionStatus: {
			getSnapshot: () => status,
			subscribe: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
		sessions: {
			list: {
				getSnapshot: () => ({ byId: byId() }),
				subscribe: (listener) => {
					listListeners.add(listener);
					return () => listListeners.delete(listener);
				},
			},
		},
	};

	let teardown;
	const ctx = {
		uiSession,
		effect(factory) {
			teardown = factory();
			return teardown;
		},
	};

	const api = {
		moduleExports,
		ctx,
		shown,
		notificationInstances,
		warnings,
		infos,
		debugMessages,
		document,
		/** Turn-completion toasts only, without the diagnostic stream. */
		real: () => shown.filter((toast) => toast.tag !== "dsh-turn-notify-dump"),
		/** Publish a new status map and notify subscribers like the host store. */
		setStatus(next) {
			status = new Map(Object.entries(next));
			for (const listener of listeners) listener();
		},
		/** Replace the Session list rows and notify list subscribers. */
		setRows(next) {
			rows = next;
			for (const listener of listListeners) listener();
		},
		/** Replace the Session list rows without telling any subscriber. */
		setRowsSilently(next) {
			rows = next;
		},
		/** Run every registered poll callback once. */
		firePoll() {
			for (const handle of intervals) handle.callback();
		},
		intervalCount: () => intervals.size,
		microtaskCount: () => microtasks.length,
		flushMicrotasks() {
			while (microtasks.length > 0) microtasks.shift()();
		},
		dispose() {
			if (typeof teardown === "function") teardown();
			teardown = undefined;
		},
		listenerCount: () => listeners.size,
	};
	return api;
}

console.log("bundle registration");
{
	const runtime = createRuntime();
	assert(runtime.moduleExports.id === "@99galaxy/dsh-turn-notify", "module id is the package name");
	assert(typeof runtime.moduleExports.apply === "function", "exports apply");
	assert(
		Array.isArray(runtime.moduleExports.inject) && runtime.moduleExports.inject.includes("uiSession"),
		"injects the uiSession client service",
	);
	assert(runtime.moduleExports.buildMarker === undefined, "no stray runtime fields");
}

console.log("missing module loader");
{
	const warnings = [];
	runInContext(
		source,
		createContext({
			console: {
				warn: (...args) => warnings.push(args.map(String).join(" ")),
			},
		}),
	);
	assert(warnings.some((line) => line.includes("module loader unavailable")), "missing loader degrades safely");
}

console.log("config normalization");
{
	const runtime = createRuntime();
	const { normalizeConfig } = runtime.moduleExports;
	const defaults = normalizeConfig(undefined);
	assert(defaults.enabled === true && defaults.notifyWhenFocused === true, "defaults notify on every turn");
	const typed = normalizeConfig({ enabled: "yes", notifyWhenFocused: true, message: "好了" });
	assert(typed.enabled === true, "wrong-typed flag falls back to the default");
	assert(normalizeConfig({ notifyWhenFocused: false }).notifyWhenFocused === false, "the quiet rule can be opted into");
	assert(typed.message === "好了", "custom message is accepted");
	assert(normalizeConfig({ maskTitle: true }).maskTitle === true, "title masking can be opted into");
}

console.log("background session finished");
{
	const runtime = createRuntime({
		focused: false,
		rows: { "session-a": { title: "重构登录模块" } },
	});
	runtime.moduleExports.apply(runtime.ctx, {});
	// seed: turn starts
	runtime.setStatus({ "session-a": { running: true } });
	assert(runtime.real().length === 0, "starting a turn says nothing");
	// turn ends
	runtime.setStatus({ "session-a": { running: false } });
	assert(runtime.real().length === 1, "finishing a turn raises exactly one toast");
	assert(runtime.real()[0].title === "重构登录模块", "toast title is the session title");
	assert(String(runtime.real()[0].body).startsWith("本轮已完成"), "toast body uses the configured message");
	assert(String(runtime.real()[0].tag).startsWith("dshturn-"), "toast tag is per session");
	// a further publish with no change must not repeat
	runtime.setStatus({ "session-a": { running: false, pendingInteraction: { kind: "question" } } });
	assert(runtime.real().length === 1, "unrelated status churn does not repeat the toast");
	runtime.dispose();
}

console.log("duration reaches the toast");
{
	let now = 1000;
	const runtime = createRuntime({
		focused: false,
		now: () => now,
		rows: { "session-a": { title: "耗时会话" } },
	});
	runtime.moduleExports.apply(runtime.ctx, {});
	runtime.setStatus({ "session-a": { running: true } });
	now += 133000;
	runtime.setStatus({ "session-a": { running: false } });
	assert(
		runtime.real()[0].body === "本轮已完成 · 2m 13s",
		"the elapsed time is captured before turn state is cleared",
	);
	runtime.dispose();
}

console.log("short duration and empty message");
{
	let now = 1000;
	const runtime = createRuntime({
		focused: false,
		now: () => now,
		rows: { "session-a": { title: "短任务" } },
	});
	runtime.moduleExports.apply(runtime.ctx, { message: "  " });
	runtime.setStatus({ "session-a": { running: true } });
	now += 250;
	runtime.setStatus({ "session-a": { running: false } });
	assert(runtime.real()[0].body === "< 1s", "sub-second turns use a readable duration");
	runtime.setStatus({ "session-a": { running: true } });
	now += 12000;
	runtime.setStatus({ "session-a": { running: false } });
	assert(runtime.real()[1].body === "12s", "an empty message does not leave a separator prefix");
	runtime.dispose();
}

console.log("privacy title mask");
{
	const runtime = createRuntime({ focused: false, rows: { "session-a": { title: "客户机密计划" } } });
	runtime.moduleExports.apply(runtime.ctx, { maskTitle: true });
	runtime.setStatus({ "session-a": { running: true } });
	runtime.setStatus({ "session-a": { running: false } });
	assert(runtime.real()[0].title === "会话已完成", "maskTitle removes the session title");
	runtime.dispose();
}

console.log("notification lifecycle");
{
	const runtime = createRuntime({ focused: false, rows: { "session-a": { title: "生命周期" } } });
	runtime.moduleExports.apply(runtime.ctx, {});
	runtime.setStatus({ "session-a": { running: true } });
	runtime.setStatus({ "session-a": { running: false } });
	const notification = runtime.notificationInstances[0];
	notification.onclose();
	assert(
		notification.onclick === null &&
			notification.onshow === null &&
			notification.onerror === null &&
			notification.onclose === null,
		"notification close releases event handler closures",
	);
	runtime.dispose();
}

console.log("notification tags");
{
	const prefix = "session_20261102_";
	const runtime = createRuntime({
		focused: false,
		rows: {
			[prefix + "001"]: { title: "第一个" },
			[prefix + "002"]: { title: "第二个" },
		},
	});
	runtime.moduleExports.apply(runtime.ctx, {});
	runtime.setStatus({
		[prefix + "001"]: { running: true },
		[prefix + "002"]: { running: true },
	});
	runtime.setStatus({
		[prefix + "001"]: { running: false },
		[prefix + "002"]: { running: false },
	});
	assert(runtime.real().length === 2, "simultaneously completed sessions both notify");
	assert(runtime.real()[0].tag !== runtime.real()[1].tag, "full session ids prevent tag collisions");
	runtime.dispose();
}

console.log("status event batching");
{
	const runtime = createRuntime({
		focused: false,
		queueMicrotasks: true,
		rows: { "session-a": { title: "批量事件" } },
	});
	runtime.moduleExports.apply(runtime.ctx, {});
	runtime.setStatus({ "session-a": { running: true } });
	runtime.setStatus({ "session-a": { running: false, completionUnread: true } });
	assert(runtime.microtaskCount() === 1, "a burst of status events schedules one tick");
	runtime.flushMicrotasks();
	assert(runtime.real().length === 1, "the batched tick preserves completion fallback");
	runtime.dispose();
}

console.log("unknown running state");
{
	let now = 1000;
	const runtime = createRuntime({
		focused: false,
		now: () => now,
		rows: { "session-a": { title: "状态未知" } },
	});
	runtime.moduleExports.apply(runtime.ctx, {});
	runtime.setStatus({ "session-a": { running: true } });
	now += 5000;
	runtime.setStatus({ "session-a": { running: undefined, pendingInteraction: { kind: "question" } } });
	assert(runtime.real().length === 0, "an unknown running state never counts as completion");
	now += 128000;
	runtime.setStatus({ "session-a": { running: false } });
	assert(runtime.real().length === 1, "an explicit false still reports completion");
	assert(runtime.real()[0].body.endsWith("2m 13s"), "an unknown state preserves the turn start time");
	runtime.dispose();
}

console.log("short turn completion fallback");
{
	const runtime = createRuntime({ focused: false, rows: { "session-a": { title: "极短回合" } } });
	runtime.moduleExports.apply(runtime.ctx, {});
	runtime.setStatus({ "session-a": { running: false, completionUnread: true } });
	assert(runtime.real().length === 1, "completionUnread catches a turn unseen by the poll");
	runtime.setStatus({ "session-a": { running: false, completionUnread: true } });
	assert(runtime.real().length === 1, "a sticky completionUnread does not repeat the toast");
	runtime.setStatus({ "session-a": { running: true, completionUnread: false } });
	runtime.setStatus({ "session-a": { running: false, completionUnread: true } });
	assert(runtime.real().length === 2, "a later turn can report the same session again");
	runtime.setStatus({ "session-a": { running: true, completionUnread: false } });
	runtime.setStatus({ "session-a": { running: undefined, completionUnread: true } });
	runtime.setStatus({ "session-a": { running: false, completionUnread: true } });
	assert(
		runtime.real().length === 3,
		"unknown completion followed by false still raises only one toast",
	);
	runtime.dispose();
}

console.log("remote client config");
{
	let requested = "";
	const runtime = createRuntime({
		focused: false,
		fetch: async (url) => {
			requested = String(url);
			return {
				ok: true,
				json: async () => ({
					ok: true,
					config: {
						enabled: true,
						notifyWhenFocused: true,
						skipSubagents: true,
						message: "宿主配置",
						debugProbe: false,
						debugDump: false,
					},
				}),
			};
		},
		rows: { "session-a": { title: "远端配置" } },
	});
	runtime.moduleExports.apply(runtime.ctx, {});
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert(requested === "/dsh-turn-notify/config", "the browser reads the host config route");
	runtime.setStatus({ "session-a": { running: true } });
	runtime.setStatus({ "session-a": { running: false } });
	assert(runtime.real()[0].body === "宿主配置", "host config reaches the browser plugin");
	runtime.dispose();
}

console.log("remote config failure");
{
	const runtime = createRuntime({
		fetch: async () => {
			throw new Error("offline");
		},
	});
	runtime.moduleExports.apply(runtime.ctx, {});
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert(runtime.listenerCount() === 1, "a failed remote config still starts the watcher");
	assert(runtime.infos.some((line) => line.includes("remote config unavailable")), "fetch failure falls back safely");
	runtime.dispose();
}

console.log("host config route");
{
	let route;
	let cleanup;
	let disposed = false;
	hostEntry.apply(
		{
			inject(deps, callback) {
				assert(deps.includes("webServer"), "the host waits for webServer");
				callback({
					webServer: {
						register(definition) {
							route = definition;
							return () => {
								disposed = true;
							};
						},
					},
					effect(factory) {
						cleanup = factory();
					},
				});
			},
		},
		{
			diagnostics: false,
			message: "来自宿主",
			notifyWhenFocused: false,
			skipSubagents: false,
			maskTitle: true,
		},
	);
	let status = 0;
	let body = "";
	const response = {
		writeHead(code) {
			status = code;
		},
		end(value = "") {
			body = String(value);
		},
	};
	route.handler({ method: "GET" }, response);
	const payload = JSON.parse(body);
	assert(route.path === "/dsh-turn-notify/config", "the config route uses the package namespace");
	assert(status === 200 && payload.ok === true, "the config route returns JSON");
	assert(payload.config.message === "来自宿主", "the host returns configured client values");
	assert(payload.config.notifyWhenFocused === false, "boolean options preserve their declared type");
	assert(payload.config.maskTitle === true, "the host forwards title masking");
	route.handler({ method: "POST" }, response);
	assert(status === 405, "the config route is read-only");
	let threw = false;
	try {
		route.handler(
			{ method: "GET" },
			{
				headersSent: false,
				writeHead() {},
				end() {
					throw new Error("closed");
				},
			},
		);
	} catch (_error) {
		threw = true;
	}
	assert(threw === false, "closed response streams do not escape the host handler");
	cleanup();
	assert(disposed === true, "the route is disposed with the plugin effect");
}

console.log("remote disable");
{
	const runtime = createRuntime({
		fetch: async () => ({
			ok: true,
			json: async () => ({
				ok: true,
				config: {
					enabled: false,
					notifyWhenFocused: true,
					skipSubagents: true,
					message: "不应出现",
					debugProbe: false,
					debugDump: false,
				},
			}),
		}),
	});
	runtime.moduleExports.apply(runtime.ctx, {});
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert(runtime.listenerCount() === 0, "a remote disabled config prevents subscriptions");
	assert(runtime.intervalCount() === 0, "a remote disabled config prevents polling");
}

console.log("quiet rule, when enabled")
{
	const runtime = createRuntime({
		focused: true,
		rows: { "session-a": { title: "当前会话", retainedBy: { mainView: 1 } } },
	});
	runtime.moduleExports.apply(runtime.ctx, { notifyWhenFocused: false });
	runtime.setStatus({ "session-a": { running: true } });
	runtime.setStatus({ "session-a": { running: false } });
	assert(runtime.real().length === 0, "a watched session finishing does not interrupt");
	runtime.dispose();
}

console.log("watched session, window in the background");
{
	const runtime = createRuntime({
		focused: false,
		rows: { "session-a": { title: "当前会话", retainedBy: { mainView: 1 } } },
	});
	runtime.moduleExports.apply(runtime.ctx, {});
	runtime.setStatus({ "session-a": { running: true } });
	runtime.setStatus({ "session-a": { running: false } });
	assert(runtime.real().length === 1, "an unfocused window still gets the toast");
	runtime.dispose();
}

console.log("notifyWhenFocused opt-in");
{
	const runtime = createRuntime({
		focused: true,
		rows: { "session-a": { title: "当前会话", retainedBy: { mainView: 1 } } },
	});
	runtime.moduleExports.apply(runtime.ctx, { notifyWhenFocused: true });
	runtime.setStatus({ "session-a": { running: true } });
	runtime.setStatus({ "session-a": { running: false } });
	assert(runtime.real().length === 1, "opt-in notifies even while you watch");
	runtime.dispose();
}

console.log("subagents stay quiet");
{
	const runtime = createRuntime({
		focused: false,
		rows: { "session-child": { title: "子代理", subagent: { mode: "continuable" } } },
	});
	runtime.moduleExports.apply(runtime.ctx, {});
	runtime.setStatus({ "session-child": { running: true } });
	runtime.setStatus({ "session-child": { running: false } });
	assert(runtime.real().length === 0, "a subagent turn does not raise its own toast");
	runtime.dispose();
}

console.log("hidden subagent status");
{
	const runtime = createRuntime({ focused: false, rows: {} });
	runtime.moduleExports.apply(runtime.ctx, {});
	runtime.setStatus({ "hidden-child": { running: true, subagent: { mode: "continuable" } } });
	runtime.setStatus({ "hidden-child": { running: false, subagent: { mode: "continuable" } } });
	assert(runtime.real().length === 0, "status-only subagent metadata still suppresses the toast");
	runtime.dispose();
}

console.log("seeding and teardown");
{
	const runtime = createRuntime({ focused: false, rows: { "session-a": { title: "旧会话" } } });
	// a session already idle when the plugin mounts must not fire
	runtime.moduleExports.apply(runtime.ctx, {});
	runtime.setStatus({ "session-a": { running: false } });
	assert(runtime.real().length === 0, "pre-existing idle sessions never fire");
	assert(runtime.listenerCount() === 1, "subscribes exactly once");
	assert(runtime.warnings.length === 0, "no warnings on the happy path");
	runtime.dispose();
	assert(runtime.listenerCount() === 0, "teardown unsubscribes");
}

console.log("debug probe");
{
	const runtime = createRuntime({ focused: true, rows: {} });
	runtime.moduleExports.apply(runtime.ctx, { debugProbe: true });
	assert(runtime.real().length === 1, "debugProbe raises exactly one startup toast");
	assert(runtime.real()[0].tag === "dsh-turn-notify-probe", "the probe uses its own tag");
	assert(runtime.infos.some((line) => line.includes("turn-notify: active")), "the probe logs its state");
	runtime.dispose();
}

console.log("config from the context when apply receives none");
{
	const runtime = createRuntime({ focused: false, rows: { "session-a": { title: "ctx 配置" } } });
	runtime.ctx.config = { message: "搞定了" };
	runtime.moduleExports.apply(runtime.ctx);
	assert(
		!runtime.real().some((toast) => toast.tag === "dsh-turn-notify-probe"),
		"a missing apply argument alone must not raise the probe",
	);
	runtime.setStatus({ "session-a": { running: true } });
	runtime.setStatus({ "session-a": { running: false } });
	assert(runtime.real().length === 1, "still notifies when no config argument is passed");
	assert(String(runtime.real()[0].body).startsWith("搞定了"), "ctx.config supplies the message");
}

console.log("debug dump");
{
	const runtime = createRuntime({ focused: true, diagnostic: true, rows: { "session-a": { title: "被看着" } } });
	runtime.moduleExports.apply(runtime.ctx, { debugDump: true });
	const dump = runtime.shown.find((toast) => toast.tag === "dsh-turn-notify-dump");
	assert(dump !== undefined, "the first tick publishes a diagnostic toast");
	assert(String(dump.body).includes("ticks=1"), "the diagnostic body carries counters");
	runtime.setStatus({ "session-a": { running: true } });
	runtime.setStatus({ "session-a": { running: false } });
	assert(
		runtime.real().some((toast) => String(toast.tag).startsWith("dshturn-")),
		"debugDump bypasses the quiet rule",
	);
	assert(
		runtime.shown.filter((toast) => toast.tag === "dsh-turn-notify-dump").length === 1,
		"debugDump emits only one diagnostic OS toast",
	);
	assert(runtime.debugMessages.some((line) => line.includes("turn-notify dump")), "later diagnostics use the console");
	runtime.dispose();
}

console.log("list-only running source");
{
	const runtime = createRuntime({ focused: false, rows: { "session-a": { title: "只有列表" } } });
	runtime.moduleExports.apply(runtime.ctx, {});
	runtime.setRows({ "session-a": { title: "只有列表", running: true } });
	runtime.setRows({ "session-a": { title: "只有列表", running: false } });
	assert(
		runtime.real().length === 1 && runtime.real()[0].title === "只有列表",
		"running reported only by the list rows still notifies",
	);
}

console.log("poll catches a turn no store announced");
{
	const runtime = createRuntime({ focused: false, rows: { "session-a": { title: "静默轮询" } } });
	runtime.moduleExports.apply(runtime.ctx, {});
	assert(runtime.intervalCount() === 1, "a safety poll is registered");
	runtime.setRowsSilently({ "session-a": { title: "静默轮询", running: true } });
	runtime.firePoll();
	runtime.setRowsSilently({ "session-a": { title: "静默轮询", running: false } });
	runtime.firePoll();
	assert(
		runtime.real().length === 1 && runtime.real()[0].title === "静默轮询",
		"the poll alone detects the turn boundary",
	);
	runtime.dispose();
	assert(runtime.intervalCount() === 0, "teardown clears the poll");
}

console.log("subscription does not depend on ctx.effect");
{
	const runtime = createRuntime({ focused: false, rows: { "session-a": { title: "不靠 effect" } } });
	const inertCtx = {
		uiSession: runtime.ctx.uiSession,
		// A kernel that collects the factory without running it yet.
		effect() {
			return () => {};
		},
	};
	runtime.moduleExports.apply(inertCtx, {});
	assert(runtime.listenerCount() === 1, "subscribes even when ctx.effect never runs the factory");
	runtime.setStatus({ "session-a": { running: true } });
	runtime.setStatus({ "session-a": { running: false } });
	assert(
		runtime.real().length === 1 && runtime.real()[0].title === "不靠 effect",
		"the watcher still works on such a kernel",
	);
}

console.log("disabled plugin does nothing");
{
	const runtime = createRuntime({ focused: false, rows: { "session-a": { title: "x" } } });
	runtime.moduleExports.apply(runtime.ctx, { enabled: false });
	assert(runtime.listenerCount() === 0 && typeof runtime.moduleExports.apply === "function", "disabled skips the subscription");
}

console.log("missing Notification API is reported, not thrown");
{
	const runtime = createRuntime({ focused: false, notification: false, rows: { "session-a": { title: "x" } } });
	let threw = false;
	try {
		runtime.moduleExports.apply(runtime.ctx, {});
	} catch (_error) {
		threw = true;
	}
	assert(threw === false, "apply returns instead of throwing");
	assert(runtime.listenerCount() === 0, "no subscription without the API");
	assert(
		runtime.warnings.some((line) => line.includes("no Notification API")),
		"the reason is logged once",
	);
}

console.log("denied Notification permission");
{
	const runtime = createRuntime({ permission: "denied" });
	runtime.moduleExports.apply(runtime.ctx, {});
	assert(runtime.listenerCount() === 0, "denied permission does not create listeners");
	assert(runtime.intervalCount() === 0, "denied permission does not start polling");
	assert(runtime.infos.some((line) => line.includes("permission denied")), "denied permission is logged once");
}

console.log("late uiSession provider");
{
	const runtime = createRuntime({ focused: false, rows: { "session-a": { title: "晚到会话" } } });
	let pending;
	const lateCtx = {
		inject(deps, callback) {
			pending = { deps, callback };
		},
	};
	runtime.moduleExports.apply(lateCtx, {});
	assert(pending !== undefined && pending.deps.includes("uiSession"), "waits through ctx.inject");
	assert(runtime.listenerCount() === 0, "nothing is subscribed before the service arrives");
	pending.callback({ uiSession: runtime.ctx.uiSession, effect: runtime.ctx.effect });
	assert(runtime.listenerCount() === 1, "starts once the service arrives");
	runtime.setStatus({ "session-a": { running: true } });
	runtime.setStatus({ "session-a": { running: false } });
	assert(
		runtime.real().length === 1 && runtime.real()[0].title === "晚到会话",
		"a late start still notifies",
	);
	runtime.dispose();
}

console.log("missing uiSession is reported, not thrown");
{
	const runtime = createRuntime({ focused: false, rows: {} });
	const broken = { effect: runtime.ctx.effect };
	let threw = false;
	try {
		runtime.moduleExports.apply(broken, {});
	} catch (_error) {
		threw = true;
	}
	assert(threw === false, "apply survives a missing uiSession");
	assert(
		runtime.warnings.some((line) => line.includes("uiSession unavailable")),
		"the missing service is logged",
	);
}

console.log("");
console.log(failures === 0 ? "ALL " + checks + " CHECKS PASSED" : failures + " OF " + checks + " CHECKS FAILED");
process.exitCode = failures === 0 ? 0 : 1;
