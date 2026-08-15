import Schema from "@deepseek-ai/schemastery";
import { AttachmentId } from "@deepseek-ai/dsh-attachment";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { SessionId } from "@deepseek-ai/dsh-session";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

//#region src/codex.ts
const CONNECTOR_PACKAGE = "dsh-codex-connect";
const CODEX_PROVIDER_ID = "openai-codex";
const CODEX_AUTH_FILENAME = ".openai-codex-auth.json";
const AUTH_FORMAT_VERSION = 1;
const MAX_AUTH_DOCUMENT_BYTES = 16 * 1024;
const REFRESH_WINDOW_MS = 300 * 1e3;
/** Fixed first-party Codex endpoint. Subscription credentials never cross to configured origins. */
const CODEX_IMAGE_BASE_URL = "https://chatgpt.com/backend-api/codex";
function dshHome() {
	const configured = process.env.DSH_HOME?.trim();
	return configured === void 0 || configured.length === 0 ? join(homedir(), ".dsh") : configured;
}
async function defaultLoadConnector() {
	return import(CONNECTOR_PACKAGE);
}
async function defaultReadCodexAuthDocument(signal) {
	const filename = join(dshHome(), CODEX_AUTH_FILENAME);
	let info;
	try {
		info = await lstat(filename);
	} catch (error) {
		throw new Error("OpenAI Codex is signed out. Install dsh-codex-connect and sign in from DSH settings.", { cause: error });
	}
	if (!info.isFile() || info.isSymbolicLink()) throw new Error("The Codex OAuth store must be a regular file.");
	if (info.size < 2 || info.size > MAX_AUTH_DOCUMENT_BYTES) throw new Error("The Codex OAuth store has an invalid size.");
	if (process.platform !== "win32" && (info.mode & 63) !== 0) throw new Error("The Codex OAuth store is readable beyond its owner; run chmod 600 before retrying.");
	let text;
	try {
		text = await readFile(filename, {
			encoding: "utf8",
			signal
		});
	} catch (error) {
		signal.throwIfAborted();
		throw new Error("The Codex OAuth store could not be read.", { cause: error });
	}
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new Error("The Codex OAuth store is not valid JSON.", { cause: error });
	}
}
function exactKeys(record, allowed) {
	return Object.keys(record).every((key) => allowed.includes(key));
}
function parseCredential(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const credential = value;
	if (!exactKeys(credential, [
		"type",
		"access",
		"refresh",
		"expires",
		"accountId"
	])) return void 0;
	if (credential.type !== "oauth" || typeof credential.access !== "string" || credential.access.trim().length === 0 || credential.access.length > 16384 || typeof credential.refresh !== "string" || credential.refresh.trim().length === 0 || credential.refresh.length > 16384 || typeof credential.expires !== "number" || !Number.isFinite(credential.expires) || credential.expires <= 0 || typeof credential.accountId !== "string" || credential.accountId.trim().length === 0 || credential.accountId.length > 256) return void 0;
	return credential;
}
function parseDocument(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const document = value;
	if (document.version !== AUTH_FORMAT_VERSION || !exactKeys(document, ["version", "credential"])) return void 0;
	return parseCredential(document.credential);
}
function parseConnector(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const module = value;
	if (typeof module.OpenAICodexCredentialStore !== "function" || typeof module.readOpenAICodexRateLimits !== "function") return void 0;
	return module;
}
function connectorUnavailable(error) {
	if (typeof error !== "object" || error === null) return false;
	const record = error;
	return record.code === "ERR_MODULE_NOT_FOUND" && typeof record.message === "string" && record.message.startsWith(`Cannot find package '${CONNECTOR_PACKAGE}'`);
}
async function raceAbort(operation, signal) {
	signal.throwIfAborted();
	let onAbort;
	const aborted = new Promise((_resolve, reject) => {
		onAbort = () => reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([operation, aborted]);
	} finally {
		if (onAbort !== void 0) signal.removeEventListener("abort", onAbort);
	}
}
function project(credential, now) {
	if (credential.expires <= now) throw new Error("OpenAI Codex sign-in expired. Sign in again from Codex Connect settings or run \"dsh openai-codex login\".");
	return {
		accessToken: credential.access,
		accountId: credential.accountId
	};
}
/** Resolve the current DSH-owned Codex subscription credential without retaining it. */
async function resolveCodexSubscriptionAuth(signal, loadConnector = defaultLoadConnector, readDocument = defaultReadCodexAuthDocument, now = Date.now, trackWork) {
	signal.throwIfAborted();
	let loaded;
	try {
		loaded = await loadConnector();
	} catch (error) {
		signal.throwIfAborted();
		if (!connectorUnavailable(error)) throw new Error("Codex Connect could not be loaded safely.", { cause: error });
		const credential$1 = parseDocument(await readDocument(signal));
		signal.throwIfAborted();
		if (credential$1 === void 0) throw new Error("OpenAI Codex is signed out or its credential store is incompatible. Sign in again from Codex Connect settings.");
		return project(credential$1, now());
	}
	signal.throwIfAborted();
	const connector = parseConnector(loaded);
	if (connector === void 0) throw new Error("The installed dsh-codex-connect package is incompatible. Update it before using subscription image generation.");
	const store = new connector.OpenAICodexCredentialStore();
	let credential = parseCredential(await store.read(CODEX_PROVIDER_ID));
	signal.throwIfAborted();
	if (credential === void 0) throw new Error("OpenAI Codex is signed out. Sign in from Codex Connect settings.");
	if (credential.expires <= now() + REFRESH_WINDOW_MS) {
		let refreshError;
		const refreshWork = connector.readOpenAICodexRateLimits(store);
		trackWork?.(refreshWork);
		try {
			await raceAbort(refreshWork, signal);
		} catch (error) {
			signal.throwIfAborted();
			refreshError = error;
		}
		credential = parseCredential(await store.read(CODEX_PROVIDER_ID));
		signal.throwIfAborted();
		if (credential === void 0) throw new Error("OpenAI Codex refresh returned no usable credential. Sign in again from Codex Connect settings.");
		if (credential.expires <= now() && refreshError !== void 0) throw new Error("OpenAI Codex sign-in could not be refreshed. Sign in again from Codex Connect settings.", { cause: refreshError });
	}
	return project(credential, now());
}

//#endregion
//#region src/openai.ts
const MIN_PIXELS = 655360;
const MAX_PIXELS = 8294400;
const MAX_EDGE = 3840;
const MAX_ERROR_BYTES = 8192;
/** HTTP/protocol failure with a stable retry decision. */
var ImageApiError = class extends Error {
	status;
	code;
	retryable;
	constructor(message, options = {}) {
		super(message, options.cause === void 0 ? void 0 : { cause: options.cause });
		this.name = "ImageApiError";
		this.status = options.status;
		this.code = options.code;
		this.retryable = options.retryable ?? false;
	}
};
/** Validate an OpenAI base URL before a credential can be sent to it. */
function imageApiBaseUrl(value) {
	const url = new URL(value);
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new TypeError("baseUrl must use https, or http for a loopback host");
	if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") throw new TypeError("baseUrl must not contain credentials, a query, or a fragment");
	const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
	if (url.protocol !== "https:" && !loopback) throw new TypeError("baseUrl must use https outside loopback");
	return url.href.replace(/\/+$/u, "");
}
/** Validate GPT Image 2's automatic or arbitrary-resolution size. */
function imageSize(value) {
	if (value === "auto") return value;
	const match = /^(\d{2,4})x(\d{2,4})$/u.exec(value);
	if (match === null) throw new TypeError("size must be auto or WIDTHxHEIGHT");
	const width = Number(match[1]);
	const height = Number(match[2]);
	const pixels = width * height;
	if (width % 16 !== 0 || height % 16 !== 0) throw new TypeError("size edges must be divisible by 16");
	if (width > MAX_EDGE || height > MAX_EDGE) throw new TypeError(`size edges must not exceed ${MAX_EDGE}px`);
	if (pixels < MIN_PIXELS || pixels > MAX_PIXELS) throw new TypeError(`size must contain ${MIN_PIXELS}–${MAX_PIXELS} pixels`);
	const ratio = width / height;
	if (ratio < 1 / 3 || ratio > 3) throw new TypeError("size aspect ratio must be between 1:3 and 3:1");
	return `${width}x${height}`;
}
function isRecord$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function outputFormat(value, fallback) {
	return value === "png" || value === "jpeg" || value === "webp" ? value : fallback;
}
function quality(value, fallback) {
	return value === "auto" || value === "low" || value === "medium" || value === "high" ? value : fallback;
}
function background(value, fallback) {
	return value === "auto" || value === "opaque" ? value : fallback;
}
function usage(value) {
	if (!isRecord$1(value)) return void 0;
	const inputTokens = value.input_tokens;
	const outputTokens = value.output_tokens;
	const totalTokens = value.total_tokens;
	if (![
		inputTokens,
		outputTokens,
		totalTokens
	].every((item) => typeof item === "number" && Number.isSafeInteger(item) && item >= 0)) return;
	return {
		inputTokens,
		outputTokens,
		totalTokens
	};
}
function providerError(value) {
	const error = isRecord$1(value) && isRecord$1(value.error) ? value.error : isRecord$1(value) ? value : void 0;
	const code = typeof error?.code === "string" ? error.code : void 0;
	const message = typeof error?.message === "string" && error.message.trim() !== "" ? error.message : "OpenAI Image API request failed.";
	return {
		...code === void 0 ? {} : { code },
		message
	};
}
function safeProviderMessage(status, value) {
	const detail = providerError(value);
	if (detail.code === "moderation_blocked" || detail.code === "image_generation_user_error") return new ImageApiError(detail.code === "moderation_blocked" ? "Image generation was blocked by the provider safety policy. Revise the prompt and try again." : detail.message, {
		status,
		...detail.code === void 0 ? {} : { code: detail.code }
	});
	return new ImageApiError(detail.message, {
		status,
		...detail.code === void 0 ? {} : { code: detail.code },
		retryable: status === 429 || status >= 500
	});
}
function base64Bytes(value, maximum) {
	const maximumChars = Math.ceil(maximum / 3) * 4 + 8;
	if (value.length === 0 || value.length > maximumChars || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) throw new ImageApiError("OpenAI returned invalid or oversized image data.");
	const bytes = Buffer.from(value, "base64");
	if (bytes.byteLength === 0 || bytes.byteLength > maximum) throw new ImageApiError("OpenAI returned invalid or oversized image data.");
	return bytes;
}
function ssePayload(chunk) {
	const data = chunk.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
	if (data === "" || data === "[DONE]") return void 0;
	try {
		return JSON.parse(data);
	} catch (error) {
		throw new ImageApiError("OpenAI returned malformed streaming JSON.", {
			cause: error,
			retryable: true
		});
	}
}
async function* readSse(body, signal, maximumEventChars, maximumTotalBytes) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let totalBytes = 0;
	let reachedEnd = false;
	const abort = () => {
		reader.cancel(signal.reason).catch(() => {});
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		while (true) {
			signal.throwIfAborted();
			const { done, value } = await reader.read();
			signal.throwIfAborted();
			if (done) {
				reachedEnd = true;
				break;
			}
			totalBytes += value.byteLength;
			if (totalBytes > maximumTotalBytes) throw new ImageApiError("OpenAI image stream exceeded its byte limit.");
			buffer += decoder.decode(value, { stream: true }).replaceAll("\r", "");
			let boundary = buffer.indexOf("\n\n");
			while (boundary >= 0) {
				if (boundary > maximumEventChars) throw new ImageApiError("OpenAI image stream event exceeded its byte limit.");
				const payload$1 = ssePayload(buffer.slice(0, boundary));
				buffer = buffer.slice(boundary + 2);
				if (payload$1 !== void 0) yield payload$1;
				boundary = buffer.indexOf("\n\n");
			}
			if (buffer.length > maximumEventChars) throw new ImageApiError("OpenAI image stream event exceeded its byte limit.");
		}
		buffer += decoder.decode().replaceAll("\r", "");
		const payload = ssePayload(buffer.trim());
		if (payload !== void 0) yield payload;
	} finally {
		signal.removeEventListener("abort", abort);
		if (!reachedEnd) try {
			await reader.cancel(signal.reason);
		} catch {}
		reader.releaseLock();
	}
}
async function boundedResponseText(response, maximumBytes, signal, truncate) {
	if (response.body === null) return "";
	const reader = response.body.getReader();
	const chunks = [];
	let totalBytes = 0;
	let reachedEnd = false;
	let cancelled = false;
	const abort = () => {
		reader.cancel(signal.reason).catch(() => {});
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		while (true) {
			signal.throwIfAborted();
			const { done, value } = await reader.read();
			signal.throwIfAborted();
			if (done) {
				reachedEnd = true;
				break;
			}
			const remaining = maximumBytes - totalBytes;
			if (value.byteLength > remaining) {
				if (truncate && remaining > 0) chunks.push(value.subarray(0, remaining));
				cancelled = true;
				await reader.cancel("response byte limit reached");
				if (!truncate) throw new ImageApiError("OpenAI JSON response exceeded its byte limit.");
				break;
			}
			chunks.push(value);
			totalBytes += value.byteLength;
		}
	} finally {
		signal.removeEventListener("abort", abort);
		if (!reachedEnd && !cancelled) try {
			await reader.cancel(signal.reason);
		} catch {}
		reader.releaseLock();
	}
	const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}
