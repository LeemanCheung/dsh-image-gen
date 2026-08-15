/** Lifecycle-owned stylesheet for the image generation card. */
export const IMAGE_GEN_STYLES = `
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
`
