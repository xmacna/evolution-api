# Business app echoes — proposal and evidence (2026-11-24)

## Diagnosis and contract checkpoint

Fresh main: MetaController dispatches entry.forEach(async), only first change, then passes the entire batch to a service that reads its first entry/change. Its event handler is unawaited and statuses[0] is unsafe. messageHandle emits inbound/chatbot before Chatwoot and catches failures. Echoes need a separate path, including their own acknowledgment.

Evolution owns routing, echo normalization/persistence and Portal mirroring. Elysium owns the existing durable bot_pause_states human-pause mechanism. Before mirroring or accepting an echo, Evolution calls POST /api/bot-control/whatsapp-business-app-echo-pause with x-partenon-secret and {instanceName,phoneNumberId,messageId,remoteJid,timestamp,conversationId}. URL/token have explicit empty-default WA_BUSINESS_COEXISTENCE_PAUSE_URL/TOKEN settings. Only {ok:true,verified:true,paused:true} or the verified superseded_by_resume response is acceptance. No normal bot emission or inbound receipt is created for an app echo. Existing integration sessions may also be paused, but that is not proof that an external workflow is paused.

A stable Message identity includes instance ID and Meta message ID; pending delivery is retried, and completion is recorded atomically in contextInfo.coexistenceEchoDelivered with the Portal IDs after pause and Portal acknowledgment. Delivery statuses cannot consume or reopen this completion marker. The Portal conversation is resolved before the backend validates its account/inbox/contact binding; no outgoing message is created until verified pause acknowledgment. Portal mirrors retain WAID: source IDs so Chatwoot's existing send guard prevents WhatsApp retransmission. Reconciliation uses the existing configured Chatwoot import connection; missing connection fails explicitly rather than silently claiming deduplication.

BSUID-only recipients are a valid current Meta variant. This draft explicitly rejects processing with a dedicated unsupported-identity error and does not acknowledge success, manufacture a phone/JID, or discard it as an invalid payload. General rollout is blocked until a separate identity/mapping implementation is proved. No production or real-number proof is claimed.

## Official sources opened today

- https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users — app mirroring, 24h sync, no register, current BSUID warning.
- https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/smb_message_echoes — full syntax; text, revoke and edit examples; to is optional, to_user_id is a distinct user identifier.
- https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages — regular inbound text and delivered-status examples, no requirement for contacts on failure statuses.
- https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages — official media message references.
- https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/history — future piece: phases/chunks, progress, consent error, media follow-up.

Fixtures retain documented field names and shape, replacing every identifier, timestamp, phone and body with synthetic local values. Derived variants (batches, empty arrays, BSUID-only, media) are labeled in test/fixtures/meta-coexistence/README.md. They contain no live payload, credential or lead data.

## Validation environment

Initial implementation used no new dependencies. The manager later authorized one narrow exception for the CI security finding: pinned express-rate-limit 8.7.5 (see below). Existing read-only esbuild 0.25.5 at /home/luccanxbc/awc-lote2/src/node_modules is used to transpile the actual production classes into a VM with only external boundaries stubbed. Local Node is v26.13.0; production engine requires Node 24, so this harness does not replace Node 24 CI/typecheck. No HTTP, DB, service, container, app startup or Graph calls are allowed in the harness.


## Implemented behavior and boundaries

The public Meta callback now authenticates coexistence events with X-Hub-Signature-256, using bytes captured by the express.json verify hook only on /webhook/meta. WA_BUSINESS_APP_SECRET has an empty default. Missing configuration returns 503; missing/invalid signatures or missing raw bytes return 403 before controller dispatch. When the secret is configured, all Meta POSTs require signatures. WA_BUSINESS_ALLOW_UNSIGNED_LEGACY=true deliberately preserves the former ordinary-message behavior only when no app secret is configured; false requires configured verification for all traffic. This GET challenge token is separate from the App Secret.

App echoes never create InboundReceipt, publish MESSAGES_UPSERT to normal inbound webhook/bot sinks, or initialize a chatbot session. Existing native sessions are paused through IntegrationSession; the actual native BaseChatbotService.process method ignores a subsequent inbound in that state. External workflows rely on the Elysium endpoint's existing bot_pause_states writer/readback, never on this native session as a substitute. A verified superseded_by_resume response preserves the later human choice, including native sessions.

Text and media identifiers are persisted as outgoing. Media uses the actual existing Business GET downloader and Portal attachment sender, never a new WhatsApp POST. Revoke/edit currently append Portuguese notices in the thread with the original Meta ID retained in local contextInfo; they do not mutate/delete the original Portal entry. Edits without supported text/caption fail explicitly. Unknown echo content is not silently accepted.

