# Application quality guide for DinkVision V2

A successful system carries a user's task through every layer: client input, authentication, API validation, business rules, database/storage, background work and visible feedback. A working screen alone does not establish a working recording system.

The measures below are suggested acceptance metrics. Targets need a defined device/network workload and are not measured production results.

## 1. Functionality

**Meaning in practice:** The system does the complete job users need and follows its rules. In DinkVision, recording must produce a usable replay with the correct recipients, access restrictions and retention period.

**Implementation example 1:** Trace and validate the full capture → local save → multipart upload → verified ready state → replay workflow. Persist the file/session/email job together so the UI cannot advertise a replay that does not exist.

**Implementation example 2:** Define acceptance scenarios for admin enrollment, player access, cancelled uploads, short recordings and guest-link expiry. Test each producer and consumer against the same request/response contract.

**Key metric:** **End-to-end task success rate** = completed valid tasks / attempted valid tasks × 100%. Suggested gate: every critical acceptance scenario passes before local testing is called complete.

## 2. Reliability

**Meaning in practice:** Work survives interruptions and recovers predictably. A network error or app restart should not lose the only copy of a match or create duplicate delivery.

**Implementation example 1:** Keep the local recording until the server verifies the final R2 object. Save durable upload-attempt state and resume using confirmed remote parts after Wi-Fi loss or app restart.

**Implementation example 2:** Use leases and idempotent completion for concurrent retries. Reconcile lost responses, retry safe storage operations with limits, and flag uncertain email sends for review rather than sending duplicates.

**Key metric:** **Recovery success rate** = interrupted recordings recovered without footage loss / recoverable interrupted recordings × 100%. Measure under forced network loss, process termination and expired leases; target 100% in the acceptance fault matrix.

## 3. Performance

**Meaning in practice:** The application responds quickly while controlling CPU, memory, network traffic and battery use. Large video transfers must not freeze recording controls or exhaust device memory.

**Implementation example 1:** Stream Java uploads with a fixed 64 KiB buffer and browser uploads in 8 MiB parts. Send video directly to R2; keep the application API responsible for authorization and progress confirmation.

**Implementation example 2:** Bound and paginate admin/job queries, index queue/tenant lookups, and measure API timings separately from camera processing and video transfer. Investigate measured slow queries before adding caches.

**Key metric:** **p95 control-API latency**: the time below which 95% of non-video API requests complete. Set a test target such as <1 second on the agreed local network, excluding upload/encoding time, and record the workload used.

## 4. Usability

**Meaning in practice:** Players and staff understand what is happening and can recover without guessing. Status should distinguish footage saved locally, transfer progress, cloud confirmation and email delivery.

**Implementation example 1:** Show loading, empty, waiting, uploading, cancelled, offline and error states with a specific next action. Explain that the saved recording is retained when a transfer fails; separate storage health from Gmail connection status.

**Implementation example 2:** Use readable contrast, labeled controls, keyboard focus, screen-reader names and adequate touch targets. Test the same critical tasks on a phone, tablet and desktop, including permission denial.

**Key metric:** **Unassisted task completion rate** = users completing a defined task without help / users attempting it × 100%. Test enrollment, start/stop and replay retrieval with representative users; choose a target such as ≥90% before wider rollout.

## 5. Security

**Meaning in practice:** Only authorized people/devices can access or change data. Credentials stay confidential, tenants stay isolated, and expired recordings stop being accessible.

**Implementation example 1:** Verify identity, tenant membership and device ownership on the server; enforce tenant RLS and composite foreign keys. Give privileged completion/cleanup functions only the execution grants they need. Test forged IDs, tenant cookies and cross-tenant requests.

**Implementation example 2:** Keep R2 private; issue short-lived, operation-specific URLs only after authorization. Keep Supabase/R2 secrets server-side, encrypt Gmail refresh tokens, redact signed URLs from errors and reject invalid OAuth state or replay signatures.

**Key metric:** **Unauthorized-access denial rate** = rejected unauthorized attempts / attempted unauthorized cases × 100%. Target 100% across the maintained authorization test matrix; this complements dependency/security reviews and is not proof of total security.

## 6. Scalability

**Meaning in practice:** The system can handle more courts, devices and recordings without excessive delay, unfair queues or uncontrolled resource growth.

**Implementation example 1:** Upload bytes directly to object storage, keeping large transfers out of the Next.js process. Use bounded multipart sizes and queue limits rather than buffering entire videos or accepting unlimited parallel work.

**Implementation example 2:** Partition access and work by tenant, rotate worker attention across tenants, and claim jobs with leases. Add worker capacity only after verifying that two workers cannot double-complete or double-send a job.

**Key metric:** **Maximum sustainable concurrent devices** while meeting agreed latency and error-rate limits. Load-test a stated recording size, upload bandwidth and tenant mix; do not infer capacity from a single-device demo.

## 7. Maintainability

**Meaning in practice:** Developers can change the system safely and understand failures without untangling unrelated code. Storage behavior, authorization and UI state should have clear ownership.

**Implementation example 1:** Separate storage SDK access, upload orchestration, client transport and replay signing. Keep a versioned upload protocol shared by browser/server and explicitly implemented by Java; preserve compatibility paths where historical data requires them.

**Implementation example 2:** Use additive, versioned migrations and focused regression tests. Document environment variables, recovery states, deployment order and acceptance gaps. Remove obsolete wording and assumptions from active R2 flows without rewriting unrelated camera drivers.

**Key metric:** **Change failure rate** = released changes that cause incidents or require rollback/hotfix / released changes × 100%. Establish a baseline and reduce it; a low rate with small changes and useful tests is stronger evidence than line coverage alone.

## 8. Portability

**Meaning in practice:** The application runs in its supported environments without hidden dependencies on one developer's machine, key path or device. Portability means tested compatibility, not a promise to run everywhere.

**Implementation example 1:** Use explicit environment configuration and reproducible builds. Keep the local Android variant separate, use the current workstation's debug signing key, and prevent local commands from inheriting credentials for another environment.

**Implementation example 2:** Maintain a support matrix for Java Android versions/ABIs, browser recording formats, USB/UVC hardware and desktop tooling. Use standard HTTPS/S3 interfaces behind a storage module while testing provider-specific multipart and signing behavior.

**Key metric:** **Supported-environment pass rate** = passing required environment/device combinations / required combinations × 100%. Target 100% for the declared support matrix; emulator results do not count as physical USB-camera validation.

## R2 and R2 storage fit different needs

R2 fits an application's private video-byte storage: the application controls object keys, multipart transfer, access URLs and retention through APIs. Drive fits human-managed documents, folders, collaboration and its own preview/sharing experience. R2 does not automatically replace Drive's viewer, sharing UI, video processing or Gmail.

For DinkVision, R2 gives more direct control over automated recording transfers, while Supabase retains identity/metadata and Gmail sends replay links. The tradeoff is that DinkVision must operate its own replay/access and cleanup workflow. Actual cost and performance depend on storage volume, requests, network conditions and the chosen playback design; verify them with a representative workload.

Cloudflare and Supabase MCP connections help the coding agent manage these services. The running application still needs separate runtime credentials and integration tests. See the [phased implementation and local testing guide](r2-local-implementation.md).
