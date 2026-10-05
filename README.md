# Folio — your local resume workspace

One base resume. A thoughtful version for every opportunity.

Folio imports a PDF resume and uses Ollama or OpenAI to create separate, editable resumes and cover letters for each job description, or explicitly translate a saved document into Simplified Chinese or English. Original PDFs, extracted text, job descriptions, source snapshots, and generated documents are stored in SQLite on your computer.

## Start here

This workspace is installed and configured for the existing local Ollama model **gemma4:latest**. The development server is available at **http://127.0.0.1:5173** while its VS Code task is running.

First **create a local account** or **log in**. For the first account only, open the [local setup-code file](data/account-setup-code) on this computer and enter its contents into Folio's **Setup code** field. Never paste that code into chat, issues, logs, or screenshots. See **Local accounts** below before claiming an existing workspace.

1. Upload a **text-based PDF**, up to 10 MB.
2. Review the extracted text in **Base resume**. Correct formatting or reading-order issues if needed.
3. Open **AI settings** and choose your provider and model.
4. Select **New version**, enter the job title and company, and paste the job description.
5. The AI automatically matches the JD's language. An English JD creates one English resume; a non-English JD creates a matching-language resume **and an English version**. Review each draft, highlighted keywords, and unsupported requirements. Compare against the **Base snapshot** and **Job description** tabs.
6. Edit the resume, save changes, and mark it **Draft**, **Ready**, or **Applied**.
7. Select **Export PDF** to download the saved version.

Every generation creates one or two new versions. Editing a version never changes its base resume. Replacing or editing the active base affects future generations only. Existing versions retain the exact source text used to create them.

### Local accounts

- Choose **Email** or **Phone** as the sign-in method. Phone identifiers require international format with `+` and the country code. Passwords must be **12–128 characters**; spaces are preserved. Email/phone identifiers are **not verified**: Folio sends no email or SMS and has **no self-service password recovery**. An authorized local administrator can reset a password as described below. Accounts are local to this installation, not external identity-provider accounts.
- On a new or upgraded installation without accounts, startup creates a restricted-permission [local setup-code file](data/account-setup-code). If `DATA_DIR` is customized, open the same-named file in that directory instead. The code is never supplied by the web page or session API. Only someone with local filesystem access should create the first account.
- **The first email/phone account claims all existing unowned bases, PDFs, resumes, cover letters, and translations once.** The bootstrap username administrator does not claim or consume this setup. Back up the data directory before upgrading or claiming. Later accounts start with empty workspaces; they cannot list, edit, translate, delete, or download another account's documents. Creating a later account does not recover a lost password or reclaim previous documents.
- Passwords are stored as salted **scrypt hashes**, never plaintext. A random `folio_session` cookie is **HttpOnly**, **SameSite=Strict**, and valid for **7 days** (absolute expiry); only its SHA-256 hash is stored in the database. The cookie is deliberately not `Secure` on loopback HTTP. Reload preserves a valid session. Logging out revokes that session; expiry or revocation is enforced on protected requests and returns the UI to login, removing open documents and unsaved UI state.
- Use **Sign out** before another person uses this browser. Close document, settings, generation, and translation dialogs and finish active uploads/saves/downloads first; signing out is disabled while those are open or busy. Unsaved base edits require confirmation before discarding. A tab signed out elsewhere will return to login on its next protected request, not necessarily immediately while idle.
- Browser API keys and per-operation consent are memory-only and cleared on logout or reload. Non-secret provider/model preferences persist under an **account-scoped** browser-storage key; switching accounts loads that account's preferences, not the previous account's. The old unscoped preference key is not imported. Logging back in restores your own preferences, not API keys or consent.
- Accounts isolate application access, **not the operating-system owner**. Anyone able to read the database, backups, browser profile, or local environment can access local data; this is not application-level encryption. Ollama, configured model defaults, any server-side OpenAI key (and its billing), and the one-at-a-time generation/translation capacity are shared local-server resources. Per-request OpenAI consent remains required for every account.

### Administrator setup and user management

