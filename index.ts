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
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

// The message type pi passes through the `context` hook. Derived from the
// exported event type so we don't depend on @earendil-works/pi-agent-core directly.
type AgentMessage = ContextEvent["messages"][number];

// ---------------------------------------------------------------------------
// Config (env-overridable; sensible defaults so it works with zero setup)
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLD_PCT = 80; // percent of the context window
// Once over threshold we don't regenerate every single turn — only after the
// usage climbs another REFRESH_STEP in the configured unit. For percent
// thresholds this is percentage points; for token thresholds this is 5% of the
// active context window (falling back to 5% of the configured token threshold).
const REFRESH_STEP = 5;
const DEFAULT_REL_PATH = ".pi/handoff.md";
// Only offer to reload a handoff this fresh on session start.
const STALE_MS = 24 * 60 * 60 * 1000;
// Cheap/fast summarizer candidates, best first; matched by substring on model id.
const CHEAP_HINTS = ["flash-lite", "flash", "haiku", "nano", "mini"];

// Threshold can be a percent of the context window or an absolute token count.
// Stored as a discriminated union; older configs (`threshold: 80`) are read as
// percent for back-compat, see `normalizeStoredThreshold`.
type Threshold =
	| { type: "percent"; value: number }
	| { type: "tokens"; value: number };

// Persisted, user-wide config written by /handoff-setup. Lives next to pi's
// other agent state (auth.json, settings.json). Env vars always override it.
type HandoffConfig = {
	model?: string;
	// New shape: discriminated union. Legacy: bare number == percent.
	threshold?: Threshold | number;
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
		cachedConfig = JSON.parse(
			readFileSync(configPath(), "utf8"),
		) as HandoffConfig;
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

function isValidPercent(n: number): boolean {
	return Number.isFinite(n) && n > 0 && n < 100;
}

function isValidTokenCount(n: number): boolean {
	// Sane lower bound to catch typos like "100" meant as 100k; upper bound
	// generous enough for any realistic context window.
	return (
		Number.isFinite(n) && Number.isInteger(n) && n >= 1000 && n <= 10_000_000
	);
}

// Parse human-friendly token strings: "120000", "120k", "120K", "1.5m", "2M".
// Returns undefined on garbage. Whole-number result; 1k = 1000, 1m = 1_000_000.
function parseTokenCount(raw: string): number | undefined {
	const s = raw.trim().toLowerCase();
	if (!s) return undefined;
	const m = /^(\d+(?:\.\d+)?)\s*([km])?$/.exec(s);
	if (!m) return undefined;
	const base = Number(m[1]);
	if (!Number.isFinite(base)) return undefined;
	const mult = m[2] === "k" ? 1000 : m[2] === "m" ? 1_000_000 : 1;
	return Math.round(base * mult);
}

// Parse the env override / single-string form: "80" (legacy percent),
// "80%", "120000", "120k", "1.5m". Returns undefined on garbage.
function parseThresholdSpec(raw: string): Threshold | undefined {
	const s = raw.trim();
	if (!s) return undefined;
	if (s.endsWith("%")) {
		const n = Number(s.slice(0, -1).trim());
		return isValidPercent(n) ? { type: "percent", value: n } : undefined;
	}
	// Bare integer in [1,99] is treated as percent for back-compat with the old
	// PI_HANDOFF_THRESHOLD=80 spelling.
	if (/^\d+$/.test(s)) {
		const n = Number(s);
		if (isValidPercent(n)) return { type: "percent", value: n };
		if (isValidTokenCount(n)) return { type: "tokens", value: n };
		return undefined;
	}
	const tokens = parseTokenCount(s);
	return tokens != null && isValidTokenCount(tokens)
		? { type: "tokens", value: tokens }
		: undefined;
}

// Normalize a stored value into a Threshold, accepting the legacy bare-number
// form. Returns undefined if the stored value is invalid.
function normalizeStoredThreshold(
	v: HandoffConfig["threshold"],
): Threshold | undefined {
	if (typeof v === "number") {
		return isValidPercent(v) ? { type: "percent", value: v } : undefined;
	}
	if (v && typeof v === "object") {
		if (v.type === "percent" && isValidPercent(v.value)) return v;
		if (v.type === "tokens" && isValidTokenCount(v.value)) return v;
	}
	return undefined;
}

function formatThreshold(t: Threshold): string {
	return t.type === "percent"
		? `${t.value}%`
		: `${formatTokens(t.value)} tokens`;
}

// Compact token formatter for human-facing strings ("120k", "1.5M").
function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) {
		const k = n / 1000;
		return `${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}k`;
	}
	const m = n / 1_000_000;
	return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
}

