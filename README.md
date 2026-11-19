# AMERB AI

Amenfiman Community Bank's internal, locally-hosted Claude-style chat app, powered by models running on your own machine via [Ollama](https://ollama.com). Accounts, sessions, conversations, and uploaded documents are all stored locally in SQLite — nothing leaves the machine it runs on.

## Requirements

- Node.js 22.5+ (uses the built-in `node:sqlite` module — no native build tools needed)
- [Ollama](https://ollama.com) installed and running, with at least one model pulled

## Setup

```bash
cd amerb-ai
npm install
cp .env.example .env
```

Edit `.env` if you want to change the port or session secret (recommended before exposing this beyond localhost).

Pull a model if you haven't already:

```bash
ollama pull llama3.1
```

Make sure Ollama is running (it usually runs automatically in the background; otherwise start it with `ollama serve`).

### Optional: image generation

To let AMERB AI actually generate images (not just read them), set up the local Stable Diffusion service once:

```bash
cd imagegen
setup.bat
```

This creates a Python virtual environment and installs `torch` (CPU build), `diffusers`, `transformers`, and `flask`. It does **not** download the model itself — that happens automatically the first time the service handles a request.

## Run

- **Windows:** double-click **`start.bat`** in this folder (the top-level one, not `imagegen\start.bat`).
- **Linux / macOS:** run **`./start.sh`** in this folder.

Both run the same launcher (`scripts/launch.js`), which checks this machine before starting: it creates `.env` with a random session secret if needed, installs dependencies if they're missing or were installed on a different OS, starts Ollama if it's installed but not running, downloads the default model if it isn't there yet, and starts the image generation service if it was set up on this machine. It then prints every address the app can be opened at and opens **https://localhost:3000**. Press Ctrl+C in that window to stop everything. (Add `--no-browser` to skip opening the browser, e.g. on a server.)

> `imagegen\start.bat` / `imagegen/start.sh` on their own only start the image generation microservice (port 7861) — not AMERB AI itself. Always start from the launcher at the project root.

### Keeping it running (start at boot, restart after a crash)

`start.bat` stops when its window is closed or the PC restarts. To run AMERB AI as a service instead:

- **Windows:** right-click **`install-service.bat`** → *Run as administrator*. It installs a Windows
  service called **AMERB AI** that starts at boot and is restarted automatically if it crashes; remove it
  later with `uninstall-service.bat`. Check on it with `npm run service:status`.
- **Linux:** `sudo deploy/install-systemd.sh` installs and starts a systemd unit.

Full details, including which Windows account to run it as when Ollama is a per-user install, are in
**[docs/WINDOWS-SERVICE.md](docs/WINDOWS-SERVICE.md)**.

### Docker

`docker compose up -d` runs the app, Ollama and (optionally) the image service in containers, pulling
the models on first start — convenient for moving the whole stack to another machine. See
**[docs/DOCKER.md](docs/DOCKER.md)**.

### Network access (Windows and Linux)

The server listens on **every** network interface (`HOST=0.0.0.0` in `.env`), so it is reachable from other PCs on the bank's network at `https://<this machine's IP>:3000`. It runs on Windows and Linux from the same folder and the same command.

**Find the address to give staff.** On startup the launcher prints every address, the same way this does at any time:

```bash
node scripts/networking.js          # or: npm run network:info
```

It lists each LAN address, says whether the HTTPS certificate covers it, and prints the firewall command for the platform.

**Firewall.** Desktop firewalls block incoming connections by default, so a fresh machine can look "down" to everyone else:

- **Windows** — installing or repairing the service now adds the rule itself (TCP 3000, named "AMERB AI (TCP 3000)"). By hand, in an Administrator PowerShell: `netsh advfirewall firewall add rule name="AMERB AI (TCP 3000)" dir=in action=allow protocol=TCP localport=3000`.
- **Linux** — `sudo sh deploy/install-systemd.sh` opens the port in ufw or firewalld when one is active (`--no-firewall` skips it when IT manages the firewall centrally). By hand: `sudo ufw allow 3000/tcp` or `sudo firewall-cmd --add-port=3000/tcp --permanent && sudo firewall-cmd --reload`.

**Certificate.** The app generates its own HTTPS certificate on first start, covering `localhost`, the machine's hostname and the addresses it had at that moment. If the machine's address changes (DHCP, a new adapter), browsers will warn on the new address. Fix it by re-issuing the certificate for the current addresses:

- **Windows service:** `repair-service.bat --refresh-certificate` (Administrator) — backs up the old one and generates a new one on restart.
- **Any platform:** stop the app, delete the `certs` folder, start it again.

Staff PCs must then trust the new `certs\server.cert` (copy it to each PC → Install Certificate → Local Machine → Trusted Root Certification Authorities). To cover a fixed IP or a DNS name such as `amerb.bank.local`, list it in `PUBLIC_HOSTNAMES` in `.env` before re-issuing.

**Keeping it running.** On Windows install it as a service (`install-service.bat`, or `repair-service.bat` to finish a half-installed one) and on Linux as a systemd unit (`sudo sh deploy/install-systemd.sh`); both start at boot and restart after a crash, which is what makes the address above stay live without anyone logged in. See [docs/WINDOWS-SERVICE.md](docs/WINDOWS-SERVICE.md).

### Moving it to another computer

Copy the whole folder (you can leave out `node_modules`, `imagegen/venv` and `certs` — they're rebuilt for the new machine). On the new machine you need **Node.js 22.5+** and **[Ollama](https://ollama.com/download)**; then run `start.bat` or `./start.sh`. Your users, chats and documents travel with `data/amerb-ai.sqlite`. The launcher reinstalls dependencies built for the other OS, and the server creates a new HTTPS certificate when it notices the hostname has changed (staff PCs that trusted the old one need to trust the new `certs/server.cert`). For image generation, run `imagegen\setup.bat` or `imagegen/setup.sh` once on the new machine.

Sign up with a `@amenfimanbank.com` work email (registration is restricted to that domain), pick your department, choose a model in the sidebar, and start chatting.

### HTTPS and the security warning

AMERB AI runs over HTTPS only (no plain HTTP), so session cookies and everything else are encrypted in transit. On first run it generates its own self-signed certificate (`certs/server.cert` / `certs/server.key` — never commit these; already gitignored) covering `localhost`, `127.0.0.1`, this machine's hostname, and every LAN IP address it currently has, so it works whether you open it locally or a colleague opens it over the bank's network at `https://<this-machine's-IP>:3000`.

Because it's self-signed (not issued by a CA browsers already trust), **every browser will show a "your connection isn't private" warning the first time** — this is expected, not a bug. Two ways to handle it:

- **Click through it** — "Advanced" → "Proceed to [site] (unsafe)". Works immediately, no setup, but shows the warning again on a different browser/PC.
- **Trust the certificate** (recommended if several staff will use this) — copy `certs/server.cert` to each PC and import it into **Trusted Root Certification Authorities** (Windows: double-click the file → Install Certificate → Local Machine → place in that store). After that, the warning won't appear again on that PC.

The certificate is generated once and reused — it won't regenerate (and force everyone to re-trust it) just because the machine's IP changed after a reboot. Delete the `certs/` folder if you ever need a fresh one (e.g. after changing the machine's hostname).

### Starting it manually instead

If you'd rather run things by hand (e.g. to see logs in your own terminal), the root `start.bat` is just this, in two separate terminals:

```bash
# terminal 1 — optional, only needed for image generation
cd imagegen
start.bat

# terminal 2 — the actual app
npm start
```

The first request to the image generation service downloads `stabilityai/sd-turbo` (~5GB) from Hugging Face — this needs internet access once; after that it's cached locally and works offline. If you don't run it, everything else in AMERB AI still works — you'll just get a clear error if you ask it to generate an image.

### Running the test suite

```bash
npm test
```

Each test file spins up a real instance of the app as its own process against a disposable temporary SQLite database — never `data/amerb-ai.sqlite` — so it's always safe to run, including against a machine with real staff data on it. Covers login lockout, department-scoped document access, message-version switching, conversation-retention cleanup (including the exact boundary condition behind a real incident where a manual test once deleted more than intended), the waiting line and rate limits, model fallback, the quality report, and the reply-language rules (against a stand-in Ollama, so no real model is needed and no real chat is produced).

Runs take about a minute and a half: files run one at a time (`--test-concurrency=1`), because running several app instances at once made the suite flaky on modest Windows machines — the first connection to a freshly started server is occasionally dropped by the local firewall/antivirus, which is why the test client retries connection-level failures. `npm run test:fast` runs two files at a time on a machine with headroom.

## Features

- **Accounts & sessions** — signup/login restricted to `@amenfimanbank.com` addresses, bcrypt-hashed passwords, httpOnly session cookies.
- **Three folders, not one pile** — each knowledge base has its own folder, both in the app and on disk beside the database:
  - `data\knowledge\Bank-wide\` — **bank policies**, visible to every staff member; only an administrator can add or remove them;
  - `data\knowledge\Department - <name>\` — shared with that department only;
  - `data\knowledge\Personal - <username>\` — one person's own chat attachments and AI-made files.

  The database stays authoritative and enforces the access rules; the folders are a kept-in-step copy so IT can open them in Explorer, copy them to a backup drive, or hand a department its own folder. Files move between folders when a document is shared or published, are removed when it is deleted, and a reconcile pass (at startup and every five minutes) restores anything deleted by hand and removes files that aren't in the app. A `README.txt` in `data\knowledge` says the same to whoever opens it.
- **When the policies don't answer, ask the approved websites** — if none of the knowledge bases has anything relevant and the question is a policy question (not "hello"), AMERB AI searches **only the domains an administrator approved** (never the open web) and answers from those results, with a note under the reply naming the sites searched and links to the pages. If the search fails, it says so and is told not to invent a policy. On by default; Admin → Tools turns it off, and it does nothing until at least one domain is approved.
- **Three separate knowledge bases** — every access rule lives in `server/documentAccess.js`:
  - **Bank-wide** — policies and documents for all staff. Every staff member can read and search them; only admins can add or remove them.
  - **Department** (Credit, Loans, Finance, HR, IT, …) — anyone in a department can upload files for the whole department, and only staff signed in under that department can see or search them. A Credit officer's uploads are invisible to HR and vice versa. The uploader or an admin can delete them.
  - **My files** — files attached in a chat, documents AMERB AI generates, and web pages it fetches. Private to the person they belong to, until they choose **Share with department** on the Knowledge base page.
  Admins can see and manage every document (including uploading into a specific department), but their own chat answers draw on the same three bases as anyone else's.
- **File attachments** — the **+** button next to the message box lets you attach PDFs, Word docs, Excel/CSV files, or text/markdown files (up to 20MB each, 5 per message), matching the Claude-style attach menu. Attached files are parsed to text, chunked, and saved to your own **My files**.
- **Retrieval** — once a file is in a knowledge base you can ask about it later without re-attaching it. Search works **by meaning**, not just exact words — "staff leave entitlement" finds a policy that says "annual holidays" — using a small local embedding model (`nomic-embed-text` in Ollama, downloaded automatically by the launcher; documents never leave the machine), combined with exact keyword matching for names, codes and figures. It covers the bank-wide base, your department's base and your own files, and the sources are cited under the answer. New uploads are indexed within seconds; without the embedding model, search falls back to keywords. This is retrieval-augmented generation (RAG), not fine-tuning — the underlying model itself isn't modified.
- **Knowledge base page** (`/knowledge.html`, Workspace menu → Knowledge base) — the three bases as separate sections, each with its own upload button where the user is allowed to add files, a filter box, and download/delete/share actions. Admins also get a department picker to browse or upload into any department.
- **Image understanding** — attach a photo, screenshot, or scanned document (PNG/JPG/WEBP/BMP/GIF) the same way as any other file. Two things happen: (1) local OCR (`tesseract.js`) extracts any readable text into the department knowledge base, so it's searchable in chat like any other document; (2) if the selected model supports vision (Ollama reports a `vision` capability — look for the 👁 tag in the model dropdown; none of this bank's currently-installed models have it by default, pull one like `llava`, `llama3.2-vision`, or `moondream` from the admin portal), the actual image is sent to the model so it can literally look at it, not just read OCR'd text. A scanned, image-only PDF can't be read by the PDF parser (no text layer) — upload it as an image instead.
- **Tool use (safe subset)** — the model can call several tools during chat, shown live as status lines ("🔧 Calculating...", "🌐 Searching the web...", etc.):
  - **Calculator** (`run_code`): evaluates math/data expressions (arithmetic, sums, averages, loan/interest math) using `mathjs`'s expression language — not arbitrary JavaScript. There is no way to safely sandbox full code execution on a bare host without containers, so this is intentionally a restricted math language instead: no filesystem, network, or loop constructs are reachable from it. Runs in a worker thread with a hard timeout. Available to every user; only engaged for models that report `tools` capability (most modern Ollama models do).
  - **Web fetch** (`fetch_url`): fetches a web page's text content, but *only* for domains an admin has explicitly approved in the admin portal's Tools tab (default: none approved), or a domain returned by a `web_search` call earlier in the same turn (see below). Each request also re-resolves the domain's DNS and refuses to fetch if it points at a private/loopback/internal address, even for an approved domain — this blocks DNS-rebinding attacks from turning an approved public domain into a path to internal services.
  - **Web search** (`web_search`): searches the public internet (via DuckDuckGo's HTML endpoint — no API key needed) and returns titled results with snippets and URLs, which the model can then read in full with `fetch_url`. **Off by default** — this is the one tool that sends user-typed query text to an external service rather than only fetching pages an admin pre-approved, so an admin has to explicitly turn it on in the Tools tab.
  - **Image generation** (`generate_image`): ask AMERB AI to "generate," "create," or "design" an image and it actually produces one — using a local Stable Diffusion Turbo model (`imagegen/`, a separate Python service), entirely offline once the model is downloaded. On CPU this takes roughly 30–40 seconds per image. Generated images are saved to your department's knowledge base like any other image, shown inline in the chat, and downloadable from the Knowledge Base page.
  - **Document generation** (`create_word_document`, `create_pdf_document`, `create_excel_document`, `create_powerpoint`): produces real `.docx`/`.pdf`/`.xlsx`/`.pptx` files, shown in a live preview panel on the right and saved to the knowledge base.
- **Admin portal** (`/admin.html`, visible only to admin accounts) —
  - **Users**: view all staff accounts, change department, promote/demote admins, delete accounts (at least one admin is always kept).
  - **Local LLMs**: see installed Ollama models, pull new ones from the Ollama library with a live progress bar, or delete ones no longer needed — all without touching a terminal.
  - **External AI**: connect cloud AI providers — **OpenAI**, **Anthropic (Claude)**, **DeepSeek**, or any **OpenAI-compatible** service (Groq, Mistral, OpenRouter, Together, a self-hosted vLLM, …). Paste an API key, click *Connect & load models* (the key is checked straight away by listing the provider's models), then tick which models staff may use. They appear in the chat model picker marked ☁ with the provider's name, and work with every tool (calculator, documents, web search, memory) and with Compare models. API keys are encrypted at rest (AES-256-GCM, key in `data/secret.key` — keep that file with the database when moving or backing up; it's never committed) and only ever shown masked. **Privacy:** unlike local models, an external model sends the staff member's messages and any knowledge base excerpts used to answer them to that provider, and usage is billed to the key's account — staff see a red notice under the message box whenever one is selected. **Customer details are masked by default:** Ghana Card, phone, email, TIN and account/card numbers are replaced with placeholders like `[ACCOUNT_NUMBER_1]` in everything sent to the provider and restored in the reply staff see (an admin can switch this off). Names and free text are not masked, so still only enable models your data policy allows.
  - **Knowledge base**: see every uploaded document across all departments, with uploader and size, and delete anything no longer needed.
  - **Tools**: toggle web search on/off, manage the domain allowlist for the web fetch tool, and set the **language** options — the default reply language for staff, whether staff may choose their own, and the glossary of preferred Twi/Ga wording for banking terms.
  - **Analytics**: usage totals, messages by department/model, thumbs up/down feedback, most active staff, most-cited documents.
  - **System**: download a full database backup at any time (safe to run while staff are actively using the app — uses SQLite's own online-backup API, not a raw file copy), and configure automatic conversation retention (delete conversations older than N days; disabled by default). The "Clean up now" button always previews exactly what would be deleted — count, users, titles, dates — before anything is removed.
- **Login lockout** — an account is temporarily locked for 15 minutes after 5 failed password attempts in a row, to slow down password guessing. An admin resetting a user's password also clears any active lock.
- **Stay signed in** — login sessions are stored in the database, so restarting the server doesn't sign anyone out (sessions last 7 days). An admin resetting a password or deleting an account signs that person out everywhere.
- **Audit log** (admin portal → Audit log) — a permanent record of sign-ins (including failed and locked-out attempts), every question asked in chat with the model that answered it, document uploads/deletions/sharing, and every admin change, with time, user, department and IP address. Filter by person, activity and dates, and export to CSV. Entries can't be edited or deleted in the app and outlive deleted accounts and chats; passwords and API keys are never recorded.
- **Bulk staff onboarding** — the Users tab in the admin portal accepts a CSV (`username,email,department`) to create many accounts at once, each with a temporary password shown once.
- **Operations dashboard** (admin portal → Operations) — live view of everything the app depends on: whether Ollama is reachable and how fast it answers, which models are loaded into memory and until when, CPU (with a five-minute history), memory, GPU (when an NVIDIA card is present), database and log size, free disk, and how many messages are answering or waiting right now. It also shows recent warnings and errors straight from the log file, with a filter, so most problems can be diagnosed without opening a terminal.
- **Health check** — `GET /health` on the same HTTPS port, needing no login: `{"status":"ok",...}` with HTTP 200, or 503 when the database is unreadable (or when `?deep=1&strict=1` finds Ollama down). `?deep=1` adds an Ollama check and reports `"degraded"` rather than failing, so a supervisor doesn't restart the app for a problem restarting can't fix. Used by the Docker healthcheck and the Windows service. Add `--no-browser` / service mode as below.
- **Waiting line for the local model** — one machine can only generate a few answers at once, so extra messages wait in a first-come line instead of stalling: the browser is shown "waiting — you're 2nd in line, about 20 sec" and updates as the line moves. Closing the tab or pressing stop leaves the line. Models run by an external provider don't wait, since they don't use this machine. The number of simultaneous answers, how many people may wait, and how many messages one person can have going are all admin settings (Operations tab and `CHAT_CONCURRENCY`, `CHAT_MAX_WAITING`, `CHAT_PER_USER` in `.env`).
- **Per-person rate limits** — a sliding-window limit on messages per minute and per hour (default 15/minute, 300/hour) so one person or a runaway script can't monopolise the machine. Over the limit, the reply is a clear "wait about 40 seconds" message with HTTP 429 and a `Retry-After` header. Both limits are admin settings and `0` disables one.
- **Model routing** (admin portal → Model routing) —
  - **Per-department default model**: Credit can start its staff on one model, IT on another. It's a starting point only — anyone can still pick any model, and their own choice is remembered.
  - **Automatic fallback**: if the chosen model can't answer at all (Ollama down, model deleted, provider outage), the turn is retried on the next model in an admin-ordered list, and finally on the local `DEFAULT_MODEL`. The person sees a quiet note saying which model answered instead, and the saved message records both. An answer is never switched halfway through — only when nothing has been written yet — so two model's outputs can't end up spliced together. The tab warns when a model in the fallback list is an external provider, since that means a local request could leave the machine.
- **Answer quality by model** (same tab) — the thumbs up/down staff already give, turned into a per-model report: answers, ratings, approval %, average reply time, how often a model answered as a fallback, and a verdict (`Good` from 85%, `OK`, `Review` below 60% once a model has 10 ratings). Ranking uses the statistical lower bound of the approval rate, so "1 of 1" can't outrank "90 of 100". It lists the questions behind recent thumbs down for review, and suggests a better default per department when staff there rate another model clearly higher.
- **Structured logs with rotation** — one JSON line per event in `logs/amerb-ai.log` (rotated at 10 MB, five kept; `LOG_DIR`, `LOG_LEVEL`, `LOG_MAX_MB`, `LOG_KEEP`), including one line per API request with status and duration, every model failure and fallback, and rate-limit and queue refusals. The launcher keeps its own `logs/service.log`. Nothing in the log grows without bound.
- **Currency and exchange-rate questions** — Admin → Tools → Exchange rates lets AMERB AI look up a rate instead of guessing or claiming it has no live data. Only the currency pair is sent to the rate service (never the question or customer data), the address can be pointed at the bank's own source, and every answer states the rate, its publishing date and where it came from. Off by default.

  Web search itself stopped working from many networks because DuckDuckGo answers automated clients with an anti-bot page (HTTP 202). The app no longer reports that as "no results": it says the search was refused, shows it under the reply, and logs it. For reliable searching inside the bank, run a **self-hosted SearXNG** and set SEARXNG_URL in .env — no scraping, no bot checks, and no query leaving the bank except to the engines you configure.
- **Reply languages — English (default), Twi (Akan), Ga, French** — an administrator can offer these, **per model and only after that model passes a capability test in the language**; staff then choose their own (Workspace → Reply language) or the bank fixes one for everyone. Full operator guide: **[docs/LANGUAGES.md](docs/LANGUAGES.md)**.

  **Why testing first.** Answering in another language is a *model* capability, and the app cannot add it. Measured on the machine this was built for, `qwen3:4b-instruct` produced unreadable Twi and Ga — repetitive nonsense like "wɔ bɔɔ kɛ bɔɔ kɛ wɔ kɔnɛ kɔnɛ…" in about 36 seconds. So a language stays invisible to staff until the model in front of them has passed real tests, which check: translation accuracy (does it come back in the language, with the figures intact?), comprehension and meaning (does it answer a question about an English bank paragraph with the right amount, rather than fluent-sounding noise?), the bank's approved terminology, consistency (same sentence twice), and basic prose quality. Producing *some* text in a language never counts as capability. Results are stored with the model, date, tester, score and evidence, and a later failure revokes the approval and moves affected staff back to the default.

  **Safety nets that stay on regardless of the model.** A reply that reads as garbled — or that isn't in the requested language at all — is flagged under the message in chat, with **Answer in English** (regenerates the same question in English, keeping the conversation and the person's preference) and **Report translation** (records it for the administrator). Warnings are stored on the message, written to Operations → Recent warnings and errors, and counted per language under Admin → Language → Usage & quality. If a language can't be used for the selected model the answer is given in English with a plain explanation — never in an unapproved language.

  **Bank wording, not machine translations.** Administrators maintain the approved wording for banking terms (`loan → bosea`) in Admin → Language → Bank wording — add, search, edit, delete, per language, with an optional context line and a record of who added and last changed the term. There are hard limits of 60 characters per field and **200 terms per language**, and an optional **approval workflow**: when it's on, a new or edited term stays *pending* and is deliberately kept out of what the model is told until an administrator approves it, so an unapproved wording can never be presented as the bank's. The list starts empty and the code never invents a translation.

  **Monitoring, feedback and read-only audit access.** Every AI answer is counted per language, model and provider, with filters (date range, language, provider, model), each language's share of answers, a daily trend, and per-model figures that separate a model problem from a wording problem. Staff rate a translated reply **good / incorrect / hard to understand**, and those verdicts feed the same figures. Garbled or untranslated answers are recorded as structured warning events — references only, never question or answer text — alongside Operations → Recent warnings and errors, and an **Investigate warnings** view summarises them and flags recurring failures per model and language. A third role, **auditor**, can read the language records, capability results, usage reports and the audit log but change nothing; there is no route anywhere that edits an audit entry.

  **What always holds.** The interface stays in English and only answers change language; figures, GHS amounts, dates, account numbers, product names, document titles and quoted policy wording are never translated; established Ghanaian banking terms stay recognisable; generated documents stay in English; a question written in a local language is also searched in English (English terms from the bank wording, plus one optional search-only translation); external providers are marked ☁ and keep their identifier masking. Voice input is still English-only — Whisper has no Twi or Ga support — though `SPEECH_MODEL` in `.env` can point at a fine-tuned model later.
- **Docker Compose** — `docker compose up -d` brings up the app, Ollama (with the models pulled automatically on first run) and, with `--profile imagegen`, the image service, with named volumes for data, certificates, logs and models. See [docs/DOCKER.md](docs/DOCKER.md).
- **Getting started guide** (Workspace menu → Getting started) — a quick reference for the less-obvious features (@-mention, voice input, saved prompts, search, read-aloud, shortcuts). Shown automatically the first time anyone reaches the chat screen in a given browser.

The first account is not automatically an admin — promote your first admin manually via the SQLite database, or run the app once, sign up, then update that user's `role` column to `'admin'` in `data/amerb-ai.sqlite`.

- **Search all chats** — the search icon next to the sidebar's chat filter opens a full-text search across every message in every one of your own past conversations, not just chat titles.
- **Saved prompts** (Workspace menu → Saved prompts) — each staff member can save their own reusable prompts and drop them into the composer with one click.
- **@-mention a document** — typing `@` in the composer brings up an autocomplete of documents visible to you (your department's uploads, plus bank-wide ones); picking one attaches it to the message the same way the paperclip button does.
- **Voice input** (mic button in the composer) — speech-to-text runs entirely locally via a small Whisper model (`@xenova/transformers`, ONNX + WASM, no native build step). The model itself (~40MB) downloads once from Hugging Face on first use, the same one-time-download-then-fully-offline pattern as `ollama pull` — after that, transcription never leaves the machine, unlike the browser's own built-in speech recognition, which would send audio to a cloud provider.

## Production hardening

This section is the checklist the app was hardened against; it is not optional reading if the app is
exposed to the bank's network.

**First administrator.** Nobody is an administrator automatically. Set `BOOTSTRAP_ADMIN_EMAIL` in
`.env` to the address that should own the system, sign up with it once, then remove the setting. (Before
this rule existed, any account registering the username `admin` was promoted on the next restart — that
escalation path is gone, and `admin`/`administrator`/`root`/`system` are reserved names.)

**Sign-in.** Passwords are 12 characters minimum; bcrypt cost 12 throughout. Successful sign-in rotates
the session id (no fixation), and changing your own password signs out every other session. Five failed
attempts lock an account — the counter is incremented atomically in SQLite, so parallel guessing cannot
slip past it — and every failure returns exactly the same message and takes the same time whether the
account exists or not (no enumeration). A per-address throttle (30 attempts per 15 minutes) sits in front
of sign-in, sign-up and password change; `AUTH_RATE_MAX` changes it.

**Behind a proxy.** Set `TRUST_PROXY` (see `.env.example`) or every audit entry, lockout and rate limit
will see the proxy's address instead of the person's.

**Response headers.** Every response carries a Content-Security-Policy (`script-src 'self'` plus the
hashes of the app's own inline theme scripts — not `unsafe-inline`), `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, HSTS, and a Permissions-Policy that
allows only the microphone. State-changing requests from another site are refused as well as being
protected by the SameSite cookie.

**Uploads and stored files.** A file's type is decided by the app from its extension/bytes — never from
the upload's own Content-Type header — and only PDFs and images are ever served inline. Everything else
downloads as an attachment, and file responses additionally carry `CSP: sandbox`, `nosniff` and
`frame-ancestors 'self'` so a crafted document cannot run script in the app's origin. HTML previews of
Word/Excel files are stripped of scripts, event handlers and `javascript:` links. Uploads are throttled
per person (40 per 15 minutes) and capped at 20 MB × 5 files, and a too-large upload answers 413 rather
than an opaque 500.

**Web tools.** `fetch_url` only reaches domains an administrator approves and refuses private, loopback,
link-local, carrier-grade-NAT, benchmarking, mapped-IPv6 and multicast addresses (checked after DNS
resolution, with the connection pinned to the checked IP). Web search is off by default; when the
bank's own documents cannot answer a policy question, only the approved websites are searched and the
reply says which ones.

**Operations.** `SIGTERM` drains in-flight answers before exiting (10 s cap) and an uncaught exception
shuts the process down deliberately, so the service restarts a clean one instead of carrying on in an
unknown state. `/health` reports database and Ollama state. Errors are logged in full and returned to
the browser as a plain message, never a stack trace. Downloading the whole database is recorded in the
audit log.

**Dependencies.** `npm audit --omit=dev` reports two high advisories, both `image-size` (reached
only through `pptxgenjs` when it embeds an image into a generated presentation; the app builds decks from
text and never passes an uploaded image to it — no fixed `pptxgenjs` release exists yet). Voice input's
`sharp` dependency is pinned to a patched version. Run `npm audit` after every dependency change and
before each release.

**Known limitations, documented rather than hidden.** Voice input cannot load on a Windows server whose
own `onnxruntime.dll` shadows the speech model's runtime — the app reports it and typing keeps working
(set `SPEECH_DISABLED=1` to hide the microphone). Twi and Ga answers depend entirely on the model and are
gated behind capability tests (see `docs/LANGUAGES.md`). Media and documents are stored inside the SQLite
database, which is not encrypted at rest — protect the machine and the backups accordingly.

## How it works

- **Backend**: Express server (`server/`) — auth, sessions, conversations, document upload/parsing, retrieval, and proxying chat/model-management requests to Ollama with streaming (Server-Sent Events).
- **Database**: SQLite file at `data/amerb-ai.sqlite`, created and migrated automatically on first run. Tables: `users`, `conversations`, `messages`, `documents`, `document_chunks`, `allowed_domains`, `app_settings`.
- **Document parsing**: `.pdf` via `pdf-parse`, `.docx` via `mammoth`, `.xlsx`/`.xls` via SheetJS (`xlsx`, installed from SheetJS's own CDN to get their patched release — the npm-published version has known unpatched CVEs), images via `tesseract.js` (OCR), and `.txt`/`.md`/`.csv` read directly.
- **Retrieval** (`server/retrieval.js`, `server/embeddings.js`): each document chunk is embedded with a local Ollama embedding model in the background and stored in SQLite (`chunk_embeddings`); a question is embedded the same way and matched by cosine similarity (cut-off 0.65, calibrated on the bank's documents), then merged with keyword-overlap matches. Access rules are applied in SQL before any matching, so a passage from another department can never be returned.
- **Tool-calling loop** (`server/tools.js`, wired into `server/routes/chat.js`): when the selected model reports `tools` capability, the server does up to 4 non-streaming round-trips with Ollama offering the three tools, executing any tool calls and feeding results back, before doing the final streamed answer.
- **Image generation service** (`imagegen/service.py`): a small standalone Flask app in its own Python virtual environment (kept separate from Node entirely), wrapping a `diffusers` Stable Diffusion Turbo pipeline. The Node server calls it over `http://127.0.0.1:7861` (configurable via `IMAGEGEN_URL` in `.env`) exactly like it calls Ollama — if the service isn't running, image generation just fails with a clear error; nothing else in the app is affected.
- **Frontend**: Plain HTML/CSS/JS (`public/`) — no build step.
- **Queue, limits and model routing** (`server/queue.js`, `server/rateLimit.js`, `server/modelRouting.js`): the chat route admits a request through the rate limiter, then waits for a slot in a FIFO queue before the turn runs (nothing is saved if it's refused up front). The turn's model call goes through a small wrapper that records success/failure per model and, on a failure before any text has streamed, retries on the next configured fallback. Settings live in `app_settings`, so they can be changed without a restart.
- **Logging** (`server/logger.js`, `server/monitor.js`): every console message plus a per-request line goes to a size-rotated JSON log; `/health` and the Operations tab read live state from Ollama's own API (`/api/tags`, `/api/ps`, `/api/version`), `os` counters, `nvidia-smi` when present, and SQLite's `statfs`.
- **Reply language** (`server/languages.js`): a per-user column (`users.reply_language`) resolved against the admin defaults on every message; Twi/Ga detection is a conservative marker-based scorer (it answers in English when unsure rather than guessing, since answering a Ga speaker in Twi is worse than English); the language instruction is one extra system message, and document search gets an English version of the question via the glossary plus, optionally, one small model call.

## Security notes on the tool-use feature

Giving a local LLM the ability to run code and fetch web pages is a real expansion of what this app can do to your systems, so worth being explicit about the tradeoffs made:

- **No arbitrary code execution.** Full JavaScript/Python sandboxing cannot be done safely without OS-level isolation (containers/VMs), which this single-host setup doesn't have. Instead, `run_code` only runs `mathjs` expressions — a restricted math language with no loops, no `require`/`import` of modules, and no access to the filesystem or network by construction.
- **Web fetch is deny-by-default.** `fetch_url` only works for domains an admin explicitly adds in the admin portal, or ones surfaced by a `web_search` call earlier in the same conversation turn. With no domains approved and web search off (both defaults), every fetch attempt fails.
- **Web search is off by default and admin-gated.** It's the first tool that sends user-typed text to an external party (DuckDuckGo) rather than only retrieving pre-approved content — verified during testing that it's correctly refused with a clear error until an admin enables it in the Tools tab.
- **DNS-rebinding / SSRF protection, with the connection actually pinned.** Every fetch resolves the hostname itself and refuses to proceed if it's a private/loopback/link-local address — even for an approved domain. Critically, the outbound connection is then pinned to that exact validated IP via a custom `undici` dispatcher, rather than letting `fetch()` re-resolve DNS a second time — closing the classic rebinding TOCTOU gap where a fast-flipping DNS record returns a safe IP for the check and a different one for the real connection. Verified directly: a domain that's publicly approved but resolves to `127.0.0.1` is correctly blocked from reaching the app's own internal API.
- **Redirects are followed manually**, re-validating the allowlist and IP check on every hop, capped at 3 redirects.
- **Response size and time are capped** (300KB read, 8s timeout) to limit resource exhaustion.
- Local open-weight models have much thinner safety alignment than Claude — a malicious or cleverly-crafted uploaded document could attempt prompt injection to get the model to misuse these tools. The guardrails above are designed to hold even if the model itself is fully compromised by such an injection (e.g. it can ask to fetch an unapproved or internal-resolving domain, but the server will refuse regardless of what the model "wants").
- **Image generation has no content filter.** `sd-turbo` ships without the Stable Diffusion safety checker component, so nothing currently blocks generating inappropriate images. This is an internal tool used by accountable bank staff (not a public product), but worth knowing — if this becomes a concern, a content-moderation step (e.g. a second pass classifying generated images, or prompt-level keyword blocking) would need to be added deliberately; it isn't there today.

## Notes on running this beyond your own machine

This is built for local/on-prem single-server use. If you plan to expose it more broadly within the bank's network:

- Set a strong, random `SESSION_SECRET` in `.env`.
- Put it behind a reverse proxy or an internal CA certificate if staff shouldn't have to click through the self-signed one. (The session cookie is already `secure` and HTTPS-only.)
- Sessions are already stored in SQLite (`server/sessionStore.js`) and survive restarts.
- Review upload limits (`server/routes/documents.js`) and the retrieval context caps (`server/retrieval.js`) if departments accumulate a large number of documents.
- Run it as a service (see [docs/WINDOWS-SERVICE.md](docs/WINDOWS-SERVICE.md)) so it comes back by itself after a reboot or crash, and point a monitor at `/health?deep=1&strict=1`.
- Keep `logs/` and `data/` on the same disk as the database, and back up `data/amerb-ai.sqlite` together with `data/secret.key` — the key decrypts the external-provider API keys stored next to it.

