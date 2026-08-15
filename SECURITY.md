# Security Policy

## Supported versions

Security fixes are provided for the latest tagged release and the current default branch.

## Report a vulnerability

Please use GitHub's [private vulnerability reporting](https://github.com/LeemanCheung/dsh-image-gen/security/advisories/new). Do not open a public issue for a vulnerability.

Include the affected version or commit, DSH version, operating system, reproduction steps, and impact. Remove API keys, private prompts, generated private images, filesystem paths, and unrelated logs before submitting.

If private vulnerability reporting is temporarily unavailable, open a public issue that requests a private contact channel without disclosing technical details.

## Credential and data expectations

- The plugin resolves the configured credential reference for each operation and must never persist or log the resolved secret.
- Provider requests reject redirects and default to HTTPS. Plain HTTP is limited to loopback development hosts.
- Final-image RPC reads are loopback-only and authorized against the exact session and call record.
- Partial image bytes are bounded, kept only during an active call, and never written to session history.
- Completed images are validated and stored by DSH's attachment service.
