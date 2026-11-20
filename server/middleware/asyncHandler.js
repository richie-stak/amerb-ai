// Express 4 does not catch rejected promises (or synchronous throws) from an async route handler — an
// unhandled rejection there crashes the whole Node process by default, taking every user down with it.
// Wrap every async handler in this so any error becomes a clean response.
//
// The error is forwarded to the API error handler rather than answered here: that handler keeps the
// message of a 4xx (a model that cannot chat, an invalid setting, a rejected upload) for the person who
// caused it, and turns anything else into a plain 500 while writing the details to the log. Answering
// with a bare 500 here is what made useful explanations reach the browser as "Something went wrong on
// the server." — the same problem reported for the provider form.
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      if (res.headersSent) {
        // A streaming response (SSE) may already be underway — nothing left to do but close it.
        console.error(`Unhandled error in ${req.method} ${req.originalUrl}:`, err);
        res.end();
        return;
      }
      next(err);
    });
  };
}

module.exports = asyncHandler;
