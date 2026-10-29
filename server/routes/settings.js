const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { isWebSearchEnabled } = require('../settings');

const router = express.Router();
router.use(requireAuth);

// Read-only view of settings that affect what a regular user's chat UI should show/allow —
// e.g. whether to let them toggle the web-search globe icon at all.
router.get('/', (req, res) => {
  res.json({ webSearchEnabled: isWebSearchEnabled() });
});

module.exports = router;
