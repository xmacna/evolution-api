# Nex Evolution — Round 3, controlled mode race

Owner `nex-evolution-build-sol`, gpt-6.1-sol/high, no subagents; up to three implementation deliveries. Origin: explicit round3 mandate, [PR11 AJUSTES](https://github.com/xmacna/evolution-api/pull/11#issuecomment-6712969805), FILA-AUTORIZADA/PAUTA3 and round2 checkpoint.

## Ownership and criterion

Own worktree `C:\Users\Lucca Galaxy Book\work\nex-night-20261107\evolution-inbox-race-repro`; branch `xmacna/inbox-mode-race-repro`; main base `6b93af39399f01a17aa421b0a235d82c41c6e4c9`. Active claim `pr11-mode-race-controlled-repro`; claims and open PRs checked before editing. Existing PR11/14 branches and Partenon1066 owner preserved.

- [x] Read brief, previous checkpoint/handoff, original CI artifact, runtime and CI configuration; archive round2 runtime documents.
- [x] Add two controlled first-snapshot cases preserving all runtime bytes, Serializable and eight retries; original test/assertions untouched.
- [ ] Execute real database cases in existing disposable CI, capture native error provenance and attempt counts.
- [ ] Publish bounded conclusion, meaningful code/test evidence, paired docs and independent review at final SHA. Propose runtime correction only after reproducing and explaining its failure.
- [ ] Continue next independent executable issue if no original failure is established; waiting for review is not backlog.

The repo's tracker is GitHub xmacna/evolution-api; the linked origin issue is in xmacna/elysium. No CONTEXT/ADRs or configured triage vocabulary exists on this base, so no triage labels/architecture decision is invented. Domain context is the real inbox implementation and existing offline/PG tests: claim persists fenced receipt under enforce; transition must refuse downgrade while incomplete receipts exist; off bypass retains dispatch semantics. Skills setup-matt-pocock-skills/diagnose context from this task is retained without changing another front's global configuration.

[Controlled diagnosis](../../docs/inbound-mode-race/CONTROLLED.md) · [HTML](../../docs/inbound-mode-race/CONTROLLED.html). CI/build results are pending execution, not assumed. No local service, customer/production operation, deployment, merge or same-SHA rerun. All report/plan files are committed with their sibling HTML.
