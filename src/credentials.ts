import { CONFIG_PATH, readConfigFile } from "./config.ts";
import { configurationError } from "./errors.ts";

const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_MODEL = "jev-latest";
/**
 * Sent to a self-hosted endpoint on the loopback interface so the SDK's
 * non-empty-key check passes. Local servers (Kev, Laya, Von) ignore it unless
 * their own key is configured.
 */
const LOCAL_API_KEY = "local";

/** localhost, 127.0.0.0/8, or ::1: a server on this machine, not TypeSafe. */
function isLoopbackUrl(value: string): boolean {
	let host: string;
	try {
		host = new URL(value).hostname;
	} catch {
		return false;
	}
	const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
	return (
		bare === "localhost" ||
		bare === "::1" ||
		/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)
	);
}

export interface JevCredentials {
	apiKey: string;
	baseUrl: string;
	model: string;
}

/**
 * Read per run without mutating process.env or exposing credentials to Chromium.
 * Precedence: environment, then the JSON configuration file.
 */
export function readJevCredentials(
	options: { path?: string; env?: NodeJS.ProcessEnv } = {},
): JevCredentials {
	const path = options.path ?? CONFIG_PATH;
	const env = options.env ?? process.env;
	const raw = readConfigFile(path);
	const typesafe = raw.typesafe as
		| { apiKey?: unknown; baseUrl?: unknown; model?: unknown }
		| undefined;
	const value = (input: unknown) =>
		typeof input === "string" ? input.trim() : "";

	const baseUrl =
		value(env.TYPESAFE_BASE_URL) || value(typesafe?.baseUrl) || DEFAULT_BASE_URL;
	// A local, Jev-compatible server authenticates by nothing or by its own key,
	// so only a remote endpoint must carry a TypeSafe secret.
	const apiKey =
		value(env.TYPESAFE_API_KEY) ||
		value(typesafe?.apiKey) ||
		(isLoopbackUrl(baseUrl) ? LOCAL_API_KEY : "");
	if (!apiKey)
		throw configurationError(
			`The jev_run Jev loop requires TYPESAFE_API_KEY in the pi process environment or typesafe.apiKey in ${path}, unless typesafe.baseUrl points at a local server.`,
		);

	return {
		apiKey,
		baseUrl,
		model:
			value(env.TYPESAFE_DEFAULT_MODEL) ||
			value(typesafe?.model) ||
			DEFAULT_MODEL,
	};
}

/** Optional override for the pi model that generates field text. */
export function readTextHelperModel(
	options: { path?: string; env?: NodeJS.ProcessEnv } = {},
): string | undefined {
	const path = options.path ?? CONFIG_PATH;
	const env = options.env ?? process.env;
	const raw = readConfigFile(path);
	const textHelper = raw.textHelper as { model?: unknown } | undefined;
	const value = (input: unknown) =>
		typeof input === "string" ? input.trim() : "";
	return value(env.PI_JEV_BROWSER_TEXT_MODEL) || value(textHelper?.model) || undefined;
}