type FileOps = {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
};

function computeFileLists(fileOps: FileOps): {
	readFiles: string[];
	modifiedFiles: string[];
} {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readFiles = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles, modifiedFiles };
}

function formatFileOperations(
	readFiles: string[],
	modifiedFiles: string[],
): string {
	const sections: string[] = [];
	if (readFiles.length > 0) {
		sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(
			`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`,
		);
	}
	return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}

// Durable diagnostics: set PI_HANDOFF_DEBUG to a file path (or "1" for
// <tmpdir>/pi-handoff-debug.jsonl) to append one JSON line per notable event.
// Notifications are too transient to debug compaction; this isn't.
function debugLog(entry: Record<string, unknown>): void {
	const v = process.env.PI_HANDOFF_DEBUG?.trim();
	if (!v) return;
	const path =
		v === "1" || v.toLowerCase() === "true"
			? join(tmpdir(), "pi-handoff-debug.jsonl")
			: v;
	try {
		appendFileSync(
			path,
			`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`,
		);
	} catch {
		// never let logging break a real operation
	}
}

function readHandoffFile(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch (err) {
		debugLog({
			kind: "handoff-read-failed",
			path,
			error: (err as Error).message,
		});
		return undefined;
	}
}

function isFreshHandoffFile(path: string): boolean {
	try {
		return Date.now() - statSync(path).mtimeMs <= STALE_MS;
	} catch (err) {
		debugLog({
			kind: "handoff-stat-failed",
			path,
			error: (err as Error).message,
		});
		return false;
	}
}

