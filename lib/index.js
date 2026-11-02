/**
 * Node half of the turn-completion notifier.
 *
 * The browser half in `lib/client.js` owns every contribution; this entry
 * exists so the package appears as an ordinary Loader row, which is what makes
 * `dsh.client` in package.json discoverable by the client module system.
 */
/** Loader identity for this plugin. */
export const name = "turn-notify";

/** Browser half fetches its Loader settings from this read-only route. */
const CONFIG_ROUTE = "/dsh-turn-notify/config";
const CLIENT_DEFAULTS = {
	enabled: true,
	notifyWhenFocused: true,
	skipSubagents: true,
	maskTitle: false,
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
 * Loader-visible body; the browser half carries the feature.
 * @param ctx - Host root context.
 * @param config - Loader entry config.
 */
export function apply(ctx, config) {
	const settings = config !== null && typeof config === "object" ? config : {};
	if (settings.diagnostics === true) {
		try {
			ctx.logger?.info?.("turn-notify: host entry loaded pid=%d", process.pid);
		} catch (_error) {
			/* diagnostics must not block plugin startup */
		}
	}
	if (!ctx || typeof ctx.inject !== "function") return;
	ctx.inject(["webServer"], (scope) => {
		if (!scope || !scope.webServer || typeof scope.webServer.register !== "function") return;
		scope.effect(() => {
			const dispose = scope.webServer.register({
				kind: "exact",
				path: CONFIG_ROUTE,
				handler: (request, response) => {
					try {
						if (typeof response.on === "function") response.on("error", () => {});
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
					} catch (_error) {
						try {
							if (!response.headersSent) response.writeHead(500);
						} catch (_ignored) {
							/* response may already be closed */
						}
						try {
							response.end();
						} catch (_ignored) {
							/* response may already be closed */
						}
					}
				},
			});
			return () => {
				if (typeof dispose === "function") dispose();
			};
		}, "turn-notify: client config route");
	});
}