1. Run `npm run admin:init` locally from this project. It initializes the username **wxpwindy** only when no administrator exists. Type the initial password into the **hidden terminal prompt**. The password is not shipped in source, accepted through command-line arguments, or printed. Initialization is explicit, not repeated on server startup, and never resets an existing administrator.
2. In Folio select **Log in → Username**, then sign in as **wxpwindy** using the password entered locally. On the first login, **Change password** is mandatory before any workspace or admin API is accessible. The bootstrap accepts 10–128 characters so an existing requested initial password can be used; the replacement must be a different **12–128 character** password. The initial password stops working after replacement. All other sessions are revoked.
3. Open **Administration** in the workspace navigation. The responsive panel can search users, **enable/disable accounts**, **revoke all sessions**, **make/remove administrators**, and **reset another user's password**. Actions require confirmation and are enforced by the server, not merely hidden in the UI. You cannot disable, demote, reset, or revoke your own account here; use **Change password** for your own credentials. At least one enabled administrator must remain.
4. **Reset password** requires a new temporary password of 12–128 characters. Deliver it to the account owner through a secure channel outside Folio. Old credentials and sessions stop working, and the user must change the temporary password on login. Disabled accounts stay disabled after a reset. No email or SMS is sent. Administrator password resets are powerful: an administrator who knows a temporary password can potentially sign in as its owner. Grant this role only to someone trusted to administer these local accounts.
5. **Initialize setup code / Rotate setup code** writes a new restricted-permission local setup-code file and invalidates the previous code. The UI/API never returns its contents. This is available **only before the first email/phone account completes the protected legacy claim**; a bootstrap administrator does not consume that claim. Once claimed, setup cannot be reopened, and documents cannot be reassigned by rotating a code. With a custom `DATA_DIR`, use the file there.

Existing accounts migrate as ordinary users, not administrators. Admin listings contain account metadata only; document routes still enforce the signed-in owner's scope, including for administrators. Disabling, role changes and resets preserve documents and revoke sessions; no destructive account deletion is provided. Requests already authorized before revocation can finish, but subsequent protected requests are denied. Password-reset and password-change handlers recheck authorization after asynchronous hashing before committing.

Any signed-in account can open **Change password**, enter its current password and confirm a different 12–128 character password, then choose **Save new password**. The server verifies and hashes the replacement and rotates the current session; other sessions are revoked. **Cancel** returns to the workspace without changes. Mandatory temporary-password replacement cannot be skipped, but **Sign out** is still available. Password changes do not alter AI API keys or setup codes.

Under **Administration → Feature switches**, turning off **Web Chat** hides its menu entry for every account and blocks chat API requests. The menu refreshes after returning from administration, on reload, and when the tab becomes active again. If an open chat is found to be disabled, it closes and its temporary conversation/draft is cleared. Turning the switch back on restores the menu entry. Feature switches can only be changed by administrators; unavailable or still-loading feature status does not expose the feature menu.

Administrators remain subject to loopback, Host/Origin, mutation-header, stale-tab, and rate-limit protections. The initial password is stored only as a salted scrypt hash. No master password, automatic reset on restart, or public bootstrap endpoint exists. Keep administrator credentials safe; if all administrator access is lost, this app offers no unattended reset or verification-based recovery. Never publish this local app.

### Local CI/CD dashboard

Open **Administration → CI/CD pipeline** while signed in as a local administrator. The dashboard shows live step status, bounded/redacted logs, source fingerprints, the last 10 runs, and the active/previous web release. Ordinary accounts cannot view logs or run/deploy builds. Existing loopback, session, forced-password-change, stale-tab and mutation protections apply.

**Run pipeline** validates a snapshot of the current working source (including uncommitted edits), not an assumed Git commit. Fixed stages are: source snapshot → lint → backend tests → frontend typecheck → backend typecheck → production web build → Playwright browser tests → package release. No arbitrary shell command, branch, URL or directory can be submitted from the browser. A failing, timed-out, interrupted or cancelled step skips the remaining stages and cannot be deployed. Runs have a 10-minute timeout per command. Only one runner can operate at a time; a filesystem lock also prevents collisions with terminal-started runs.

The optional **Folio: local CI** VS Code task / **npm run ci:local** starts the same pipeline from a terminal, without deployment. Its status and logs also appear in the dashboard; cancel terminal-started runs with Ctrl+C. Web-started runs can be cancelled in the dashboard. The server cancels its active child process group when shutting down; interrupted run history is retained after restart.

