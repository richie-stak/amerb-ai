# Reply languages (Twi, Ga, French)

AMERB AI answers in English by default. An administrator can offer Twi (Akan), Ga and/or French as
well, per model, *after that model has passed a capability test in the language*. Staff then choose
their own reply language, or the bank can fix one for everyone.

The application's interface stays in English — only the AI's answers change language. Documents the
model generates (letters, memos, reports, spreadsheets) stay in English, because official bank
documents do.

> **Read this first.** Answering in another language is a *model* capability; the app cannot add it.
> Measured on the machine this was built for, `qwen3:4b-instruct` answered a Twi question with
> "wɔ bɔɔ kɛ bɔɔ kɛ wɔ kɔnɛ kɔnɛ…" in about 36 seconds. That is why a language is locked until a
> model passes the tests below, and why a suspicious answer is flagged in the chat rather than
> presented as a translation.

## The model in one picture

```
Administrator                       System                          Staff
─────────────                       ──────                          ─────
enable a language  ──────────►  availability = enabled
                                 AND the model in front of
                                 the person passed a test
                                        │
run capability test ────────────►  approved / failed  ──────────►  language appears in the
(bank default model)               (stored, dated,                 "Reply language" dialog
                                    audited)                        for that model only
                                        │
                                        ▼
                            staff pick a language  ─────────►  answers in that language,
                            (or the bank fixes one)             with a warning + "Answer in
                                                                English" if it looks wrong
```

## 1. Enable and approve a language (Admin → Language)

1. **Turn the language on** in the Languages table. English is always on and is the default.
2. **Run a capability test** for the bank's default model in Capability testing. Testing one
   language takes a few minutes on a CPU-only machine (it makes several real model calls), and the
   progress is shown step by step; **Stop** cancels it.
3. Only when every check passes does the language appear to staff. A failed test leaves it off, with
   the reason recorded.

What the test actually checks — a model is **not** approved just because it produced some text in the
language:

| Check | What it means |
| --- | --- |
| Translation accuracy | the sentence comes back in the target language, not English, and the figures survive (GHS 200.00, 6 months) exactly |
| Comprehension and meaning | a question asked in the language about an English bank paragraph is answered with the right amount, not fluent-sounding noise |
| Banking terminology | the bank's own approved wording is used (only checked when the bank has recorded any) |
| Consistency | the same sentence translated twice reads the same way — not a fresh invention each time |
| Quality | every answer is real prose, not a loop of repeated words |

Results are stored with the model, the date, who ran it, the score and each check's evidence, and are
never edited. Re-running a test replaces the approval decision; a later failure revokes it and moves
staff who were using that language back to the bank default.

## 2. Staff preferences

- Workspace → **Reply language** shows only the languages available *for the model currently
  selected*; unavailable ones are greyed out with the reason.
- A person's own choice overrides the bank default, and changing the bank default never overrides an
  existing personal choice.
- If an administrator turns off "let staff choose", everyone follows the bank default and the
  personal setting is ignored (not deleted).
- If a language stops being available, affected staff are automatically moved back to the bank
  default; the change is written to the audit log (`language.reverted`).

## 3. Bank wording for banking terms (Admin → Language → Bank wording)

Documents and products are in English. Record the wording the bank itself uses for a term (e.g.
`loan → bosea`) and the model is told to use it. For each language you can **add, search, edit and
delete** terms, and each term carries:

