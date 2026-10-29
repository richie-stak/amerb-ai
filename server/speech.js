// Local speech-to-text via transformers.js (ONNX + WASM, no native build step) — audio never
// leaves this machine, unlike the browser's built-in speech recognition which sends it to a
// cloud provider. The model itself is fetched from Hugging Face once on first use and then
// cached on disk, the same one-time-download-then-fully-offline pattern as `ollama pull`.
let transcriberPromise = null;

async function getTranscriber() {
  if (!transcriberPromise) {
    transcriberPromise = (async () => {
      const { pipeline, env } = await import('@xenova/transformers');
      env.allowLocalModels = false;
      return pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en');
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
