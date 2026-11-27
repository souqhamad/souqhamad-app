# Gallery and listing image path fixes - 2026-10-29

Scope: native app repository `SmartStoreAI/AI`, based on `1efca4f` (1.0.47).
The server repository remains at `5856a67`; no server configuration, database,
Cloudflare resource or deployed application was changed by this repair.

## Behavior

- The viewer and detail screen prefer the server's display URL. New records
  alias `originalUrl` to `displayUrl`; these now share one decoded view instead
  of creating a second request/view for the same resource. Original-only legacy
  records remain viewable, without deriving new URLs from naming conventions.
- Known display derivatives are warmed even when original and display are equal.
- Native preview downloads use `expo/fetch` with AbortSignal, an actual started
  request deadline, a streamed 12 MiB byte limit and at most three transfer slots.
  Queue waiting no longer consumes another image's request deadline. Timed-out
  transfers release their slot and automatic retries remain bounded to two.
- The download is decoded from a temporary local file at at most 900x900. Expo's
  disk cache is checked first and populated under the unchanged CDN URL after
  successful decoding. Temporary files are removed after cache copy, failure or
  completed cancellation. Local decoding itself is not cancellable; obsolete
  late results are released. No original image on the phone is deleted.
- Preview components retain recovery subscriptions through a failure. A selected
  failed image can restart even when its detail-screen subscriber still exists.
  Native readiness is reported after onDisplay rather than merely after decode.
  Events from prior attempts, replaced resources and closed views are ignored.
- Distinct full-source layers stay mounted after first activation; loaded
  previews are preserved during a different layer's retry. A stalled shared
  display offers retry while a successful thumbnail remains visible.
- Pager selection has one authority (native viewability), with native RTL
  direction matching the list's coordinate model. Selection is reconciled by
  image ID when refreshed images move or disappear. No raw momentum offset can
  overwrite selection. Native deceleration is tuned and iOS directional lock is
  enabled; actual gesture feel still requires a device.
- Cards attempt distinct server-provided URLs in thumbnail/display/original
  order on actual load errors. A valid display stops fallback. There is no
  endless cycle and stale errors cannot skip the next image.

## Upload and storage contracts inspected

Manual direct upload: device JPEG1800 -> authenticated upload reservation ->
private R2 intake -> Queue/Worker -> Cloudflare Images display900 + thumbnail360
WebP -> server byte/metadata checks and R2 copy -> ListingImage/ready -> public
CDN URLs. The server still owns authorization, limits and final acceptance.

Hamad chat and legacy multipart remain separate server-processing routes. The
app repair does not change those workflows, move models, or alter upload APIs.
The required originalUrl field stays compatible with the display alias. Existing
original-only objects are not rewritten or removed.

The public feed intentionally returns a primary image for each card; the public
listing detail endpoint returns the full approved image array. Neither viewer
windowSize3 nor decode concurrency3 limits the gallery to three images.

## Verification on this repair

- Mobile: `pnpm.cmd test`: 302 passed, 0 failed, 0 skipped.
- Mobile: `pnpm.cmd check`: TypeScript and ESLint passed.
- `expo export --platform all --output-dir .data/gallery-fix-export`: web,
  Android Hermes and iOS Hermes exports passed. This is not a signed AAB/IPA.
- Isolated browser gallery: 5 passed, 0 failed. All API/image traffic was
  intercepted; eight photos opened directly and scrolled forward/backward,
  thumbnail remained through delayed/failed display, retry recovered without
  restart and legacy double-tap zoom worked. Report/screenshots are under
  `.data/gallery-delivery/`. The test uses generated colored fixtures, not
  production photos. Browser physics do not establish Android/iPhone behavior.
- Server focused image contracts: 39 passed, 0 failed, 0 skipped, with simulated
  storage/model effects. The Windows sandbox initially prevented tsx startup
  (`uv_os_get_passwd`); the same checks passed outside that sandbox.
- Cloudflare Worker local suite: 34 passed, 0 failed.
- The prior read-only public sample had seven image records, not one: the feed
  intentionally exposed one primary while detail returned seven. All fourteen
  display/thumbnail objects returned HTTP200 and fully decoded as WebP. This
  sample does not establish availability of every production listing.
- `git diff --check` passed. Existing native gesture/transformation code remains
  in place. No connected phone or emulator was available for physical testing.

## Delivery boundary

Release 1.0.48 includes these app changes. The native build base is 238,
above confirmed Google Play code 237; Codemagic adds PROJECT_BUILD_NUMBER,
so its first possible code is 239. The actual number is printed by its preflight.
Pushing main triggers configured Codemagic workflows when the repository webhook
is enabled. A completed, signed AAB/IPA is still required to update an installed
release; a Git push does not establish successful signing or store publication.

A further layout check passed 24 image/screen dimension combinations and three
resize-then-page transitions in the isolated web export. Contain fit preserved
aspect ratios, and the 412x915 screen had a measured 412x779 image viewport.
These checks do not establish native-device rendering or gesture feel.

End-to-end authenticated production upload with a real phone, current Queue
backlog and native Android/iPhone gesture behavior remain to be verified on the
intended devices; passing mocked suites is not that verification. No server,
Cloudflare or production data changes are part of this app release.
