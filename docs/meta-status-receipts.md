# Meta status receipts

The Meta channel stores each delivery receipt in `MessageUpdate`, associated with the local
`Message` by the exact Meta message ID and the current instance. `SENT` confirms acceptance;
`DELIVERED` or `READ` confirms delivery reported by Meta. The provider strings are retained,
including `FAILED`; a successful HTTP response never creates a delivery receipt.

`contacts` and `contacts[0].profile` are optional in status webhooks. The channel tolerates absent
or empty contact arrays, handles each receipt independently, and continues the batch when a local
message is unknown, a receipt is malformed, or an event relay fails. The local receipt is saved
before relaying it. Its recipient and direction come from the matched local message, avoiding
the shared mutable recipient of another webhook. An unknown local message is skipped; this change
does not backfill old receipts or introduce a receipt retry queue.

The channel sets recipient identity before handling the event and awaits the handler. Ordinary
incoming messages retain their chatbot, message, and contact ingestion. A Meta contact without a
profile phone uses the incoming message JID. Contact updates remain scoped to the current instance.
No database migration, outgoing-message contract, pairing flow, or runtime recipe is changed.

## Verification

`npm run test:xmacna-meta` exercises the actual `BusinessStartupService` methods with database,
chatbot, telemetry, and event boundaries replaced by local fixtures. It checks optional contact
profiles, exact message relations, receipt batches, per-message identity, relay failure, deletions,
malformed receipts, ordinary incoming text, and asynchronous processing completion. Fixtures use
synthetic data and do not send WhatsApp messages. Run `npx tsc --noEmit` as well.

The regression was reproduced on production revision
`5955acd0eb15d9c25659f6716fe6c40dde07aa2b`: empty contacts and contacts without a profile throw before
receipt handling; an unknown first message or deletion returns from the whole batch. The live image
label identified that revision, and inspection of its active bundle confirmed the same paths.
The preserved September webhook capture on the Evolution host contains both `sent` and `delivered`
status values with `contacts` present and no contact profile. Its existing SHA-256 is
`53ffd090a31e72fc2f57f5485d6eaac9f9f94756cc90ff805919e25be843b60f`.
The bounded live-log inspection on 30 October also found `reading 'name'` errors whose first
application frame was `so.messageHandle` at `/evolution/dist/main.js:285:774`. The retained evidence
and local reproduction demonstrate the failing payload shape; they do not correlate every current
missing receipt with an individual inbound webhook.

The Hermes database inspection on 30 October 2026 found 798 historical updates and no updates
associated with messages newer than 13 April. Three recent outgoing message IDs were present but
had empty `MessageUpdate` relations. This establishes the observation gap. It does not prove that
every missing receipt reached this handler or that every omission has the same cause. Deployment
validation must correlate a new test message ID with a persisted `DELIVERED`/`READ` receipt and the
campaign history. Preparation and local tests alone do not establish live delivery.

The existing Meta controller still dispatches entries through an asynchronous `forEach` and passes
the original first-entry envelope to the channel. This separate multi-entry routing limitation is
outside this handler repair. The HTTP response is not a processing-completion barrier; check the
exact message relation when validating receipts.

Tracking: [xmacna/elysium#677](https://github.com/xmacna/elysium/issues/677) and
[xmacna/elysium#1019](https://github.com/xmacna/elysium/issues/1019).
