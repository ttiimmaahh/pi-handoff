import { complete } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	buildSessionContext,
	convertToLlm,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// The message type pi passes through the `context` hook. Derived from the
// exported event type so we don't depend on @earendil-works/pi-agent-core directly.
type AgentMessage = ContextEvent["messages"][number];
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

// ---------------------------------------------------------------------------
// Config (env-overridable; sensible defaults so it works with zero setup)
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLD = 80; // percent of the context window
// Once over threshold we don't regenerate every single turn — only after the
// usage climbs another REFRESH_STEP percent, so the doc stays fresh without
// firing a summarization call on each turn.
const REFRESH_STEP = 5;
const DEFAULT_REL_PATH = ".pi/handoff.md";
// Only offer to reload a handoff this fresh on session start.
const STALE_MS = 24 * 60 * 60 * 1000;
// Cheap/fast summarizer candidates, best first; matched by substring on model id.
const CHEAP_HINTS = ["flash-lite", "flash", "haiku", "nano", "mini"];

// Persisted, user-wide config written by /handoff-setup. Lives next to pi's
// other agent state (auth.json, settings.json). Env vars always override it.
type HandoffConfig = {
	model?: string;
	threshold?: number;
	compaction?: "enrich" | "off";
};

function configPath(): string {
	return (
		process.env.PI_HANDOFF_CONFIG?.trim() ||
		join(homedir(), ".pi", "agent", "pi-handoff-config.json")
	);
}

let cachedConfig: HandoffConfig | undefined;

function getConfig(): HandoffConfig {
	if (cachedConfig) return cachedConfig;
	try {
		cachedConfig = JSON.parse(readFileSync(configPath(), "utf8")) as HandoffConfig;
	} catch {
		cachedConfig = {};
	}
	return cachedConfig;
}

