const express = require('express');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { transcribeAudio } = require('../speech');

const router = express.Router();
router.use(requireAuth);

// The frontend resamples to mono 16kHz Float32 PCM before sending, so this caps out at a little
// over 3 minutes of audio (16000 samples/sec * 4 bytes/sample) — plenty for a composer message.
router.post(
  '/transcribe',
  express.raw({ type: 'application/octet-stream', limit: '15mb' }),
  asyncHandler(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ error: 'No audio data received' });
    }
    if (req.body.length % 4 !== 0) {
      return res.status(400).json({ error: 'Malformed audio data' });
    }
    const samples = new Float32Array(req.body.buffer, req.body.byteOffset, req.body.length / 4);
    const text = await transcribeAudio(samples);
    res.json({ text });
  })
);

module.exports = router;
