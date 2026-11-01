/**
 * Turn-completion notifier — browser half.
 *
 * Subscribes to the client's own per-Session status store (`uiSession.sessionStatus`)
 * and raises a Windows notification when a Session's turn goes running → idle.
 *
 * Deliberately reuses DSH's own notion of "which Session the user is watching"
 * (`retainedBy.mainView`) so a turn the user is visibly waiting on stays quiet.
 */
window.__ModuleLoader__.load({
	id: "@99galaxy/dsh-turn-notify",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		//#region config
		/** Required client services: the Session status store and the Session list. */
		const inject = ["uiSession"];

		/**
		 * Diagnostic round switch, independent of Loader config: the browser half
		 * must be able to prove itself even when no config reaches it. Set
		 * `window.__dshTurnNotifyDiagnostic = false` to silence the stream.
		 */
		const DIAGNOSTIC_DUMP =
			typeof window !== "undefined" && window.__dshTurnNotifyDiagnostic === true;
		const CONFIG_URL = "/dsh-turn-notify/config";

		const DEFAULTS = {
			/** Master switch. */
			enabled: true,
			/** Notify even for the Session the user is actively looking at. */
			notifyWhenFocused: true,
			/** Leave subagent Sessions quiet; their parent turn reports instead. */
			skipSubagents: true,
			/** Second line of the toast body, e.g. "本轮已完成 · 2m 13s". */
			message: "本轮已完成",
			/** Raise one toast at startup so the OS notification channel can be proven. */
			debugProbe: false,
			/** Publish the watcher's own state as toasts, and drop all suppression. */
			debugDump: false,
		};

		/** Copy only keys the caller declared with the default's own type. */
		function normalizeConfig(input) {
			const config = { ...DEFAULTS };
			if (input !== null && typeof input === "object") {
				for (const key of Object.keys(DEFAULTS)) {
					if (typeof input[key] === typeof DEFAULTS[key]) config[key] = input[key];
				}
			}
			if (DIAGNOSTIC_DUMP) config.debugDump = true;
			return config;
		}

		/** Format a duration in whole seconds the way a toast reads best. */
		function formatDuration(ms) {
			if (!(ms > 0)) return "";
			const total = Math.round(ms / 1000);
			if (total < 60) return total + "s";
			const minutes = Math.floor(total / 60);
			const seconds = total % 60;
			if (minutes < 60) return seconds === 0 ? minutes + "m" : minutes + "m " + seconds + "s";
			const hours = Math.floor(minutes / 60);
			const rest = minutes % 60;
			return rest === 0 ? hours + "h" : hours + "h " + rest + "m";
		}
		//#endregion

		//#region watcher
		/**
		 * Build the watcher over one `uiSession` service.
		 * @param ctx - Client root context carrying `uiSession` and `effect`.
		 * @param config - Normalized plugin config.
		 * @returns Handle with `tick()` for tests and `dispose()` for teardown.
		 */
		function createWatcher(ctx, config, configSource = "none") {
			/** sessionId → whether a turn was running at the last tick. */
			let lastRunning = new Map();
			/** sessionId → epoch ms the current turn started. */
			const startedAt = new Map();
			/** Sessions whose current idle cycle has already raised a completion. */
			const completionHandled = new Set();
			/** Suppresses the first tick, which only seeds the baseline. */
			let seeded = false;
			let disposed = false;
			/** Diagnostic counters, only meaningful while `debugDump` is on. */
			let ticks = 0;
			let lastDumpAt = 0;
			let dumpedOnce = false;
			let changes = 0;
			/** How many Sessions each source contributed to the last snapshot. */
			let statusCount = 0;
			let listCount = 0;
			/** What the last turn boundary decided, and why it failed when it did. */
			let lastDecision = "none";
			let lastError = "";
			let lastSub = "-";
			/** Last Notification lifecycle event reported by the platform. */
			let lastEvent = "none";
			/** Latest snapshot, so an event handler can publish without a new tick. */
			let lastSnapshot = new Map();
			let dumping = false;

			const store = () => ctx.uiSession && ctx.uiSession.sessionStatus;

			/**
			 * Resolve the Session controller client face.
			 *
			 * `sessions` is the service the whole UI shares (provided on the root
			 * context); `uiSession.sessions` is the same object when the UI-layer
			 * service is present. Preferring the root service keeps working even
			 * when the UI layer never populated its own derived store.
			 * @returns The controller client face, or null.
			 */
			function controller() {
				try {
					if (ctx.sessions && ctx.sessions.list) return ctx.sessions;
				} catch (_error) {
					/* fall through */
				}
				try {
					if (ctx.uiSession && ctx.uiSession.sessions && ctx.uiSession.sessions.list) {
						return ctx.uiSession.sessions;
					}
				} catch (_error) {
					/* fall through */
				}
				return null;
			}

			/** Short name of the resolved controller, for diagnostics. */
			function controllerSource() {
				try {
					if (ctx.sessions && ctx.sessions.list) return "sessions";
				} catch (_error) {
					/* fall through */
				}
				try {
					if (ctx.uiSession && ctx.uiSession.sessions) return "uiSession";
				} catch (_error) {
					/* fall through */
				}
				return "none";
			}

			/** The live list snapshot, or null. */
			function listSnapshot() {
				try {
					const face = controller();
					const list = face && face.list && face.list.getSnapshot();
					return list && list.byId ? list : null;
				} catch (_error) {
					return null;
				}
			}

			/**
			 * Merge the status store with the Session list rows.
			 *
			 * `uiSession.sessionStatus` is the authoritative running view, but the
			 * list rows carry their own `running` flag. Reading both, with the status
			 * store winning where it has an answer, is exactly what DSH's own sidebar
			 * does (`status?.running ?? row.running`) and keeps the watcher alive if
			 * either source is empty in a given build.
			 * @returns Merged map of Session id to its last known running state.
			 */
			function snapshot() {
				const merged = new Map();
				let statusMap = null;
				try {
					statusMap = store() ? store().getSnapshot() : null;
				} catch (_error) {
					statusMap = null;
				}
				statusCount = 0;
				listCount = 0;
				if (statusMap !== null && typeof statusMap[Symbol.iterator] === "function") {
					for (const entry of statusMap) {
						const status = entry[1];
						merged.set(entry[0], {
							running: status && typeof status.running === "boolean" ? status.running : undefined,
							completionUnread:
								status && typeof status.completionUnread === "boolean"
									? status.completionUnread
									: undefined,
						});
					}
					statusCount = merged.size;
				}
				const list = listSnapshot();
				const byId = list ? list.byId : null;
				if (byId) {
					for (const sessionId of Object.keys(byId)) {
						const row = byId[sessionId];
						const rowRunning =
							row !== null && row !== undefined && typeof row.running === "boolean"
								? row.running
								: undefined;
						const existing = merged.get(sessionId);
						if (existing === undefined) {
							merged.set(sessionId, { running: rowRunning });
							listCount += 1;
						} else if (existing.running === undefined && rowRunning !== undefined) {
							existing.running = rowRunning;
						}
					}
				}
				if (statusMap === null && merged.size === 0) return null;
				return merged;
			}

			/** Read the sidebar row behind a Session id, for the title and view state. */
			function rowOf(sessionId) {
				const list = listSnapshot();
				const byId = list ? list.byId : null;
				return byId && byId[sessionId] ? byId[sessionId] : null;
			}

			/** Whether the user is currently being shown this Session in the main view. */
			function isViewed(sessionId) {
				const row = rowOf(sessionId);
				if (row === null) return false;
				return (row.retainedBy && row.retainedBy.mainView ? row.retainedBy.mainView : 0) > 0;
			}

			function isSubagent(sessionId) {
				if (!config.skipSubagents) return false;
				const row = rowOf(sessionId);
				if (row === null) return false;
				return row.subagent !== undefined && row.subagent !== null && row.subagent !== false;
			}

			function titleOf(sessionId) {
				const row = rowOf(sessionId);
				const title = row && row.title;
				return typeof title === "string" && title.length > 0 ? title : undefined;
			}

			/** The renderer is unfocused or hidden: the user is not looking at us. */
			function unattended() {
				if (typeof document === "undefined") return true;
				try {
					if (document.visibilityState === "hidden") return true;
					if (typeof document.hasFocus === "function") return !document.hasFocus();
				} catch (_error) {
					return true;
				}
				return false;
			}

			function show(sessionId, elapsedMs) {
				if (typeof Notification === "undefined") {
					lastError = "no-api";
					return false;
				}
				const title = titleOf(sessionId);
				const elapsed = typeof elapsedMs === "number" ? formatDuration(elapsedMs) : "";
				const body = elapsed.length > 0 ? config.message + " · " + elapsed : config.message;
				try {
					// Shape kept identical to the startup probe, which Windows did display:
					// no `silent`, and a tag without characters Windows may dislike.
					const notification = new Notification(title === undefined ? "会话已完成" : title, {
						body,
						tag: "dshturn-" + short(sessionId),
					});
					notification.onclick = () => {
						try {
							window.focus();
						} catch (_error) {
							/* a toast click must never throw into the host page */
						}
					};
					notification.onshow = () => {
						lastEvent = "show";
						dumpNow();
					};
					notification.onerror = (event) => {
						lastEvent = "error:" + String((event && (event.message || event.type)) || "?").slice(0, 24);
						dumpNow();
					};
					lastError = "";
					return true;
				} catch (error) {
					lastError = String((error && error.message) || error).slice(0, 40);
					console.warn("turn-notify: could not show notification", error);
					return false;
				}
			}

			/** Decide and fire for one finished turn. */
			function completed(sessionId, elapsedMs) {
				const row = rowOf(sessionId);
				lastSub = row && row.subagent !== undefined && row.subagent !== null && row.subagent !== false ? "1" : "0";
				// A diagnostic round must observe every transition, so nothing here
				// may suppress the attempt.
				if (config.debugDump) {
					lastDecision = "debug";
					show(sessionId, elapsedMs);
					lastDecision = lastError === "" ? "shown" : "fail";
					return lastError === "";
				}
				if (isSubagent(sessionId)) {
					lastDecision = "subagent";
					return false;
				}
				const viewed = isViewed(sessionId);
				if (viewed && !config.notifyWhenFocused && !unattended()) {
					lastDecision = "quiet";
					return false;
				}
				show(sessionId, elapsedMs);
				lastDecision = lastError === "" ? "shown" : "fail";
				return lastError === "";
			}

			/** Shortest readable form of one Session id. */
			function short(id) {
				return String(id).slice(0, 8);
			}

			/**
			 * Publish the watcher's own state through the notification channel.
			 *
			 * The renderer has no filesystem and no console the operator can reach,
			 * so the toast is the only stream a diagnosis can ride on.
			 * @param current - Latest status snapshot.
			 */
			function dump(current) {
				if (dumping) return;
				dumping = true;
				const running = [];
				for (const entry of current) {
					if (entry[1] && entry[1].running === true) running.push(short(entry[0]));
				}
				const permission = typeof Notification === "undefined" ? "n/a" : Notification.permission;
				const body =
					"ticks=" +
					ticks +
					" size=" +
					current.size +
					" run=[" +
					(running.join(",") || "-") +
					"] focus=" +
					(unattended() ? "off" : "on") +
					" perm=" +
					permission +
					" evt=" +
					lastEvent +
					" cfg=" +
					(typeof configSource === "function" ? configSource() : configSource) +
					" ctl=" +
					controllerSource() +
					" src=" +
					statusCount +
					"/" +
					listCount +
					" dec=" +
					lastDecision +
					" sub=" +
					lastSub +
					" err=" +
					(lastError === "" ? "-" : lastError) +
					" events=" +
					changes;
				try {
					const toast = new Notification("turn-notify 诊断", {
						body,
						tag: "dsh-turn-notify-dump",
					});
					toast.onclick = () => {};
				} catch (_error) {
					/* diagnostics must never break the watcher */
				}
				dumping = false;
			}

			/** Publish a diagnostic immediately, for an event handler to report through. */
			function dumpNow() {
				if (!config.debugDump) return;
				dump(lastSnapshot);
			}

			/** Reconcile one status snapshot against the previous tick. */
			function tick() {
				if (disposed) return;
				ticks += 1;
				const current = snapshot();
				if (current === null) {
					lastSnapshot = new Map();
					if (config.debugDump) dump(lastSnapshot);
					return;
				}
				lastSnapshot = current;
				let changed = false;
				const next = new Map();
				for (const entry of current) {
					const sessionId = entry[0];
					const status = entry[1];
					const running =
						status && typeof status.running === "boolean" ? status.running : undefined;
					if (running === true) {
						if (lastRunning.get(sessionId) !== true) startedAt.set(sessionId, Date.now());
						completionHandled.delete(sessionId);
						next.set(sessionId, true);
						continue;
					}

					const observedEnd =
						running === false &&
						lastRunning.get(sessionId) === true &&
						!completionHandled.has(sessionId);
					const unreadEnd =
						running === false &&
						status.completionUnread === true &&
						!completionHandled.has(sessionId);
					const fallbackEnd =
						running === undefined &&
						status &&
						status.completionUnread === true &&
						!completionHandled.has(sessionId);
					if (seeded && (observedEnd || unreadEnd || fallbackEnd)) {
						changed = true;
						changes += 1;
						const began = startedAt.get(sessionId);
						completed(sessionId, began === undefined ? undefined : Date.now() - began);
						completionHandled.add(sessionId);
					}
					if (!seeded && status && status.completionUnread === true) {
						completionHandled.add(sessionId);
					}
					if (running === false) next.set(sessionId, false);
					else if (lastRunning.has(sessionId)) next.set(sessionId, lastRunning.get(sessionId));
					if (running === false || fallbackEnd) startedAt.delete(sessionId);
				}
				for (const sessionId of startedAt.keys()) {
					if (!current.has(sessionId)) startedAt.delete(sessionId);
				}
				for (const sessionId of completionHandled) {
					if (!current.has(sessionId)) completionHandled.delete(sessionId);
				}
				lastRunning = next;
				seeded = true;
				if (config.debugDump) {
					const now = Date.now();
					if (!dumpedOnce || changed || now - lastDumpAt >= 15000) {
						lastDumpAt = now;
						dumpedOnce = true;
						dump(current);
					}
				}
			}

			return {
				tick,
				controller,
				dispose() {
					disposed = true;
					lastRunning = new Map();
					startedAt.clear();
					completionHandled.clear();
				},
			};
		}
		//#endregion

		//#region plugin
		/** Read profile-side client settings from the plugin's read-only host route. */
		async function readRemoteConfig() {
			if (typeof fetch !== "function") return null;
			try {
				const response = await fetch(CONFIG_URL, {
					cache: "no-store",
					headers: { accept: "application/json" },
				});
				if (!response || response.ok === false) return null;
				const payload = await response.json();
				return payload && payload.ok === true && payload.config && typeof payload.config === "object"
					? payload.config
					: null;
			} catch (_error) {
				return null;
			}
		}

		/**
		 * Client plugin body: watch turn completions and raise OS notifications.
		 * @param ctx - Client root context.
		 * @param config - Loader entry config.
		 */
		function apply(ctx, config) {
			// The client Loader omits entry config, so prefer the host route below;
			// retain direct/context input for tests and hosts that already provide it.
			let raw = config;
			if (raw === undefined && ctx !== undefined && ctx !== null) {
				try {
					raw = ctx.config;
				} catch (_error) {
					raw = undefined;
				}
			}
			const resolved = normalizeConfig(raw);
			if (!resolved.enabled) return;
			let configSource = raw === undefined ? "none" : "object";
			/** Everything that needs a usable `uiSession` and a Notification API. */
			const start = (scope) => {
				let begun = false;
				const begin = () => {
					if (begun) return;
					begun = true;
					if (!resolved.enabled) return;
					if (typeof Notification === "undefined") {
						console.warn("turn-notify: this context has no Notification API; notifications are off");
						return;
					}
					if (Notification.permission === "default") {
						try {
							const request = Notification.requestPermission();
							if (request && typeof request.catch === "function") request.catch(() => {});
						} catch (_error) {
							/* older renderers return undefined instead of a promise */
						}
					}
					// Diagnostic round: probe when the flag is set, and also when no config
					// reached the browser at all, so a missing config cannot masquerade as
					// "plugin never loaded".
					if (resolved.debugProbe) {
						console.warn(
							"turn-notify: active. permission=" +
								Notification.permission +
								" sessions=" +
								(scope.uiSession && scope.uiSession.sessionStatus ? "store-present" : "store-missing"),
						);
						try {
							const probe = new Notification("turn-notify 已加载", {
								body: "通知通道正常。窗口在后台且会话跑完时会用这个通道提醒你。",
								tag: "dsh-turn-notify-probe",
							});
							probe.onclick = () => {
								try {
									window.focus();
								} catch (_error) {
									/* ignore */
								}
							};
						} catch (error) {
							console.warn("turn-notify: probe notification failed", error);
						}
					}
					const watcher = createWatcher(scope, resolved, () => configSource);
					// Subscribe synchronously: `ctx.effect` is the documented owner of
					// cleanup, but a watcher that depends on it never starting would be
					// silent for the wrong reason. Cleanup stays best effort.
					const onStatus = () => {
						try {
							watcher.tick();
						} catch (error) {
							console.warn("turn-notify: status tick failed", error);
						}
					};
					const unsubscribers = [];
					try {
						if (scope.uiSession && scope.uiSession.sessionStatus && typeof scope.uiSession.sessionStatus.subscribe === "function") {
							unsubscribers.push(scope.uiSession.sessionStatus.subscribe(onStatus));
						}
					} catch (_error) {
						/* the list store alone still drives the watcher */
					}
					try {
						if (watcher.controller) {
							const face = watcher.controller();
							const list = face && face.list;
							if (list && typeof list.subscribe === "function") unsubscribers.push(list.subscribe(onStatus));
						}
					} catch (_error) {
						/* the status store alone still drives the watcher */
					}
					try {
						if (scope.remote && typeof scope.remote.$on === "function") {
							unsubscribers.push(scope.remote.$on("api-session/status", onStatus));
						}
					} catch (_error) {
						/* polling remains the final fallback */
					}
					// A timer is independent of every cordis lifecycle mechanism: even when
					// neither store notifies, a turn boundary is seen within one interval.
					let poll;
					try {
						poll = setInterval(onStatus, 2000);
					} catch (_error) {
						poll = undefined;
					}
					const unsubscribe = () => {
						try {
							if (poll !== undefined) clearInterval(poll);
						} catch (_error) {
							/* ignore */
						}
						for (const stop of unsubscribers) {
							try {
								stop();
							} catch (_error) {
								/* teardown is best effort */
							}
						}
					};
					try {
						watcher.tick();
					} catch (error) {
						console.warn("turn-notify: initial tick failed", error);
					}
					try {
						if (typeof scope.effect === "function") {
							scope.effect(() => () => {
								watcher.dispose();
								unsubscribe();
							}, "turn-notify: turn completion watch");
						}
					} catch (error) {
						console.warn("turn-notify: could not register cleanup", error);
					}
				};
				if (typeof fetch !== "function") {
					begin();
					return;
				}
				void readRemoteConfig().then((remote) => {
					if (remote) {
						Object.assign(resolved, normalizeConfig(remote));
						configSource = "http";
					}
					begin();
				});
			};
			if (ctx.uiSession !== undefined) {
				start(ctx);
				return;
			}
			// `inject` only gates apply when the kernel honors it; a late provider is
			// the other half of the same contract.
			if (typeof ctx.inject === "function") {
				ctx.inject(["uiSession"], (scope) => {
					start(scope);
				});
				return;
			}
			console.warn("turn-notify: uiSession unavailable; notifications are off");
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.createWatcher = createWatcher;
		exports.normalizeConfig = normalizeConfig;
		return module.exports;
	}
});
