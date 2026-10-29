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

### Network access

By default the server listens on every network interface (`HOST=0.0.0.0` in `.env`), so other PCs on the same network can open it at `https://<this machine's IP>:3000` — the launcher prints the exact addresses on startup. Set `HOST=127.0.0.1` to allow this computer only. If other PCs can't connect, the firewall is blocking the port: on Windows allow Node.js when prompted (or have IT open TCP 3000); on Linux run e.g. `sudo ufw allow 3000/tcp`. If staff will use a fixed IP or a DNS name (e.g. `amerb.bank.local`), list it in `PUBLIC_HOSTNAMES` so the HTTPS certificate covers it.

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

Each test file spins up a real instance of the app as its own process against a disposable temporary SQLite database — never `data/amerb-ai.sqlite` — so it's always safe to run, including against a machine with real staff data on it. Covers login lockout, department-scoped document access, message-version switching, and conversation-retention cleanup (including the exact boundary condition behind a real incident where a manual test once deleted more than intended).

## Features

- **Accounts & sessions** — signup/login restricted to `@amenfimanbank.com` addresses, bcrypt-hashed passwords, httpOnly session cookies.
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
  - **Tools**: toggle web search on/off, and manage the domain allowlist for the web fetch tool.
  - **Analytics**: usage totals, messages by department/model, thumbs up/down feedback, most active staff, most-cited documents.
  - **System**: download a full database backup at any time (safe to run while staff are actively using the app — uses SQLite's own online-backup API, not a raw file copy), and configure automatic conversation retention (delete conversations older than N days; disabled by default). The "Clean up now" button always previews exactly what would be deleted — count, users, titles, dates — before anything is removed.
- **Login lockout** — an account is temporarily locked for 15 minutes after 5 failed password attempts in a row, to slow down password guessing. An admin resetting a user's password also clears any active lock.
- **Stay signed in** — login sessions are stored in the database, so restarting the server doesn't sign anyone out (sessions last 7 days). An admin resetting a password or deleting an account signs that person out everywhere.
- **Audit log** (admin portal → Audit log) — a permanent record of sign-ins (including failed and locked-out attempts), every question asked in chat with the model that answered it, document uploads/deletions/sharing, and every admin change, with time, user, department and IP address. Filter by person, activity and dates, and export to CSV. Entries can't be edited or deleted in the app and outlive deleted accounts and chats; passwords and API keys are never recorded.
- **Bulk staff onboarding** — the Users tab in the admin portal accepts a CSV (`username,email,department`) to create many accounts at once, each with a temporary password shown once.
- **Getting started guide** (Workspace menu → Getting started) — a quick reference for the less-obvious features (@-mention, voice input, saved prompts, search, read-aloud, shortcuts). Shown automatically the first time anyone reaches the chat screen in a given browser.

The first account is not automatically an admin — promote your first admin manually via the SQLite database, or run the app once, sign up, then update that user's `role` column to `'admin'` in `data/amerb-ai.sqlite`.

- **Search all chats** — the search icon next to the sidebar's chat filter opens a full-text search across every message in every one of your own past conversations, not just chat titles.
- **Saved prompts** (Workspace menu → Saved prompts) — each staff member can save their own reusable prompts and drop them into the composer with one click.
- **@-mention a document** — typing `@` in the composer brings up an autocomplete of documents visible to you (your department's uploads, plus bank-wide ones); picking one attaches it to the message the same way the paperclip button does.
- **Voice input** (mic button in the composer) — speech-to-text runs entirely locally via a small Whisper model (`@xenova/transformers`, ONNX + WASM, no native build step). The model itself (~40MB) downloads once from Hugging Face on first use, the same one-time-download-then-fully-offline pattern as `ollama pull` — after that, transcription never leaves the machine, unlike the browser's own built-in speech recognition, which would send audio to a cloud provider.

## How it works

- **Backend**: Express server (`server/`) — auth, sessions, conversations, document upload/parsing, retrieval, and proxying chat/model-management requests to Ollama with streaming (Server-Sent Events).
- **Database**: SQLite file at `data/amerb-ai.sqlite`, created and migrated automatically on first run. Tables: `users`, `conversations`, `messages`, `documents`, `document_chunks`, `allowed_domains`, `app_settings`.
- **Document parsing**: `.pdf` via `pdf-parse`, `.docx` via `mammoth`, `.xlsx`/`.xls` via SheetJS (`xlsx`, installed from SheetJS's own CDN to get their patched release — the npm-published version has known unpatched CVEs), images via `tesseract.js` (OCR), and `.txt`/`.md`/`.csv` read directly.
- **Retrieval** (`server/retrieval.js`, `server/embeddings.js`): each document chunk is embedded with a local Ollama embedding model in the background and stored in SQLite (`chunk_embeddings`); a question is embedded the same way and matched by cosine similarity (cut-off 0.65, calibrated on the bank's documents), then merged with keyword-overlap matches. Access rules are applied in SQL before any matching, so a passage from another department can never be returned.
- **Tool-calling loop** (`server/tools.js`, wired into `server/routes/chat.js`): when the selected model reports `tools` capability, the server does up to 4 non-streaming round-trips with Ollama offering the three tools, executing any tool calls and feeding results back, before doing the final streamed answer.
- **Image generation service** (`imagegen/service.py`): a small standalone Flask app in its own Python virtual environment (kept separate from Node entirely), wrapping a `diffusers` Stable Diffusion Turbo pipeline. The Node server calls it over `http://127.0.0.1:7861` (configurable via `IMAGEGEN_URL` in `.env`) exactly like it calls Ollama — if the service isn't running, image generation just fails with a clear error; nothing else in the app is affected.
- **Frontend**: Plain HTML/CSS/JS (`public/`) — no build step.

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
- Put it behind HTTPS (e.g. a reverse proxy) — cookies are currently not marked `secure`.
- Sessions are already stored in SQLite (`server/sessionStore.js`) and survive restarts.
- Review upload limits (`server/routes/documents.js`) and the retrieval context caps (`server/retrieval.js`) if departments accumulate a large number of documents.
