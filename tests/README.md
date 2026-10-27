# Isolated browser tests

Run `npm run test:e2e` from the project root. Chromium is the only browser used;
install it with `npx playwright install chromium` when necessary. Build the app
with `npm run build` first. The fixture builds automatically if the static entry
point is missing, but does not rebuild an existing distribution.
An existing Google Chrome installation can be used without downloading another
Chromium copy by setting `PLAYWRIGHT_CHANNEL=chrome` for the test command.

## Isolation

- Playwright starts `tsx tests/fixture-server.ts` on `http://127.0.0.1:3101`.
- The actual Express routes, PDF parser/exporter, React UI, and SQLite store run.
- SQLite uses `:memory:` only. A fixture-only reset route clears versions, bases,
  sessions, users, and setup hashes before each test; one worker prevents tests
  from resetting each other's data. Production auth and owner-scoped stores run
  unchanged; there is no environment flag or production authentication bypass.
- Reload assertions retain the running fixture's memory database. Restarting the
  fixture loses all test data; no real workspace database is opened.
- AI generation is deterministic and injected into `createApp`. Server fetch is
  disabled, the cloud environment key is cleared, and browser requests to other
  origins are blocked and fail the test. Settings use a deliberately fake key.
- The fake generator branches on `documentType` and the exact fictional French
  JD in [tests/data.ts](tests/data.ts), not a language-detection heuristic. It
  returns complete English/French letter bodies in the shared `resumeText`
  envelope, plus the full English counterpart for French. Resume fixtures remain
  unchanged. The OpenAI consent test also uses this fake generator, never OpenAI.
- The fake translator is the third dependency in `createApp(store, generate,
  translate)`. It returns only `{ text }`, using deterministic fictional Chinese
  or English resume/letter bodies. Synthetic `E2E-SAVED-…` edit markers from the
  actual source argument are retained, exposing stale/base-text selection bugs.
  Translation also uses the existing fetch/browser network blocks, even when
  the selected provider is OpenAI. No real translator or cloud service is called.
- PDF uploads are synthetic PDFKit buffers, never personal files or disk fixtures.
- No application source or package scripts are changed by these tests.
- CI/CD browser tests inject an in-memory fake pipeline through `createApp`'s
  eighth argument. They never start builds or deploy real releases. The fixture-only
  pipeline completion endpoint requires the same local test headers as other utilities.
  Real runner tests use temporary fictional filesystems. During local CI, the fixture
  mounts the release-qualified asset prefix from `FOLIO_CI_RELEASE_ID`, so Playwright
  validates the exact frontend bytes subsequently packaged for deployment.

### Authentication fixture contract

- [tests/helpers.ts](tests/helpers.ts) extends Playwright with default
  `extraHTTPHeaders: { 'X-Folio-Request': '1' }` and overrides `request` with
  `context.request`. Unlike Playwright's standalone API request fixture, this
  client shares the browser's cookie jar: reset/login/signup/logout Set-Cookie
  responses affect both UI and subsequent API assertions. New tabs share it too.
- `POST /__test/reset` returns **204**, atomically clears only the in-memory
  fixture tables, and defaults to the fictional email account `alex@example.test`
  with ID `e2e-default-user` and an empty workspace. Its fictional password is
  hashed once at startup using the production `hashPassword` function. Reset
  inserts a SHA-256-hashed random 32-byte session token and sends its real
  HttpOnly/SameSite=Strict seven-day `folio_session` cookie. Production middleware
  must accept that session; ordinary document tests do not spend the shared
  signup/login rate-limit budget. No default PDF/base is inserted.
- `{ anonymous: true }` instead seeds only the hash of the fixed **fictional**
  setup code exported as `testSetupCode` in the helper and expires the cookie.
  `test.use({ anonymous: true })` also clears browser cookies, checks
  `{ user: null, setupRequired: true }`, and opens the first-signup screen.
  Default tests assert the exact seeded session identity before opening the UI.
- `{ anonymous: true, legacy: true }` additionally seeds a synthetic legacy PDF,
  base, and metadata-free version in the **unowned** root scope, before signup.
  Only real first-account signup can claim them. `legacy: true` without anonymous
  mode is rejected. No code is read from the user's setup file or `DATA_DIR`.
