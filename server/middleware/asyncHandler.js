// Express 4 does not catch rejected promises (or synchronous throws) from an async route
// handler — an unhandled rejection there crashes the whole Node process by default, taking
// every user down with it. Wrap every async handler in this so any unexpected error (a bad
// request body, a DB bind error, anything) turns into a clean error response instead.
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      console.error(`Unhandled error in ${req.method} ${req.originalUrl}:`, err);
      if (res.headersSent) {
        // A streaming response (SSE) may already be underway — nothing left to do but close it.
        res.end();
        return;
      }
      res.status(500).json({ error: 'Something went wrong on the server.' });
    });
  };
}

module.exports = asyncHandler;
