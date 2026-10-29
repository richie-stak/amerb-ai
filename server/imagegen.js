const db = require('./db');

const IMAGEGEN_URL = process.env.IMAGEGEN_URL || 'http://127.0.0.1:7861';
const GENERATE_TIMEOUT_MS = 180_000; // CPU generation can take a while

async function checkHealth() {
  try {
    const r = await fetch(`${IMAGEGEN_URL}/health`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return { ready: false, loading: false, error: `Service responded with status ${r.status}` };
    return await r.json();
  } catch (err) {
    return {
      ready: false,
      loading: false,
      error: 'Image generation service is not running. Start it with imagegen/start.bat (or start.sh).',
      details: err.message,
    };
  }
}

// Calls the local Stable Diffusion service, then saves the result as a document so it's
// retrievable, downloadable, and shows up in the department's knowledge base like any image.
async function generateImage(prompt, user) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GENERATE_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${IMAGEGEN_URL}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('Image generation timed out (this is CPU-only and can be slow)');
    throw new Error('Could not reach the image generation service. Is it running?');
  }
  clearTimeout(timer);

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Image generation service responded with status ${res.status}`);
  }
  const data = await res.json();

  const filename = `generated-${Date.now()}.png`;
  const department = user.department || 'General';
  const result = db
    .prepare(
      'INSERT INTO documents (user_id, department, is_personal, filename, mime_type, kind, image_data, char_count) VALUES (?, ?, 1, ?, ?, ?, ?, ?)'
    )
    .run(user.id, department, filename, 'image/png', 'image', data.image_base64, prompt.length);

  db.prepare('INSERT INTO document_chunks (document_id, chunk_index, content) VALUES (?, 0, ?)').run(
    result.lastInsertRowid,
    `Generated image. Prompt: ${prompt}`
  );

  return { documentId: result.lastInsertRowid, filename, seconds: data.seconds };
}

module.exports = { checkHealth, generateImage, IMAGEGEN_URL };