- `POST /__test/legacy` uses the caller's valid session to select
  `store.forUser(userId)`, creating a metadata-free version from that account's
  uploaded base (**201**, or **401** without a session / **409** without a base).
  It never selects another user's base or the unowned root scope.
- `POST /__test/expire-session` expires only the caller's session in the fixture
  database (**204**, or **401** without a current session). It leaves the browser
  cookie intact so an actual protected request exercises expiry handling.
- Every test utility requires `X-Folio-Request: 1`, retains the application's
  Host/Origin checks, and exists only on the loopback fixture. The protected
  workspace readiness URL now returns 401 before reset; Playwright accepts 401
  as a ready HTTP server. No public health/auth bypass is added.
- Privacy assertions use the exact `folio-ai-settings:e2e-default-user` key for
  the default account and reject an unscoped key. Session cookies are expected,
  but API keys/passwords/consent must never be persisted in cookies or storage.

## Coverage

1. Desktop empty state, counts, no overflow, and full-page screenshot.
2. Original PDF download equality; extraction preview and text correction;
   minimum JD length; generation; notes, keywords, gaps, and immutable source;
   resume editing; ready/applied statuses and counters; PDF download signature;
   role/company search and every status filter; reload persistence; cancel and
   confirm deletion.
3. Wrong extension, oversized, fake, damaged, and insufficient-text PDFs;
   actionable UI errors and recovery through a valid upload.
4. AI provider/model preferences persist; the fake key survives reopening the
   dialog but is absent from storage, cookies, workspace JSON, and refreshed UI.
5. Mobile navigation at 360px and 390px; uploaded base, generated version tabs,
   settings dialog, document/dialog overflow checks, and mobile screenshots.
6. Separate 320px viewport overflow regression, so failures at that width do not
  prevent the rest of the mobile workflow from being exercised.
7. BYOK custom base URL/model selection, URL syntax validation, separate memory-only
   keys, destination-change/reload/logout clearing, per-operation consent, and
   request wiring for resumes, cover letters, cleanup, and translations. These
   cases use the same injected fake providers, never a real BYOK endpoint.

### Cover-letter cases

- **English lifecycle at 320px:** assert `documentType: 'cover-letter'` in the
  POST and saved record; paragraph preview (no CV headings); notes, JD and base
  snapshot; edit/save/status; export filename and actual parsed PDF text; reload
  persistence and snapshot immutability after a base edit. A resume with the same
  role/company remains separate through combined type/search/status filters and
  letter-only deletion. Check document, nested form/editor/card/filter containers,
  and control bounds for horizontal overflow.
- **French/English pair:** complete distinct letter drafts with shared generation
  and snapshot metadata; language labels; independent edits/statuses; cancel and
  accept the unsaved-language-switch guard; reload and switch from a filtered
  card. Parse both exported PDFs and compare the saved body including French
  accents, curly apostrophes, and em dashes, not merely the PDF signature.
- **Explicit OpenAI consent:** unchecked consent blocks POSTs; switching in
  either direction clears it; an explicitly approved letter succeeds through the
  fake provider. New forms/reload remain unchecked, and browser storage, cookies,
  and workspace JSON contain neither consent nor the fake API key.
- **Failure/retry:** a one-shot browser route returns an actionable HTTP 502
  generation error. The form retains the JD/type, the database is unchanged, and
  retry reaches the real fixture routes and saves exactly one letter. This tests
  UI recovery, not real model validation or backend atomicity; backend tests cover
  those separately.

These cases extend the existing resume tests; auth adaptation changes only their
shared setup and exact account-scoped preference assertions, not privacy guards.
PDF extraction verifies text integrity, not visual pagination or a one-page limit.

### Explicit translation cases

[tests/translation.spec.ts](tests/translation.spec.ts) adds six tests alongside
the 15 resume/cover-letter cases. Shared setup uses an automatic auth-aware fixture
so each importing spec gets its own reset and initial navigation:

1. **Base lifecycle:** save edited base text; disabled dirty actions/hint; Chinese,
  English, and repeated Chinese requests create independent draft IDs/generation
  IDs without overwriting the base or original PDF. Assert empty base-derived JD,
  language/type/provenance, Translation badge/notes (no keywords/gaps), real
  Chinese and English PDF text extraction and filenames, edit/save/status/reload,
  and result-only deletion with the other copies unchanged.
