# EigenScope for VS Code & Pi (`v0.2.19`)

Protect proprietary code, API credentials, customer identifiers, and internal infrastructure across every AI coding agent in VS Code—including **GitHub Copilot**, **Pi Coding Agent**, **Claude Code**, **Cursor**, **OpenAI Codex CLI**, **Meta Muse Code**, **Antigravity IDE**, **Gemini CLI**, **Cline / Roo Code**, and **Continue**. Configure zero-secret MCP and lifecycle hook protection in one click and watch live multi-provider reasoning streams strictly in RAM via the **Chain-of-Thought (CoT) Stream Explorer**.

## Core Capabilities

1. **Universal In-IDE AI Agent Auto-Detection & 1-Click Zero-Secret Wiring**
   - Automatically discovers installed AI extensions (`GitHub Copilot`, `Claude Code`, `Cline / Roo Code`, `Continue`, `OpenAI Codex`, `Codeium`, `Amazon Q`, `Cody`) and local workspace agent configurations (`.claude/`, `.cursor/`, `.codex/`, `.muse/`, `.agents/`).
   - Click **Configure Automated Protection (1-Click)** to generate clean `.vscode/mcp.json`, `.mcp.json`, `.claude/settings.json`, `.cursor/mcp.json`, `.codex/config.toml`, and `.muse/eigenscope-settings.json` wired to `@eigenscope/mcp-server` and `eigenscope-hook`—with zero plaintext secrets stored in repository config files.

2. **Live RAM-Only CoT Stream Explorer (Cross-OS & Multi-Provider)**
   - Streams full, readable `CHAIN OF THOUGHT` reasoning steps, tool calls, token counts, and automated quality/safety alerts (hedging, missing-context complaints, bypass claims) directly inside VS Code memory across macOS, Linux, and Windows (`Claude Code`, `Codex CLI`, `Gemini CLI`, `Antigravity IDE`, `Meta Muse Code`, `Cline`, `Roo Code`, `Continue.dev`, `Pi CLI`).
   - Raw reasoning text stays strictly in RAM and is never persisted to disk.

3. **3-Stage Protection & Deterministic Local Restoration**
   - **Stage 1 — Outbound Protection:** Decomposes prompts and untrusted tool outputs via fail-closed mathematical 4-channel separation before any external model sees them, enforcing task-equivalence and mutual-information leakage bounds.
   - **Stage 2 — Live Model Reception:** Captures streaming reasoning (`thinking_delta`) honestly with explicit provider capability reporting and live placeholder safety diagnostics.
   - **Stage 3 — Lossless Rehydration & Session Wipe:** Restores exact original names, credentials, and figures locally and immediately destroys the single-use memory ticket (`/v1/vault/scrub`).

4. **Protected vs. Audit vs. Standard Modes & Pi File Review**
   - Toggle `eigenscopePi.protectionMode` between **Protected** (fail-closed enforcement), **Audit** (telemetry observation), and **Standard** (direct passthrough).
   - Review Pi file modifications turn-by-turn with inline added/removed line counts, side-by-side VS Code diffs, and single-file revert across macOS, Linux, and Windows.

5. **1-Click Browser Device-Code Sign-In**
   - Click **Connect EigenScope** to sign in via RFC 8628 browser device code into VS Code `SecretStorage` (and optional mode-`0600` `~/.config/eigenscope/credentials.json`), or connect directly to your self-hosted `orthocore-sidecar`.

## Requirements

- VS Code `>= 1.95.0` and Node.js `>= 20.0.0`.
- Sign in to EigenScope Cloud (`https://eigenscope.guardianai.network`) or point `eigenscopePi.endpointUrl` to your private `orthocore-sidecar` (`http://127.0.0.1:8443`).
- Optional Pi CLI (`npm install -g @earendil-works/pi-coding-agent` or run **EigenScope: Set Up Pi CLI** from the Command Palette; automatically resolves `nvm`, Volta, `fnm`, and Homebrew installations).

## Security, Privacy & Product Boundary

- **100% Customer-Owned Model Providers:** Your coding agents continue calling your chosen LLM providers directly on protected `task_core` text; EigenScope never proxies or bundles third-party model keys.
- **Zero On-Disk Secrets or Reasoning Logs:** Volatile `vault_ticket` mappings exist only in RAM until immediate zeroization, and opt-in trace receipts (`eigenscopePi.traceReceiptsEnabled`) record content-free metadata only—never prompts, secret values, or reasoning streams.

---

Published by **Guardian AI Inc.** · [Documentation](https://eigenscope.guardianai.network/guide/coding) · [Support](https://eigenscope.guardianai.network/support)
