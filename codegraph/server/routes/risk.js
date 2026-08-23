const express = require("express");
const { runQuery } = require("../db");
const { recordsToObjects } = require("../serialize");

const router = express.Router();

// GET /api/risk?limit=15
//
// The showcase query: for every package, count its transitive "blast radius"
// (how many packages would be affected if it broke, up to 3 hops upstream)
// and its maintainer count (bus factor). Packages with a large blast radius
// and one or zero maintainers are single points of failure.
//
// In a relational schema this needs a recursive CTE per package just to get
// the transitive closure, then a second aggregation joined back against a
// maintainer count — expensive and awkward at scale. Here it's one traversal.
router.get("/", async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 15, 1), 50);

    const cypher = `
      MATCH (dep:Package)
      OPTIONAL MATCH (dependent:Package)-[:DEPENDS_ON*1..3]->(dep)
      WITH dep, count(DISTINCT dependent) AS blastRadius
      OPTIONAL MATCH (m:Developer)-[:MAINTAINS]->(dep)
      WITH dep, blastRadius, count(DISTINCT m) AS maintainerCount
      WHERE blastRadius > 0
      RETURN dep.name AS name,
             dep.category AS category,
             blastRadius,
             maintainerCount
      ORDER BY blastRadius DESC, maintainerCount ASC
      LIMIT $limit
    `;

    const records = await runQuery(cypher, { limit });
    res.json(recordsToObjects(records));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
