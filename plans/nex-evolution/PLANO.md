# Nex Evolution — Round 3, controlled mode race

Owner `nex-evolution-build-sol`, gpt-6.1-sol/high, no subagents; up to three implementation deliveries. Origin: explicit round3 mandate, [PR11 AJUSTES](https://github.com/xmacna/evolution-api/pull/11#issuecomment-6712969805), FILA-AUTORIZADA/PAUTA3 and round2 checkpoint.

## Ownership and criterion

Own worktree `C:\Users\Lucca Galaxy Book\work\nex-night-20261107\evolution-inbox-race-repro`; branch `xmacna/inbox-mode-race-repro`; main base `6b93af39399f01a17aa421b0a235d82c41c6e4c9`. Active claim `pr11-mode-race-controlled-repro`; claims and open PRs checked before editing. Existing PR11/14 branches and Partenon1066 owner preserved.

- [x] Read brief, previous checkpoint/handoff, original CI artifact, runtime and CI configuration; archive round2 runtime documents.
- [x] Add two controlled first-snapshot cases preserving all runtime bytes, Serializable and eight retries; original test/assertions untouched.
- [x] Execute real database cases in existing disposable CI, capture native error provenance and attempt counts: both first conflicts P2034/known; loser resolved on attempt2; full CI/PG/build PASS on source6538a08.
- [x] Record bounded conclusion in paired docs: original rejection not reproduced/explained; runtime correction not justified. Publish final-SHA proof and independent review request after final checks.
- [ ] Continue next independent executable issue if no original failure is established; waiting for review is not backlog.

The repo's tracker is GitHub xmacna/evolution-api; the linked origin issue is in xmacna/elysium. No CONTEXT/ADRs or configured triage vocabulary exists on this base, so no triage labels/architecture decision is invented. Domain context is the real inbox implementation and existing offline/PG tests: claim persists fenced receipt under enforce; transition must refuse downgrade while incomplete receipts exist; off bypass retains dispatch semantics. Skills setup-matt-pocock-skills/diagnose context from this task is retained without changing another front's global configuration.

[Controlled diagnosis](../../docs/inbound-mode-race/CONTROLLED.md) · [HTML](../../docs/inbound-mode-race/CONTROLLED.html). The remaining original PR11 gate needs actual failure provenance; another blind stress run is not an executable next task. Independent next item: `query.sh` accepts non-Success SSM readbacks because it only rejects Failed, unlike the separate query-vec work owned by nex-maquina-correcao-sol. Reproduce with Bash/AWS fixtures in a new Elysium worktree, open a concrete issue and keep scope separate. No local service, customer/production operation, deployment, merge or same-SHA rerun. All report/plan files are committed with their sibling HTML.