function saveConfig(cfg: HandoffConfig): void {
	cachedConfig = cfg;
	const p = configPath();
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`);
}

function isValidThreshold(n: number): boolean {
	return Number.isFinite(n) && n > 0 && n < 100;
}

// Whether to replace pi's built-in compaction summary with our structured one.
// Default on; env wins over saved config.
function compactionEnrichEnabled(): boolean {
	const env = process.env.PI_HANDOFF_COMPACTION?.trim().toLowerCase();
	if (env === "off" || env === "0" || env === "false") return false;
	if (env === "on" || env === "enrich" || env === "1" || env === "true") {
		return true;
	}
	return getConfig().compaction !== "off";
}

// Precedence: env var → saved config → built-in default.
function thresholdPct(): number {
	const envV = Number(process.env.PI_HANDOFF_THRESHOLD);
	if (isValidThreshold(envV)) return envV;
	const cfgV = getConfig().threshold;
	if (typeof cfgV === "number" && isValidThreshold(cfgV)) return cfgV;
	return DEFAULT_THRESHOLD;
}

function handoffPath(cwd: string): string {
	const p = process.env.PI_HANDOFF_PATH?.trim() || DEFAULT_REL_PATH;
	return isAbsolute(p) ? p : join(cwd, p);
}

// Round percent for display; debounce math stays on the raw float.
function fmtPct(n: number): string {
	return `${Math.round(n)}%`;
}

// Resolve a "provider/id" spec against the registry (split on the first "/";
// model ids may contain "--" but not "/").
function resolveModelSpec(
	ctx: ExtensionContext,
	spec: string | undefined,
): Model<Api> | undefined {
	if (!spec || !spec.includes("/")) return undefined;
	const slash = spec.indexOf("/");
	return ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1));
}

// Cheapest known model by name hint, preferring the conversation's provider so
// existing auth works.
function autoPickCheapModel(ctx: ExtensionContext): Model<Api> | undefined {
	const curProvider = ctx.model?.provider;
	const ranked = ctx.modelRegistry
		.getAvailable()
		.map((m) => ({ m, rank: CHEAP_HINTS.findIndex((h) => m.id.includes(h)) }))
		.filter((x) => x.rank !== -1)
		.sort(
			(a, b) =>
				a.rank - b.rank ||
				Number(b.m.provider === curProvider) -
					Number(a.m.provider === curProvider),
		);
	return ranked[0]?.m;
}

// Precedence: env override → saved /handoff-setup choice → auto cheapest →
// current model. Returns undefined only if there are no models at all.
function pickSummaryModel(ctx: ExtensionContext): Model<Api> | undefined {
	return (
		resolveModelSpec(ctx, process.env.PI_HANDOFF_MODEL?.trim()) ??
		resolveModelSpec(ctx, getConfig().model) ??
		autoPickCheapModel(ctx) ??
		ctx.model
	);
}

// Human-friendly model line for the setup picker. The name is padded to a
// shared width so the cost column lines up vertically — that's what makes the
// cheapest-first ordering obvious at a glance.
function modelLabel(m: Model<Api>, nameWidth: number): string {
	const name = `${m.provider}/${m.id}`;
	const cost = m.cost
		? `$${m.cost.input}/$${m.cost.output} per Mtok`
		: "cost n/a";
	return `${name.padEnd(nameWidth)}  ${cost}`;
}

const HANDOFF_SECTIONS = `## Goal
The user's overall objective, in one or two sentences.

## Current State
What has been done so far — concrete code changes, files touched (with paths), and decisions made (with the reasoning).

## Next Steps
The immediate actions to take, in order. Be specific: file paths, commands, function/symbol names.

## Open Questions & Blockers
Anything unresolved, risky, or waiting on the user.

## Key Facts & Conventions
Durable facts needed to continue: commands, paths, gotchas, project conventions discovered during the session.`;

const HANDOFF_GUIDANCE =
	"Be thorough but tight. Prefer concrete references (paths, symbols, commands) over prose. Do NOT invent anything the conversation does not support.";

// Full-session handoff for a fresh session (written to .pi/handoff.md).
const HANDOFF_PROMPT = `You are writing a HANDOFF DOCUMENT so a fresh AI coding session can resume this work with zero prior context. Read the conversation and produce structured markdown with exactly these sections:

${HANDOFF_SECTIONS}

${HANDOFF_GUIDANCE}`;

// Compaction summary for the earlier portion of an ongoing session (recent
// turns are kept verbatim after this summary).
const COMPACTION_PROMPT = `You are compacting an ongoing AI coding session. Summarize the EARLIER portion of the conversation below into structured markdown so the work continues seamlessly — recent turns are kept verbatim after your summary. Use exactly these sections:

${HANDOFF_SECTIONS}

${HANDOFF_GUIDANCE}`;

// Pull the assistant's text out of a completion response, defensively (the
// content is a union of block types).
function joinAssistantText(content: readonly unknown[]): string {
	return content
		.filter(
			(c): c is { type: "text"; text: string } =>
				!!c &&
				typeof c === "object" &&
				(c as { type?: unknown }).type === "text" &&
				typeof (c as { text?: unknown }).text === "string",
		)
		.map((c) => c.text)
		.join("\n")
		.trim();
}

async function generateHandoff(
	ctx: ExtensionContext,
	reason: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const model = pickSummaryModel(ctx);
	if (!model) {
		ctx.ui.notify("[handoff] No model available to summarize.", "warning");
		return undefined;
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		ctx.ui.notify(`[handoff] No usable auth for ${model.id}; skipped.`, "warning");
		return undefined;
	}

	const { messages } = buildSessionContext(ctx.sessionManager.getBranch());
	const conversation = serializeConversation(convertToLlm(messages));
	if (!conversation.trim()) return undefined;

	const response = await complete(
		model,
		{
			messages: [
				{
					role: "user" as const,
					content: [
						{
							type: "text" as const,
							text: `${HANDOFF_PROMPT}\n\n<conversation>\n${conversation}\n</conversation>`,
						},
					],
					timestamp: Date.now(),
				},
			],
		},
		{ apiKey: auth.apiKey, headers: auth.headers, maxTokens: 8192, signal },
	);

	const summary = joinAssistantText(response.content);
	if (!summary) return undefined;

	const usage = ctx.getContextUsage();
	const header = [
		"<!-- pi-handoff: auto-generated. Safe to edit or delete. -->",
		"# Session Handoff",
		"",
		`- Generated: ${new Date().toISOString()}`,
		`- Reason: ${reason}`,
		`- Session: ${ctx.sessionManager.getSessionId()}`,
		`- Conversation model: ${ctx.model?.id ?? "unknown"}`,
		`- Summarizer: ${model.id}`,
		usage?.percent != null ? `- Context at generation: ${fmtPct(usage.percent)}` : "",
		"",
		"---",
		"",
	]
		.filter(Boolean)
		.join("\n");

	const path = handoffPath(ctx.sessionManager.getCwd());
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${header}\n${summary}\n`);
	return path;
}

type UserMsg = Extract<AgentMessage, { role: "user" }>;

function isUserMessage(m: AgentMessage): m is UserMsg {
	return (m as { role?: unknown }).role === "user";
}

// Merge the handoff into the FIRST user message rather than prepending a
// separate one — back-to-back user messages break strict-alternation backends
// (Anthropic via Bedrock/SAP).
function injectHandoff(messages: AgentMessage[], handoff: string): AgentMessage[] {
	const banner =
		"[Resuming from a previous session. The handoff document below is your " +
		`context for continuing the work.]\n\n${handoff}\n\n---\n\n`;
	const fresh: UserMsg = {
		role: "user",
		content: [{ type: "text", text: banner }],
		timestamp: Date.now(),
	};

	const idx = messages.findIndex(isUserMessage);
	if (idx === -1) return [fresh, ...messages];

	const target = messages[idx];
	if (!isUserMessage(target)) return [fresh, ...messages];

	const content =
		typeof target.content === "string"
			? banner + target.content
			: [{ type: "text" as const, text: banner }, ...target.content];
	const merged: UserMsg = { ...target, content };
	return [...messages.slice(0, idx), merged, ...messages.slice(idx + 1)];
}

