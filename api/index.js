// Vercel serverless entry point — the actual app lives in ../server.js so
// local dev (npm start) and this deployment share one codebase.
module.exports = require("../server.js");
