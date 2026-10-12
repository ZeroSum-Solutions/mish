# Inactive source repository and snapshot boundary

[storage/workbench-source-store.ts](../storage/workbench-source-store.ts) accepts an already-open SQLite database and
the server's resolved data root. Follow the root [daemon data directory contract](../../../../AGENTS.md#daemon-data-directory-contract).
`migrateSourceRecords` is an explicit migration hook. Only the coordinated bootstrap registers it, versioned, on the owned database after native ownership ([placement runtime](placement/RUNTIME.md)); ordinary bootstrap does not.
This is the first unreleased schema; it supplies no migration from a previously
installed draft schema: version-1 registration refuses pre-existing unversioned tables rather than backfilling them.
Future migration and publication must run under the daemon's qualified ownership,
recovery and write admission boundary. This increment supplies no coordinator permit.

`publish(record, expectedRevision)` atomically appends immutable metadata and
advances its head with a compare-and-set check. An exact current retry changes
nothing. History retains prior restrictions; the store offers no deletion or head
rollback. ResourceRef and admission associations stay fixed across revisions.
Terms and evidence publication require their exact immutable admission revision
to exist first; refusal leaves records, heads and generation unchanged. Retrying
after admission publication derives the canonical resource key at insertion.
Record hashes detect accidental corruption and supply no provenance. F1 parsers
validate stored admission/assessment shapes; local strict parsers cover terms and
evidence metadata. Terms/proof bodies stay in their existing private evidence store.

`buildTrustedSourceSnapshot(store, request, dependencies)` authenticates the
principal and reads one SQLite snapshot. Root must inject actual current project
and source authority, issuer/revision verification, terms verification, source
inspection, evidence-byte reads and verification, and licence/client/obligation
resolution. Issuer verification authenticates the exact human-issued record and
explicit supersession of prior restrictions; choosing the highest number is
insufficient. Verification includes a stream whose earlier principal/project/ref
matched the caller, even when its new head moves out of scope. Different assessment
IDs remain active, including denials. Discovery uses the issued canonical
ResourceRef, independently of an assessment's unsigned admission envelope. Source
verification receives all immutable same-resource admission histories and must
verify changes to acquisition mode, origin, target and bytes against prior
restrictions. Evidence must bind an existing immutable admission of that same
resource and acquisition channel and its actual current SQLite head; an alias ID
alone grants nothing. Earlier alias revisions cannot supply current proof.

The inspector must read acquired and closure file bytes, audit dependency byte
pins, and recompute closure identity using the existing acquisition convention.
The builder hashes acquired/file/proof bytes, checks sizes/roles and exact closure
metadata, then verifies principal/source/terms/connector and operation evidence
bindings. Operation evidence has explicit project, target, audience and operation
scope. A source scope is limited to acquisition, terms and licence evidence.
Source-wide terms-independent acquisition/project proof may carry null terms;
other evidence must bind the current terms, including an explicitly verified
null-terms owned-source case. No stored allowance or evidence-ID list creates a
verified reference.

Root's authority epoch must change whenever relevant authentication, project,
source/byte, terms, issuer, grant, licence or client authority changes. The builder
uses separate cloned callback contexts and records, then checks it, current principal, evidence expiry and SQLite generation after all
asynchronous verification. It then evaluates F4. Valid current denials return
`blocked`; incomplete rights throw `SourceSnapshotError` with F4's typed decision.
Dependency failures also prevent a snapshot. All assessment evidence must verify,
including refs outside the selected right; this deliberately fails closed. A dangling
head also blocks reads conservatively, even outside the requested resource.

This increment has no routes, CLI/UI, bootstrap wiring, blob store or network
acquisition. The existing licensed acquisition module remains external. The tests
use synthetic records and injected verification fixtures. Root still owns actual
held-grant/acquisition wiring, preparation/runtime compatibility, scoped preview
exposure and final-I/O authority rechecks. A returned snapshot is a rights opinion
at a checked instant, never permission to publish later without those gates.
