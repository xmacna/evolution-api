# WhatsApp Business app coexistence — 2026-11-24

Owner: ger-nyx-sol / Evolution worker. Branch: nyx/meta-coexistence-echoes-20261124.

- [x] Read mandate, current main, rules and official echo/messages documentation today.
- [x] Diagnose unawaited dispatch, first-entry/change-only routing, unsafe statuses and missing echo handling.
- [x] Agree strict pause contract with Elysium owner (see docs/coexistence/echoes.md).
- [x] RED: execute actual service/controller/Chatwoot methods against official-derived fixtures and isolated boundaries.
- [x] GREEN: echo persistence, verified human pause, strict Portal mirror, retry/dedupe and batch routing.
- [ ] Review checkpoint before push; draft PR dedicated to echoes/status guard.
- [ ] Separate branch: durable contacts/history ingest and readiness; no historical bot replay or current human pause.

AGUARDA: manager review before push; Elysium pause draft must be reviewed/configured alongside this PR before rollout. Elysium owner supplied offline route + verified writer/readback tests using bot_pause_states. No production/deploy/merge/real-number actions authorized.
