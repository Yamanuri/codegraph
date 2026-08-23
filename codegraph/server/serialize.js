// serialize.js — converts neo4j-driver Node/Relationship/Integer objects into plain JSON
// so route handlers can res.json() results directly.

const neo4j = require("neo4j-driver");

function toPlain(value) {
  if (value === null || value === undefined) return value;

  if (neo4j.isInt(value)) {
    return value.toNumber();
  }

  if (Array.isArray(value)) {
    return value.map(toPlain);
  }

  // neo4j Node
  if (value && value.labels && value.properties) {
    return {
      _label: value.labels[0],
      ...toPlain(value.properties),
    };
  }

  // neo4j Relationship
  if (value && value.type && value.properties && value.start !== undefined) {
    return {
      _type: value.type,
      ...toPlain(value.properties),
    };
  }

  if (value instanceof Object && typeof value === "object" && !(value instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = toPlain(v);
    }
    return out;
  }

  return value;
}

// Turns an array of neo4j Records into an array of plain objects keyed by the RETURN aliases.
function recordsToObjects(records) {
  return records.map((record) => {
    const obj = {};
    record.keys.forEach((key) => {
      obj[key] = toPlain(record.get(key));
    });
    return obj;
  });
}

module.exports = { toPlain, recordsToObjects };