function parsedResponse(text) {
	if (text === "") return {};
	try {
		return JSON.parse(text);
	} catch {
		return { message: text };
	}
}
async function responseErrorBody(response, signal) {
	return parsedResponse(await boundedResponseText(response, MAX_ERROR_BYTES, signal, true));
}
async function responseImageBody(response, signal, maximumImageBytes) {
	const text = await boundedResponseText(response, Math.ceil(maximumImageBytes / 3) * 4 + 65536, signal, false);
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new ImageApiError("OpenAI returned malformed image JSON.", {
			cause: error,
			retryable: true
		});
	}
}
function completedFromEvent(event, request, maximum) {
	if (event.type !== "image_generation.completed" || typeof event.b64_json !== "string") return void 0;
	const parsedUsage = usage(event.usage);
	return {
		data: base64Bytes(event.b64_json, maximum),
		size: typeof event.size === "string" ? event.size : request.size,
		quality: quality(event.quality, request.quality),
		outputFormat: outputFormat(event.output_format, request.outputFormat),
		background: background(event.background, request.background),
		...parsedUsage === void 0 ? {} : { usage: parsedUsage }
	};
}
function retryDelay(response, base, attempt) {
	const raw = response?.headers.get("retry-after");
	if (raw !== null && raw !== void 0) {
		const seconds = Number(raw);
		if (Number.isFinite(seconds) && seconds >= 0) return Math.min(3e4, seconds * 1e3);
		const date = Date.parse(raw);
		if (Number.isFinite(date)) return Math.min(3e4, Math.max(0, date - Date.now()));
	}
	return Math.min(1e4, base * 2 ** Math.max(0, attempt - 1));
}
function wait(ms, signal) {
	return new Promise((resolve, reject) => {
		const finish = () => {
			signal.removeEventListener("abort", abort);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		const abort = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			reject(signal.reason);
		};
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
	});
}
/** Direct Image API client with redirect rejection and bounded retries. */
var OpenAIImageClient = class {
	endpoint;
	fetchImpl;
	protocol;
	constructor(options) {
		this.options = options;
		const baseUrl = imageApiBaseUrl(options.baseUrl);
		this.protocol = options.protocol ?? "openai-api";
		if (this.protocol === "codex-subscription") {
			if (baseUrl !== CODEX_IMAGE_BASE_URL) throw new TypeError("Codex subscription credentials may be sent only to the first-party Codex endpoint");
			if (options.accountId === void 0 || options.accountId.length === 0 || options.accountId.length > 256) throw new TypeError("Codex subscription mode requires a valid ChatGPT account id");
			if (options.turnId === void 0 || options.turnId.length === 0 || options.turnId.length > 512) throw new TypeError("Codex subscription mode requires a valid image turn id");
		}
		this.endpoint = `${baseUrl}/images/generations`;
		this.fetchImpl = options.fetchImpl ?? fetch;
	}
	/** Generate one image and surface progressive partial frames. */
	async generate(request, signal, onProgress) {
		const body = JSON.stringify({
			model: this.options.model,
			prompt: request.prompt,
			size: request.size,
			quality: request.quality,
			background: request.background,
			n: 1,
			...this.protocol === "codex-subscription" ? {} : {
				output_format: request.outputFormat,
				...request.outputFormat === "png" || request.outputCompression === void 0 ? {} : { output_compression: request.outputCompression },
				moderation: this.options.moderation,
				stream: true,
				partial_images: this.options.partialImages
			}
		});
		let lastError;
		for (let attempt = 1; attempt <= this.options.maxRetries + 1; attempt += 1) {
			signal.throwIfAborted();
			onProgress({
				kind: "requesting",
				attempt
			});
			let response;
			try {
				response = await this.fetchImpl(this.endpoint, {
					method: "POST",
					redirect: "error",
					headers: {
						accept: this.protocol === "codex-subscription" ? "application/json" : "text/event-stream",
						authorization: `Bearer ${this.options.apiKey}`,
						"content-type": "application/json",
						...this.protocol === "codex-subscription" ? {
							"chatgpt-account-id": this.options.accountId,
							"x-codex-image-turn-id": this.options.turnId,
							originator: "deepseek-harness"
						} : {}
					},
					body,
					signal
				});
				if (!response.ok) throw safeProviderMessage(response.status, await responseErrorBody(response, signal));
				onProgress({
					kind: "generating",
					attempt
				});
				if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
					const value = await responseImageBody(response, signal, this.options.maxImageBytes);
					if (!isRecord$1(value) || !Array.isArray(value.data) || !isRecord$1(value.data[0]) || typeof value.data[0].b64_json !== "string") throw new ImageApiError("OpenAI returned no image.", { retryable: true });
					const parsedUsage = usage(value.usage);
					return {
						data: base64Bytes(value.data[0].b64_json, this.options.maxImageBytes),
						size: typeof value.size === "string" ? value.size : request.size,
						quality: quality(value.quality, request.quality),
						outputFormat: outputFormat(value.output_format, request.outputFormat),
						background: background(value.background, request.background),
						...parsedUsage === void 0 ? {} : { usage: parsedUsage }
					};
				}
				if (response.body === null) throw new ImageApiError("OpenAI returned an empty image stream.", { retryable: true });
				const maximumEventChars = Math.ceil(this.options.maxImageBytes / 3) * 4 + 16384;
				const maximumTotalBytes = (this.options.partialImages + 1) * maximumEventChars + 65536;
				for await (const raw of readSse(response.body, signal, maximumEventChars, maximumTotalBytes)) {
					if (!isRecord$1(raw)) continue;
					const event = raw;
					if (event.type === "error") throw safeProviderMessage(502, event);
					if (event.type === "image_generation.partial_image" && typeof event.b64_json === "string") {
						base64Bytes(event.b64_json, this.options.maxImageBytes);
						onProgress({
							kind: "partial",
							attempt,
							index: typeof event.partial_image_index === "number" ? event.partial_image_index : 0,
							outputFormat: outputFormat(event.output_format, request.outputFormat),
							data: event.b64_json
						});
					}
					const completed = completedFromEvent(event, request, this.options.maxImageBytes);
					if (completed !== void 0) return completed;
				}
				throw new ImageApiError("OpenAI ended the image stream before completion.", { retryable: true });
			} catch (error) {
				if (signal.aborted) throw signal.reason;
				lastError = error;
				if (!(error instanceof ImageApiError ? error.retryable : true) || attempt > this.options.maxRetries) throw error;
				onProgress({
					kind: "retrying",
					attempt
				});
				await wait(retryDelay(response, this.options.retryBaseMs, attempt), signal);
			}
		}
		throw lastError;
	}
};

