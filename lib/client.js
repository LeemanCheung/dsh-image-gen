window.__ModuleLoader__.load({
	id: "dsh-image-gen",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
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
		const REFERENCE_MARKER = "DSH_IMAGE_REF_V1 ";
		//#endregion
		//#region src/client/styles.ts
		/** Lifecycle-owned stylesheet for the image generation card. */
		const IMAGE_GEN_STYLES = `
.dshImageGen {
  --ig-accent: var(--dsw-color-accent, #4f72ff);
  --ig-accent-soft: color-mix(in srgb, var(--ig-accent) 18%, transparent);
  --ig-text: var(--dsw-color-text-primary, #17191c);
  --ig-muted: var(--dsw-color-text-secondary, #747981);
  --ig-border: var(--dsw-color-border-subtle, color-mix(in srgb, currentColor 13%, transparent));
  --ig-surface: var(--dsw-color-bg-secondary, color-mix(in srgb, currentColor 4%, transparent));
  width: min(100%, 560px);
  margin: 8px 0 12px 22px;
  overflow: hidden;
  color: var(--ig-text);
  border: 1px solid var(--ig-border);
  border-radius: 18px;
  background: color-mix(in srgb, var(--ig-surface) 92%, transparent);
  box-shadow: 0 14px 38px color-mix(in srgb, #000 10%, transparent);
  isolation: isolate;
}
.dshImageGen__header {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 48px;
  padding: 0 14px;
  border-bottom: 1px solid var(--ig-border);
  background: color-mix(in srgb, var(--ig-surface) 96%, transparent);
}
.dshImageGen__mark {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  flex: 0 0 auto;
  border-radius: 8px;
  color: white;
  background: linear-gradient(145deg, #315cff, #9c5cff 68%, #ff67b6);
  box-shadow: 0 4px 14px color-mix(in srgb, var(--ig-accent) 35%, transparent);
}
.dshImageGen__mark svg { width: 14px; height: 14px; }
.dshImageGen__heading { min-width: 0; flex: 1; }
.dshImageGen__title {
  overflow: hidden;
  font-size: 13px;
  font-weight: 650;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dshImageGen__subtitle {
  overflow: hidden;
  color: var(--ig-muted);
  font-size: 11px;
  line-height: 15px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dshImageGen__state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  color: var(--ig-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.dshImageGen__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ig-accent);
  box-shadow: 0 0 0 0 var(--ig-accent-soft);
  animation: dshImageGenPulse 1.8s ease-out infinite;
}
.dshImageGen[data-state="done"] .dshImageGen__dot { background: #20a66a; animation: none; }
.dshImageGen[data-state="error"] .dshImageGen__dot { background: #dc4f52; animation: none; }
.dshImageGen__stage {
  position: relative;
  display: grid;
  place-items: center;
  min-height: 230px;
  max-height: 430px;
  overflow: hidden;
  aspect-ratio: var(--ig-ratio, 1 / 1);
  background:
    radial-gradient(circle at 24% 26%, color-mix(in srgb, #775cff 36%, transparent), transparent 36%),
    radial-gradient(circle at 78% 67%, color-mix(in srgb, #ff5c9d 28%, transparent), transparent 40%),
    linear-gradient(145deg, #111522, #191529 46%, #111d2a);
}
.dshImageGen__stage::before,
.dshImageGen__stage::after {
  content: "";
  position: absolute;
  pointer-events: none;
}
.dshImageGen__stage::before {
  inset: -40%;
  background: conic-gradient(from 45deg, transparent, color-mix(in srgb, #74d6ff 28%, transparent), transparent 30%, color-mix(in srgb, #d78cff 22%, transparent), transparent 72%);
  filter: blur(40px);
  animation: dshImageGenOrbit 9s linear infinite;
}
.dshImageGen__stage::after {
  inset: 0;
  opacity: .2;
  background-image:
    linear-gradient(color-mix(in srgb, #fff 12%, transparent) 1px, transparent 1px),
    linear-gradient(90deg, color-mix(in srgb, #fff 9%, transparent) 1px, transparent 1px);
  background-size: 32px 32px;
  mask-image: radial-gradient(circle, #000 10%, transparent 72%);
}
.dshImageGen__scan {
  position: absolute;
  z-index: 4;
  inset: -20% 0 auto;
  height: 38%;
  opacity: .66;
  pointer-events: none;
  background: linear-gradient(to bottom, transparent, color-mix(in srgb, #bdeaff 28%, transparent), color-mix(in srgb, #fff 58%, transparent), transparent);
  filter: blur(5px);
  mix-blend-mode: screen;
  animation: dshImageGenScan 3.2s cubic-bezier(.48, 0, .5, 1) infinite;
}
.dshImageGen__orb {
  position: relative;
  z-index: 3;
  width: 86px;
  height: 86px;
  border: 1px solid color-mix(in srgb, #fff 28%, transparent);
  border-radius: 50%;
  box-shadow: inset 0 0 28px color-mix(in srgb, #bda3ff 22%, transparent), 0 0 50px color-mix(in srgb, #7299ff 24%, transparent);
  animation: dshImageGenBreathe 2.8s ease-in-out infinite;
}
.dshImageGen__orb::before,
.dshImageGen__orb::after {
  content: "";
  position: absolute;
  border-radius: inherit;
}
.dshImageGen__orb::before { inset: 12px; border: 1px dashed color-mix(in srgb, #fff 34%, transparent); animation: dshImageGenOrbit 5s linear infinite reverse; }
.dshImageGen__orb::after { inset: 30px; background: #fff; box-shadow: 0 0 26px #9ab5ff; }
.dshImageGen__image {
  position: absolute;
  z-index: 2;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #0c0f17;
  animation: dshImageGenDevelop .9s cubic-bezier(.2, .75, .25, 1) both;
}
.dshImageGen[data-state="running"] .dshImageGen__image { filter: saturate(.9) contrast(.96); }
.dshImageGen[data-state="done"] .dshImageGen__scan,
.dshImageGen[data-state="done"] .dshImageGen__orb { display: none; }
.dshImageGen__draft {
  position: absolute;
  z-index: 5;
  top: 12px;
  left: 12px;
  padding: 4px 8px;
  color: color-mix(in srgb, #fff 88%, transparent);
  border: 1px solid color-mix(in srgb, #fff 24%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, #070a12 62%, transparent);
  font-size: 10px;
  letter-spacing: .06em;
  text-transform: uppercase;
  backdrop-filter: blur(12px);
}
.dshImageGen__error {
  position: relative;
  z-index: 6;
  max-width: 410px;
  margin: 24px;
  padding: 16px 18px;
  color: #ffdfe0;
  border: 1px solid color-mix(in srgb, #ff7b7f 45%, transparent);
  border-radius: 14px;
  background: color-mix(in srgb, #491e2c 72%, transparent);
  font-size: 12px;
  line-height: 1.55;
  backdrop-filter: blur(18px);
}
.dshImageGen__footer { padding: 11px 14px 12px; }
.dshImageGen__prompt {
  display: -webkit-box;
  overflow: hidden;
  color: var(--ig-text);
  font-size: 12px;
  line-height: 1.5;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.dshImageGen__meta {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 9px;
  flex-wrap: wrap;
}
.dshImageGen__chip {
  padding: 3px 7px;
  color: var(--ig-muted);
  border: 1px solid var(--ig-border);
  border-radius: 999px;
  background: color-mix(in srgb, var(--ig-surface) 85%, transparent);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.dshImageGen__actions { display: flex; gap: 6px; margin-left: auto; }
.dshImageGen__button {
  appearance: none;
  padding: 5px 9px;
  color: var(--ig-text);
  border: 1px solid var(--ig-border);
  border-radius: 8px;
  background: var(--ig-surface);
  cursor: pointer;
  font: inherit;
  font-size: 11px;
  transition: border-color .16s ease, background .16s ease, transform .16s ease;
}
.dshImageGen__button:hover { border-color: color-mix(in srgb, var(--ig-accent) 45%, var(--ig-border)); background: var(--ig-accent-soft); }
.dshImageGen__button:active { transform: translateY(1px); }
.dshImageGen__details { margin-top: 9px; color: var(--ig-muted); font-size: 11px; }
.dshImageGen__details summary { cursor: pointer; user-select: none; }
.dshImageGen__details p { margin: 7px 0 0; white-space: pre-wrap; line-height: 1.55; }
.dshImageGen__lightbox {
  position: fixed;
  z-index: 10000;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 28px;
  background: color-mix(in srgb, #05070c 88%, transparent);
  backdrop-filter: blur(18px);
}
.dshImageGen__lightbox img { max-width: 94vw; max-height: 90vh; object-fit: contain; border-radius: 12px; box-shadow: 0 28px 90px #000; }
.dshImageGen__lightbox button { position: fixed; top: 18px; right: 18px; color: white; border-color: color-mix(in srgb, #fff 25%, transparent); background: color-mix(in srgb, #000 52%, transparent); }
@keyframes dshImageGenPulse { 70% { box-shadow: 0 0 0 7px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
@keyframes dshImageGenOrbit { to { transform: rotate(360deg); } }
@keyframes dshImageGenScan { 0% { transform: translateY(-40%); opacity: 0; } 15% { opacity: .65; } 80% { opacity: .5; } 100% { transform: translateY(410%); opacity: 0; } }
@keyframes dshImageGenBreathe { 50% { transform: scale(1.08); opacity: .72; } }
@keyframes dshImageGenDevelop { 0% { opacity: 0; filter: blur(22px) saturate(.35) brightness(1.5); transform: scale(1.035); } 55% { opacity: .92; filter: blur(6px) saturate(.75) brightness(1.15); } 100% { opacity: 1; filter: blur(0) saturate(1) brightness(1); transform: scale(1); } }
@media (prefers-color-scheme: dark) { .dshImageGen { --ig-text: var(--dsw-color-text-primary, #f2f3f5); --ig-muted: var(--dsw-color-text-secondary, #a2a7af); } }
@media (max-width: 640px) { .dshImageGen { width: calc(100% - 6px); margin-left: 6px; border-radius: 15px; } .dshImageGen__state { display: none; } .dshImageGen__stage { min-height: 200px; } }
@media (prefers-reduced-motion: reduce) { .dshImageGen *, .dshImageGen *::before, .dshImageGen *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; scroll-behavior: auto !important; } }
`;
		//#endregion
		//#region src/client/index.tsx
		/** Browser plugin: animated progressive image-generation tool card. */
		const NS = "dsh.imageGen";
		const POLL_MS = 650;
		const en = {
			generating: "Generating image",
			generated: "Generated image",
			edited: "Edited image",
			failed: "Image generation failed",
			requesting: "Contacting GPT Image 2",
			rendering: "Rendering pixels",
			saving: "Saving final image",
			waiting: "Preparing the canvas",
			ready: "Final image saved",
			draft: "Live draft",
			preview: "Preview",
			download: "Download",
			close: "Close",
			details: "Prompt & details",
			requested: "Requested",
			unverified: "unverified",
			loading: "Loading final image",
			unavailable: "The generated image is unavailable. Reload the page or check Host logs.",
			noOutput: "The provider did not return a usable image."
		};
		const zh = {
			generating: "正在生成图片",
			generated: "图片已生成",
			edited: "图片编辑已完成",
			failed: "图片生成失败",
			requesting: "正在连接 GPT Image 2",
			rendering: "正在渲染像素",
			saving: "正在保存最终图片",
			waiting: "正在准备画布",
			ready: "最终图片已保存",
			draft: "实时草图",
			preview: "预览",
			download: "下载",
			close: "关闭",
			details: "提示词与详情",
			requested: "请求参数",
			unverified: "未核验",
			loading: "正在加载最终图片",
			unavailable: "无法读取已生成图片。请刷新页面或查看 Host 日志。",
			noOutput: "服务未返回可用图片。"
		};
		function isRecord(value) {
			return typeof value === "object" && value !== null && !Array.isArray(value);
		}
		function argsOf(block) {
			const raw = "kind" in block ? block.call?.argsRaw : block.argsRaw;
			if (raw === null || raw === void 0) return {
				prompt: "",
				size: "auto",
				quality: "auto",
				outputFormat: "png"
			};
			try {
				const value = JSON.parse(raw);
				if (!isRecord(value)) throw new Error("not an object");
				return {
					prompt: typeof value.prompt === "string" ? value.prompt : "",
					size: typeof value.size === "string" ? value.size : "auto",
					quality: typeof value.quality === "string" ? value.quality : "auto",
					outputFormat: typeof value.output_format === "string" ? value.output_format : "png"
				};
			} catch {
				return {
					prompt: "",
					size: "auto",
					quality: "auto",
					outputFormat: "png"
				};
			}
		}
		function referenceFromText(value) {
			if (typeof value !== "string") return void 0;
			const start = value.indexOf(REFERENCE_MARKER);
			if (start < 0) return void 0;
			const line = value.slice(start + 17).split("\n", 1)[0];
			if (line === void 0 || line.length > 2048) return void 0;
			try {
				const parsed = JSON.parse(line);
				if (!isRecord(parsed) || parsed.schema !== "dsh-image-gen/ref-v1" || typeof parsed.callId !== "string" || !isRecord(parsed.image)) return void 0;
				return parsed;
			} catch {
				return;
			}
		}
		function presentationOf(block) {
			if (!("kind" in block)) return void 0;
			if (isRecord(block.meta) && block.meta.schema === "dsh-image-gen/presentation-v1" && isRecord(block.meta.result)) {
				const result = block.meta.result;
				if (result.schema === "dsh-image-gen/result-v1" && isRecord(result.image) && result.callId === block.callId) return block.meta;
			}
			const marker = block.content.filter((item) => item.type === "text").map((item) => item.type === "text" ? referenceFromText(item.text) : void 0).find((item) => item !== void 0 && item.callId === block.callId);
			if (marker === void 0) return void 0;
			const args = argsOf(block);
			return {
				schema: PRESENTATION_SCHEMA,
				result: {
					schema: RESULT_SCHEMA,
					callId: marker.callId,
					model: marker.model,
					prompt: args.prompt,
					image: marker.image,
					...marker.referenceImage === void 0 ? {} : { referenceImage: marker.referenceImage },
					size: marker.size,
					quality: marker.quality,
					...marker.requestedSize === void 0 ? {} : { requestedSize: marker.requestedSize },
					...marker.requestedQuality === void 0 ? {} : { requestedQuality: marker.requestedQuality },
					...marker.providerSize === void 0 ? {} : { providerSize: marker.providerSize },
					...marker.qualitySource === void 0 ? {} : { qualitySource: marker.qualitySource },
					outputFormat: marker.outputFormat,
					background: marker.background,
					elapsedMs: marker.elapsedMs,
					...marker.usage === void 0 ? {} : { usage: marker.usage }
				}
			};
		}
		function resultError(block, fallback) {
			if (!("kind" in block) || !block.isError) return "";
			return block.content.filter((item) => item.type === "text").map((item) => item.type === "text" ? item.text : "").join("\n").trim() || fallback;
		}
		function dataUrl(format, data) {
			return `data:${format === "jpeg" ? "image/jpeg" : `image/${format}`};base64,${data}`;
		}
		function finalImageUrl(mediaType, data) {
			if (typeof URL.createObjectURL !== "function") return `data:${mediaType};base64,${data}`;
			const binary = atob(data);
			const bytes = new Uint8Array(binary.length);
			for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
			return URL.createObjectURL(new Blob([bytes], { type: mediaType }));
		}
		function aspectRatio(args, result) {
			if (result !== void 0 && result.image.width > 0 && result.image.height > 0) return result.image.width / result.image.height;
			const match = /^(\d+)x(\d+)$/u.exec(args.size);
			if (match === null) return 1;
			return Math.min(3, Math.max(1 / 3, Number(match[1]) / Number(match[2])));
		}
		function elapsedLabel(ms) {
			if (ms < 6e4) return `${Math.max(0, Math.round(ms / 1e3))}s`;
			return `${Math.floor(ms / 6e4)}m ${Math.round(ms % 6e4 / 1e3)}s`;
		}
		function ImageMark() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "dshImageGen__mark",
				"aria-hidden": true,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
					viewBox: "0 0 24 24",
					fill: "none",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
						d: "M12 2.8l1.6 5.1L19 9.5l-5.4 1.7L12 16.3l-1.6-5.1L5 9.5l5.4-1.6L12 2.8Z",
						fill: "currentColor"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
						d: "M18.2 14.3l.9 2.7 2.7.9-2.7.9-.9 2.7-.9-2.7-2.7-.9 2.7-.9.9-2.7Z",
						fill: "currentColor",
						opacity: ".72"
					})]
				})
			});
		}
		/** The session-scoped progressive card for one image_gen call. */
		function ImageGenCard({ sessionId, callId, block, t, requestProgress, requestImage }) {
			const args = (0, react.useMemo)(() => argsOf(block), [block]);
			const presentation = (0, react.useMemo)(() => presentationOf(block), [block]);
			const settled = "kind" in block;
			const failed = settled && (block.isError || presentation === void 0);
			const [progress, setProgress] = (0, react.useState)();
			const [finalImage, setFinalImage] = (0, react.useState)();
			const [loadError, setLoadError] = (0, react.useState)(false);
			const [lightbox, setLightbox] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				if (settled) return;
				const controller = new AbortController();
				let live = true;
				let timer;
				const poll = async () => {
					try {
						const next = await requestProgress(sessionId, callId, controller.signal);
						if (!live) return;
						setProgress(next);
					} catch {
						if (!controller.signal.aborted && live) setProgress(void 0);
					}
					if (live) timer = setTimeout(() => {
						poll();
					}, POLL_MS);
				};
				poll();
				return () => {
					live = false;
					controller.abort();
					if (timer !== void 0) clearTimeout(timer);
				};
			}, [
				callId,
				requestProgress,
				sessionId,
				settled
			]);
			(0, react.useEffect)(() => {
				if (presentation === void 0) return;
				const controller = new AbortController();
				let live = true;
				let objectUrl;
				setLoadError(false);
				setFinalImage(void 0);
				requestImage(sessionId, callId, controller.signal).then(({ attachment, data }) => {
					if (!live) return;
					objectUrl = finalImageUrl(attachment.mediaType, data);
					setFinalImage(objectUrl);
				}).catch(() => {
					if (live) setLoadError(true);
				});
				return () => {
					live = false;
					controller.abort();
					if (objectUrl?.startsWith("blob:") === true) URL.revokeObjectURL(objectUrl);
				};
			}, [
				callId,
				presentation,
				requestImage,
				sessionId
			]);
			(0, react.useEffect)(() => {
				if (!lightbox) return;
				const close = (event) => {
					if (event.key === "Escape") setLightbox(false);
				};
				document.addEventListener("keydown", close);
				return () => {
					document.removeEventListener("keydown", close);
				};
			}, [lightbox]);
			const result = presentation?.result;
			const prompt = result?.prompt || args.prompt;
			const partial = !settled && progress?.partial !== void 0 ? dataUrl(progress.partial.format, progress.partial.data) : void 0;
			const src = finalImage ?? partial;
			const ratio = aspectRatio(args, result);
			const state = failed ? "error" : settled ? "done" : "running";
			const phase = progress?.state === "requesting" ? t("requesting") : progress?.state === "generating" ? t("rendering") : progress?.state === "saving" ? t("saving") : settled && finalImage !== void 0 ? t("ready") : settled && presentation !== void 0 && !loadError ? t("loading") : t("waiting");
			const title = failed ? t("failed") : settled ? result?.referenceImage === void 0 ? t("generated") : t("edited") : t("generating");
			const startedAt = progress?.startedAt || ("time" in block ? block.time : Date.now());
			const elapsed = result?.elapsedMs ?? Math.max(0, Date.now() - startedAt);
			const error = failed ? settled && block.isError ? resultError(block, t("noOutput")) : t("noOutput") : loadError ? t("unavailable") : "";
			const filename = result?.image.name ?? `gpt-image-2.${result?.outputFormat === "jpeg" ? "jpg" : result?.outputFormat ?? args.outputFormat}`;
			const sizeLabel = result === void 0 ? args.size : `${result.image.width}x${result.image.height}`;
			const qualityLabel = result === void 0 ? args.quality : result.qualitySource === "provider" ? result.quality : `${result.quality} (${result.qualitySource === "request" ? t("requested").toLowerCase() : t("unverified")})`;
			const download = () => {
				if (finalImage === void 0) return;
				const anchor = document.createElement("a");
				anchor.href = finalImage;
				anchor.download = filename;
				anchor.click();
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
				className: "dshImageGen",
				"data-state": state,
				"aria-busy": !settled,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
						className: "dshImageGen__header",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ImageMark, {}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dshImageGen__heading",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dshImageGen__title",
									children: title
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dshImageGen__subtitle",
									children: failed ? "GPT Image 2" : phase
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dshImageGen__state",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "dshImageGen__dot" }), elapsedLabel(elapsed)]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dshImageGen__stage",
						style: { "--ig-ratio": String(ratio) },
						children: [
							!settled && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "dshImageGen__scan" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "dshImageGen__orb" })] }),
							src !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
								className: "dshImageGen__image",
								src,
								alt: prompt || title
							}, src.slice(-32)),
							partial !== void 0 && finalImage === void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dshImageGen__draft",
								children: t("draft")
							}),
							error !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dshImageGen__error",
								role: "alert",
								children: error
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("footer", {
						className: "dshImageGen__footer",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dshImageGen__prompt",
								children: prompt || title
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dshImageGen__meta",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dshImageGen__chip",
										children: sizeLabel
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dshImageGen__chip",
										children: qualityLabel
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dshImageGen__chip",
										children: (result?.outputFormat ?? args.outputFormat).toUpperCase()
									}),
									progress !== void 0 && progress.attempt > 1 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "dshImageGen__chip",
										children: ["attempt ", progress.attempt]
									}),
									finalImage !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "dshImageGen__actions",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "dshImageGen__button",
											onClick: () => {
												setLightbox(true);
											},
											children: t("preview")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "dshImageGen__button",
											onClick: download,
											children: t("download")
										})]
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
								className: "dshImageGen__details",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("summary", { children: t("details") }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: prompt }),
									result?.requestedSize !== void 0 && result.requestedQuality !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: `${t("requested")}: ${result.requestedSize} · ${result.requestedQuality}` }),
									result?.usage !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: `${result.model} · ${result.usage.totalTokens} tokens · ${elapsedLabel(result.elapsedMs)}` })
								]
							})
						]
					}),
					lightbox && finalImage !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dshImageGen__lightbox",
						role: "dialog",
						"aria-modal": "true",
						"aria-label": t("preview"),
						onClick: () => {
							setLightbox(false);
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
							src: finalImage,
							alt: prompt || title,
							onClick: (event) => {
								event.stopPropagation();
							}
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dshImageGen__button",
							onClick: () => {
								setLightbox(false);
							},
							children: t("close")
						})]
					})
				]
			});
		}
		function decodeProgress(value) {
			if (!isRecord(value) || value.state !== "missing" && value.state !== "requesting" && value.state !== "generating" && value.state !== "saving" || typeof value.revision !== "number" || typeof value.attempt !== "number" || typeof value.startedAt !== "number") throw new Error("Host returned invalid image progress");
			return value;
		}
		function decodeImage(value) {
			if (!isRecord(value) || !isRecord(value.attachment) || typeof value.data !== "string") throw new Error("Host returned invalid image data");
			return value;
		}
		/** Register the localized keyed tool card and its lifecycle-owned CSS. */
		const inject = [
			"slots",
			"locale",
			"connection"
		];
		/** Browser Cordis plugin entry. */
		function apply(ctx) {
			const connection = ctx.get("connection");
			if (connection === void 0) throw new Error("dsh-image-gen requires the Client connection service");
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "dsh-image-gen: locale dictionaries");
			ctx.effect(() => {
				const style = document.createElement("style");
				style.dataset.plugin = "dsh-image-gen";
				style.textContent = IMAGE_GEN_STYLES;
				document.head.append(style);
				return () => {
					style.remove();
				};
			}, "dsh-image-gen: card styles");
			const t = ctx.locale.bind(NS);
			const call = async (endpoint, payload, signal) => {
				if (!connection.isLoopback) throw new Error("Image previews are available only from the local DSH page");
				const result = await connection.rpc.call(IMAGE_GEN_RPC_CHANNEL, endpoint, payload, signal);
				if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
				return result.value;
			};
			ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
				name: "tool.call.toolview",
				key: "image_gen",
				locale: NS,
				inject: () => ({
					t,
					requestProgress: async (sessionId, callId, signal) => decodeProgress(await call(IMAGE_GEN_RPC_ENDPOINT.progress, {
						sessionId: String(sessionId),
						callId
					}, signal)),
					requestImage: async (sessionId, callId, signal) => decodeImage(await call(IMAGE_GEN_RPC_ENDPOINT.image, {
						sessionId: String(sessionId),
						callId
					}, signal))
				})
			}, ImageGenCard));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map