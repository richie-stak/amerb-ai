// Local speech-to-text via transformers.js (ONNX, no native build step) — audio never leaves this
// machine, unlike the browser's built-in speech recognition which sends it to a cloud provider. The
// model is fetched from Hugging Face once on first use and then cached on disk, the same
// one-time-download-then-fully-offline pattern as `ollama pull`.
//
// Two deployment realities this file has to handle, both found while making the app production-ready:
//
//  - Whisper has no Twi or Ga support at all, so the default is the English-only tiny model (smaller
//    and more accurate for the English staff actually speak). SPEECH_MODEL points it elsewhere.
//  - The ONNX Runtime native library that transformers.js loads can be shadowed by a copy of
//    `onnxruntime.dll` that Windows itself ships in C:\Windows\System32 (version 1.17 on this
//    machine). The load then fails — sometimes by throwing, and under one combination of versions by
//    crashing the whole process. Voice input is a convenience, not something worth taking the server
//    down for, so every failure here is caught, remembered, and reported as "voice input is not
//    available" while typing carries on working. SPEECH_DISABLED=1 skips loading it altogether.
const fs = require('node:fs');
const SPEECH_MODEL = process.env.SPEECH_MODEL || 'Xenova/whisper-tiny.en';
const DISABLED = ['1', 'true', 'yes'].includes(String(process.env.SPEECH_DISABLED || '').toLowerCase());
const FORCED = ['1', 'true', 'yes'].includes(String(process.env.SPEECH_FORCE || '').toLowerCase());

let transcriberPromise = null;
let failure = null;

// Windows ships its own, older onnxruntime.dll in System32, and the loader finds that one first. The
// mismatch does not raise a catchable error — it terminates the process (access violation), which
// would take AMERB AI down for every user the moment somebody pressed the microphone. So check for it
// before loading anything, and refuse politely. SPEECH_FORCE=1 overrides for a machine where the
// administrator has verified the versions match.
function nativeRuntimeHazard() {
  if (process.platform !== 'win32' || FORCED) return null;
  const shadow = 'C:\\Windows\\System32\\onnxruntime.dll';
  if (!fs.existsSync(shadow)) return null;
  return (
    'this server has Windows’ own ONNX Runtime in C:\\Windows\\System32, which conflicts with the one the ' +
    'speech model needs (loading it would crash the app). Voice input is off; typing works normally. ' +
    'Administrators can set SPEECH_FORCE=1 if the versions have been checked, or SPEECH_DISABLED=1 to hide the microphone.'
  );
}

function conflictReason() {
  return nativeRuntimeHazard() ? new Error(`Voice input is not available: ${nativeRuntimeHazard()}`) : null;
}

async function getTranscriber() {
  if (DISABLED) throw new Error('Voice input is switched off on this server (SPEECH_DISABLED).');
  if (failure) throw failure;
  const hazard = conflictReason();
  if (hazard) {
    failure = hazard;
    throw failure;
  }
  if (!transcriberPromise) {
    transcriberPromise = (async () => {
      try {
        const { pipeline, env } = await import('@huggingface/transformers');
        env.allowLocalModels = false;
        return await pipeline('automatic-speech-recognition', SPEECH_MODEL);
      } catch (err) {
        // Remember the failure so a broken install is reported instantly instead of retried (and
        // re-crashing) on every button press.
        failure = new Error(
          `Voice input is not available on this server: ${err.message}. Typing works normally. ` +
            'An administrator can set SPEECH_DISABLED=1 to hide the microphone entirely, or run the app ' +
            'on a machine whose ONNX Runtime matches the speech model.'
        );
        transcriberPromise = null;
        throw failure;
      }
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

// Used by the admin portal / health check to say whether the microphone will work before staff try it.
function speechStatus() {
  if (DISABLED) return { available: false, reason: 'switched off (SPEECH_DISABLED)' };
  if (failure) return { available: false, reason: failure.message };
  return { available: null, reason: transcriberPromise ? 'model loaded' : 'not loaded yet (loads on first use)' };
}

module.exports = { transcribeAudio, speechStatus };
