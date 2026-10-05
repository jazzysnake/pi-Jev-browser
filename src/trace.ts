import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { CONFIG_PATH, expandHome, readConfigFile } from "./config.ts";
import { configurationError } from "./errors.ts";

/**
 * One recorded Jev decision: the exact state and typed questions that went in,
 * and the answer that came back. The pair is the training example; the metadata
 * around it is provenance. Written as one JSON object per line, so a later
 * training run can stream the file without a parser for a surrounding format.
 */
export interface DecisionRecord {
	/** Bumped if the shape changes, so a training pipeline can refuse the old one. */
	version: 1;
	at: string;
	/** One jev_run call: every decision of a run shares it. */
	runId: string;
	/** The pi session the run belongs to. */
	sessionId?: string;
	/** Which decision this was: a plan step, the next action, or a field's text. */
	kind: DecisionKind;
	model?: string;
	baseUrl?: string;
	latencyMs: number;
	/** The request as sent: `state` is the JSON string Jev reads. */
	request: { state: unknown; questions: unknown };
	/** The raw answer, kept whole so a re-scoring pass does not need the API. */
	response?: unknown;
	/** Set instead of `response` when the call failed, so timeouts are data too. */
	error?: string;
}

export type DecisionKind = "plan" | "action" | "text";

export interface DecisionLogConfig {
	/** A directory (one file per run) or a `.jsonl`/`.ndjson` file (appended). */
	path: string;
}

export interface DecisionLogger {
	/** Absolute path this logger writes to. */
	readonly file: string;
	readonly runId: string;
	record(entry: Omit<DecisionRecord, "version" | "at" | "runId" | "sessionId" | "model" | "baseUrl">): void;
}

const FILE_EXTENSIONS = new Set([".jsonl", ".ndjson"]);

/**
 * The decision log is opt-in: without `decisionLog.path` nothing is written, so
 * a default installation never puts page content on disk. An explicit
 * `"enabled": false` keeps the path in the file but turns the log off.
 */
export function readDecisionLogConfig(
	options: { path?: string; env?: NodeJS.ProcessEnv } = {},
): DecisionLogConfig | undefined {
	const configPath = options.path ?? CONFIG_PATH;
	const env = options.env ?? process.env;
	const raw = readConfigFile(configPath);
	const log = raw.decisionLog as { path?: unknown; enabled?: unknown } | undefined;
	const value = (input: unknown) =>
		typeof input === "string" ? input.trim() : "";

	if (log?.enabled === false) return undefined;
	const path =
		value(env.PI_JEV_BROWSER_DECISION_LOG) || value(log?.path);
	if (!path) return undefined;
	return { path: resolve(expandHome(path)) };
}

/**
 * Append-only decision log. The directory is created and checked here, before
 * the browser starts, so a bad path fails as a setup problem rather than
 * mid-run. A write that fails later stops the logger instead of the run:
 * collecting training data must never break the loop it observes.
 */
export function createDecisionLogger(
	config: DecisionLogConfig,
	context: { runId?: string; sessionId?: string; model?: string; baseUrl?: string } = {},
): DecisionLogger {
	const runId = context.runId ?? randomUUID();
	const file = FILE_EXTENSIONS.has(extname(config.path))
		? config.path
		: resolve(config.path, `${runId}.jsonl`);
	try {
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	} catch (error) {
		throw configurationError(
			`Cannot create the decision log at ${file}: ${error instanceof Error ? error.message : String(error)}. Fix decisionLog.path in ${CONFIG_PATH} or remove it to disable the log.`,
		);
	}
	let writable = true;
	return {
		file,
		runId,
		record(entry) {
			if (!writable) return;
			const record: DecisionRecord = {
				version: 1,
				at: new Date().toISOString(),
				runId,
				...(context.sessionId ? { sessionId: context.sessionId } : {}),
				...(context.model ? { model: context.model } : {}),
				...(context.baseUrl ? { baseUrl: context.baseUrl } : {}),
				...entry,
			};
			try {
				// 0600: page content can hold personal data, and this file is training
				// data, not an artifact to publish.
				appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
			} catch {
				writable = false;
			}
		},
	};
}
