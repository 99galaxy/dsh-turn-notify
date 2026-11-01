/**
 * Node half of the turn-completion notifier.
 *
 * The browser half in `lib/client.js` owns every contribution; this entry
 * exists so the package appears as an ordinary Loader row, which is what makes
 * `dsh.client` in package.json discoverable by the client module system.
 */
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Loader identity for this plugin. */
export const name = "turn-notify";

/** Marker path used to prove the Loader entry really loaded. */
const MARKER = join(tmpdir(), "dsh-turn-notify-loaded.log");
/** Browser half fetches its Loader settings from this read-only route. */
const CONFIG_ROUTE = "/dsh-turn-notify/config";
const CLIENT_DEFAULTS = {
	enabled: true,
	notifyWhenFocused: true,
	skipSubagents: true,
	message: "本轮已完成",
	debugProbe: false,
	debugDump: false,
};

/** Keep only the client keys this plugin understands and their declared types. */
function clientConfig(settings) {
	const output = { ...CLIENT_DEFAULTS };
	for (const key of Object.keys(CLIENT_DEFAULTS)) {
		if (typeof settings[key] === typeof CLIENT_DEFAULTS[key]) output[key] = settings[key];
	}
	return output;
}

/**
 * Write one diagnostic line. Best effort: a failing marker must never break the
 * Host boot, so every filesystem error is swallowed.
 * @param line - Text to append.
 */
function mark(line) {
	try {
		appendFileSync(MARKER, new Date().toISOString() + " " + line + "\n", "utf8");
	} catch (_error) {
		/* diagnostics are optional */
	}
}

/**
 * Loader-visible body; the browser half carries the feature.
 * @param ctx - Host root context.
 * @param config - Loader entry config.
 */
export function apply(ctx, config) {
	const settings = config !== null && typeof config === "object" ? config : {};
	if (settings.diagnostics !== false) {
		mark("host entry loaded pid=" + process.pid);
	}
	if (!ctx || typeof ctx.inject !== "function") return;
	ctx.inject(["webServer"], (scope) => {
		if (!scope || !scope.webServer || typeof scope.webServer.register !== "function") return;
		scope.effect(() => {
			const dispose = scope.webServer.register({
				kind: "exact",
				path: CONFIG_ROUTE,
				handler: (request, response) => {
					if (request.method !== "GET") {
						response.writeHead(405, { allow: "GET" });
						response.end();
						return;
					}
					const body = JSON.stringify({ ok: true, config: clientConfig(settings) });
					response.writeHead(200, {
						"content-type": "application/json; charset=utf-8",
						"cache-control": "no-store",
						"content-length": Buffer.byteLength(body),
					});
					response.end(body);
				},
			});
			return () => {
				if (typeof dispose === "function") dispose();
			};
		}, "turn-notify: client config route");
	});
}
