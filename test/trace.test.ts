import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJevPolicy, createTypeSafeClient } from "../src/policy.ts";
import type { Observation } from "../src/observe.ts";
import { createDecisionLogger, readDecisionLogConfig } from "../src/trace.ts";

/** The smallest observation that exercises one action decision. */
const observation: Observation = {
	url: "https://example.test",
	title: "Search",
	text: "Search",
	scrollUp: false,
	scrollDown: false,
	targets: [{ id: "1", operation: "TYPE_TEXT", label: "Query", value: "" }],
};

test("the decision log is opt-in and reads path, enabled and the env override", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-jev-browser-trace-"));
	const path = join(directory, "config.json");
	try {
		// Absent, blank and explicitly disabled all leave the log off, so a default
		// installation never writes page content to disk.
		assert.equal(readDecisionLogConfig({ path, env: {} }), undefined);
		writeFileSync(path, JSON.stringify({ decisionLog: { path: "   " } }));
		assert.equal(readDecisionLogConfig({ path, env: {} }), undefined);
		writeFileSync(
			path,
			JSON.stringify({ decisionLog: { path: join(directory, "logs"), enabled: false } }),
		);
		assert.equal(readDecisionLogConfig({ path, env: {} }), undefined);

		writeFileSync(path, JSON.stringify({ decisionLog: { path: "~/traces" } }));
		assert.deepEqual(readDecisionLogConfig({ path, env: {} }), {
			path: join(homedir(), "traces"),
		});
		assert.deepEqual(
			readDecisionLogConfig({
				path,
				env: { PI_JEV_BROWSER_DECISION_LOG: join(directory, "from-env") },
			}),
			{ path: join(directory, "from-env") },
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a logger writes one JSONL record per decision into a directory", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-jev-browser-trace-"));
	try {
		const logger = createDecisionLogger(
			{ path: join(directory, "logs") },
			{
				runId: "run-1",
				sessionId: "session-1",
				model: "jev-latest",
				baseUrl: "https://api.typesafe.ai",
			},
		);
		assert.equal(logger.file, join(directory, "logs", "run-1.jsonl"));
		logger.record({
			kind: "action",
			latencyMs: 12,
			request: { state: '{"page":"x"}', questions: { action: { type: "choice" } } },
			response: { answers: { action: { type: "choice", choice: "CLICK:1" } } },
		});
		// A failed call is data too: it records why, instead of a response.
		logger.record({
			kind: "text",
			latencyMs: 7,
			request: { state: '{"page":"x"}', questions: {} },
			error: "Request timed out after 10000ms.",
		});

		const records = readFileSync(logger.file, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.equal(records.length, 2);
		assert.equal(records[0].version, 1);
		assert.equal(records[0].runId, "run-1");
		assert.equal(records[0].sessionId, "session-1");
		assert.equal(records[0].model, "jev-latest");
		assert.equal(records[0].baseUrl, "https://api.typesafe.ai");
		assert.match(records[0].at, /^\d{4}-\d{2}-\d{2}T/);
		assert.equal(records[0].kind, "action");
		assert.equal(records[0].latencyMs, 12);
		assert.deepEqual(records[0].request.questions, { action: { type: "choice" } });
		assert.equal(records[0].response.answers.action.choice, "CLICK:1");
		assert.equal(records[1].error, "Request timed out after 10000ms.");
		assert.equal(records[1].response, undefined);

		// Records are page content, so the file is private.
		if (process.platform !== "win32")
			assert.equal(statSync(logger.file).mode & 0o777, 0o600);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a .jsonl path appends every run to one file, and a bad path fails as config", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-jev-browser-trace-"));
	try {
		const file = join(directory, "all.jsonl");
		for (const runId of ["a", "b"]) {
			const logger = createDecisionLogger({ path: file }, { runId });
			assert.equal(logger.file, file);
			logger.record({
				kind: "plan",
				latencyMs: 1,
				request: { state: "s", questions: {} },
			});
		}
		const records = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.deepEqual(
			records.map((record) => record.runId),
			["a", "b"],
		);

		// A path that cannot be created is a setup error, reported before the
		// browser starts rather than as a mid-run mystery.
		writeFileSync(join(directory, "blocker"), "not a directory");
		assert.throws(
			() => createDecisionLogger({ path: join(directory, "blocker", "nested") }),
			/Cannot create the decision log/,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a policy records the exact pair it sent and the answer it got", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-jev-browser-trace-"));
	try {
		const client = createTypeSafeClient(
			{
				apiKey: "offline-test-key",
				baseUrl: "https://typesafe.example.test",
				model: "jev-latest",
			},
			{
				fetch: async (_input, init) => {
					const body = JSON.parse(String(init?.body));
					const choices = Object.keys(body.questions.action.criteria);
					return Response.json({
						model: "jev-latest",
						answers: {
							action: {
								type: "choice",
								choice: "WAIT",
								confidence: 0.5,
								probabilities: Object.fromEntries(
									choices.map((choice) => [choice, 1 / choices.length]),
								),
							},
						},
						usage: { input_tokens: 1, output_tokens: 0 },
					});
				},
			},
		);
		const logger = createDecisionLogger(
			{ path: join(directory, "logs") },
			{ runId: "run-2" },
		);
		const policy = createJevPolicy({
			text: async () => ({ text: "x" }),
			client,
			logger,
		});
		await policy.choose(observation, "Search", [], new AbortController().signal);

		const [record] = readFileSync(logger.file, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.equal(record.kind, "action");
		assert.equal(record.runId, "run-2");
		// The input is the exact state the loop sent, not a re-serialized copy.
		assert.equal(
			record.request.state,
			JSON.stringify({ page: observation, recentActions: [] }),
		);
		assert.equal(record.request.questions.action.type, "choice");
		assert.equal(record.response.answers.action.choice, "WAIT");
		assert.equal(typeof record.latencyMs, "number");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
