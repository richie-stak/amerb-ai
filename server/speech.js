// Local speech-to-text via transformers.js (ONNX + WASM, no native build step) — audio never
// leaves this machine, unlike the browser's built-in speech recognition which sends it to a
// cloud provider. The model itself is fetched from Hugging Face once on first use and then
// cached on disk, the same one-time-download-then-fully-offline pattern as `ollama pull`.
// Which Whisper model is used. The default is the English-only tiny model: Whisper has no Twi or Ga
// support at all (its language list doesn't include them), so a multilingual model wouldn't help
// those, while the English-only one is both smaller and more accurate for the English that staff
// speak day to day. SPEECH_MODEL lets an admin point at a multilingual or fine-tuned model later
// (e.g. Xenova/whisper-base) without touching the code.
const SPEECH_MODEL = process.env.SPEECH_MODEL || 'Xenova/whisper-tiny.en';
let transcriberPromise = null;

async function getTranscriber() {
  if (!transcriberPromise) {
    transcriberPromise = (async () => {
      const { pipeline, env } = await import('@xenova/transformers');
      env.allowLocalModels = false;
      return pipeline('automatic-speech-recognition', SPEECH_MODEL);
    })();
  }
  return transcriberPromise;
}

// samples must be mono PCM at 16kHz, as a Float32Array — the resampling happens client-side.
async function transcribeAudio(samples) {
  const transcriber = await getTranscriber();
  const result = await transcriber(samples);
  return (result.text || '').trim();
}

module.exports = { transcribeAudio };
