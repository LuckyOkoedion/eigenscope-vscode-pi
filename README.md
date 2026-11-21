# EigenScope for VS Code & Pi (`v0.2.16`)

Run the **Pi coding agent** inside VS Code with workspace file review, per-file diff & revert, and integrated **EigenScope Semantic Firewall** protection plus a live **3-Stage Protection & Reasoning Trace** inspector.

## Features

1. **Protected vs. Standard Mode Toggle (`eigenscopePi.protectionMode`)**:
   - **Protected (fail-closed):** Decomposes outbound prompts and untrusted tool outputs through EigenScope `/v1/decompose` (`CODING_AGENT_FIREWALL` & `UNTRUSTED_TOOL_IPI_FIREWALL`) before Pi sends them to its configured model provider, then restores exact protected entities locally via single-use `/v1/rehydrate` and `/v1/vault/scrub`.
   - **Audit:** Records protection and reasoning trace telemetry without blocking when unconfigured.
   - **Standard:** Runs Pi directly without EigenScope separation when explicitly selected by the user.
2. **3-Stage Protection & Reasoning Trace Drawer**:
   - **Stage 1 — Decompose & Quarantine:** Protected `symbol_keys`, symbol count, task sufficiency (`eta`), MI leakage bound (bits), compression (`rho`), and gateway latency.
   - **Stage 2 — Model Reception & Reasoning Observation:** Streams live model reasoning (`thinking_delta`) when emitted by the active provider, reports capability honestly (`Observed thinking stream` vs `Provider did not emit reasoning tokens`), and flags placeholder confusion or shortcut/bypass language.
   - **Stage 3 — Deterministic Rehydrate & Vault Scrub:** Displays `symbols_resolved`, `unresolved_placeholders`, `exact_identifier_match`, and single-use `vault_ticket_scrubbed` verification.
3. **1-Click Browser Onboarding**: Click **Connect EigenScope** to authorize via RFC 8628 device code into VS Code `SecretStorage` (and optional `0600` `~/.config/eigenscope/credentials.json`), or click **Upgrade / Credits** to add prepaid credits at [eigenscope.guardianai.network/pricing](https://eigenscope.guardianai.network/pricing).
4. **Pi File Change Review & Revert**: Tracks file modifications during a turn, shows inline added/removed line counts, opens clean VS Code diffs, and supports safe single-file revert on macOS, Linux, and Windows.

## Requirements

- Install Pi CLI (`npm install -g @earendil-works/pi-coding-agent` or run **EigenScope: Set Up Pi CLI** from the Command Palette).
- Sign in to EigenScope Cloud (`https://eigenscope.guardianai.network`) or point `eigenscopePi.endpointUrl` at your local `orthocore-sidecar` (`http://127.0.0.1:8443`).

## Security, Privacy & Architecture Boundary

- **Client-Only Boundary:** This repository contains only the open-source (Apache-2.0) VS Code webview extension and Pi bridge client. Separation, restoration, and optional enterprise enclave custody execute through authenticated calls to `/v1/decompose`, `/v1/rehydrate`, and `/v1/vault/scrub` against your configured EigenScope gateway or local `orthocore-sidecar`.
- **No On-Disk Secret Logs:** Session `vault_ticket`s live strictly in ephemeral memory, credentials use VS Code `SecretStorage` (and optional mode-`0600` `~/.config/eigenscope/credentials.json`), and opt-in trace receipts (`eigenscopePi.traceReceiptsEnabled`) contain metadata counts/keys only — never prompts, raw secret values, or reasoning text.
- **Zero Provider Proxy Wrapping:** Pi invokes your configured LLM provider directly on `task_core`; EigenScope never bundles or proxies third-party model keys.

---

Published by **Guardian AI Inc.** · [Documentation](https://eigenscope.guardianai.network/guide/coding) · [Support](https://eigenscope.guardianai.network/support)