export default function (pi: ExtensionAPI) {
	// Highest context percent we've already written a handoff for, so we debounce
	// regeneration. Reset whenever the context shrinks (compaction / new session).
	let lastGenPct: number | null = null;
	let busy = false;
	let pendingInjection: string | undefined;

	// --- Threshold watcher: fire-and-forget so we never block the turn. -------
	pi.on("turn_end", (_event, ctx) => {
		const pct = ctx.getContextUsage()?.percent;
		if (pct == null || pct < thresholdPct()) return;
		if (busy) return;
		if (lastGenPct != null && pct < lastGenPct + REFRESH_STEP) return;

		busy = true;
		lastGenPct = pct; // optimistic: debounce immediately, regenerate at +REFRESH_STEP
		void (async () => {
			try {
				const path = await generateHandoff(ctx, `auto: context ${fmtPct(pct)}`);
				if (path) {
					ctx.ui.notify(
						`[handoff] Context at ${fmtPct(pct)} — saved handoff to ${path}. ` +
							"Consider /compact or a new session (it'll offer to reload this).",
						"warning",
					);
				}
			} catch (err) {
				if (!signalAborted(ctx)) {
					ctx.ui.notify(
						`[handoff] Generation failed: ${(err as Error).message}`,
						"warning",
					);
				}
			} finally {
				busy = false;
			}
		})();
	});

	// Phase 2 — replace pi's default compaction summary with our structured
	// handoff format, so the in-context summary after /compact carries the same
	// Goal/State/Next-Steps shape. Returns undefined (→ pi's default compaction)
	// on opt-out or any failure.
	pi.on("session_before_compact", async (event, ctx) => {
		if (!compactionEnrichEnabled()) return;

		const model = pickSummaryModel(ctx);
		if (!model) return;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) return;

		const { preparation } = event;
		const older = [
			...preparation.messagesToSummarize,
			...preparation.turnPrefixMessages,
		];
		const conversation = serializeConversation(convertToLlm(older));
		if (!conversation.trim()) return;

		const prior = preparation.previousSummary
			? `\n\nEarlier summary, for continuity:\n${preparation.previousSummary}`
			: "";

		try {
			const response = await complete(
				model,
				{
					messages: [
						{
							role: "user" as const,
							content: [
								{
									type: "text" as const,
									text: `${COMPACTION_PROMPT}${prior}\n\n<conversation>\n${conversation}\n</conversation>`,
								},
							],
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					maxTokens: 8192,
					signal: event.signal,
				},
			);
			const summary = joinAssistantText(response.content);
			if (!summary) return; // empty → fall back to pi's default compaction

			ctx.ui.notify(
				`[handoff] Structured compaction via ${model.id}.`,
				"info",
			);
			return {
				compaction: {
					summary,
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
				},
			};
		} catch {
			// Any failure (incl. abort) → undefined → pi runs its default compaction.
			return;
		}
	});

	// Context shrinks after compaction — allow the next threshold crossing to regenerate.
	pi.on("session_compact", () => {
		lastGenPct = null;
	});

	// --- New/resumed session: offer to reload a recent handoff. ---------------
	pi.on("session_start", async (event, ctx) => {
		lastGenPct = null;
		// Offer reload on a genuinely fresh session (`new`) or on a fresh launch
		// (`startup` — the crash-recovery case). Skip `resume`/`reload`/`fork`:
		// those restore the full history, so a handoff would be redundant.
		if (event.reason !== "new" && event.reason !== "startup") return;
		if (!ctx.hasUI) return;

		const path = handoffPath(ctx.sessionManager.getCwd());
		if (!existsSync(path)) return;
		if (Date.now() - statSync(path).mtimeMs > STALE_MS) return;

		const content = readFileSync(path, "utf8");
		// Never offer to reload a handoff that THIS session wrote (e.g. it auto-
		// generated at the threshold, or pi resumed the same session on startup).
		const wroteBy = content.match(/^- Session: (.+)$/m)?.[1]?.trim();
		if (wroteBy && wroteBy === ctx.sessionManager.getSessionId()) return;

		const load = await ctx.ui.confirm(
			"Resume from handoff?",
			`A recent handoff doc exists:\n${path}\n\nLoad it into this session?`,
		);
		if (load) {
			pendingInjection = content;
			ctx.ui.notify("[handoff] Loaded — injected on your next message.", "info");
		}
	});

	// --- Inject a loaded handoff into the next LLM call, once. -----------------
	pi.on("context", (event) => {
		if (!pendingInjection) return;
		const messages = injectHandoff(event.messages, pendingInjection);
		pendingInjection = undefined;
		return { messages };
	});

	// --- Manual controls. -----------------------------------------------------
	pi.registerCommand("handoff", {
		description: "Generate a session handoff document now",
		handler: async (_args, ctx) => {
			ctx.ui.notify("[handoff] Generating…", "info");
			try {
				const path = await generateHandoff(ctx, "manual /handoff", ctx.signal);
				if (path) {
					lastGenPct = ctx.getContextUsage()?.percent ?? lastGenPct;
					ctx.ui.notify(`[handoff] Saved to ${path}`, "info");
				} else {
					ctx.ui.notify("[handoff] Nothing to summarize yet.", "warning");
				}
			} catch (err) {
				ctx.ui.notify(`[handoff] Failed: ${(err as Error).message}`, "error");
			}
		},
	});

	pi.registerCommand("handoff-load", {
		description: "Load the existing handoff document into this session",
		handler: async (_args, ctx) => {
			const path = handoffPath(ctx.sessionManager.getCwd());
			if (!existsSync(path)) {
				ctx.ui.notify(`[handoff] No handoff doc at ${path}.`, "warning");
				return;
			}
			pendingInjection = readFileSync(path, "utf8");
			ctx.ui.notify("[handoff] Loaded — injected on your next message.", "info");
		},
	});

	// Guided, /login-style configuration: pick the summarizer model and the
	// trigger threshold, persisted to the config file. Env vars still override.
	pi.registerCommand("handoff-setup", {
		description: "Configure pi-handoff (summarizer model + trigger threshold)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(
					"[handoff] No UI here — configure via env: " +
						"PI_HANDOFF_MODEL=provider/id, PI_HANDOFF_THRESHOLD=80.",
					"warning",
				);
				return;
			}
			const cfg = getConfig();

			// Step 1 — summarizer model: only providers you've configured. Sort by
			// input cost (it dominates for summarization: big input, small output),
			// then output, then name for stable, readable ordering.
			const models = ctx.modelRegistry
				.getAvailable()
				.slice()
				.sort(
					(a, b) =>
						(a.cost?.input ?? 0) - (b.cost?.input ?? 0) ||
						(a.cost?.output ?? 0) - (b.cost?.output ?? 0) ||
						`${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`),
				);
			if (models.length === 0) {
				ctx.ui.notify(
					"[handoff] No configured providers found. Run /login first, " +
						"then /handoff-setup.",
					"warning",
				);
				return;
			}
			const AUTO = "Auto — cheapest available model (recommended)";
			const nameWidth = Math.max(
				...models.map((m) => `${m.provider}/${m.id}`.length),
			);
			const labels = models.map((m) => modelLabel(m, nameWidth));
			const picked = await ctx.ui.select(
				`Handoff summarizer model — current: ${cfg.model ?? "auto"}`,
				[AUTO, ...labels],
			);
			if (picked === undefined) {
				ctx.ui.notify("[handoff] Setup cancelled.", "info");
				return;
			}
			let model: string | undefined;
			if (picked !== AUTO) {
				const chosen = models[labels.indexOf(picked)];
				model = chosen ? `${chosen.provider}/${chosen.id}` : undefined;
			}

			// Step 2 — trigger threshold.
			const current = cfg.threshold ?? DEFAULT_THRESHOLD;
			let threshold = cfg.threshold;
			const entered = await ctx.ui.input(
				`Trigger at what % of context? (1–99, blank = ${current})`,
				String(current),
			);
			if (entered && entered.trim()) {
				const n = Number(entered.trim());
				if (isValidThreshold(n)) {
					threshold = n;
				} else {
					ctx.ui.notify(
						`[handoff] "${entered.trim()}" isn't 1–99; keeping ${current}%.`,
						"warning",
					);
				}
			}

			// Step 3 — structured compaction toggle.
			const currentCompaction = cfg.compaction === "off" ? "off" : "on";
			const enrich = await ctx.ui.confirm(
				"Structured compaction?",
				`Use the structured handoff format for pi's /compact summaries too, ` +
					`replacing the default compaction summary? (currently: ${currentCompaction})`,
			);
			const compaction: "enrich" | "off" = enrich ? "enrich" : "off";

			saveConfig({ ...cfg, model, threshold, compaction });
			ctx.ui.notify(
				`[handoff] Saved to ${configPath()} — model: ${model ?? "auto"}, ` +
					`threshold: ${threshold ?? DEFAULT_THRESHOLD}%, ` +
					`compaction: ${compaction}.`,
				"info",
			);
		},
	});
}

function signalAborted(ctx: ExtensionContext): boolean {
	return ctx.signal?.aborted === true;
}
