// Reads a streamed HTTP response line by line. Used for Ollama's newline-delimited JSON as well
// as the Server-Sent Events ("data: {...}") that OpenAI-style and Anthropic APIs stream.
async function forEachLine(response, onLine) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) onLine(trimmed);
    }
  }
  if (buffer.trim()) onLine(buffer.trim());
}

// Turns a failed HTTP response into an error message worth showing an admin — providers put the
// useful part ("Incorrect API key", "model not found", "insufficient balance") in a JSON body.
async function responseError(response, who) {
  const text = await response.text().catch(() => '');
  let detail = text;
  try {
    const json = JSON.parse(text);
    detail = json.error?.message || json.error || json.message || text;
  } catch {
    /* not JSON — keep the raw text */
  }
  if (typeof detail !== 'string') detail = JSON.stringify(detail);
  return new Error(`${who} responded with status ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
}

// Images reach the adapters as bare base64 (Ollama's format); external APIs want the media type
// spelled out, so it's read from the first bytes of the file itself.
function imageMediaType(base64) {
  if (base64.startsWith('iVBOR')) return 'image/png';
  if (base64.startsWith('/9j/')) return 'image/jpeg';
  if (base64.startsWith('R0lG')) return 'image/gif';
  if (base64.startsWith('UklG')) return 'image/webp';
  return 'image/png';
}

// Tool-call arguments arrive as a JSON string from external APIs; the app works with objects.
function parseArguments(raw) {
  if (raw && typeof raw === 'object') return raw;
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

module.exports = { forEachLine, responseError, imageMediaType, parseArguments };