Retries after pause, Portal errors, and Portal acceptance followed by local DB failure remain pending until acknowledged. Portal source reconciliation is persistent. The in-memory promise map coalesces only simultaneous calls in a single process; it is not a distributed lock. Concurrent processes can still race before the remote source_id is committed, so this PR does not claim exactly-once delivery across replicas. General rollout requires verified Portal uniqueness/idempotency and the identity follow-up.

This PR alone does not enable history or smb_app_state_sync ingestion. Signed delivery is not sync readiness. Those fields fail explicitly before normal inbound processing and still require the separate durable capture/recovery/status implementation (piece 3). This includes official history media follow-ups in value.messages, which must never be mistaken for live inbound. No Graph SMBAppData POST is implemented or triggered by an incoming webhook here.

## Local validation and reproduction

With the repository's existing dev dependencies available:

```sh
npm run test:xmacna-meta-coexistence
git diff --check
```

In the constrained review environment, the same npm script ran with NODE_PATH pointing to the existing read-only esbuild installation; no dependency was installed. The test uses actual production service, controller, router, Portal adapter, media downloader, Portal send guard, and native bot process methods, transpiled in a VM. HTTP, persistence and app runtime boundaries are replaced; no app server/container/database is started. Fixtures are synthetic and documented next to the tests.

- Initial main preimage: 15 tests RED, including the unsafe empty payload and missing echo adapter/batch handling. Evidence: evidence/echo-red.txt.
- Signature test before signature implementation: RED (unsigned POST returned 200 instead of 403). Evidence: evidence/signature-red.txt.
- Current implementation: 44 tests GREEN. Evidence: evidence/echo-green.txt.
- History media guard before its fix: RED (historical value.messages incorrectly reached live processing); evidence: evidence/history-guard-red.txt.
- git diff --check passed. Full lint/typecheck/production engine run were unavailable: no complete repo dependencies, no Prettier/ESLint or Node 24 donor found. Local Node was 26.13.0 and existing esbuild 0.25.5; the repo declares Node 24 and esbuild 0.27.7. Tests are wired into the existing inbox CI command, but no CI result is claimed here.

Cross-repo pause evidence is owned by Elysium: src/partenon/server/src/routes/__tests__/businessAppEchoPause.test.ts executes the authenticated route and real writeVerifiedPauseState against stubbed Directus/HTTP, including readback mismatch failure. This complements the Evolution boundary tests; it does not claim a live n8n/Clara execution.

No deploy, pairing, real-number message, live DB, production API or merge was performed. Draft review remains a prerequisite to any runtime rollout, together with Elysium pause configuration, exact instance allowlist/binding, App Secret, subscriptions and the separate history/identity pieces.

## Workflow review

The existing quality workflow runs on PRs to main and pushes to main, with isolated PostgreSQL, lint/tests and a source build. Security runs CodeQL/dependency review. Neither workflow deploys or builds/pushes a container image. The feature-branch push itself does not match their main-only push trigger. No workflow file was modified.


## CI findings and bounded dependency exception

The first CI run reported 12 lint issues in this delta and a new CodeQL missing-rate-limiting finding on the signature authorization route. The lint issues were corrected. The manager explicitly authorized adding pinned express-rate-limit 8.7.5 instead of an unmodeled custom limiter. package-lock-only with scripts/audit/funding disabled changed 20 lockfile lines; debug 4.4.3 and ip-address 10.7.2 were already locked. No dependency tree was installed on SSD. Only the middleware and ip-address package were extracted in RAM for the real middleware test, with existing debug/ms read-only.

POST /webhook/meta applies the standard middleware before HMAC and controller effects, with a default 12,000 requests per observed client IP per 60 seconds. Rejection returns 429 and Retry-After; a test uses the actual library with a controlled clock to prove window recovery. The default memory store is per process and resets on restart; it does not establish distributed limits. No trust-proxy setting, client-IP spoofing bypass, workflow suppression or CodeQL dismissal was added. Deploy review must tune capacity for the actual Meta/load-balancer aggregation. Official library usage/configuration opened 2026-11-24: https://express-rate-limit.mintlify.app/quickstart/usage and https://express-rate-limit.mintlify.app/reference/configuration .

A further review caught a country-identity mismatch: the generic Baileys createJid helper transforms BR/MX/AR numbers. The Cloud service now preserves authoritative E.164 digits consistently in app echo, incoming messages, contacts and available status recipients. BR/MX/AR synthetic tests execute the real legacy utility as a control, and the real service uses a dedicated exact Cloud identity helper. Previously stored heuristic-based contacts/sessions are not migrated or merged by this PR; reconciling those records requires a separately reviewed migration, not fabricated country aliases. Source proof: the official echo/messages references identify to/from/recipient_id as the actual Cloud user phone values.

Additional RED evidence: evidence/cloud-identity-red.txt and evidence/rate-limit-red.txt. Current evidence/echo-green.txt includes all 44 tests. The first CI did not pass; a subsequent full CI result must be read from the PR checks rather than inferred from these local tests.


