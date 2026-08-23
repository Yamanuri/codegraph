require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");

const { verifyConnectivity } = require("./db");
const packagesRouter = require("./routes/packages");
const developersRouter = require("./routes/developers");
const riskRouter = require("./routes/risk");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Health check — also used by the frontend on load to show a clear
// "database unreachable" state instead of a wall of failed requests.
app.get("/api/health", async (req, res) => {
  const status = await verifyConnectivity();
  res.status(status.ok ? 200 : 503).json(status);
});

app.use("/api/packages", packagesRouter);
app.use("/api/developers", developersRouter);
app.use("/api/risk", riskRouter);

app.use(express.static(path.join(__dirname, "..", "public")));

// Centralized error handler — every route calls next(err) on failure instead
// of handling errors inline, so a database outage always turns into one
// consistent 503 response rather than an unhandled exception per route.
app.use((err, req, res, next) => {
  console.error(err);
  if (err.isDbUnavailable) {
    return res.status(503).json({
      error: "Could not reach the CognoDB database. Check your connection details and try again.",
      detail: err.message,
    });
  }
  res.status(500).json({ error: "Something went wrong.", detail: err.message });
});

app.listen(PORT, () => {
  console.log(`CodeGraph server listening on http://localhost:${PORT}`);
});
