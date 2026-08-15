# Contributing

Contributions are welcome through focused issues and pull requests.

## Setup

Requirements:

- Node.js 22.19 or newer (Node.js 24 is also tested).
- DeepSeek Harness 0.1.0-rc.6 or newer compatible prerelease.

```powershell
npm ci
npm run check
```

`npm run check` typechecks both platforms, runs the keyless transport/Host/component suite, builds Host and browser bundles, executes the built-artifact smoke, and validates package metadata. Publint reports an expected warning for `lib/client.js`: DSH requires that `.js` path but reads its CommonJS closure factory as browser module-loader source rather than importing it as Node ESM.

## Changes

- Keep Host side effects owned by the Cordis fiber and await asynchronous teardown.
- Keep the model-facing result text-only. Final image references belong in versioned presentation metadata and the bounded Code Mode replay marker.
- Treat RPC payloads, provider responses, and durable session records as untrusted JSON.
- Reject credential-bearing redirects and preserve all response limits.
- Update `lib/index.js`, `lib/client.js`, and `lib/client.js.map` with every source change. CI rejects stale bundles.
- Update both English and Chinese documentation for user-visible behavior.
- Add regression coverage for changed transport, lifecycle, replay, or card behavior.

## Real provider checks

The default suite never reads `OPENAI_API_KEY`. If you manually exercise OpenAI, use a disposable test project, review cost settings, and never attach a key, private prompt, or private generated image to an issue.

## Security

Do not report vulnerabilities in a public issue. Follow [SECURITY.md](./SECURITY.md).
