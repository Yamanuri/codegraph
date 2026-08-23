# CodeGraph — dependency risk & impact explorer

CodeGraph is a small web app for exploring an open-source package ecosystem as
what it actually is: a graph. Pick any package and see what it pulls in, what
depends on it, and — the headline feature — which packages are quietly
carrying the whole ecosystem on one maintainer's shoulders.

Built for the Wexa AI CognoDB take-home assignment.

> The seed ecosystem (`torque`, `wick-orm`, `tinyshim`, and friends) is a
> fictional but realistically-shaped set of packages, not real npm packages.
> Fictional data was used deliberately so the demo never states inaccurate
> facts about real projects or maintainers.

---

## Why a graph database?

A dependency ecosystem is a network, not a table. The questions worth asking
about it are all variable-depth traversals over relationships:

- *"What does this package pull in, transitively?"*
- *"If this package breaks, what else breaks — three hops out?"*
- *"Do these two packages share anything downstream?"*
- *"Which packages have a huge blast radius but only one maintainer?"*

In a relational schema, each of those needs a recursive CTE, and the last one
needs **two** — one recursive CTE for the transitive closure, joined against a
second aggregation for maintainer counts — before you can even filter. It gets
slower and uglier as the graph gets deeper, and every "one more hop" request
means rewriting the recursion.

In CognoDB, the same question is one Cypher pattern that reads like the
question itself:

```cypher
MATCH (dependent:Package)-[:DEPENDS_ON*1..3]->(target:Package)
```

Cost scales with the size of the traversal, not the size of the whole table,
and the model grows the same way an ecosystem does — a new relationship type
(say, `LICENSED_AS`) is a new pattern to match, not a new join and a schema
migration.

---

## The use case

**CodeGraph = a risk radar for package dependency graphs.**

Every package in the ecosystem is a node. Every "package A requires package B"
relationship is a `DEPENDS_ON` edge. Developers maintain and contribute to
packages; organizations publish them. From that graph, the app answers four
things a non-technical stakeholder (an eng manager, a security reviewer) would
actually want to know:

1. **Explorer** — what does this package depend on, and what depends on it?
   (multi-hop, either direction, adjustable depth)
2. **Risk Radar** — across the *whole* ecosystem, which packages have a large
   blast radius but few maintainers? (the bus-factor problem — think
   `left-pad`, for real)
3. **Compare** — do these two packages share anything downstream?
4. **Developers** — what does this person maintain, and who else works on the
   same packages? (a 2-hop "collaborator" query)

---

## Data model

<!-- screenshot: paste your own diagram export here, e.g. screenshots/data-model.png -->

```
 (Organization) --PUBLISHES--> (Package) <--DEPENDS_ON-- (Package)
                                    ^  ^
                        MAINTAINS  |  |  CONTRIBUTES_TO {commits}
                                    |  |
                              (Developer) --WORKS_AT--> (Organization)
```

**Nodes**

| Label          | Key properties                                                        |
|----------------|------------------------------------------------------------------------|
| `Package`      | `name` (unique), `version`, `description`, `category`, `downloadsPerWeek`, `license` |
| `Developer`    | `name` (unique), `username`, `bio`                                     |
| `Organization` | `name` (unique), `type`                                                |

**Relationships**

| Type              | Direction                     | Properties  | Meaning                          |
|-------------------|--------------------------------|-------------|-----------------------------------|
| `DEPENDS_ON`      | `(Package)->(Package)`         | —           | A requires B at runtime           |
| `MAINTAINS`       | `(Developer)->(Package)`       | —           | Has commit/release access         |
| `CONTRIBUTES_TO`  | `(Developer)->(Package)`       | `commits`   | Lighter-touch contributor         |
| `PUBLISHES`       | `(Organization)->(Package)`    | —           | Package is org-backed             |
| `WORKS_AT`        | `(Developer)->(Organization)`  | —           | Employment, for org context       |

The seed data (`seed/data.js`) loads **44 packages, 24 developers, 7
organizations**, ~62 `DEPENDS_ON` edges, plus `MAINTAINS`, `CONTRIBUTES_TO`,
`PUBLISHES`, and `WORKS_AT` edges. It's shaped so a handful of small utility
packages (`tinyshim`, `flicker-log`, `pact-types`) sit underneath a large
fraction of the ecosystem while being maintained by only one or two people —
on purpose, to make the Risk Radar view show something real.

---

## The main queries, explained

All queries are parameterized and run through the official `neo4j-driver` —
no string-concatenated Cypher anywhere in the codebase.

**1. Transitive dependency / dependent tree** (`GET /packages/:name/tree`) —
the multi-hop traversal at the core of the app. `depth` is clamped to 1–4 and
interpolated into the relationship's hop range (the only thing that can't be
a bind parameter in Cypher), never into a node or property value:

