const express = require("express");
const { runQuery } = require("../db");
const { recordsToObjects, toPlain } = require("../serialize");

const router = express.Router();

// GET /api/packages?search=http&limit=20
// Simple name/description search, used to power the search box.
router.get("/", async (req, res, next) => {
  try {
    const search = (req.query.search || "").trim();
    const limit = neo4jInt(req.query.limit, 25);

    const cypher = search
      ? `MATCH (p:Package)
         WHERE toLower(p.name) CONTAINS toLower($search)
            OR toLower(p.description) CONTAINS toLower($search)
         RETURN p ORDER BY p.name LIMIT $limit`
      : `MATCH (p:Package) RETURN p ORDER BY p.downloadsPerWeek DESC LIMIT $limit`;

    const records = await runQuery(cypher, { search, limit });
    res.json(recordsToObjects(records).map((r) => r.p));
  } catch (err) {
    next(err);
  }
});

// GET /api/packages/:name — detail card: the package itself, its maintainers,
// publishing org, and direct (1-hop) dependencies + dependents.
router.get("/:name", async (req, res, next) => {
  try {
    const { name } = req.params;

    const cypher = `
      MATCH (p:Package {name: $name})
      OPTIONAL MATCH (org:Organization)-[:PUBLISHES]->(p)
      OPTIONAL MATCH (dev:Developer)-[:MAINTAINS]->(p)
      OPTIONAL MATCH (p)-[:DEPENDS_ON]->(direct:Package)
      OPTIONAL MATCH (dependent:Package)-[:DEPENDS_ON]->(p)
      RETURN p,
             org,
             collect(DISTINCT dev.name) AS maintainers,
             collect(DISTINCT direct.name) AS directDependencies,
             collect(DISTINCT dependent.name) AS directDependents
    `;

    const records = await runQuery(cypher, { name });
    if (records.length === 0 || records[0].get("p") === null) {
      return res.status(404).json({ error: `No package named "${name}" was found.` });
    }

    const row = recordsToObjects(records)[0];
    res.json({
      ...row.p,
      organization: row.org ? row.org.name : null,
      maintainers: row.maintainers.filter(Boolean),
      directDependencies: row.directDependencies.filter(Boolean),
      directDependents: row.directDependents.filter(Boolean),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/packages/:name/tree?direction=dependencies|dependents&depth=3
// The headline multi-hop traversal: walks the dependency graph outward (or the
// reverse, "who breaks if this breaks") up to `depth` hops and returns a
// node/edge list the frontend renders as a radial graph.
router.get("/:name/tree", async (req, res, next) => {
  try {
    const { name } = req.params;
    const direction = req.query.direction === "dependents" ? "dependents" : "dependencies";
    const depth = Math.min(Math.max(neo4jInt(req.query.depth, 2), 1), 4);

    // `root` is bound once by the first MATCH; the OPTIONAL MATCH below reuses
    // that same variable (no re-declared label/properties, which Cypher
    // disallows on an already-bound node) so both directions walk from the
    // exact node we already found.
    const pattern =
      direction === "dependencies"
        ? `(root)-[:DEPENDS_ON*1..${depth}]->(node:Package)`
        : `(node:Package)-[:DEPENDS_ON*1..${depth}]->(root)`;

    // We ask for the paths themselves so we can flatten every hop into a
    // deduplicated node list and an edge list with each edge's hop distance,
    // which is what the client-side radial layout needs.
    const cypher = `
      MATCH (root:Package {name: $name})
      OPTIONAL MATCH path = ${pattern}
      RETURN root, path
    `;

    const records = await runQuery(cypher, { name });
    if (records.length === 0) {
      return res.status(404).json({ error: `No package named "${name}" was found.` });
    }

    const rootNode = toPlain(records[0].get("root"));
    if (!rootNode) {
      return res.status(404).json({ error: `No package named "${name}" was found.` });
    }

    const nodesById = new Map();
    const edges = [];
    const edgeSeen = new Set();

    nodesById.set(rootNode.name, { ...rootNode, hop: 0 });

    for (const record of records) {
      const path = record.get("path");
      if (!path) continue;

      // Each segment's start/end always follow the real DEPENDS_ON direction
      // (the pattern's arrow is written the same way for both queries), so
      // start "depends on" end regardless of which direction we searched.
      // But root sits at a *different end* of the path depending on which
      // direction we searched: for "dependencies" root is segment 0's start
      // (hop 0 outward); for "dependents" root is the last segment's end
      // (hop 0 inward). Hop distance is measured from wherever root actually is.
      const pathLen = path.segments.length;

      path.segments.forEach((segment, i) => {
        const start = toPlain(segment.start);
        const end = toPlain(segment.end);
        const startHop = direction === "dependencies" ? i : pathLen - i;
        const endHop = direction === "dependencies" ? i + 1 : pathLen - i - 1;

        if (!nodesById.has(start.name) || nodesById.get(start.name).hop > startHop) {
          nodesById.set(start.name, { ...start, hop: startHop });
        }
        if (!nodesById.has(end.name) || nodesById.get(end.name).hop > endHop) {
          nodesById.set(end.name, { ...end, hop: endHop });
        }

        const edgeKey = `${start.name}->${end.name}`;
        if (!edgeSeen.has(edgeKey)) {
          edgeSeen.add(edgeKey);
          edges.push({ from: start.name, to: end.name });
        }
      });
    }

    res.json({
      root: rootNode.name,
      direction,
      depth,
      nodes: Array.from(nodesById.values()),
      edges,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/packages/:a/shared/:b — packages that both A and B transitively
// depend on. This is the kind of "common ancestor across two arbitrary-depth
// paths" query that turns into a multi-way recursive self-join in SQL and is
// a single pattern match here.
router.get("/:a/shared/:b", async (req, res, next) => {
  try {
    const { a, b } = req.params;
    const cypher = `
      MATCH (p1:Package {name: $a})-[:DEPENDS_ON*1..4]->(shared:Package)<-[:DEPENDS_ON*1..4]-(p2:Package {name: $b})
      WHERE p1 <> p2
      RETURN DISTINCT shared
      ORDER BY shared.name
      LIMIT 50
    `;
    const records = await runQuery(cypher, { a, b });
    res.json(recordsToObjects(records).map((r) => r.shared));
  } catch (err) {
    next(err);
  }
});

function neo4jInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = router;