## Other app message types and future content

Static location, shared contacts and reactions are now covered. Location reuses the existing pure location normalization and Portal renderer. Reactions reuse the message helper and display an outgoing Portuguese notice with the target message ID retained only in metadata; absent emoji displays removal. Shared contacts display their names, optional phones/emails/sites/addresses/organization/birthday, including contacts without phones. The complete original payload remains in local contextInfo for these structured messages. They follow the same verified-pause and WAID mirror path and never create a live inbound or send a reaction/location/contact back to WhatsApp.

An authenticated phone-addressable echo whose presentation is unknown is stored durably as businessAppUnsupportedMessage before the verified pause. The Portal thread is resolved for binding, the real pause is verified, and the mirror fails explicitly while the payload remains pending. It is not silently discarded or acknowledged as complete. BSUID-only remains the separate identity block described above.

Official sources opened 2026-11-24:

- https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/location — coordinates, optional name/address/url and full webhook example.
- https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/contacts-messages — contacts array; formatted name required; phone and other metadata optional.
- https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/reaction-messages — message_id/emoji request example, fetched as public text/markdown after the web tool returned 429.
- https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/reaction — full reaction and removal webhook examples, including omitted emoji, fetched as public text/markdown and read from the manager's RAM copy.

Evidence/complex-echo-red.txt records the failing new cases before implementation; echo-green.txt includes the passing 44-case suite. Complex-content.json replaces all names/contacts/locations/IDs/addresses with synthetic values; it is combined with the official-derived echo envelope. Existing pinned Prettier 3.9.6 was fetched into private RAM, verified against package-lock's SHA-512 integrity, and used only on the changed source files. No formatter dependency or lock entry changed.


## Reconciled Portal ID semantics

PostgreSQL bigint IDs arrive as strings, so every mirror acknowledgment now validates/converts message, inbox and display-conversation IDs to positive Prisma Int32 values. Invalid/nonintegral/overflow IDs fail rather than marking completion. A subsequent source review proved that Chatwoot API conversation IDs are per-account display_id, while messages.conversation_id is the internal FK. The echo-specific reconciliation now joins conversations and contacts, scopes account+inbox+source_id, verifies the recipient and returns display_id. Before asking for human pause, retry preparation reuses the existing source message's thread rather than creating a fresh one after a conversation was resolved. Legacy helper callers without this explicit scope retain their former path.

Primary source opened 2026-11-24: xmacna/chatwoot app/models/message.rb (push_event_data), app/models/conversation.rb (database-generated display IDs), and API conversations base/direct-upload controllers. The PostgreSQL test deliberately uses internal IDs 101/202 with display_id 7 in two separate accounts and proves scope/recipient behavior with the actual import helper. It runs in the existing isolated PostgreSQL CI command, without starting an app or calling a production API. Evidence: display-id-red.txt, echo-postgres-green.txt and the 44-case echo-green.txt. Local PG16 was private, disposable and bound to loopback in RAM; no live database was accessed.

A format that was initially retained as unsupported is not remapped automatically by the collision guard if parser support is added later. Re-presentation requires explicit reconciliation of that pending record; no live backfill is part of this change.


## Ordinary receipt boundary and per-instance Portal snapshot

Ordinary messages/statuses retain the legacy asynchronous acceptance boundary: the callback does not wait for chatbotController.emit/n8n/LLM completion. Identity guards run before acceptance; background failures are caught with a payload-free log. This is deliberately distinct from echoes (verified pause + Portal acknowledgment) and the separate durable history capture. No global Cloud inbound receipt implementation was added. A controlled pending chatbot promise reproduced the blocking regression before this fix, and a rejection test confirms detached failures are handled.

The two strict echo methods use an instance-scoped receiver for legacy Portal helpers, with the provider/getProvider snapshot captured before awaits. Another instance changing the singleton's provider cannot retarget its account, URL or credentials. An interleaving test exercises that boundary; the ordinary legacy Portal integration was not refactored.


Strict echo/history/state changes are accepted before ordinary asynchronous changes in a mixed batch. A failure that makes Meta retry the complete batch therefore does not launch ordinary work first. Relative order within each class is preserved. A controlled controller test reproduced the ordinary emission before a later echo failure, then passed with strict-first handling; this is not a global Cloud receipt/deduplication mechanism.


App media calls use the strict download/base64 mode: only fixed messages are logged/propagated on failure, without raw Axios errors, URLs or authorization headers. The legacy mode remains unchanged for other callers. A synthetic Axios failure containing a clearly fake bearer value and URL reproduced the leak before this fix; media-secret-red.txt and the 44-case echo-green.txt record the result. Reaction notices show natural Portuguese text; the target ID is retained in API/local metadata rather than displayed to attendants.
