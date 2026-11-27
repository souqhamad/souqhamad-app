# 1.0.46 - image upload and gallery reliability

Direct uploads use two bounded workers, ordered reservation and authoritative
server image records. Each image reports preparation/transfer/processing/ready;
partial successes survive another image failure. Existing idempotency and account
identity cancellation remain. Legacy uploads stay serial.

Gallery thumbnails are visible before full-size downloads. Late same-attempt
success is accepted after a stall, actual failures retry twice, and active-image
priority shares a bounded preview cache across details and modal. Old JPEG and new
processed WebP URLs are both accepted without changing route contracts.

Realtime updates target relevant query keys. Seller detail uses a separate
summary cache key. Server changes and Cloudflare Worker deployment are required
for all-WebP processing and removal of non-chat model waits; mobile changes alone
do not activate those server behaviors.

Version 1.0.46; local native floor198; Codemagic versionCode/buildNumber is
198 + PROJECT_BUILD_NUMBER. Signing/build/store submission are separate steps.
