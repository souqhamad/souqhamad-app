# Image upload transfer and recovery - 2026-10-30

App release: 1.0.49. The existing Codemagic build-number formula is retained:
238 + PROJECT_BUILD_NUMBER. The counter spans platform workflows.

## Confirmed behavior corrected

- The two-slot batch previously held a slot through both transfer and remote
  processing. Direct transfers now release their slot after confirmed PUT or
  resumed processing; at most two transfers run while up to the listing limit
  of eight server jobs finish. The batch still waits for every started job and
  stops scheduling after a failure. Legacy transfers retain their original path.
- A settled/failed local upload no longer claims ownership of a server job it
  is not polling. After save/publication settles, recovery rediscovers remaining
  jobs, including on the new-editor route using the newly saved draft ID.
- Brief failed recovery reads have five bounded backoff retries and retain the
  explicit retry action. Closing the editor or switching identity cancels work.
- Approved photos update the editor/detail caches as they finish, rather than
  waiting for the slowest photo. Failed/pending selected assets remain retryable.
  Recovery and local saves/publication have exclusive snapshot ownership.
- Recovered jobs corresponding to selected local assets use one display/capacity
  slot. The full server job list still prevents premature publication.
- Publication advances the image revision and immediately caches its authoritative
  published response, preventing an earlier draft read from restoring draft state.

## Manual editor keyboard visibility

The fixed page header remains outside a measured keyboard-aware form viewport.
The focused input is rechecked after keyboard/layout/content-size changes, using
native ancestry and window coordinates to avoid moving the form for a portaled
selection modal. Android window resizing and manual overlap never stack. Focus
capture waits until the target updates native focus state; blur, manual dragging,
unmount and changed offsets invalidate stale measurements. Oversized multiline
inputs retain their first visible line. No new native dependency was added.

## Server counterpart

The server promotes at most two independent derivative HEAD/copy chains in
parallel, with the existing shared deadline, source ETag, immutable conditional
copy and destination verification. All started operations settle before failure
returns to the database transaction. Ownership, leases, cancellation, technical
validation and finalization ordering remain enforced. No original is regenerated.

No Worker, queue-concurrency, schema, model, authorization or publication-policy
changes are required. The app still uploads private JPEG intake bytes; Cloudflare
produces the retained display/thumbnail WebP files before server acceptance.

## Verification

- App suite: 335 passed, no failures or skipped tests.
- App TypeScript and ESLint: passed.
- Android Hermes, iOS Hermes and web bundling: passed for the repaired source.
  These exports are not signed AAB/IPA packages.
- Server focused image contracts: 49 passed, including the 16 object-promotion
  tests. Server TypeScript and scoped ESLint passed.

## Verification boundary

Behavioral tests gate transfer, processing, recovery and conditional-copy timing;
they demonstrate overlap and recovery without making live production uploads.
They do not measure real network speed, Cloudflare backlog or physical-device
background behavior. Current production bootstrap was read only and advertised
r2-direct-v1 enabled, eight photos, 12 MiB per photo.

A new signed app package and deployment of the server counterpart are needed to
activate the changes. Git push/build export alone does not establish store
publication or completion of AWS deployment. Physical-device upload verification
still needs the owner's installed release and normal account operation.
