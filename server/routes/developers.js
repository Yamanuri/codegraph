const express = require("express");
const { runQuery } = require("../db");
const { recordsToObjects } = require("../serialize");

const router = express.Router();

// GET /api/developers?search=ada
router.get("/", async (req, res, next) => {
  try {
    const search = (req.query.search || "").trim();
    const cypher = search
      ? `MATCH (d:Developer)
         WHERE toLower(d.name) CONTAINS toLower($search) OR toLower(d.username) CONTAINS toLower($search)
         RETURN d ORDER BY d.name LIMIT 25`
      : `MATCH (d:Developer) RETURN d ORDER BY d.name LIMIT 25`;
    const records = await runQuery(cypher, { search });
    res.json(recordsToObjects(records).map((r) => r.d));
  } catch (err) {
    next(err);
  }
});

// GET /api/developers/:name — profile, the packages they touch, their org,
// and a 2-hop "who else works on the packages I work on" collaborator list.
router.get("/:name", async (req, res, next) => {
  try {
    const { name } = req.params;

    const cypher = `
      MATCH (d:Developer {name: $name})
      OPTIONAL MATCH (d)-[r:MAINTAINS|CONTRIBUTES_TO]->(pkg:Package)
      OPTIONAL MATCH (d)-[:WORKS_AT]->(org:Organization)
      WITH d, org, collect(DISTINCT {name: pkg.name, relationship: type(r)}) AS packages
      OPTIONAL MATCH (d)-[:MAINTAINS|CONTRIBUTES_TO]->(:Package)<-[:MAINTAINS|CONTRIBUTES_TO]-(collab:Developer)
      WHERE collab <> d
      WITH d, org, packages, collab, count(*) AS sharedPackages
      ORDER BY sharedPackages DESC
      RETURN d, org, packages, collect(DISTINCT {name: collab.name, sharedPackages: sharedPackages})[0..8] AS collaborators
    `;

    const records = await runQuery(cypher, { name });
    if (records.length === 0 || records[0].get("d") === null) {
      return res.status(404).json({ error: `No developer named "${name}" was found.` });
    }

    const row = recordsToObjects(records)[0];
    res.json({
      ...row.d,
      organization: row.org ? row.org.name : null,
      packages: row.packages.filter((p) => p.name),
      collaborators: row.collaborators.filter((c) => c.name),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