**Deploy web release** explicitly publishes a successful, immutable frontend build to **http://127.0.0.1:3001**, using an atomic local release pointer. Browser tests run against that exact release's asset URLs before packaging. **Roll back web release** restores the previous tested web build. Existing release-qualified assets remain available for open tabs while retained. Reload the production UI after deployment. The Vite development UI on **:5173** always shows current workspace source, not the deployed release. **CD here intentionally covers the web UI only:** it does not restart/update the running backend, install dependencies, run database migrations, change accounts or touch resume data. Deploy backend changes separately with a planned restart; keep API changes backward-compatible with retained web releases.

Prerequisites: Node 24+, installed project dependencies, and Playwright Chromium or installed Google Chrome. On macOS the pipeline detects installed Chrome; alternatively set **PLAYWRIGHT_CHANNEL=chrome** before starting Folio. Install dependencies/browsers separately; the pipeline deliberately does not download them or call live AI providers. It builds in a private, Git-ignored local pipeline directory, copies only allowlisted source/config/test/public entries, excludes local environment files and data, and reuses installed packages while keeping writable tool caches isolated. Test fixtures use in-memory databases. **This is not an OS security sandbox: run only trusted source and dependencies.** A build/test script is trusted local code and can access the host OS; do not use this runner for untrusted pull requests.

