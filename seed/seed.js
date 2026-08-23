// seed.js — loads seed/data.js into CognoDB.
//
// Run with: npm run seed
// Safe to re-run: constraints use MERGE, so re-seeding won't duplicate nodes.

require("dotenv").config();
const neo4j = require("neo4j-driver");
const {
  packages,
  dependsOn,
  organizations,
  developers,
  maintains,
  contributesTo,
  publishes,
  worksAt,
} = require("./data");

const { COGNODB_URI, COGNODB_USER, COGNODB_PASSWORD } = process.env;

if (!COGNODB_URI || !COGNODB_USER || !COGNODB_PASSWORD) {
  console.error(
    "Missing COGNODB_URI / COGNODB_USER / COGNODB_PASSWORD.\n" +
      "Copy .env.example to .env and fill in your CognoDB Cloud connection details first."
  );
  process.exit(1);
}

const driver = neo4j.driver(COGNODB_URI, neo4j.auth.basic(COGNODB_USER, COGNODB_PASSWORD));

async function run(session, label, cypher, params) {
  process.stdout.write(`  ${label}... `);
  const result = await session.run(cypher, params);
  console.log(`ok (${result.summary.counters.updates().nodesCreated || 0} nodes, ${result.summary.counters.updates().relationshipsCreated || 0} rels)`);
}

async function main() {
  console.log("Connecting to CognoDB...");
  await driver.verifyConnectivity();
  console.log("Connected.\n");

  const session = driver.session();
  try {
    console.log("Creating uniqueness constraints...");
    await session.run("CREATE CONSTRAINT package_name IF NOT EXISTS FOR (p:Package) REQUIRE p.name IS UNIQUE");
    await session.run("CREATE CONSTRAINT developer_name IF NOT EXISTS FOR (d:Developer) REQUIRE d.name IS UNIQUE");
    await session.run("CREATE CONSTRAINT org_name IF NOT EXISTS FOR (o:Organization) REQUIRE o.name IS UNIQUE");
    console.log("Done.\n");

    console.log("Loading nodes...");
    await run(
      session,
      "Package nodes",
      `UNWIND $rows AS row
       MERGE (p:Package {name: row.name})
       SET p += row`,
      { rows: packages }
    );
    await run(
      session,
      "Developer nodes",
      `UNWIND $rows AS row
       MERGE (d:Developer {name: row.name})
       SET d += row`,
      { rows: developers }
    );
    await run(
      session,
      "Organization nodes",
      `UNWIND $rows AS row
       MERGE (o:Organization {name: row.name})
       SET o += row`,
      { rows: organizations }
    );

    console.log("\nLoading relationships...");
    await run(
      session,
      "DEPENDS_ON",
      `UNWIND $rows AS row
       MATCH (a:Package {name: row[0]}), (b:Package {name: row[1]})
       MERGE (a)-[:DEPENDS_ON]->(b)`,
      { rows: dependsOn }
    );

    const maintainRows = Object.entries(maintains).flatMap(([pkg, devs]) =>
      devs.map((dev) => ({ dev, pkg }))
    );
    await run(
      session,
      "MAINTAINS",
      `UNWIND $rows AS row
       MATCH (d:Developer {name: row.dev}), (p:Package {name: row.pkg})
       MERGE (d)-[:MAINTAINS]->(p)`,
      { rows: maintainRows }
    );

    await run(
      session,
      "CONTRIBUTES_TO",
      `UNWIND $rows AS row
       MATCH (d:Developer {name: row[0]}), (p:Package {name: row[1]})
       MERGE (d)-[r:CONTRIBUTES_TO]->(p)
       SET r.commits = row[2]`,
      { rows: contributesTo }
    );

    await run(
      session,
      "PUBLISHES",
      `UNWIND $rows AS row
       MATCH (o:Organization {name: row[0]}), (p:Package {name: row[1]})
       MERGE (o)-[:PUBLISHES]->(p)`,
      { rows: publishes }
    );

    await run(
      session,
      "WORKS_AT",
      `UNWIND $rows AS row
       MATCH (d:Developer {name: row[0]}), (o:Organization {name: row[1]})
       MERGE (d)-[:WORKS_AT]->(o)`,
      { rows: worksAt }
    );

    console.log("\nSeed complete.");
    console.log(`  ${packages.length} packages, ${developers.length} developers, ${organizations.length} organizations`);
    console.log(`  ${dependsOn.length} DEPENDS_ON edges, ${maintainRows.length} MAINTAINS edges, ${contributesTo.length} CONTRIBUTES_TO edges`);
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch((err) => {
  console.error("\nSeed failed:", err.message);
  process.exit(1);
});
