// Runs in a worker thread so a runaway expression can be killed on timeout without
// affecting the main server process. Uses mathjs's expression parser rather than
// arbitrary JavaScript — there is no safe way to sandbox full JS execution on a bare
// host (no containers/VMs here), but a restricted math/data expression language has no
// access to the filesystem, network, or Node internals by construction.
const { parentPort, workerData } = require('node:worker_threads');
const { create, all } = require('mathjs');

const math = create(all, {});

function formatValue(value) {
  return value === undefined ? '(no output)' : math.format(value, { precision: 14 });
}

try {
  const result = math.evaluate(workerData.code);
  let output;
  if (result && Array.isArray(result.entries)) {
    output = result.entries.map(formatValue).join('\n');
  } else if (Array.isArray(result)) {
    output = result.map(formatValue).join('\n');
  } else {
    output = formatValue(result);
  }
  parentPort.postMessage({ ok: true, output: output.slice(0, 4000) });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err.message || String(err) });
}