function msgKind(m: unknown): string {
	const o = m as { role?: unknown; type?: unknown };
	return (
		(typeof o?.role === "string" && o.role) ||
		(typeof o?.type === "string" && o.type) ||
		"?"
	);
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

// Precedence: env var → saved config → built-in default (80% of window).
function effectiveThreshold(): Threshold {
	const env = process.env.PI_HANDOFF_THRESHOLD;
	if (env) {
		const parsed = parseThresholdSpec(env);
		if (parsed) return parsed;
	}
	const cfg = normalizeStoredThreshold(getConfig().threshold);
	if (cfg) return cfg;
	return { type: "percent", value: DEFAULT_THRESHOLD_PCT };
}

// Returns true when the current usage has crossed the configured threshold.
// Uses the unit the user picked: percent compares against `usage.percent`,
// tokens compares against `usage.tokens`. Either field can be null right after
// compaction — in that case we report "not crossed" and wait for the next
// turn's measurement.
function isOverThreshold(
	usage: { percent: number | null; tokens: number | null },
	t: Threshold,
): boolean {
	if (t.type === "percent") {
		return usage.percent != null && usage.percent >= t.value;
	}
	return usage.tokens != null && usage.tokens >= t.value;
}

function handoffPath(cwd: string): string {
	const p = process.env.PI_HANDOFF_PATH?.trim() || DEFAULT_REL_PATH;
	return isAbsolute(p) ? p : join(cwd, p);
}

// Round percent for display; debounce math stays on the raw float.
function fmtPct(n: number): string {
	return `${Math.round(n)}%`;
}

// Human-friendly description of *current* usage relative to the chosen unit.
// Used in notifications/handoff headers so the message matches the unit the
// user configured ("context at 82%" vs "context at 142k tokens").
function fmtUsage(
	usage: { percent: number | null; tokens: number | null },
	t: Threshold,
): string {
	if (t.type === "tokens" && usage.tokens != null) {
		return `${formatTokens(usage.tokens)} tokens`;
	}
	if (usage.percent != null) return fmtPct(usage.percent);
	if (usage.tokens != null) return `${formatTokens(usage.tokens)} tokens`;
	return "unknown";
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
					Number(a.m.provider === curProvider) ||
				compareModelCost(a.m, b.m) ||
				`${a.m.provider}/${a.m.id}`.localeCompare(`${b.m.provider}/${b.m.id}`),
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
function hasKnownCost(m: Model<Api>): boolean {
	return (
		typeof m.cost?.input === "number" && typeof m.cost?.output === "number"
	);
}

function compareModelCost(a: Model<Api>, b: Model<Api>): number {
	const aKnown = hasKnownCost(a);
	const bKnown = hasKnownCost(b);
	if (aKnown !== bKnown) return aKnown ? -1 : 1;
	return (
		(a.cost?.input ?? Number.POSITIVE_INFINITY) -
			(b.cost?.input ?? Number.POSITIVE_INFINITY) ||
		(a.cost?.output ?? Number.POSITIVE_INFINITY) -
			(b.cost?.output ?? Number.POSITIVE_INFINITY)
	);
}

function modelLabel(m: Model<Api>, nameWidth: number): string {
	const name = `${m.provider}/${m.id}`;
	const cost = hasKnownCost(m)
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
		ctx.ui.notify(
			`[handoff] No usable auth for ${model.id}; skipped.`,
			"warning",
		);
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
	const usageLine =
		usage?.percent != null && usage?.tokens != null
			? `- Context at generation: ${fmtPct(usage.percent)} (${formatTokens(usage.tokens)} tokens)`
			: usage?.percent != null
				? `- Context at generation: ${fmtPct(usage.percent)}`
				: usage?.tokens != null
					? `- Context at generation: ${formatTokens(usage.tokens)} tokens`
					: "";
	const header = [
		"<!-- pi-handoff: auto-generated. Safe to edit or delete. -->",
		"# Session Handoff",
		"",
		`- Generated: ${new Date().toISOString()}`,
		`- Reason: ${reason}`,
		`- Session: ${ctx.sessionManager.getSessionId()}`,
		`- Conversation model: ${ctx.model?.id ?? "unknown"}`,
		`- Summarizer: ${model.id}`,
		usageLine,
		"",
		"---",
		"",
	]
		.filter(Boolean)
		.join("\n");

	if (signal?.aborted) return undefined;

	const path = handoffPath(ctx.sessionManager.getCwd());
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${header}\n${summary}\n`, { mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch (err) {
		debugLog({
			kind: "handoff-chmod-failed",
			path,
			error: (err as Error).message,
		});
	}
	return path;
}

type UserMsg = Extract<AgentMessage, { role: "user" }>;

function isUserMessage(m: AgentMessage): m is UserMsg {
	return (m as { role?: unknown }).role === "user";
}

// Merge the handoff into the FIRST user message rather than prepending a
// separate one — back-to-back user messages break strict-alternation backends
// (Anthropic via Bedrock/SAP).
function injectHandoff(
	messages: AgentMessage[],
	handoff: string,
): AgentMessage[] {
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
	// Highest context usage we've successfully written a handoff for, so we
	// debounce regeneration. Reset whenever the context shrinks (compaction / new session).
	let lastGenPct: number | null = null;
	let lastGenTokens: number | null = null;
	let busy = false;
	let autoGeneration: AbortController | undefined;
	let generationId = 0;
	let pendingInjection: string | undefined;

	function resetDebounce(): void {
		lastGenPct = null;
		lastGenTokens = null;
	}

	function shouldDebounce(
		usage: {
			percent: number | null;
			tokens: number | null;
			contextWindow: number;
		},
		threshold: Threshold,
	): boolean {
		if (threshold.type === "percent") {
			return (
				usage.percent == null ||
				(lastGenPct != null && usage.percent < lastGenPct + REFRESH_STEP)
			);
		}

		if (usage.tokens == null) return true;
		const tokenStep = Math.max(
			1,
			Math.round(
				((usage.contextWindow || threshold.value) * REFRESH_STEP) / 100,
			),
		);
		return lastGenTokens != null && usage.tokens < lastGenTokens + tokenStep;
	}

	function markGenerated(
		usage: { percent: number | null; tokens: number | null },
		threshold: Threshold,
	): void {
		if (threshold.type === "percent") {
			lastGenPct = usage.percent;
		} else {
			lastGenTokens = usage.tokens;
		}
	}

	// --- Threshold watcher: fire-and-forget so we never block the turn. -------
	pi.on("turn_end", (_event, ctx) => {
		const usage = ctx.getContextUsage();
		if (!usage) return;
		const threshold = effectiveThreshold();
		if (!isOverThreshold(usage, threshold)) return;
		if (busy || shouldDebounce(usage, threshold)) return;

		busy = true;
		autoGeneration?.abort();
		const controller = new AbortController();
		autoGeneration = controller;
		const thisGeneration = ++generationId;
		const usageStr = fmtUsage(usage, threshold);
		void (async () => {
			try {
				const path = await generateHandoff(
					ctx,
					`auto: context ${usageStr}`,
					controller.signal,
				);
				if (
					path &&
					!controller.signal.aborted &&
					thisGeneration === generationId
				) {
					markGenerated(usage, threshold);
					ctx.ui.notify(
						`[handoff] Context at ${usageStr} — saved handoff to ${path}. ` +
							"Consider /compact or a new session (it'll offer to reload this).",
						"warning",
					);
				}
			} catch (err) {
				if (!controller.signal.aborted && !signalAborted(ctx)) {
					ctx.ui.notify(
						`[handoff] Generation failed: ${(err as Error).message}`,
						"warning",
					);
				}
			} finally {
				if (autoGeneration === controller) {
					autoGeneration = undefined;
					busy = false;
				}
			}
		})();
	});

	// Phase 2 — replace pi's default compaction summary with our structured
	// handoff format, so the in-context summary after /compact carries the same
	// Goal/State/Next-Steps shape. Returns undefined (→ pi's default compaction)
	// on opt-out or any failure.
	pi.on("session_before_compact", async (event, ctx) => {
		debugLog({
			kind: "compaction-hook-fired",
			enabled: compactionEnrichEnabled(),
		});
		if (!compactionEnrichEnabled()) return;

		const model = pickSummaryModel(ctx);
		if (!model) {
			debugLog({ kind: "compaction-fallback", reason: "no-model" });
			ctx.ui.notify(
				"[handoff] No model for compaction; using pi default.",
				"warning",
			);
			return;
		}
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			debugLog({
				kind: "compaction-fallback",
				reason: "no-auth",
				model: model.id,
				error: auth.ok ? "missing-apiKey" : auth.error,
			});
			ctx.ui.notify(
				`[handoff] No auth for ${model.id}; using pi default compaction.`,
				"warning",
			);
			return;
		}

		const { preparation } = event;
		const older = [
			...preparation.messagesToSummarize,
			...preparation.turnPrefixMessages,
		];
		const conversation = serializeConversation(convertToLlm(older));
		debugLog({
			kind: "compaction",
			model: model.id,
			toSummarize: preparation.messagesToSummarize.length,
			turnPrefix: preparation.turnPrefixMessages.length,
			olderKinds: older.map(msgKind),
			conversationLen: conversation.length,
			conversationPreview: conversation.slice(0, 400),
			hasPreviousSummary: Boolean(preparation.previousSummary),
		});
		if (!conversation.trim()) {
			debugLog({ kind: "compaction-fallback", reason: "empty-conversation" });
			ctx.ui.notify(
				"[handoff] Nothing to summarize for compaction " +
					`(toSummarize=${preparation.messagesToSummarize.length}, ` +
					`turnPrefix=${preparation.turnPrefixMessages.length}); using pi default.`,
				"warning",
			);
			return;
		}

		const prior = preparation.previousSummary
			? `\n\nEarlier summary, for continuity:\n${preparation.previousSummary}`
			: "";
		const customInstructions = event.customInstructions?.trim()
			? `\n\nAdditional user instructions for this compaction:\n${event.customInstructions.trim()}`
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
									text: `${COMPACTION_PROMPT}${prior}${customInstructions}\n\n<conversation>\n${conversation}\n</conversation>`,
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
			debugLog({
				kind: "compaction-result",
				summaryLen: summary.length,
				summaryPreview: summary.slice(0, 200),
			});
			if (!summary) {
				ctx.ui.notify(
					"[handoff] Empty compaction summary; using pi default.",
					"warning",
				);
				return; // fall back to pi's default compaction
			}

			const { readFiles, modifiedFiles } = computeFileLists(
				preparation.fileOps,
			);
			const summaryWithFiles =
				summary + formatFileOperations(readFiles, modifiedFiles);

			debugLog({ kind: "compaction-applied", model: model.id });
			ctx.ui.notify(`[handoff] Structured compaction via ${model.id}.`, "info");
			return {
				compaction: {
					summary: summaryWithFiles,
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					details: { readFiles, modifiedFiles },
				},
			};
		} catch (err) {
			// Don't break compaction — fall back to pi's default — but say so.
			debugLog({
				kind: "compaction-fallback",
				reason: "exception",
				error: (err as Error).message,
			});
			ctx.ui.notify(
				`[handoff] Compaction enrichment failed (using pi default): ${(err as Error).message}`,
				"warning",
			);
			return;
		}
	});

	// Context shrinks after compaction — allow the next threshold crossing to regenerate.
	pi.on("session_compact", () => {
		resetDebounce();
	});

	pi.on("session_shutdown", () => {
		generationId++;
		autoGeneration?.abort();
		autoGeneration = undefined;
		busy = false;
	});

	// --- New/resumed session: offer to reload a recent handoff. ---------------
	pi.on("session_start", async (event, ctx) => {
		resetDebounce();
		// Offer reload on a genuinely fresh session (`new`) or on a fresh launch
		// (`startup` — the crash-recovery case). Skip `resume`/`reload`/`fork`:
		// those restore the full history, so a handoff would be redundant.
		if (event.reason !== "new" && event.reason !== "startup") return;
		if (!ctx.hasUI) return;

		const path = handoffPath(ctx.sessionManager.getCwd());
		if (!existsSync(path)) return;
		if (!isFreshHandoffFile(path)) return;

		const content = readHandoffFile(path);
		if (!content) return;
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
			ctx.ui.notify(
				"[handoff] Loaded — injected on your next message.",
				"info",
			);
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
					const usage = ctx.getContextUsage();
					if (usage) markGenerated(usage, effectiveThreshold());
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
			const content = readHandoffFile(path);
			if (!content) {
				ctx.ui.notify(
					`[handoff] Could not read handoff doc at ${path}.`,
					"warning",
				);
				return;
			}
			pendingInjection = content;
			ctx.ui.notify(
				"[handoff] Loaded — injected on your next message.",
				"info",
			);
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
						"PI_HANDOFF_MODEL=provider/id, " +
						"PI_HANDOFF_THRESHOLD=80% (or 120k).",
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
						compareModelCost(a, b) ||
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

			// Step 2 — trigger threshold (mode + value).
			const currentThreshold: Threshold = normalizeStoredThreshold(
				cfg.threshold,
			) ?? { type: "percent", value: DEFAULT_THRESHOLD_PCT };

			const PERCENT_LABEL = `Percentage of context window  (current: ${
				currentThreshold.type === "percent"
					? `${currentThreshold.value}%`
					: `${DEFAULT_THRESHOLD_PCT}%`
			})`;
			const TOKENS_LABEL = `Absolute token count${
				currentThreshold.type === "tokens"
					? `  (current: ${formatTokens(currentThreshold.value)})`
					: ""
			}`;
			const mode = await ctx.ui.select("Trigger mode", [
				PERCENT_LABEL,
				TOKENS_LABEL,
			]);
			if (mode === undefined) {
				ctx.ui.notify("[handoff] Setup cancelled.", "info");
				return;
			}

			let threshold: Threshold = currentThreshold;
			if (mode === PERCENT_LABEL) {
				const dflt =
					currentThreshold.type === "percent"
						? currentThreshold.value
						: DEFAULT_THRESHOLD_PCT;
				const entered = await ctx.ui.input(
					`Trigger at what % of context? (1–99, blank = ${dflt})`,
					String(dflt),
				);
				if (entered && entered.trim()) {
					const n = Number(entered.trim());
					if (isValidPercent(n)) {
						threshold = { type: "percent", value: n };
					} else {
						ctx.ui.notify(
							`[handoff] "${entered.trim()}" isn't 1–99; keeping ${dflt}%.`,
							"warning",
						);
						threshold = { type: "percent", value: dflt };
					}
				} else {
					threshold = { type: "percent", value: dflt };
				}
			} else {
				// Tokens. Default to current value if user is already in token mode;
				// otherwise suggest 80% of the active model's context window when known.
				const window =
					ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow;
				const suggested =
					currentThreshold.type === "tokens"
						? currentThreshold.value
						: window
							? Math.round((window * DEFAULT_THRESHOLD_PCT) / 100)
							: undefined;
				const dfltStr = suggested != null ? formatTokens(suggested) : "";
				const hint =
					suggested != null
						? `e.g. 120000 or 120k, blank = ${dfltStr}`
						: `e.g. 120000 or 120k`;
				const entered = await ctx.ui.input(
					`Trigger at how many tokens? (${hint})`,
					dfltStr,
				);
				const trimmed = entered?.trim();
				if (trimmed) {
					const n = parseTokenCount(trimmed);
					if (n != null && isValidTokenCount(n)) {
						threshold = { type: "tokens", value: n };
					} else {
						if (suggested != null) {
							ctx.ui.notify(
								`[handoff] "${trimmed}" isn't a valid token count; keeping ${formatTokens(suggested)}.`,
								"warning",
							);
							threshold = { type: "tokens", value: suggested };
						} else {
							ctx.ui.notify(
								`[handoff] "${trimmed}" isn't a valid token count; keeping previous setting.`,
								"warning",
							);
						}
					}
				} else if (suggested != null) {
					threshold = { type: "tokens", value: suggested };
				} else {
					ctx.ui.notify(
						"[handoff] No token value entered and no model context window known; " +
							"keeping previous threshold.",
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
					`threshold: ${formatThreshold(threshold)}, ` +
					`compaction: ${compaction}.`,
				"info",
			);
		},
	});
}

function signalAborted(ctx: ExtensionContext): boolean {
	return ctx.signal?.aborted === true;
}
