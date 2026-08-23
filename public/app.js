(() => {
  "use strict";

  // ---------------------------------------------------------------
  // API helper
  // ---------------------------------------------------------------
  async function api(path) {
    const res = await fetch(path);
    let body = null;
    try { body = await res.json(); } catch (_) { /* no body */ }
    if (!res.ok) {
      const err = new Error((body && body.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k === "html") node.innerHTML = v;
      else node.setAttribute(k, v);
    }
    for (const child of [].concat(children)) {
      if (child == null) continue;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }

  function loadingNode(text) {
    const tpl = document.getElementById("tpl-loading").content.cloneNode(true);
    tpl.querySelector("span").textContent = text;
    return tpl;
  }

  function errorNode(message) {
    return el("div", { class: "error-state" }, `Couldn't load that: ${message}`);
  }

  function fmtNumber(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1000) return (n / 1000).toFixed(0) + "k";
    return String(n);
  }

  // ---------------------------------------------------------------
  // Database health banner
  // ---------------------------------------------------------------
  async function checkHealth() {
    const banner = document.getElementById("db-banner");
    const text = document.getElementById("db-banner-text");
    try {
      const status = await api("/api/health");
      if (!status.ok) throw new Error(status.error || "unreachable");
      banner.hidden = true;
    } catch (err) {
      banner.hidden = false;
      text.textContent =
        "Can't reach CognoDB right now — check your .env connection details and that the instance is running.";
    }
  }

  // ---------------------------------------------------------------
  // Tab navigation
  // ---------------------------------------------------------------
  function setupTabs() {
    const tabs = document.querySelectorAll(".rail__tab");
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        tabs.forEach((t) => t.classList.remove("is-active"));
        tab.classList.add("is-active");
        document.querySelectorAll(".view").forEach((v) => v.classList.remove("is-active"));
        document.getElementById(`view-${tab.dataset.tab}`).classList.add("is-active");

        if (tab.dataset.tab === "risk" && !riskLoaded) loadRisk();
      });
    });
  }

  // ---------------------------------------------------------------
  // Generic "search box with suggestions" behavior
  // ---------------------------------------------------------------
  function setupSearch({ inputId, suggestionsId, endpoint, labelKey, descKey, onSelect }) {
    const input = document.getElementById(inputId);
    const box = document.getElementById(suggestionsId);

    const run = debounce(async (q) => {
      if (!q.trim()) { box.hidden = true; box.innerHTML = ""; return; }
      try {
        const results = await api(`${endpoint}?search=${encodeURIComponent(q)}`);
        box.innerHTML = "";
        if (results.length === 0) {
          box.appendChild(el("div", { class: "suggestion" }, el("span", { class: "suggestion__desc" }, "No matches")));
        } else {
          results.slice(0, 10).forEach((r) => {
            const row = el("div", { class: "suggestion" }, [
              el("span", { class: "suggestion__name" }, r[labelKey]),
              descKey ? el("span", { class: "suggestion__desc" }, r[descKey] || "") : null,
            ]);
            row.addEventListener("click", () => {
              input.value = r[labelKey];
              box.hidden = true;
              onSelect(r[labelKey]);
            });
            box.appendChild(row);
          });
        }
        box.hidden = false;
      } catch (err) {
        box.hidden = true;
      }
    }, 220);

    input.addEventListener("input", () => run(input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && input.value.trim()) {
        box.hidden = true;
        onSelect(input.value.trim());
      }
      if (e.key === "Escape") box.hidden = true;
    });
    document.addEventListener("click", (e) => {
      if (!box.contains(e.target) && e.target !== input) box.hidden = true;
    });
  }

  // ---------------------------------------------------------------
  // EXPLORER
  // ---------------------------------------------------------------
  let currentPackage = null;
  let currentDirection = "dependencies";
  let currentDepth = 2;

  async function selectPackage(name) {
    currentPackage = name;
    const empty = document.getElementById("explorer-empty");
    const content = document.getElementById("explorer-content");
    const detailBox = document.getElementById("explorer-detail");

    empty.hidden = true;
    content.hidden = false;
    detailBox.innerHTML = "";
    detailBox.appendChild(loadingNode(`Loading ${name}…`));

    try {
      const pkg = await api(`/api/packages/${encodeURIComponent(name)}`);
      renderDetail(pkg);
      await loadGraph();
    } catch (err) {
      detailBox.innerHTML = "";
      detailBox.appendChild(errorNode(err.message));
    }
  }

  function renderDetail(pkg) {
    const detailBox = document.getElementById("explorer-detail");
    detailBox.innerHTML = "";
    detailBox.appendChild(
      el("div", {}, [
        el("div", { class: "detail-card__top" }, [
          el("span", { class: "detail-card__name" }, pkg.name),
          el("span", { class: "detail-card__version" }, `v${pkg.version}`),
        ]),
        el("p", { class: "detail-card__desc" }, pkg.description),
        el("div", { class: "detail-card__meta" }, [
          el("span", {}, [el("strong", {}, fmtNumber(pkg.downloadsPerWeek)), " downloads/week"]),
          el("span", {}, [el("strong", {}, String(pkg.directDependencies.length)), " direct dependencies"]),
          el("span", {}, [el("strong", {}, String(pkg.directDependents.length)), " direct dependents"]),
          el("span", {}, [el("strong", {}, String(pkg.maintainers.length)), " maintainer(s)"]),
          el("span", { class: "tag" }, pkg.category),
          pkg.organization ? el("span", { class: "tag" }, pkg.organization) : null,
        ]),
      ])
    );
  }

  async function loadGraph() {
    if (!currentPackage) return;
    const canvas = document.getElementById("graph-canvas");
    const emptyMsg = document.getElementById("graph-empty");
    canvas.innerHTML = "";
    emptyMsg.hidden = true;
    canvas.appendChild(loadingNode("Tracing the graph…"));

    try {
      const data = await api(
        `/api/packages/${encodeURIComponent(currentPackage)}/tree?direction=${currentDirection}&depth=${currentDepth}`
      );
      canvas.innerHTML = "";
      if (data.nodes.length <= 1) {
        emptyMsg.hidden = false;
        emptyMsg.querySelector("p").textContent =
          currentDirection === "dependencies"
            ? "This package has no dependencies at this depth."
            : "Nothing in the ecosystem depends on this package.";
      } else {
        canvas.appendChild(renderRadialGraph(data));
      }
    } catch (err) {
      canvas.innerHTML = "";
      canvas.appendChild(errorNode(err.message));
    }
  }

  // Renders nodes/edges as a radial constellation: the root sits at the
  // center, and every hop of the traversal becomes a concentric ring —
  // the actual graph shape the query walked, drawn as a graph.
  function renderRadialGraph({ nodes, edges, direction }) {
    const W = 760, H = 520;
    const cx = W / 2, cy = H / 2;
    const maxHop = Math.max(1, ...nodes.map((n) => n.hop));
    const maxRadius = Math.min(W, H) / 2 - 60;

    const byHop = {};
    nodes.forEach((n) => { (byHop[n.hop] = byHop[n.hop] || []).push(n); });

    const positions = {};
    Object.entries(byHop).forEach(([hop, group]) => {
      hop = Number(hop);
      const r = hop === 0 ? 0 : (hop / maxHop) * maxRadius;
      group.sort((a, b) => a.name.localeCompare(b.name));
      group.forEach((node, i) => {
        const angle = (i / group.length) * Math.PI * 2 - Math.PI / 2;
        positions[node.name] = {
          x: cx + r * Math.cos(angle),
          y: cy + r * Math.sin(angle),
          node,
        };
      });
    });

    const accent = direction === "dependents" ? "#E8615A" : "#F2A93B";
    const accentDim = direction === "dependents" ? "#5C2E2C" : "#7A5B29";

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

    const edgeLayer = document.createElementNS(svgNS, "g");
    edges.forEach((edge) => {
      const a = positions[edge.from], b = positions[edge.to];
      if (!a || !b) return;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const path = document.createElementNS(svgNS, "path");
      path.setAttribute("class", "graph-edge");
      path.setAttribute("d", `M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`);
      edgeLayer.appendChild(path);
    });
    svg.appendChild(edgeLayer);

    const nodeLayer = document.createElementNS(svgNS, "g");
    Object.values(positions).forEach(({ x, y, node }) => {
      const g = document.createElementNS(svgNS, "g");
      g.setAttribute("class", "graph-node");
      g.setAttribute("transform", `translate(${x}, ${y})`);

      const radius = node.hop === 0 ? 15 : Math.max(5, 10 - node.hop);
      const circle = document.createElementNS(svgNS, "circle");
      circle.setAttribute("r", radius);
      circle.setAttribute("fill", node.hop === 0 ? accent : node.hop === 1 ? accent : accentDim);
      circle.setAttribute("stroke", node.hop === 0 ? "#fff" : "none");
      circle.setAttribute("stroke-width", "1.5");
      g.appendChild(circle);

      const label = document.createElementNS(svgNS, "text");
      label.setAttribute("text-anchor", x > cx ? "start" : x < cx ? "end" : "middle");
      label.setAttribute("x", x > cx ? radius + 6 : x < cx ? -(radius + 6) : 0);
      label.setAttribute("y", node.hop === 0 ? -(radius + 8) : 4);
      label.textContent = node.name;
      g.appendChild(label);

      g.addEventListener("click", () => {
        document.getElementById("explorer-search").value = node.name;
        selectPackage(node.name);
      });

      nodeLayer.appendChild(g);
    });
    svg.appendChild(nodeLayer);

    return svg;
  }

  function setupExplorer() {
    setupSearch({
      inputId: "explorer-search",
      suggestionsId: "explorer-suggestions",
      endpoint: "/api/packages",
      labelKey: "name",
      descKey: "description",
      onSelect: selectPackage,
    });

    document.getElementById("direction-toggle").addEventListener("click", (e) => {
      const btn = e.target.closest(".segmented__opt");
      if (!btn) return;
      document.querySelectorAll("#direction-toggle .segmented__opt").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      currentDirection = btn.dataset.direction;
      loadGraph();
    });

    const slider = document.getElementById("depth-slider");
    slider.addEventListener("input", () => {
      document.getElementById("depth-value").textContent = slider.value;
    });
    slider.addEventListener("change", () => {
      currentDepth = Number(slider.value);
      loadGraph();
    });
  }

  // ---------------------------------------------------------------
  // RISK RADAR
  // ---------------------------------------------------------------
  let riskLoaded = false;

  async function loadRisk() {
    const box = document.getElementById("risk-content");
    box.innerHTML = "";
    box.appendChild(loadingNode("Scanning the ecosystem for single points of failure…"));
    try {
      const rows = await api("/api/risk?limit=15");
      riskLoaded = true;
      box.innerHTML = "";
      if (rows.length === 0) {
        box.appendChild(el("div", { class: "empty-state" }, el("p", {}, "No risk data available yet.")));
        return;
      }
      const table = el("table", { class: "risk-table" });
      table.appendChild(
        el("thead", {}, el("tr", {}, [
          el("th", {}, "Package"),
          el("th", {}, "Category"),
          el("th", {}, "Blast radius (≤3 hops)"),
          el("th", {}, "Maintainers"),
          el("th", {}, "Risk"),
        ]))
      );
      const tbody = el("tbody");
      rows.forEach((r) => {
        const level = r.maintainerCount <= 1 && r.blastRadius >= 6 ? "high" : r.maintainerCount <= 1 || r.blastRadius >= 10 ? "med" : "low";
        const label = level === "high" ? "High risk" : level === "med" ? "Watch" : "Healthy";
        const tr = el("tr", {}, [
          el("td", { class: "pkg-name" }, r.name),
          el("td", {}, r.category),
          el("td", {}, String(r.blastRadius)),
          el("td", {}, String(r.maintainerCount)),
          el("td", {}, el("span", { class: `risk-badge risk-badge--${level}` }, label)),
        ]);
        tr.querySelector(".pkg-name").addEventListener("click", () => {
          document.querySelector('.rail__tab[data-tab="explorer"]').click();
          document.getElementById("explorer-search").value = r.name;
          selectPackage(r.name);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      box.appendChild(table);
    } catch (err) {
      box.innerHTML = "";
      box.appendChild(errorNode(err.message));
    }
  }

  // ---------------------------------------------------------------
  // COMPARE
  // ---------------------------------------------------------------
  function setupCompare() {
    // Compare uses plain text entry + button rather than dropdown suggestions,
    // to keep two simultaneous autocomplete boxes from fighting for space.
    document.getElementById("compare-run").addEventListener("click", runCompare);
    [document.getElementById("compare-a"), document.getElementById("compare-b")].forEach((input) => {
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") runCompare(); });
    });
  }

  async function runCompare() {
    const a = document.getElementById("compare-a").value.trim();
    const b = document.getElementById("compare-b").value.trim();
    const box = document.getElementById("compare-content");
    box.innerHTML = "";
    if (!a || !b) {
      box.appendChild(el("div", { class: "empty-state" }, el("p", {}, "Enter two package names to compare.")));
      return;
    }
    box.appendChild(loadingNode(`Finding what ${a} and ${b} have in common…`));
    try {
      const shared = await api(`/api/packages/${encodeURIComponent(a)}/shared/${encodeURIComponent(b)}`);
      box.innerHTML = "";
      if (shared.length === 0) {
        box.appendChild(
          el("div", { class: "empty-state" }, el("p", {}, `${a} and ${b} don't share any transitive dependencies (within 4 hops).`))
        );
        return;
      }
      box.appendChild(el("p", { style: "color:var(--muted); margin-bottom:14px;" }, `${shared.length} shared dependenc${shared.length === 1 ? "y" : "ies"}:`));
      const list = el("div", { class: "shared-list" });
      shared.forEach((pkg) => {
        const chip = el("span", { class: "shared-chip" }, pkg.name);
        chip.style.cursor = "pointer";
        chip.addEventListener("click", () => {
          document.querySelector('.rail__tab[data-tab="explorer"]').click();
          document.getElementById("explorer-search").value = pkg.name;
          selectPackage(pkg.name);
        });
        list.appendChild(chip);
      });
      box.appendChild(list);
    } catch (err) {
      box.innerHTML = "";
      box.appendChild(errorNode(err.message));
    }
  }

  // ---------------------------------------------------------------
  // DEVELOPERS
  // ---------------------------------------------------------------
  function setupDevelopers() {
    setupSearch({
      inputId: "dev-search",
      suggestionsId: "dev-suggestions",
      endpoint: "/api/developers",
      labelKey: "name",
      descKey: "bio",
      onSelect: selectDeveloper,
    });
  }

  async function selectDeveloper(name) {
    const box = document.getElementById("dev-content");
    box.innerHTML = "";
    box.appendChild(loadingNode(`Loading ${name}…`));
    try {
      const dev = await api(`/api/developers/${encodeURIComponent(name)}`);
      box.innerHTML = "";
      const card = el("div", { class: "dev-card" });
      card.appendChild(el("div", { class: "dev-card__name" }, dev.name));
      card.appendChild(el("div", { class: "dev-card__bio" }, [dev.bio, dev.organization ? ` · ${dev.organization}` : ""].join("")));

      card.appendChild(el("div", { class: "dev-section-title" }, `Works on (${dev.packages.length})`));
      const pkgRow = el("div", { class: "pill-row" });
      if (dev.packages.length === 0) pkgRow.appendChild(el("span", { style: "color:var(--muted); font-size:13px;" }, "Nothing on record."));
      dev.packages.forEach((p) => {
        const pill = el("span", { class: "pill pill--maintains" }, `${p.name} · ${p.relationship === "MAINTAINS" ? "maintainer" : "contributor"}`);
        pill.style.cursor = "pointer";
        pill.addEventListener("click", () => {
          document.querySelector('.rail__tab[data-tab="explorer"]').click();
          document.getElementById("explorer-search").value = p.name;
          selectPackage(p.name);
        });
        pkgRow.appendChild(pill);
      });
      card.appendChild(pkgRow);

      card.appendChild(el("div", { class: "dev-section-title" }, `Collaborators (share a package with)`));
      const collabRow = el("div", { class: "pill-row" });
      if (dev.collaborators.length === 0) collabRow.appendChild(el("span", { style: "color:var(--muted); font-size:13px;" }, "Works independently — no shared packages on record."));
      dev.collaborators.forEach((c) => {
        const pill = el("span", { class: "pill pill--collab" }, [c.name, el("span", { class: "pill-count" }, `×${c.sharedPackages}`)]);
        pill.style.cursor = "pointer";
        pill.addEventListener("click", () => {
          document.getElementById("dev-search").value = c.name;
          selectDeveloper(c.name);
        });
        collabRow.appendChild(pill);
      });
      card.appendChild(collabRow);

      box.appendChild(card);
    } catch (err) {
      box.innerHTML = "";
      box.appendChild(errorNode(err.message));
    }
  }

  // ---------------------------------------------------------------
  // init
  // ---------------------------------------------------------------
  document.addEventListener("DOMContentLoaded", () => {
    checkHealth();
    setupTabs();
    setupExplorer();
    setupCompare();
    setupDevelopers();
  });
})();
