# Prova sanitizada — LID enforce
Execuções locais sem build. Somente status e nomes de testes sintéticos, sem stack/payload/workflow.

## RED: source origin/main anterior, teste novo

```text
ok 1 - dispatch undefined: unresolved LID reaches durable delivery
ok 2 - dispatch off: unresolved LID reaches durable delivery
ok 3 - dispatch shadow: unresolved LID reaches durable delivery
not ok 4 - dispatch enforce: unresolved LID reaches durable delivery
not ok 5 - real recovery method: unknown LID is marked sent and receipt completes
ok 6 - real recovery method: confirmed alias retains phone routing
not ok 7 - real recovery method: conflicting alias preserves LID without choosing a phone
ok 8 - real recovery method: unexpected find failure remains retryable
ok 9 - real recovery method: unexpected mapping failure remains retryable
not ok 10 - real recovery method: durable failure never runs best-effort or completes receipt
not ok 11 - real recovery method: fencing failure cannot complete the receipt
ok 12 - real recovery method: already sent chatbot is not delivered again
not ok 13 - real recovery method: unresolved fallback preserves the alternate hint
ok 14 - dispatch: resolved identity keeps the phone and does not log fallback
ok 15 - dispatch: failed delivery keeps the receipt failed without success logging or best-effort
# tests 15
# pass 9
# fail 6
```

## GREEN: source corrigido, teste novo

```text
ok 1 - dispatch undefined: unresolved LID reaches durable delivery
ok 2 - dispatch off: unresolved LID reaches durable delivery
ok 3 - dispatch shadow: unresolved LID reaches durable delivery
ok 4 - dispatch enforce: unresolved LID reaches durable delivery
ok 5 - real recovery method: unknown LID is marked sent and receipt completes
ok 6 - real recovery method: confirmed alias retains phone routing
ok 7 - real recovery method: conflicting alias preserves LID without choosing a phone
ok 8 - real recovery method: unexpected find failure remains retryable
ok 9 - real recovery method: unexpected mapping failure remains retryable
ok 10 - real recovery method: durable failure never runs best-effort or completes receipt
ok 11 - real recovery method: fencing failure cannot complete the receipt
ok 12 - real recovery method: already sent chatbot is not delivered again
ok 13 - real recovery method: unresolved fallback preserves the alternate hint
ok 14 - dispatch: resolved identity keeps the phone and does not log fallback
ok 15 - dispatch: failed delivery keeps the receipt failed without success logging or best-effort
# tests 15
# pass 15
# fail 0
```

## Controles existentes: identidade, sinks e contratos

```text
ok 1 - Chatwoot failure is persisted and does not prevent the following n8n sink
ok 2 - fencing failure rejects instead of pretending the sink was recorded
ok 3 - a confirmed remoteJidAlt persists for a later LID-only event and keeps the reply destination
ok 4 - Baileys contact is accepted only when it returns a full phone JID
ok 5 - unknown, conflicting and cross-instance aliases fail without deriving digits from the LID
ok 6 - a phone event with alternate LID confirms the alias for a later LID event
ok 7 - group addresses do not become a member phone through an alternate LID
ok 8 - unknown LID reaches the bot with its original JID in off and shadow
ok 9 - enforce delivers unknown LID and resolves future messages after alias confirmation
ok 10 - the same message ID with and without alternate JID stays in one phone session
ok 11 - durable delivery policy propagates errors while baseline policy preserves swallow semantics
ok 12 - inbound failure propagation at the controller is opt-in per integrator (n8n only)
ok 13 - durable n8n delivery is isolated from best-effort chatbot effects
ok 14 - Chatwoot edit revisions have stable identities distinct from the original WAID
ok 15 - route instanceName wins over query and prevents cross-tenant retargeting
ok 16 - Chatwoot uses WAID preflight and surfaces media delivery failures in enforce
ok 17 - health stats expose fresh unique traffic separately from duplicate replays
# tests 17
# pass 17
# fail 0
```

Typecheck focado do helper: `tsc --noEmit --strict --skipLibCheck --target ES2022` passou.

Runtime e limites estão no relatório interno. Nenhuma conclusão de CI verde.