2. **Edited legacy source:** translate the current saved manual edit, not the
  original or later-edited base. Cancel restores the selected saved detail with
  only one open native dialog. Distinguish original **Base snapshot** from exact
  **Translation source**, preserve legacy resume semantics, then delete the
  source and reload to verify the result and both snapshots survive.
3. **Bilingual separation:** cancel from the selected English counterpart, then
  translate the French resume to English. Original language/type metadata and
  pair remain unchanged; the translation has its own generation ID and no
  language-pair switcher, including after reload.
4. **Cover letter:** saved letter edits reach the translator; preserve document
  type, role/company/JD/base snapshot, add target-language/provenance metadata,
  and retain independent generation identity. Edit/save/status/reload the result,
  filter by type, and extract the saved Chinese PDF body with type/language suffix.
5. **OpenAI privacy:** no configured server key; missing key/unchecked consent
  disables submission. Target changes in either direction and key changes reset
  consent. Exact POST fields contain only source type/ID, target, provider/model,
  key and consent — no client JD, base, or source text. New forms/reload reset
  consent and keys; storage/cookies/workspace JSON retain neither. The local
  server resolves saved source text; backend adapter tests separately check that
  only that document text, not a JD or base snapshot, goes to the provider.
6. **320px failure/retry:** a single one-shot `page.route` holds then returns HTTP
  502. Verify busy submit/target/close/cancel guards, Escape suppression, an
  actionable error, unchanged workspace, and successful retry through the real
  fixture routes. Check actions, confirmation, all four detail tabs (including
  the labeled source `pre`), editor, badges/cards and nested containers for
  horizontal overflow. Use role-based textbox locators after controlled edits.

The PDF checks use installed Unicode/CJK fonts (available on the current Mac),
never downloaded fonts. They require every saved character, ignoring only
whitespace introduced by PDF layout/extraction. They intentionally do not skip
Chinese checks: another host needs a suitable installed font or `PDF_FONT_PATH`
(plus `PDF_FONT_NAME` for a collection). Missing glyph coverage must produce the
same actionable export error as normal documents, not silently corrupt output.

These cases cover explicit translation, **not JD tailoring or translation
quality**. The fake translator is not a language model. The one-shot browser 502
tests recovery, not backend provider validation/atomicity, which have separate
backend tests. The current full suite passes all 31 browser tests and 275 backend
tests, including account coverage below. Rebuild production assets so the fixture
serves the current translation UI.

### Local account cases

[tests/auth.spec.ts](tests/auth.spec.ts) adds **nine** passing cases (31 browser
cases total including administration):

1. **First email signup:** an anonymous page cannot access unowned documents or
  retrieve the setup code. Real UI signup claims the legacy base/version and
  original PDF; verify normalized identity, cookie flags/lifetime, HttpOnly
  invisibility, reload persistence, and unchanged legacy data. A subsequent
  account is empty and cannot download the first user's PDF; the first user can
  log back in and recover the unchanged workspace.
2. **320px phone/email isolation:** create a phone account through the UI; verify
  international phone inputs and auth/workspace layouts, empty initial state,
  private base upload, and email/phone login roundtrips. Cross-owner PDF reads,
  edits, deletes, and translations return 404 through the real scoped APIs.
3. **Logout/privacy:** settings and generation dialogs disable sign-out; dirty
  base edits can cancel or confirm discard. Logout removes the authenticated UI
  and cookie. Another account sees defaults and no previous documents or key;
  both exact account-scoped preference records remain separate. Logging back in
  restores only that account's non-secret preferences and saved documents, not
  unsaved edits, API keys, or generation consent.
4. **Other-tab logout:** a real UI logout revokes the shared session. An open
  edited document's next save returns 401, immediately unmounts the document,
  and displays the login gate. Logging back in proves no unsaved edit persisted.
5. **Server expiry:** expire the fixture session without clearing its cookie;
  real original-PDF access returns 401, gates the UI, and starts no download.
  Login issues a different token and restores access to the unchanged workspace.
6. **320px validation/privacy:** mismatch and malformed phone validation block
  network submission; password length limits are checked. A wrong setup code
  gets a real 403 without creating an account. Successful signup followed by a
  wrong-password login gets the safe 401 error, not a session-expired message.
  Password fields clear on server errors; no secrets appear in storage/page
  text. Missing mutation protection still gets 403. Correct login can recover.