Private state, bounded logs and releases are under **.folio-ci/** (Git-ignored; directories/files use private permissions). Working snapshots are removed when runs finish; up to 10 run records and their retained web artifacts are kept, with active/previous deployments protected from history pruning. No cloud CI account, container daemon or additional web service is needed. If all checks pass but you do not deploy, the live web release remains unchanged. Builds use shared local dependencies; re-run validation after dependency changes.

### Career path chart

After importing a base resume, **Overview** and **Base resume** show a **Career path** chart. The X-axis is year; the Y-axis has one row per unified job title **across all companies**. Equivalent software leadership wording is matched locally: **Software Development Manager**, **Manager of Software Development**, and **Software Engineering Manager** share the **Software Engineering Manager** row. **Software Engineer Director**, **Software Engineering Director**, and **Director of Software Engineering** share the **Software Engineering Director** row (including the “Engineerng” spelling variant). These periods stay flat on Y regardless of employer or word order. Senior/junior and assistant/associate/acting/interim/deputy qualifiers remain distinct; unrelated disciplines, manager/director levels and unrecognized titles are not broadly merged. Original titles remain in bar tooltips and source details; resume text is never rewritten.

**Java Developer** and **Software Engineer** also share the **Software Engineer** row across employers. Matching qualified variants such as **Senior Java Developer** and **Senior Software Engineer** share their own row; junior, senior, lead, staff and principal roles are not flattened into the unqualified row. Unrecognized or compound titles are kept separate.

Each employment period keeps its own bar, company name and original date label. Employer/date labels are staggered below the shared row for readability; this does not indicate different levels. Return stints and overlapping periods are retained, not merged into continuous employment. Matching also ignores capitalization, spacing and Unicode width. Missing employers say **Company not stated**. Rows are ordered vertically by explicit title level, highest first: **Director → Senior Manager → Manager → Engineer**. A later manager role therefore stays below an earlier senior-manager role; employment date and employer never override that ordering. Equally ranked rows use newest start date as a tie-breaker. The broader display order is executive, VP, director, manager/head, principal, staff, lead, senior, unqualified/unclassified, junior, intern; senior/junior qualifiers distinguish management rows. This is a title-based visual guide, not a universal cross-company authority or compensation hierarchy. Roles without explicit level words still say **Not stated**.

Extraction runs locally without an AI provider or network upload. It uses job titles and employment dates from the resume, keeping date labels as written. Titles do not need to match a job-keyword list: separated company/title headers, labelled titles, and adjacent title/date lines are supported. Month dates (such as **Feb 2020–Oct 2021**, **02/2020–10/2021**, or **2020年2月–2021年10月**) determine bar positions. Year-only spans cover the stated calendar years; **Present** ends at today's date. No exact employment day is invented.

For best results use an Experience section with entries such as **Example Studio | Product Owner | Feb 2020–Present**. Common English/French/Chinese experience headings are recognized; complex PDF layouts and ambiguous title/company order can still be missed or misread. Expand **Review detected roles and source text** to verify the evidence. Edit and **Save text** in Base resume to correct the chart; unsaved edits and tailored versions do not affect it. The chart displays up to 30 recent roles and scrolls horizontally on small screens.

Use **Regenerate career path** on either chart to fetch the latest saved active base resume and rebuild the timeline, including edits or PDF replacements made in another tab. Save or discard local base edits first; regeneration never overwrites an unsaved draft or modifies stored resumes/versions. The existing chart stays visible if the refresh fails, and the button can be used to retry. No AI provider or cloud consent is needed.

Dashed connecting lines join the end dot of each role to the start dot of the next role in chronological start-date order. Matching titles stay horizontal; changes of level connect between rows. These lines show sequence, not continuous employment or confirmed promotions. Date gaps stay visible, and overlaps retain their actual dates (so a connector can run backward in time). Only the displayed roles are connected; empty or single-role charts need no connector.

Profile-style exports with separate **employer → title → dates → location** lines are supported, including blank lines between header fields. The company comes from the employer header above the title, not the location below the dates; brand names do not need a suffix such as “Company” or “Ltd”. Parenthesized tenure such as **(2 years 10 months)** is not treated as a job title. An explicit company-total-tenure header can apply to multiple following role periods at that company until another employer or section begins. Employer header evidence is included in the source review. A **Projects** subsection inside employment does not permanently hide older roles; parsing resumes at the next clear employer/title/date-with-duration block. Standalone dated project rows and education remain excluded.

### Cover letters

Select **New cover letter** → enter the job title, company, and **Job description** → **Generate cover letter** → review the draft and tailoring notes → **Edit cover letter**, then **Save changes** → **Export PDF**. You can also select **Cover letter** from the generation form's **Document type** menu. Compare claims against **Base snapshot** and the JD before sending; AI output is not guaranteed factual.

Cover letters use the same base resume, provider, privacy controls, and automatic language matching as resumes: an English JD creates one English letter; a non-English JD creates a complete matching-language letter plus a complete English counterpart. Each is saved locally as a distinct **cover-letter** document with its own text and Draft/Ready/Applied status. Switching languages prompts before discarding unsaved changes; editing or deleting one document does not change its counterpart or a resume.

The shared **Resume versions** library shows **Cover letter** badges and supports **Filter by document type** alongside search and status filters. Older documents without type metadata are treated as resumes. Exports include the type and language, for example **Example Labs - Frontend Engineer - cover-letter - en.pdf**. Generated letters aim to be concise, but long user edits can span multiple PDF pages; a one-page export is not guaranteed.

Only a downloaded local Ollama model provides offline processing. OpenAI requires explicit consent for each generation; switching document type clears that consent, and it is never persisted. The base resume and JD are sent only after confirmation, just as for resume generation.

### Translate a saved document

In **Base resume**, or an open saved resume or cover letter, select **Translate to Chinese** or **Translate to English**. In **Translate document**, confirm **Target language** — **Chinese (Simplified)** or **English** — then select **Translate document**. This translates the complete **current saved text**, including saved manual edits; it is not JD tailoring, keyword matching, or a new assessment of fit for a role.

- **Save text** or **Save changes** first. Translation actions are disabled while edits are unsaved or another operation is busy, with an explanatory hint. Cancel returns to the saved source document; while translating, closing/cancelling is disabled.
- Each request saves **one separate editable Draft**. Originals, the base text, and the uploaded PDF are never overwritten. Repeating a translation, even into the same language, creates an independent document, not a linked bilingual generation pair. Saved resumes remain resumes and cover letters remain cover letters; existing role, company, JD, and original base snapshot are retained. Base-derived translations have no JD.
- Results display a **Translation** badge and **Translated, not tailored.** notes instead of tailoring keywords/gaps. **Translation source** shows the exact saved text translated. **Base snapshot** is the original base text retained with the document and may differ from that translation source. Both snapshots remain unchanged when the source is edited or deleted.
- Review meaning, names, dates, and facts against **Translation source**. Use the regular **Edit resume** / **Edit cover letter**, **Save changes**, status, and **Export PDF** controls. Editing or deleting a result affects only that result. PDF filenames retain type/language suffixes; a base translation exports as **alex-example - Base resume - zh-Hans.pdf** for a base named **alex-example.pdf**.
- Translation uses the same provider/model settings. Only a downloaded local Ollama model provides offline processing. OpenAI requires **I agree to send this document text to OpenAI for this translation.** for each request. Changing the target or key clears consent. A key is required unless a server key is configured; browser keys remain memory-only and are cleared on reload. The browser sends source identity and translation settings to the local server; the server sends only the selected saved document text as provider input, not a separate JD, base snapshot, or PDF binary.
- Translation PDFs use the same installed Unicode/CJK fonts, glyph-coverage checks, and actionable font errors described below. No fonts are downloaded automatically. Review the exported layout as well as the text. On an error, check settings/connection and use **Retry translation**; after a connection loss, reload the library first to check whether the request already saved a draft.

### Automatic language matching

- Detection uses the predominant natural language of the job description, **not the uploaded resume**, job title, or technical keywords. For mixed-language JDs, the model uses the language of most responsibilities/requirements; ties use the first substantive prose language.
- A non-English JD produces two complete drafts in one AI request: the JD-language document and its English counterpart, both of the selected document type. Translation should preserve the same facts, names, contact details, employers, and dates, including the JD's script (for example, Simplified vs Traditional Chinese).
- Cards display language labels. Open either draft and use **Language version** to switch between the pair. Both are searchable by language, independently editable, and exported separately with language codes in their filenames.
- Both drafts are validated and saved in one database transaction. Incomplete bilingual output saves **neither** draft. Editing, changing status, or deleting one does not change the other; unsaved edits require confirmation before switching. Both retain the same immutable source snapshot.
- Old saved versions remain usable without modification or automatic translation. Generate a new version to use automatic language matching.
- Language detection and translation are model-generated and can be wrong. Review both drafts before use. No language-detection service or additional cloud provider is called; your selected provider and existing OpenAI consent apply to both outputs.

## Requirements and commands

- **Node.js 24+** and npm. SQLite uses Node's built-in `node:sqlite`; its experimental warning on Node 24 is expected.
- A modern browser supporting native dialogs.
- Either a running local Ollama model, or an OpenAI API key with access to a Chat Completions model supporting JSON mode.

Run these npm scripts from the project root:

| Command | Purpose |
| --- | --- |
| `npm install` | Install dependencies on a new checkout |
| `npm run dev` | Start Vite at http://127.0.0.1:5173 and the API at http://127.0.0.1:3001 |
| `npm run build` | Type-check frontend/backend and build production assets |
| `npm start` | Serve the built app and API together at http://127.0.0.1:3001; build first |
| `npm run admin:init` | Initialize local administrator wxpwindy once, with a hidden initial-password prompt |
| `npm run lint` | Run Oxlint |
| `npm test` | Run backend/provider/PDF tests without real AI requests |
| `npm run test:e2e` | Build and run browser tests with isolated in-memory storage and fake AI |

Stop the development task with **Terminal → Terminate Task → Folio: development**, or press Ctrl+C in its terminal. Do not run the development API and production server at the same time; both use port 3001.

The project-scoped npm cache in [.npmrc](.npmrc) avoids the existing global npm cache permission issue. Its contents are ignored by Git and are not application data.

### VS Code tasks and debugging

- **Terminal → Run Task → Folio: development** runs both development servers.
- **Terminal → Run Task → Folio: build** checks and builds the app.
- To debug backend requests, stop the development task, select **Folio: debug local app** in Run and Debug, and press F5. It builds first, attaches the Node debugger, and opens http://127.0.0.1:3001. Set breakpoints in [server/app.ts](server/app.ts) or [server/ai.ts](server/ai.ts).
- The normal development mode supports hot reload. Browser DevTools can inspect React UI behavior. No additional VS Code extensions are required.

## AI configuration

### Web chat — LM Studio and optional internet search

Open **Web chat** in the sidebar (no resume upload required). This is separate from the resume/translation AI settings:

1. Open **LM Studio**, download a chat/instruct model suitable for your computer, and load it.
2. In LM Studio's **Developer** tab, start the local server on **port 1234**. Keep it loopback-only. Folio uses the OpenAI-compatible endpoints at `http://127.0.0.1:1234/v1`; browser CORS access is not needed because Folio proxies requests server-side.
3. Click **Refresh models**, select your chat model, and send a message. If LM Studio requires a token, set `LMSTUDIO_API_KEY` in your private environment file and restart Folio. No model is downloaded automatically and no cloud model fallback occurs.
4. For current information, type your message, enable **Search the internet for this answer**, choose a provider, and allow automatically generated search terms for that answer. There is no separate keyword field: LM Studio derives the necessary keywords or a focused search question from your prompt, using recent conversation context to resolve follow-ups. Folio searches that query, takes the **top three usable, unique results in provider order**, and asks LM Studio to combine their evidence into one answer with numbered citations. The generated query and source links appear below the answer.
5. Search is off by default. Consent resets when the message, model, or provider changes, when search is toggled, and on every attempt. Successful answers also turn search off. Invalid query-generation output stops the request before any internet search; failures preserve the draft for retry.

The **Search provider** selector offers **DuckDuckGo HTML search** and **Bing RSS** without a key, plus **Brave Search** when `BRAVE_SEARCH_API_KEY` is configured server-side. Bing uses the explicit regional endpoint `https://cn.bing.com/search?format=rss`, reachable on this workspace's network when DuckDuckGo/Brave time out; results may be region-specific. Choose **Bing** if the default is blocked. Changing providers clears consent. DuckDuckGo can rate-limit, change its markup, or require a browser challenge; errors are shown explicitly rather than silently substituting an offline answer. A Brave Search API key can provide more dependable searching where reachable (its service terms/billing apply). No automatic provider fallback occurs after a search failure.

Only the generated query (at most 400 characters) is sent to the search provider, not the conversation directly; your conversation stays with the local LM Studio server for query extraction and answering. The extraction prompt requests omission of sensitive information, but **generated terms can still reveal details from your messages**—omit sensitive information when enabling web search. Resumes/PDFs are never attached automatically. Up to three result titles, URLs, and snippets are passed back to the local model as untrusted evidence. Answers request a synthesis with citations [1]–[3]; **citations are not proof of correctness**, snippets are not full webpages, and no results means no web verification. Fewer than three usable results are disclosed, not invented or padded. Source pages are never automatically fetched. Clicking a source explicitly opens an external website, which receives normal browser network information.

Conversations and drafts live only in tab memory: **New chat**, leaving the chat page, reloading, or signing out clears them. Leaving with content asks for confirmation. Folio does not store or log chats; LM Studio and the search provider may have their own logging. The last five complete turns are sent as context, with a 4,000-character composer limit and a 2,048-token answer budget. Query extraction uses schema-constrained JSON and a 512-token budget; choose a chat model supporting LM Studio structured output. Responses are displayed as plain text (no active model-supplied HTML). **Stop** cancels the pending request and keeps the draft; cancellation cannot retract an already-sent search or guarantee that LM Studio immediately releases computation. Query extraction times out after 30 seconds, search after 20 seconds, and final answer generation after three minutes (separate sequential stages). At most two chats run concurrently, with 30 chat API requests/minute. Account/session and stale-tab protections apply to all chat endpoints.

### Ollama — local processing

Ollama is the default. In this workspace, [.env](.env) selects the already-installed **gemma4:latest** model, which passed a real smoke test using fictional resume content.

On another machine, install and start Ollama, download a suitable model (for example, `ollama pull llama3.2`), and set its exact installed name in **AI settings**. Without configuration, the app defaults to `llama3.2`.

The server connects to `http://127.0.0.1:11434`. `OLLAMA_URL` can change the local port/address, but only loopback addresses are accepted. Redirects are rejected. Use a recent Ollama release supporting structured JSON-schema output and a multilingual model for the languages you need. Use a truly local downloaded model, not an Ollama cloud-backed model, if you require offline processing. Model quality, context limits, memory, and speed depend on your machine.

### OpenAI — optional cloud processing

Select **OpenAI** in AI settings, choose a supported model (default `gpt-4o-mini`), and enter your API key. Keys entered in the browser are kept **in memory only** and cleared on reload or logout. Only non-secret provider/model preferences are saved in account-scoped browser storage.

Alternatively, set `OPENAI_API_KEY` in the local, Git-ignored environment file. Never commit or share this file. The UI reports whether a server key is configured but never receives that key. API billing is separate from a ChatGPT subscription.

Every OpenAI generation requires explicit confirmation before the base resume text and job description are sent to OpenAI. The original PDF binary is not sent. OpenAI's service policies apply to that request.

Explicit document translation instead requires separate per-translation consent and sends only the saved document text, not an additional base snapshot or job description. Target/key changes reset translation consent; consent is never persisted.

### Environment options

See [.env.example](.env.example) for portable defaults. Restart the server after changing environment variables.

| Variable | Default / use |
| --- | --- |
| `OLLAMA_MODEL` | `llama3.2`; current workspace override: `gemma4:latest` |
| `OLLAMA_URL` | `http://127.0.0.1:11434`; loopback only |
| `OPENAI_MODEL` | `gpt-4o-mini` |
| `OPENAI_API_KEY` | Optional server-side key |
| `LMSTUDIO_API_KEY` | Optional token for LM Studio's local server at port 1234 |
| `BRAVE_SEARCH_API_KEY` | Optional server-side Brave Search key; otherwise DuckDuckGo HTML search is used |
| `DATA_DIR` | `data` relative to the project root |
| `PDF_FONT_PATH` | Optional path to a Unicode TTF/OTF/TTC outline font covering all resume characters |
| `PDF_FONT_NAME` | Optional PostScript face name when using a font collection with `PDF_FONT_PATH` |

Saved UI model preferences take precedence over default model names from the environment. Use **AI settings** to change an existing preference.

## Storage, privacy, and backup

- Application data, local accounts, password hashes, and hashed sessions live in the local SQLite database, with WAL/SHM sidecars while running. No external database, identity provider, analytics, or browser font service is used.
- Both servers bind to loopback. API requests reject foreign Host/Origin headers and mutations require `X-Folio-Request: 1`. All document/configuration APIs require a valid account session and resolve documents through the authenticated user's scope. **Local accounts do not make Folio public-ready:** do not expose it through port forwarding, tunnels, public interfaces, or a reverse proxy. Public hosting would require a separate security review, HTTPS/cookie changes, verification/recovery, and operational protections.
- Files are **not encrypted by the application**. Use OS account protection and disk encryption for sensitive resumes. Newly created data files use restrictive permissions.
- Older imported bases and their original PDFs are retained to preserve provenance after replacement. Only the latest base is shown as active. The UI can delete individual resumes and cover letters; it does not purge historical bases.
- **Backup:** stop all app processes, then copy the entire data directory to a protected location. **Restore:** stop the app, preserve the existing directory, and replace it with your backup before restarting.
- **Reset:** after backing up anything you need, stop the app and remove its data directory. This removes **all accounts and all workspaces**, not just the current account. Restart to create a new first-account setup code and empty database. Version deletion or reset is not a guaranteed forensic secure erase; disk backups may still contain data.
- The data directory, environment files, npm cache, and test artifacts are excluded by [.gitignore](.gitignore).

## Limits and troubleshooting

- **Cannot sign in:** check the chosen method (Email, Phone, or Username for the bootstrap administrator), identifier, and exact password including spaces. There is no verification email/SMS or self-service recovery; contact a trusted local administrator for a reset. Authentication attempts share a local IP rate limit; if limited, wait before retrying. Administrator actions have a separate rate limit. Do not delete accounts or the database to fix a typo.
- **First setup code missing/invalid:** use the file in the active `DATA_DIR`, not another installation. A missing file is recreated on restart while no users exist. If startup reports an invalid file, preserve it outside that directory and restart; keep backups and never share the code. A later account cannot claim existing owned documents.
- **Scanned PDFs need OCR first.** This app extracts selectable text; it does not run OCR. Password-protected or damaged PDFs may fail. Limits: 10 MB, 30 pages, and 50,000 extracted characters. Job descriptions: 80–30,000 characters.
- **PDF layouts are not preserved.** Multi-column source PDFs may extract in an unexpected order. Review and correct the base text before tailoring. Export uses a clean, single-column layout rather than reproducing the uploaded template. Preview and export pagination may differ.
- **Non-Latin text:** export checks glyph coverage and tries installed Unicode/CJK system fonts as needed, including TTC collections. It refuses unsupported text with an actionable error rather than silently dropping characters. If needed, configure `PDF_FONT_PATH` (and optional `PDF_FONT_NAME`) and restart. One outline font must cover the full resume. Complex-script shaping, right-to-left PDF layout, and emoji have limitations; inspect exported PDFs visually. The browser preview/editor supports language metadata and common right-to-left languages.
- **Cannot reach Ollama / model not found:** start Ollama and verify the exact model name with `ollama list`. Choose an installed model in AI settings. The app never downloads a model automatically.
- **Slow generation or translation:** the request timeout is 3 minutes; generation and translation share a one-request-at-a-time limit. Keep the active dialog open. Try a smaller model or shorter input if needed. Very long inputs can exceed a model's effective context; prefer a concise base resume and focused JD.
- **AI output needs review.** Prompts prohibit invented facts and distinguish unsupported requirements, but there is no automated guarantee of factual accuracy or ATS performance. Never add an unearned qualification just to satisfy a JD. Tailoring notes describe the initial generated draft and do not refresh after manual edits.
- **Failed generation:** invalid output or provider errors do not save a version. A connection loss after generation completes can leave a successfully saved version; reload the library before retrying.
- **Port already in use:** stop the other instance using ports 3001/5173 before starting another task. The browser must connect through the app's local URLs.
- **Changes are explicit:** use **Save text** or **Save changes**. Export is disabled while a version has unsaved changes. Avoid editing the same workspace from multiple browser tabs; updates are last-write-wins.

## Test setup

Backend tests cover validation, PDF handling, source snapshots, provider errors, privacy boundaries, and disk persistence across restarts. Browser tests cover the full workflow and responsive layouts, including 320px width.

Web-chat tests use mocked LM Studio/search responses and the isolated fake browser provider. They cover search consent/query privacy, source sanitization, cancellation, provider failures, authenticated access, rate/concurrency limits, temporary history, failure/retry, and mobile layout. No automated test calls a live search engine or model.

[tests/auth.spec.ts](tests/auth.spec.ts) adds nine passing real-UI account cases: first email signup and legacy claim, seven-day cookie/reload persistence, mobile phone/email isolation, sign-out guards and account-scoped preferences, cross-tab logout and expiry on protected requests, stale-tab upload/download/logout after another account signs in, and safe validation/setup/login errors. Stale requests cannot change the new account's data or revoke its session. The isolated fixture seeds real hashed sessions for existing document tests without consuming login attempts; anonymous tests use the production signup/login endpoints. No production authentication bypass, real setup-code file, disk database, or provider is used.

Cover-letter browser coverage includes English and French/English fictional drafts, persisted document types, independent edits/statuses, actual PDF text extraction (including French punctuation), source snapshots, combined filters, deletion isolation, consent reset, and failure/retry. All generation uses an isolated fake provider, including the OpenAI consent flow; see [tests/README.md](tests/README.md).

[tests/translation.spec.ts](tests/translation.spec.ts) adds six isolated translation cases: base Chinese/English and repeated drafts, saved legacy edits and immutable provenance, separation from bilingual groups, cover-letter type preservation, explicit OpenAI consent/privacy, and 320px failure/retry and layout guards. Export checks extract actual Chinese/English PDF text using installed fonts, without downloading fonts. The injected fake translator and blocked outbound requests prevent live provider calls. All six cases passed as part of the full regression suite.

Install the test browser with `npx playwright install chromium`, then use `npm run test:e2e`. If Google Chrome is already installed, macOS/Linux can use `PLAYWRIGHT_CHANNEL=chrome npm run test:e2e` instead. The tests use port 3101 and never touch the real data directory or call real AI providers.

Latest validation (2026-10-03): production build passed; lint had zero warnings/errors; **417 backend tests and 45 browser tests passed**. This includes automatic query extraction, top-three evidence synthesis, consent/privacy, provider/planner failures, cancellation, safe ranked sources, account protections, temporary history, and responsive UI, alongside existing account/admin, document, translation, and PDF coverage. A separate public-topic manual check verified an LM Studio-generated query, Bing search, exactly three source snippets, and a cited answer that disclosed evidence gaps; no data was saved. See [tests/RESULTS.md](tests/RESULTS.md) for details and earlier intermittent account-test findings. System-font-dependent backend tests may skip on machines without those fonts; translation browser PDF checks require installed CJK coverage. OpenAI remains tested with mocked requests, not live paid requests.

## Implementation

React + TypeScript + Vite, Express, Node SQLite, PDFParse, PDFKit, Zod, and Lucide icons. See [src/App.tsx](src/App.tsx) for the workspace UI, [src/components.tsx](src/components.tsx) for editors/dialogs, [server/app.ts](server/app.ts) for API routes, [server/store.ts](server/store.ts) for persistence, and [server/ai.ts](server/ai.ts) for provider integration.

The account gate is in [src/Auth.tsx](src/Auth.tsx); [server/auth.ts](server/auth.ts) handles scrypt passwords and cookie sessions, and [server/account-setup.ts](server/account-setup.ts) prepares the first local setup code. Auth is mandatory; test-only reset/seed utilities exist solely in [tests/fixture-server.ts](tests/fixture-server.ts).