//#endregion
//#region src/rpc.ts
/** Private loopback RPC names shared by the Host and browser halves. */
const IMAGE_GEN_RPC_CHANNEL = "/dsh-image-gen";
/** Versioned endpoints for live progress and durable image reads. */
const IMAGE_GEN_RPC_ENDPOINT = {
	progress: "generation/progress",
	image: "generation/image"
};

//#endregion
//#region src/types.ts
/** Shared JSON vocabulary for generation, presentation, and loopback RPC. */
const RESULT_SCHEMA = "dsh-image-gen/result-v1";
const PRESENTATION_SCHEMA = "dsh-image-gen/presentation-v1";
const REFERENCE_SCHEMA = "dsh-image-gen/ref-v1";
const REFERENCE_MARKER = "DSH_IMAGE_REF_V1 ";

//#endregion
//#region src/index.ts
/** Cordis plugin name. */
const name = "image-gen";
/** Required Host services. */
const inject = [
	"tools",
	"attachments",
	"credentials",
	"connection",
	"sessionPersistence"
];
/** Cordis configuration schema. */
const Config = Schema.object({
	authMode: Schema.union([
		"auto",
		"codex-subscription",
		"api-key"
	]).default("auto"),
	apiKeyEnv: Schema.string().default("OPENAI_API_KEY"),
	baseUrl: Schema.string().default("https://api.openai.com/v1"),
	model: Schema.string().default("gpt-image-2"),
	defaultSize: Schema.string().default("auto"),
	defaultQuality: Schema.union([
		"auto",
		"low",
		"medium",
		"high"
	]).default("auto"),
	defaultOutputFormat: Schema.union([
		"png",
		"jpeg",
		"webp"
	]).default("png"),
	defaultOutputCompression: Schema.number().min(0).max(100).step(1).default(90),
	defaultBackground: Schema.union(["auto", "opaque"]).default("auto"),
	moderation: Schema.union(["auto", "low"]).default("auto"),
	partialImages: Schema.number().min(0).max(3).step(1).default(3),
	requestTimeoutMs: Schema.number().min(1e4).max(3e5).step(1).default(12e4),
	maxRetries: Schema.number().min(0).max(5).step(1).default(2),
	retryBaseMs: Schema.number().min(100).max(3e4).step(1).default(1e3),
	maxConcurrent: Schema.number().min(1).max(8).step(1).default(2)
});
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function safeString(value, maximum) {
	return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : void 0;
}
function imageRefValue(ref) {
	return {
		attachmentId: String(ref.attachmentId),
		mediaType: ref.mediaType,
		bytes: ref.bytes,
		width: ref.width,
		height: ref.height,
		...ref.name === void 0 ? {} : { name: ref.name }
	};
}
function attachmentRef(value) {
	return {
		attachmentId: AttachmentId(value.attachmentId),
		mediaType: value.mediaType,
		bytes: value.bytes,
		width: value.width,
		height: value.height,
		...value.name === void 0 ? {} : { name: value.name }
	};
}
function mediaType(format) {
	return format === "jpeg" ? "image/jpeg" : `image/${format}`;
}
function extension(format) {
	return format === "jpeg" ? "jpg" : format;
}
function promptName(prompt, format) {
	return `${prompt.normalize("NFKD").replace(/[^A-Za-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 48).toLowerCase() || "generated-image"}.${extension(format)}`;
}
function imageRef(value) {
	if (!isRecord(value) || typeof value.attachmentId !== "string" || value.mediaType !== "image/png" && value.mediaType !== "image/jpeg" && value.mediaType !== "image/webp" || typeof value.bytes !== "number" || typeof value.width !== "number" || typeof value.height !== "number") return void 0;
	return value;
}
function presentation(value) {
	if (!isRecord(value) || value.schema !== PRESENTATION_SCHEMA || !isRecord(value.result)) return void 0;
	const result = value.result;
	if (result.schema !== RESULT_SCHEMA || typeof result.callId !== "string" || imageRef(result.image) === void 0) return void 0;
	return value;
}
function referenceValue(value) {
	return {
		schema: REFERENCE_SCHEMA,
		callId: value.callId,
		model: value.model,
		image: value.image,
		size: value.size,
		quality: value.quality,
		outputFormat: value.outputFormat,
		background: value.background,
		elapsedMs: value.elapsedMs,
		...value.usage === void 0 ? {} : { usage: value.usage }
	};
}
function referenceFromText(value) {
	if (typeof value !== "string") return void 0;
	const start = value.indexOf(REFERENCE_MARKER);
	if (start < 0) return void 0;
	const line = value.slice(start + REFERENCE_MARKER.length).split("\n", 1)[0];
	if (line === void 0 || line.length > 2048) return void 0;
	try {
		const parsed = JSON.parse(line);
		if (!isRecord(parsed) || parsed.schema !== REFERENCE_SCHEMA || typeof parsed.callId !== "string" || imageRef(parsed.image) === void 0) return void 0;
		return parsed;
	} catch {
		return;
	}
}
function referenceFromContent(content) {
	if (!Array.isArray(content)) return void 0;
	for (const block of content) {
		if (!isRecord(block) || block.type !== "text") continue;
		const parsed = referenceFromText(block.text);
		if (parsed !== void 0) return parsed;
	}
}
function authorizedImage(events, callId) {
	for (const event of events) {
		if (!isRecord(event) || !isRecord(event.data)) continue;
		if (event.type === "tool/result") {
			const meta = presentation(event.data.meta);
			if (meta !== void 0 && meta.result.callId === callId) return meta.result.image;
		}
		if (event.type === "tool/code-dispatch" && event.data.name === "image_gen" && event.data.subCallId === callId) {
			const marker = referenceFromContent(event.data.content);
			if (marker !== void 0 && marker.callId === callId) return marker.image;
		}
	}
}
function rpcError(reason, message) {
	return {
		ok: false,
		error: {
			code: "attachment-error",
			message,
			details: { reason }
		}
	};
}
function progressOf(entry) {
	if (entry === void 0) return {
		state: "missing",
		revision: 0,
		attempt: 0,
		startedAt: 0
	};
	return {
		state: entry.state,
		revision: entry.revision,
		attempt: entry.attempt,
		startedAt: entry.startedAt,
		...entry.partial === void 0 ? {} : { partial: entry.partial }
	};
}
function validateConfig(config) {
	imageApiBaseUrl(config.baseUrl);
	imageSize(config.defaultSize);
	credentialRef(config.apiKeyEnv);
	if (config.model.trim() === "") throw new TypeError("model must not be blank");
}
/** Register the image tool and its loopback progress/image channel. */
function apply(ctx, config) {
	validateConfig(config);
	const active = /* @__PURE__ */ new Map();
	const inFlight = /* @__PURE__ */ new Set();
	const lifetime = new AbortController();
	let stopping = false;
	const keyOf = (sessionId, callId) => `${sessionId}\u0000${callId}`;
	const trackBackgroundWork = (work) => {
		const settled = work.then(() => {}, () => {});
		inFlight.add(settled);
		settled.finally(() => {
			inFlight.delete(settled);
		});
	};
	const resolveImageAuth = async (signal) => {
		let codexError;
		if (config.authMode !== "api-key") try {
			const auth = await resolveCodexSubscriptionAuth(signal, void 0, void 0, void 0, trackBackgroundWork);
			return {
				kind: "codex-subscription",
				apiKey: auth.accessToken,
				accountId: auth.accountId
			};
		} catch (error) {
			signal.throwIfAborted();
			codexError = error;
			if (config.authMode === "codex-subscription") throw error;
		}
		const resolved = await ctx.credentials.resolve(credentialRef(config.apiKeyEnv));
		signal.throwIfAborted();
		if (resolved !== void 0) return {
			kind: "api-key",
			apiKey: resolved.value
		};
		if (codexError instanceof Error) throw new Error(`${codexError.message} No ${config.apiKeyEnv} fallback is configured.`, { cause: codexError });
		throw new Error(`No credential is configured for ${config.apiKeyEnv}. Store it in DSH credentials or export it before starting DSH.`);
	};
	ctx.effect(() => async () => {
		stopping = true;
		lifetime.abort(new DOMException("dsh-image-gen was unloaded", "AbortError"));
		await Promise.allSettled([...inFlight]);
	}, "image-gen: abort and drain active generations");
	ctx.effect(() => ctx.connection.rpc.handle(IMAGE_GEN_RPC_CHANNEL, async (endpoint, payload, signal) => {
		if (!isRecord(payload)) return rpcError("invalid-request", "A JSON object is required.");
		const sessionId = safeString(payload.sessionId, 256);
		const callId = safeString(payload.callId, 512);
		if (sessionId === void 0 || callId === void 0) return rpcError("invalid-request", "Valid sessionId and callId values are required.");
		if (endpoint === IMAGE_GEN_RPC_ENDPOINT.progress) return {
			ok: true,
			value: progressOf(active.get(keyOf(sessionId, callId)))
		};
		if (endpoint !== IMAGE_GEN_RPC_ENDPOINT.image) return rpcError("unknown-endpoint", `Unknown image generation endpoint: ${endpoint}`);
		let inspection;
		try {
			inspection = await ctx.sessionPersistence.inspect(SessionId(sessionId), signal);
		} catch {
			return rpcError("image-unavailable", "The image session could not be inspected.");
		}
		const ref = authorizedImage(inspection.events, callId);
		if (ref === void 0) return rpcError("image-unavailable", "The image is not authorized by this session.");
		try {
			const stored = await ctx.attachments.readImage(attachmentRef(ref), signal);
			return {
				ok: true,
				value: {
					attachment: imageRefValue(stored.ref),
					data: Buffer.from(stored.data).toString("base64")
				}
			};
		} catch {
			return rpcError("image-unavailable", "The generated image could not be read.");
		}
	}, { authority: "loopback" }), "image-gen: loopback progress and image RPC");
	ctx.tools.register(defineTool({
		name: "image_gen",
		description: "Generate one new image with OpenAI GPT Image 2 using the signed-in Codex subscription by default, with API-key fallback when configured. Use this when the user asks to create, draw, render, illustrate, or design an image. The result appears in an animated DSH image card with preview and download. GPT Image 2 does not support transparent backgrounds.",
		parameters: {
			prompt: {
				type: "string",
				required: true,
				description: "Detailed image prompt. Preserve user constraints and describe subject, composition, style, lighting, palette, text, and exclusions as relevant."
			},
			size: {
				type: "string",
				description: "auto or WIDTHxHEIGHT. Edges must be divisible by 16, at most 3840px, 1:3–3:1, and 655360–8294400 total pixels."
			},
			quality: {
				type: "string",
				enum: [
					"auto",
					"low",
					"medium",
					"high"
				],
				description: "Image quality. Omit for deployment default."
			},
			output_format: {
				type: "string",
				enum: [
					"png",
					"jpeg",
					"webp"
				],
				description: "Output format. Codex subscription mode accepts PNG only; JPEG/WebP require API-key mode. Omit for deployment default."
			},
			output_compression: {
				type: "integer",
				description: "API-key mode only: JPEG/WebP compression quality from 0 to 100. Do not set for PNG."
			},
			background: {
				type: "string",
				enum: ["auto", "opaque"],
				description: "Background behavior. GPT Image 2 rejects transparent."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					schema: {
						type: "string",
						const: RESULT_SCHEMA,
						required: true
					},
					callId: {
						type: "string",
						required: true
					},
					model: {
						type: "string",
						required: true
					},
					prompt: {
						type: "string",
						required: true
					},
					image: {
						type: "object",
						additionalProperties: false,
						required: true,
						properties: {
							attachmentId: {
								type: "string",
								required: true
							},
							mediaType: {
								type: "string",
								enum: [
									"image/png",
									"image/jpeg",
									"image/webp"
								],
								required: true
							},
							bytes: {
								type: "integer",
								required: true
							},
							width: {
								type: "integer",
								required: true
							},
							height: {
								type: "integer",
								required: true
							},
							name: { type: "string" }
						}
					},
					size: {
						type: "string",
						required: true
					},
					quality: {
						type: "string",
						enum: [
							"auto",
							"low",
							"medium",
							"high"
						],
						required: true
					},
					outputFormat: {
						type: "string",
						enum: [
							"png",
							"jpeg",
							"webp"
						],
						required: true
					},
					background: {
						type: "string",
						enum: ["auto", "opaque"],
						required: true
					},
					elapsedMs: {
						type: "integer",
						required: true
					},
					usage: {
						type: "object",
						additionalProperties: false,
						properties: {
							inputTokens: {
								type: "integer",
								required: true
							},
							outputTokens: {
								type: "integer",
								required: true
							},
							totalTokens: {
								type: "integer",
								required: true
							}
						}
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Generated an image with ${value.model} (${value.image.width}×${value.image.height}, ${value.outputFormat.toUpperCase()}, ${(value.elapsedMs / 1e3).toFixed(1)}s). The image is available in the DSH card for preview and download.\n${REFERENCE_MARKER}${JSON.stringify(referenceValue(value))}`
			}],
			presentationMeta: (_args, value) => ({
				schema: PRESENTATION_SCHEMA,
				result: value
			})
		},
		finalizeContent(exec, result) {
			if (exec.parent !== void 0 || result.isError) return void 0;
			let changed = false;
			const content = result.content.map((block) => {
				if (block.type !== "text") return block;
				const marker = block.text.indexOf(`\n${REFERENCE_MARKER}`);
				if (marker < 0) return block;
				changed = true;
				return {
					type: "text",
					text: block.text.slice(0, marker)
				};
			});
			return changed ? content : void 0;
		},
		timeoutMs: config.requestTimeoutMs,
		isConcurrencySafe: () => true,
		presentCall: (args) => ({
			card: "generic",
			title: "Generate image",
			kind: "other",
			rawInput: {
				prompt: args.prompt,
				size: args.size ?? config.defaultSize
			}
		}),
		presentResult: (_args, result) => ({
			card: "generic",
			title: result.isError ? "Image generation failed" : "Generated image"
		}),
		async execute(args, exec) {
			const sessionId = exec.agent?.session.header.id;
			if (sessionId === void 0) throw new Error("image_gen requires a calling DSH agent session");
			if (stopping) throw new DOMException("dsh-image-gen is stopping", "AbortError");
			const prompt = args.prompt.trim();
			if (prompt.length === 0 || prompt.length > 32e3) throw new Error("prompt must contain 1–32000 characters");
			const size = imageSize(args.size ?? config.defaultSize);
			const quality$1 = args.quality ?? config.defaultQuality;
			const outputFormat$1 = args.output_format ?? config.defaultOutputFormat;
			const outputCompression = args.output_compression ?? config.defaultOutputCompression;
			if (!Number.isSafeInteger(outputCompression) || outputCompression < 0 || outputCompression > 100) throw new Error("output_compression must be a whole number from 0 to 100");
			if (outputFormat$1 === "png" && args.output_compression !== void 0) throw new Error("output_compression is supported only for JPEG and WebP");
			if (Buffer.byteLength(prompt, "utf8") > 64e3) throw new Error("prompt must not exceed 64000 UTF-8 bytes");
			if (active.size >= config.maxConcurrent) throw new Error("Too many image generations are already running. Try again after one finishes.");
			const callId = String(exec.callId);
			const operationKey = keyOf(String(sessionId), callId);
			const entry = {
				sessionId: String(sessionId),
				callId,
				revision: 1,
				attempt: 1,
				startedAt: Date.now(),
				state: "requesting"
			};
			active.set(operationKey, entry);
			let finishOperation;
			const operationDone = new Promise((resolve) => {
				finishOperation = resolve;
			});
			inFlight.add(operationDone);
			const requestSignal = AbortSignal.any([
				lifetime.signal,
				exec.signal,
				AbortSignal.timeout(config.requestTimeoutMs)
			]);
			try {
				const auth = await resolveImageAuth(requestSignal);
				requestSignal.throwIfAborted();
				const requestOutputFormat = auth.kind === "codex-subscription" && args.output_format === void 0 ? "png" : outputFormat$1;
				if (auth.kind === "codex-subscription" && requestOutputFormat !== "png") throw new Error("Codex subscription image generation currently returns PNG. Set output_format to png or omit it.");
				if (auth.kind === "codex-subscription" && args.output_compression !== void 0) throw new Error("output_compression is available only in API-key mode");
				const requestModel = auth.kind === "codex-subscription" ? "gpt-image-2" : config.model;
				const generated = await new OpenAIImageClient({
					baseUrl: auth.kind === "codex-subscription" ? CODEX_IMAGE_BASE_URL : config.baseUrl,
					apiKey: auth.apiKey,
					model: requestModel,
					moderation: config.moderation,
					partialImages: auth.kind === "codex-subscription" ? 0 : config.partialImages,
					maxRetries: config.maxRetries,
					retryBaseMs: config.retryBaseMs,
					maxImageBytes: ctx.attachments.imageLimits.maxImageBytes,
					protocol: auth.kind === "codex-subscription" ? "codex-subscription" : "openai-api",
					...auth.kind === "codex-subscription" ? {
						accountId: auth.accountId,
						turnId: callId
					} : {}
				}).generate({
					prompt,
					size,
					quality: quality$1,
					outputFormat: requestOutputFormat,
					...requestOutputFormat === "png" ? {} : { outputCompression },
					background: args.background ?? config.defaultBackground
				}, requestSignal, (progress) => {
					entry.revision += 1;
					entry.attempt = progress.attempt;
					if (progress.kind === "requesting" || progress.kind === "retrying") {
						entry.state = "requesting";
						delete entry.partial;
					} else entry.state = "generating";
					if (progress.kind === "partial") entry.partial = {
						index: progress.index,
						format: progress.outputFormat,
						data: progress.data
					};
				});
				entry.state = "saving";
				entry.revision += 1;
				requestSignal.throwIfAborted();
				const ref = await ctx.attachments.saveImage({
					data: generated.data,
					mediaType: mediaType(generated.outputFormat),
					name: promptName(prompt, generated.outputFormat)
				});
				requestSignal.throwIfAborted();
				return {
					schema: RESULT_SCHEMA,
					callId,
					model: requestModel,
					prompt,
					image: imageRefValue(ref),
					size: generated.size,
					quality: generated.quality,
					outputFormat: generated.outputFormat,
					background: generated.background,
					elapsedMs: Math.max(0, Date.now() - entry.startedAt),
					...generated.usage === void 0 ? {} : { usage: generated.usage }
				};
			} catch (error) {
				if (error instanceof ImageApiError) ctx.logger.warn(`image_gen provider failure${error.code === void 0 ? "" : ` (${error.code})`}: ${error.message}`);
				throw error;
			} finally {
				active.delete(operationKey);
				finishOperation?.();
				inFlight.delete(operationDone);
			}
		}
	}));
}

//#endregion
export { Config, apply, inject, name };