- **English term** and **approved wording** — at most 60 characters each,
- an optional **context** line saying what the bank means by the term (e.g. "excludes staff salary
  loans"), which is also searchable,
- **who added it, who last changed it, and when**,
- an **approval status** (`approved`, or `pending` / `rejected` when the approval workflow is on).

Limits: **200 terms per language**, enforced by the server (the Add button stops working before that).

The application **never invents or approves a translation on its own**: the list starts empty, and a
term only exists because an administrator typed it. If you are not sure of a wording, leave it out —
answers still come back in the language, they just aren't told a preferred term.

### Approval workflow

Turn on **"Require approval before a term is given to the AI"** when more than one person maintains
the wording. From then on:

- a new term, or an edited one, is saved as **pending** and is **not** sent to the model;
- only terms an administrator has **approved** are included in what the AI is told — so an unreviewed
  translation can never be presented as the bank's approved wording;
- approving, rejecting, adding, editing and deleting are each written to the audit log with the
  administrator's name.

Terms that already existed when the workflow was switched on stay approved; the change itself is
recorded, so it is clear from when the rule applied.

## 4. Usage and quality (Admin → Language → Usage & quality)

Answers and warnings are counted per language, per model and per provider, with filters for **date
range, language, provider and model**:

- total AI answers, and each language's **share** of them,
- **auto-flagged** answers — ones the system judged garbled or not in the language,
- staff feedback: **good translation**, **incorrect translation**, **hard to understand**,
- a daily **trend** of answers with the flagged ones highlighted,
- a per-model table with the provider (☁ marks a model that runs outside the bank's machine), so an
  administrator can tell "this model is the problem" from "this wording is the problem".

### Investigating a warning

**Investigate warnings** lists the same events that appear under Operations → **Recent warnings and
errors**, with the reason, language, model, provider and a reference to the reply. It summarises them
by reason and calls out **recurring** failures (the same model and language again and again) — that is
the difference between an occasional odd answer and a model that should not be enabled for a
language. By design these records contain **references only**: no question or answer text is copied
into the monitoring tables.

## 5. Staff feedback

Under a translated reply staff can record a verdict: **Good translation**, **Incorrect translation**
or **Hard to understand** (clicking the same one again clears it, and "Answer in English" is always
available next to a warning). Each verdict is stored against the reply, the person, the time, the
language and the model, appears in the figures above, and is audited.

## 6. Roles and audit

| Role | Can do |
| --- | --- |
| **Staff** | chat; give feedback on replies; choose their own language if allowed |
| **Administrator** | everything: languages, capability tests, terminology, approval decisions, settings, users |
| **Auditor** | **read-only**: language settings, terminology, capability results, usage & quality reports, warnings, the audit log and analytics CSV export — every change is refused |

The audit log is append-only by design: there is no route that edits or deletes an entry, and only
administrators and auditors can read it.


## 7. What staff see when something is wrong

- **Warning under the reply** ("This answer may be unreliable in Twi…") when an answer reads as
  repetitive nonsense, or when it simply isn't in the requested language at all. It carries:
  - **Answer in English** — regenerates the same question in English (the original question and the
    conversation are kept; the person's saved preference is not changed).
  - **Report translation** — records that the translation was wrong, for the administrator to see.
- **Quiet note** when the chosen language couldn't be used for that model ("Twi isn't available for
  this model yet, so this answer is in English.").
- Warnings are stored on the message (so they're still there when the chat is reopened), written to
  Operations → **Recent warnings and errors**, and counted per language in Admin → Language →
  Usage & quality.

## 8. Data protection

- **Local models** run on the bank's own machine; nothing leaves it.
- **External providers** (OpenAI, Anthropic, DeepSeek, or any OpenAI-compatible service) are marked
  ☁ everywhere they appear, and their usage is attributed to that provider in the quality figures.
  Customer identifiers (Ghana Card, phone, email, TIN, account/card numbers) are masked before
  anything is sent to them and restored in the reply — see the admin portal's External AI tab and the
  README. Only enable an external model if the bank's data policy allows the question itself to leave
  the machine.
- A capability test sends only the fixed sample sentences (ordinary banking wording — no customer
  data) to the model being tested. The admin panel says so next to the button.
- **Language-quality monitoring stores references, not content**: a warning records the reply it
  applies to, the language, the model, the provider, the reason and the time — never the question or
  the answer. The investigation view therefore cannot become a second copy of the bank's
  conversations.
- Every change here goes through the existing access controls and audit log: language changes, term
  additions/edits/deletions/approvals, capability test runs (with who ran them), staff feedback, and
  automatic reverts. Auditors can read all of it and change none of it.

## 9. Before deployment (acceptance checklist)

Run these on the machine that will serve staff, with the models the bank will actually enable:

- [ ] `npm test` passes (it covers every rule below against stand-in models).
- [ ] Capability test run for **each** language you intend to offer, on the bank's default model —
      and on every other model staff are allowed to pick (a language is offered per model).
- [ ] Staff preference: one person chooses Twi, confirm their answers are in Twi while the bank
      default is English; change the bank default and confirm their choice is unaffected.
- [ ] Administrator override: turn off "let staff choose" and confirm everyone gets the default;
      turn it back on.
- [ ] Default-language change: switch the default and confirm new staff follow it.
- [ ] Unavailable-language fallback: turn a language off and confirm affected staff return to the
      default (and that the audit log records it).
- [ ] **Approved terminology is used**: add a term, ask a question that needs it, and confirm the
      answer uses the bank's wording. Confirm a *pending* term (with the approval workflow on) never
      reaches the model, and that an unapproved wording is never shown as bank-approved.
- [ ] Search, add, edit and delete in Bank wording each work; the 200-term and 60-character limits
      are enforced.
- [ ] Usage figures: after a day of use, spot-check answers and feedback counts against a couple of
      conversations; check the language percentages add up and the filters (date, language, provider,
      model) behave.
- [ ] Staff feedback: each of the three categories saves, survives a page reload, and appears in the
      figures; clicking it again clears it.
- [ ] Operations integration: produce a garbled answer (or use a model that is not capable) and
      confirm the warning appears in Operations → Recent warnings and errors *and* in Investigate
      warnings, with a reference to the reply.
- [ ] Roles: log in as an auditor and confirm the language records and audit log are readable but
      every Save/Approve/Delete button is refused; log in as ordinary staff and confirm the admin
      portal is not reachable.
- [ ] Audit records: confirm they accumulate and that nothing in the app offers a way to edit them.
- [ ] External AI: if any external model is enabled, confirm masked identifiers still work and that
      the bank's data policy permits it.


Do not enable a language for staff until its capability test passes. A language that has never been
tested is deliberately invisible to staff.