```cypher
MATCH (root:Package {name: $name})
OPTIONAL MATCH path = (root)-[:DEPENDS_ON*1..3]->(node:Package)
RETURN root, path
```
(reversed to `(node)-[:DEPENDS_ON*1..3]->(root)` for "who depends on this")

**2. Risk Radar — blast radius vs. bus factor** (`GET /risk`) — the query a
relational database would find genuinely awkward: a transitive closure,
aggregated, then joined against a *second* aggregation, in one traversal:

```cypher
MATCH (dep:Package)
OPTIONAL MATCH (dependent:Package)-[:DEPENDS_ON*1..3]->(dep)
WITH dep, count(DISTINCT dependent) AS blastRadius
OPTIONAL MATCH (m:Developer)-[:MAINTAINS]->(dep)
WITH dep, blastRadius, count(DISTINCT m) AS maintainerCount
WHERE blastRadius > 0
RETURN dep.name, blastRadius, maintainerCount
ORDER BY blastRadius DESC, maintainerCount ASC
```

**3. Shared transitive dependencies** (`GET /packages/:a/shared/:b`) — two
independent 4-hop walks meeting in the middle:

```cypher
MATCH (p1:Package {name: $a})-[:DEPENDS_ON*1..4]->(shared:Package)<-[:DEPENDS_ON*1..4]-(p2:Package {name: $b})
RETURN DISTINCT shared
```

**4. Developer collaborator network** (`GET /developers/:name`) — a 2-hop
"who else touches the same packages I do":

```cypher
MATCH (d:Developer {name: $name})-[:MAINTAINS|CONTRIBUTES_TO]->(:Package)<-[:MAINTAINS|CONTRIBUTES_TO]-(collab:Developer)
WHERE collab <> d
RETURN collab.name, count(*) AS sharedPackages
ORDER BY sharedPackages DESC
```

---

## Project structure

```
codegraph/
├── server/
│   ├── index.js          Express app, health check, error handling
│   ├── db.js              CognoDB connection (official neo4j-driver)
│   ├── serialize.js       Neo4j Node/Int → plain JSON
│   └── routes/
│       ├── packages.js    search, detail, dependency tree, shared deps
│       ├── developers.js  search, profile, collaborator network
│       └── risk.js        blast radius / bus factor query
├── seed/
│   ├── data.js             the ecosystem: packages, devs, orgs, edges
│   └── seed.js              loads data.js into CognoDB (idempotent, MERGE-based)
├── public/
│   ├── index.html
│   ├── styles.css
│   └── app.js              search, tab routing, radial graph renderer (SVG)
├── .env.example
└── package.json
```

## Engineering notes

- **Secrets**: connection URI, user, and password are read from environment
  variables only (`server/db.js`); `.env` is gitignored, `.env.example` shows
  the shape.
- **Error handling**: every route calls `next(err)` on failure. A single
  centralized handler in `server/index.js` turns a database outage into a
  clean `503` with a human-readable message — the frontend shows a banner
  ("Can't reach CognoDB…") instead of crashing or hanging, and every view has
  a distinct loading / empty / error state.
- **No ORM magic**: all Cypher is hand-written and parameterized, next to the
  route that uses it, so it's easy to read start to finish.

---

## Setup and run

### 1. Create a CognoDB Cloud instance

1. Sign up at [console.cognodb.com/signup](https://console.cognodb.com/signup) (no card required).
2. Create a free `c0` instance and pick a region — provisions in under a minute.
3. Copy the connection URI (`bolt+s://<instance-id>.databases.cognodb.cloud`)
   and the generated password for user `cognodb`. **The password is shown
   once** — save it now.

### 2. Configure the app

```bash
git clone <this-repo-url>
cd codegraph
cp .env.example .env
# edit .env and paste in COGNODB_URI / COGNODB_USER / COGNODB_PASSWORD
npm install
```

### 3. Seed the database

```bash
npm run seed
```

This creates uniqueness constraints and loads the full ecosystem. Safe to
re-run — everything is `MERGE`-based.

### 4. Run the app

```bash
npm start
```

Open **http://localhost:3000**. Try searching for `torque`, or open **Risk
Radar** straight away to see `tinyshim` and `flicker-log` — two packages
almost everything else quietly depends on, each maintained by one person.

---

## Screenshots

<!-- screenshot: Explorer view with the radial dependency graph -->
<!-- screenshot: Risk Radar table -->
<!-- screenshot: Compare view -->
<!-- screenshot: Developer profile with collaborators -->

## Demo

- Hosted app: `<add your deployed URL here>`
- Screen recording: `<add your recording link here>`
EOF
