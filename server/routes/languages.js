// What the chat page needs to offer reply languages, for the model the person has currently chosen:
// which languages are enabled and approved for that model, the bank-wide default, whether staff may
// choose at all, and what this person's next answer will actually be in.
//
// A language is only offered once that model has passed a capability test in it (see
// server/languageTests.js) — the UI therefore re-asks whenever the model picker changes.
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const L = require('../languages');
const languageSettings = require('../languageSettings');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const user = db.prepare('SELECT reply_language FROM users WHERE id = ?').get(req.session.userId);
  const stored = user?.reply_language || null;
  const model = typeof req.query.model === 'string' && req.query.model.trim() ? req.query.model.trim() : null;
  const availability = languageSettings.availabilityForModel(model);
  const choiceAllowed = languageSettings.choiceAllowed();
  const defaultLanguage = languageSettings.defaultLanguage();

  // What the next answer will be in: the person's choice if it's usable for this model, otherwise the
  // bank default. The chat itself enforces the same rule, so this is only the honest preview.
  let effective = defaultLanguage;
  if (choiceAllowed && stored === L.AUTO) {
    effective = stored; // resolved per message from what they write
  } else if (choiceAllowed && stored && L.CODES.includes(stored)) {
    effective = availability[stored]?.available ? stored : defaultLanguage;
  }

  res.json({
    languages: L.LANGUAGES.map((language) => ({
      code: language.code,
      label: language.label,
      native: language.native,
      available: availability[language.code].available,
      reason: availability[language.code].reason,
      // Set when an administrator offered the language without a passed test, so the dialog can say so.
      warning: availability[language.code].warning || null,
    })),
    auto: { code: L.AUTO, label: 'Match my message' },
    defaultLanguage,
    choiceAllowed,
    // What the person chose ('auto' included), or null if they have never chosen.
    mine: stored,
    // What their next answer will be in — a language code, or 'auto'.
    effective,
    effectiveLabel: effective === L.AUTO ? 'Match my message' : L.labelOf(effective),
    model,
    // True when the person's saved choice can't be used for this model (they'll get the default).
    choiceUnavailable: Boolean(choiceAllowed && stored && L.CODES.includes(stored) && !availability[stored]?.available),
  });
});

module.exports = router;
