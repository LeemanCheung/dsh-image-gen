# dsh-image-gen

[![CI](https://github.com/LeemanCheung/dsh-image-gen/actions/workflows/ci.yml/badge.svg)](https://github.com/LeemanCheung/dsh-image-gen/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Generate images in DeepSeek Harness with OpenAI `gpt-image-2`, progressive live previews, and a polished Codex-inspired developing animation.

[中文说明](./README.zh.md)

<p align="center"><img src="./assets/demo.svg" width="760" alt="Animated dsh-image-gen progressive preview" /></p>

The illustration mirrors the shipped card states; live draft frames come from the provider stream.

## Highlights

- Registers the Codex-compatible model tool name `image_gen`.
- Streams up to three real provider partial images instead of showing a fake progress bar.
- Cross-fades each partial over one animated developing plate, then sharpens into the final image.
- Stores the final image in DSH's immutable attachment store and supports replay, lightbox preview, and download.
- Keeps model-facing tool output text-only, so image generation does not make a text-only model route reject conversation history.
- Supports native tool calls and nested Code Mode calls with the same durable card.
- Resolves credentials per operation, rejects redirects, limits response sizes, validates image bytes through DSH, and retries only transient failures.
- Includes Chinese and English UI copy plus `prefers-reduced-motion` support.

## Codex parity and improvements

OpenAI Codex's built-in `image_gen` tool hardcodes `gpt-image-2`, records one working state, and saves the completed image under Codex's generated-images directory. Its public source verifies the states `in_progress`, `completed`, and `failed`; it does not expose a distinctive diffusion animation.

`dsh-image-gen` keeps the compatible `image_gen` name and model while improving the visible process:

| Experience | Codex | dsh-image-gen |
| --- | --- | --- |
| GPT Image 2 | Yes | Yes |
| Progressive provider frames | Tool supports them, default UI is generic | Up to 3 live frames in the card |
| Before first frame | Generic working state | Animated developing plate, scan, and light field |
| Frame transition | Generic activity | In-place cross-fade and focus development |
| Final result | Saved image | Durable DSH attachment, replay, lightbox, download |
| Text-only model compatibility | Not applicable to DSH history | Model receives text; image reference stays in UI metadata |
| Reduced motion | Platform dependent | Explicitly supported |

Primary references:

- [Codex image-generation tool](https://github.com/openai/codex/blob/main/codex-rs/ext/image-generation/src/tool.rs)
- [OpenAI image-generation skill](https://github.com/openai/skills/blob/main/skills/.system/imagegen/SKILL.md)
- [GPT Image 2 model](https://developers.openai.com/api/docs/models/gpt-image-2)
- [Image generation guide](https://developers.openai.com/api/docs/guides/image-generation)

## Compatibility

Verified against:

- DeepSeek Harness `0.1.0-rc.6`
- Node.js `24.15.0`
- DSH Web profile on Windows 11

Verification date: 2026-08-15.

## Install

Review third-party source before installation and pin a commit:

```powershell
dsh plugin --profile web add github:LeemanCheung/dsh-image-gen#<commit-sha>
```

For local development:

```powershell
git clone https://github.com/LeemanCheung/dsh-image-gen.git
cd dsh-image-gen
npm install
npm run check
dsh plugin --profile web add .
```

The repository commits `lib/index.js` and `lib/client.js`, so a pinned Git install does not need to run a dependency build script. Restart the DSH Host after installation and refresh the Web page.

## Credential

The default credential reference is `OPENAI_API_KEY`. Provide it through DSH's credential store or the Host environment. Do not place a raw secret in `cordis.patch.yml`, chat messages, Git, or screenshots.

PowerShell example for one Host process:

```powershell
$env:OPENAI_API_KEY = 'sk-...'
dsh --profile web
```

The plugin resolves the credential for each generation. Rotating the credential does not require changing plugin configuration.

## Use

Ask naturally in a DSH conversation, for example:

> Generate a cinematic 16:9 product photograph of a translucent mechanical keyboard on a dark glass desk, violet rim light, no text.

The model calls `image_gen`. While it runs, the card shows a developing animation and replaces the preview with each real streamed partial. DSH's existing interrupt control cancels the request. The settled card supports preview and download.

Tool options:

- `prompt`: detailed generation instructions, 1–32,000 characters and at most 64,000 UTF-8 bytes.
- `size`: `auto` or arbitrary `WIDTHxHEIGHT` accepted by GPT Image 2: each edge divisible by 16, no edge above 3840, aspect ratio 1:3–3:1, and 655,360–8,294,400 total pixels.
- `quality`: `auto`, `low`, `medium`, or `high`.
- `output_format`: `png`, `jpeg`, or `webp`.
- `output_compression`: 0–100 for JPEG/WebP only.
- `background`: `auto` or `opaque`. GPT Image 2 does not support transparent output.

## Configure

The bundle inserts the `image-gen` row with safe defaults. Override it in the selected profile's `cordis.patch.yml`:

```yaml
- id: image-gen
  name: dsh-image-gen
  config:
    apiKeyEnv: OPENAI_API_KEY
    baseUrl: https://api.openai.com/v1
    model: gpt-image-2
    defaultSize: auto
    defaultQuality: auto
    defaultOutputFormat: png
    defaultOutputCompression: 90
    defaultBackground: auto
    moderation: auto
    partialImages: 3
    requestTimeoutMs: 120000
    maxRetries: 2
    retryBaseMs: 1000
    maxConcurrent: 2
```

Configuration fails at load for an invalid provider URL or default image size. Plain HTTP is accepted only for `localhost`, `127.0.0.1`, or `[::1]` development endpoints. Credential-bearing requests use `redirect: "error"`.

### Cost note

OpenAI bills image generation by the selected image quality and size. Each progressive partial image costs an additional 100 image-output tokens according to the provider guide. Set `partialImages: 0` to minimize partial-preview cost, or `1`–`3` to trade cost for a richer live experience.

## Data, network, and permissions

- **Network:** sends the image prompt and selected options to `baseUrl`; the default is OpenAI's Images API.
- **Credentials:** reads only the configured DSH credential reference per request. The resolved secret is not stored in plugin state, logs, metadata, or session history.
- **Storage:** stores only completed images through the DSH attachment service. Partial frames stay in bounded Host memory while the call is active and are then discarded.
- **Browser access:** uses a loopback-only private RPC. A final image is returned only after the Host finds the exact attachment reference in the requested session and call record.
- **Workspace files:** does not read or write the session workspace.
- **User data:** prompts and tool arguments follow DSH's normal session logging. OpenAI receives the prompt under the terms governing the configured API account.

## Troubleshooting

### `No credential is configured for OPENAI_API_KEY`

Configure the credential for the DSH Host process, then retry. Never send the key in chat.

### Image generation was blocked

Revise the prompt. The plugin does not retry provider moderation or user-input errors.

### Preview unavailable after success

Refresh the page. If the card still cannot load, inspect Host logs and verify that the profile still mounts `dsh-image-gen` and its attachment store is available.

```powershell
dsh plugin --profile web why dsh-image-gen
dsh --profile web --dump-config
```

### Requests time out

Increase `requestTimeoutMs` within its 10–300 second range, select a lower quality, or use JPEG. DSH interruption still aborts the upstream request.

### Roll back or remove

Before changing a production profile, take a DSH config snapshot when the undo plugin is installed. To uninstall:

```powershell
dsh plugin --profile web remove dsh-image-gen
```

Restart the DSH Host and refresh the page. Existing image records remain in session history; their custom card requires the plugin to be installed.

## Development

```powershell
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

Tests use deterministic mocked SSE streams and a local redirect server. A real OpenAI smoke test is intentionally not part of the keyless suite. Real provider behavior was not exercised in this checkout because no `OPENAI_API_KEY` was available.

The build emits:

- `lib/index.js`: Host Cordis plugin.
- `lib/client.js`: browser module-loader bundle.
- `lib/client.js.map`: browser source map.

## Known limitations

- Version 0.1 generates new images. Codex-style reference-image editing is not yet exposed because a safe DSH attachment selector and explicit external-upload consent are needed.
- Final previews are intentionally loopback-only. Remote Web clients receive a clear unavailable state rather than image bytes.
- Current DSH credential resolution and attachment saving do not accept cancellation signals. The plugin checks cancellation before and after those stages and waits for them during teardown, but cannot interrupt a provider implementation that stalls inside either service.
- OpenAI may evolve arbitrary-size limits or event fields. The plugin fails closed on incompatible responses instead of guessing.

## Security

See [SECURITY.md](./SECURITY.md) for private reporting. Do not include API keys, private prompts, or generated private images in a public issue.

## License

[MIT](./LICENSE)
