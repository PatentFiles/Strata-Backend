---
name: Kalshi PEM in Secrets
description: Replit Secrets may preserve a signing key as a single line instead of multiline PEM.
---

Treat an invalid local signature-key parse separately from an exchange authentication failure. A multiline PEM entered into Secrets can reach the development process as a single line with its BEGIN and END delimiters intact. Restore the boundary newlines before parsing; never log the key, its body, or raw cryptographic exceptions.

**Why:** A read-only exchange verification initially failed before any HTTP request because the signing key was single-line; boundary normalization made the same key parse and authenticate successfully.

**How to apply:** For future Kalshi signing-key troubleshooting, report only credential-presence and parse-status metadata, then confirm actual GET authentication. Do not ask for the key in chat or assume a local parse failure means the exchange rejected credentials.