7. **Stale-tab upload:** after account B signs in using the shared browser cookie,
  account A's old tab confirms base replacement and sends its tab-local expected
  identity. The real upload returns 401; B's documents and session stay unchanged.
8. **Stale-tab download:** A's old tab cannot download B's PDF or its own previous
  PDF using B's session. The request returns 401 and starts no download.
9. **Stale-tab logout:** A's old tab cannot revoke B's new shared session. A returns
  to the login gate while B remains authenticated, including after reload.

All identifiers, passwords, keys, PDFs, and setup codes are fictional. The auth
and admin rate limiters remain active with production limits. The browser fixture
injects separate in-memory stores and resets their counters between isolated cases,
along with chat counters and feature flags; no reset route exists in production.
Backend tests cover further validation, concurrency, and hash
details; these browser cases intentionally exercise the real UI and session API.

## Administrator tests

[tests/admin.spec.ts](tests/admin.spec.ts) adds a 320px real-UI lifecycle covering
username bootstrap login, forced password change, setup rotation, user access,
role/session controls, password reset and forced user replacement, account metadata
privacy, and ordinary-user denial. The fixture-only admin bootstrap invokes the
production one-time initializer with a fictional password; it never reads or uses
the requested real password. Setup rotation changes only an in-memory hash of a
known fictional value. The production route instead writes a restricted local file.
Neither fixture utility exists in the production app.

Additional browser regressions cover optional password changes, cancellation,
confirmation/reuse validation, error focus, cleared password fields after failures,
duplicate-submit prevention, login with the replacement password, and retrying a
failed sign-out. Feature switches are keyboard-accessible switches; refreshing
features must preserve the saved state rather than toggle it.

[server/admin.test.ts](server/admin.test.ts) adds ten backend tests covering these
permissions, scrypt/session behavior, setup-file rotation and 0600 permissions,
preserved first ordinary-user claiming, owner-scoped document access, migration
and restart persistence. A deterministic request-listener test changes the actor's
role/disabled status after scrypt begins and before it completes: the target
password must remain unchanged. All databases/files are memory or temporary data.

Admin actions have a separate 60-per-15-minute budget; signup/login/password change
retain the shared 30-attempt budget. Backend tests use default limiter stores and
verify enforcement; browser resets affect only their injected fixture stores.

## Artifacts and diagnostics

Screenshots are written beneath the corresponding test's `test-results/`
directory: `desktop-empty-dashboard.png`, `mobile-empty-dashboard.png`, and
`mobile-version-detail.png`. Playwright also retains failure screenshots/traces.
Every test attaches JSON browser diagnostics, including additional tabs. Uncaught exceptions, unexpected
console errors, failed requests, and external requests fail tests. The invalid-PDF
test permits Chromium's expected HTTP 400 console messages only for the exact
local PDF upload endpoint. The cover-letter and translation failure tests permit
HTTP 502 only for their exact local generation or translation endpoint.
Account cases allow HTTP 403 only at the failed signup endpoint, and HTTP 401
only at explicitly tested login/save/PDF/upload/logout endpoints; each asserts the actual
status and UI outcome. There is no blanket auth-error or aborted-request exemption.
String entries in
`expectedHttpErrors` still mean HTTP 400; other statuses require an explicit
`{ url, status }` pair. These tests assert response statuses and UI errors;
uncaught exceptions and network failures are never exempted by this allowance.
Chromium's `ERR_ABORTED` for an unused DELETE response body is recorded separately
only if the exact local version endpoint has already returned HTTP 204; deletion
status, UI removal, and reload persistence are still required to pass.
Session invalidation can also cancel an unread response body. Auth-related
`net::ERR_ABORTED` is recorded separately only after a confirmed POST logout 204,
or a 401 whose exact URL/status is explicitly expected by that test. Unknown
response statuses, unrelated cancellations, and other network failures still
fail the suite; these exemptions do not replace the auth/UI/isolation assertions.
Successful admin actions also return 204. Their `net::ERR_ABORTED` empty-body
cancellations are recorded only for POSTs to the exact local admin UUID action
route after an observed 204; no other method, route, status, or failure is exempt.
The machine-readable `test-results/results.json` report retains per-test outcomes
and diagnostics attachments (JSON bodies are base64 encoded in that report).