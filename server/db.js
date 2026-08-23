// db.js — connection to CognoDB via the official Neo4j driver.
// CognoDB speaks openCypher over Bolt, so the standard neo4j-driver works unmodified.

const neo4j = require("neo4j-driver");
require("dotenv").config();

const { COGNODB_URI, COGNODB_USER, COGNODB_PASSWORD } = process.env;

let driver = null;
let connectionError = null;

function getDriver() {
  if (driver) return driver;

  if (!COGNODB_URI || !COGNODB_USER || !COGNODB_PASSWORD) {
    connectionError =
      "Missing COGNODB_URI / COGNODB_USER / COGNODB_PASSWORD environment variables. " +
      "Copy .env.example to .env and fill in your CognoDB Cloud connection details.";
    return null;
  }

  try {
    driver = neo4j.driver(
      COGNODB_URI,
      neo4j.auth.basic(COGNODB_USER, COGNODB_PASSWORD),
      { maxConnectionPoolSize: 20 }
    );
  } catch (err) {
    connectionError = err.message;
    driver = null;
  }

  return driver;
}

// Runs a Cypher query with parameters, always via a fresh session, and always closes it.
// Throws a normalized error the route handlers can turn into a clean 503 instead of a stack trace.
async function runQuery(cypher, params = {}) {
  const d = getDriver();
  if (!d) {
    const err = new Error(connectionError || "Database driver not initialized.");
    err.isDbUnavailable = true;
    throw err;
  }

  const session = d.session();
  try {
    const result = await session.run(cypher, params);
    return result.records;
  } catch (err) {
    err.isDbUnavailable = true;
    throw err;
  } finally {
    await session.close();
  }
}

async function verifyConnectivity() {
  const d = getDriver();
  if (!d) {
    return { ok: false, error: connectionError };
  }
  try {
    await d.verifyConnectivity();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function closeDriver() {
  if (driver) {
    await driver.close();
    driver = null;
  }
}

module.exports = { runQuery, verifyConnectivity, closeDriver, neo4j };
