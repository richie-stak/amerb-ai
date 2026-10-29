const express = require('express');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { checkHealth } = require('../imagegen');

const router = express.Router();
router.use(requireAuth);

router.get('/health', asyncHandler(async (req, res) => {
  res.json(await checkHealth());
}));

module.exports = router;
