/* sykkelturer-app.js */
(function () {
  "use strict";

  // =========================
  // Guard: kjør kun på siden som har appen
  // =========================
  const app = document.getElementById("sykkelturer-app");
  if (!app) return;

  // =========================
  // Config fra siden (valgfri)
  // =========================
  const CFG =
    window.SYKKELTURER_APP_CONFIG && typeof window.SYKKELTURER_APP_CONFIG === "object"
      ? window.SYKKELTURER_APP_CONFIG
      : {};

  // ====== DATA ======
  const DATA_ROUTES_URL =
    CFG.DATA_ROUTES_URL || "https://cdn.jsdelivr.net/gh/sihoe/kartdata-public@main/routes503.json";
  const DATA_EXTRAS_URL =
    CFG.DATA_EXTRAS_URL ||
    "https://cdn.jsdelivr.net/gh/sihoe/kartdata-public@main/routes_extras_legacy_clean502.json";
  const DATA_TEXTS_URL =
    CFG.DATA_TEXTS_URL || "https://cdn.jsdelivr.net/gh/sihoe/kartdata-public@main/routes_texts_and_highlights502.json";

  const SYMBOLS_BASE = CFG.SYMBOLS_BASE || "https://cdn.jsdelivr.net/gh/sihoe/symbols@main/";
  const OSM_TILES = CFG.OSM_TILES || "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";

  const DIFF_COL = CFG.DIFF_COLORS || {
    enkel: "#4484A2",
    middels: "#D38262",
    krevende: "#37394E",
  };

  // =========================
  // DOM
  // =========================
  const $ = (id) => document.getElementById(id);

  const elBase = $("filterBase");
  const elType = $("filterType");
  const elDiff = $("filterDiff");
  const elReset = $("btnReset");
  const elCopy = $("btnCopy");
  const elCount = $("routeCount");
  const elStatus = $("statusLine");
  const elGrid = $("grid");
  const elList = $("routeList");

  if (!elBase || !elType || !elDiff || !elReset || !elCopy || !elCount || !elStatus || !elGrid || !elList) {
    console.error("[sykkelturer-app] Mangler nødvendige DOM-elementer. Sjekk HTML-shell.");
    return;
  }

  function resolveMapDivId() {
    const cfgId = String(CFG.MAP_DIV_ID || "").trim();
    if (cfgId && document.getElementById(cfgId)) return cfgId;

    // Finn første .st-map inne i appen
    const div = app.querySelector(".st-map");
    if (div) {
      if (!div.id) div.id = "sykkelturer-map";
      return div.id;
    }

    if (document.getElementById("sykkelturer-map")) return "sykkelturer-map";
    if (document.getElementById("map")) return "map";

    return "sykkelturer-map";
  }

  const MAP_DIV_ID = resolveMapDivId();

  // =========================
  // State
  // =========================
  let map = null;
  let routeLayerGroup = null;
  let midMarkerGroup = null;

  const routeDrawnById = new Map(); // id -> polyline
  const routeMidMarkerById = new Map(); // id -> marker
  let allRoutes = [];
  let currentFiltered = [];
  let activeRouteId = null;

  // Grid “vis kun valgt”
  let selectedOnlyRouteId = null;

  // Promises for å unngå dobbel init
  let dataPromise = null;
  let mapPromise = null;

  // =========================
  // Helpers
  // =========================
  function waitForLib(name, testFn, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function tick() {
        if (testFn()) return resolve();
        if (Date.now() - t0 > timeoutMs) return reject(new Error(`${name} not ready`));
        setTimeout(tick, 60);
      })();
    });
  }

  function getLang() {
    if (typeof Weglot !== "undefined" && Weglot.getCurrentLang) return Weglot.getCurrentLang();
    const l = (document.documentElement.lang || "no").toLowerCase();
    return ["no", "en", "de"].includes(l) ? l : "no";
  }

  function asText(v, lang) {
    if (typeof v === "string") return v.trim();
    if (v && typeof v === "object") {
      const pick = v[lang] || v.no || v.en || v.de;
      if (typeof pick === "string") return pick.trim();
    }
    return "";
  }

  function normalizeDifficulty(d) {
    const s = String(d || "").toLowerCase().trim();
    if (["enkel", "easy"].includes(s)) return "enkel";
    if (["middels", "medium", "moderate"].includes(s)) return "middels";
    if (["krevende", "hard", "difficult"].includes(s)) return "krevende";
    return s || "ukjent";
  }

  function normalizeRouteType(v) {
    const s = String(v || "").toLowerCase().trim();
    if (!s) return "";
    if (["loop", "roundtrip", "round_trip", "rundtur"].includes(s)) return "loop";
    if (["out_and_back", "outandback", "out-back", "outback", "frem_og_tilbake", "fremogtilbake"].includes(s))
      return "out_and_back";
    if (["point_to_point", "pointtopoint", "a_to_b", "atob", "one_way", "oneway", "en_vei", "envei"].includes(s))
      return "point_to_point";
    return s;
  }

  function typeLabel(type, lang) {
    const map = {
      loop: { no: "Rundtur", en: "Loop", de: "Rundtour" },
      out_and_back: { no: "Frem og tilbake", en: "Out & back", de: "Hin und zurück" },
      point_to_point: { no: "En vei", en: "Point to point", de: "Von A nach B" },
    };
    return (map[type] && (map[type][lang] || map[type].no)) || type;
  }

  function difficultyIconUrl(diff) {
    return `${SYMBOLS_BASE}symbols-biking-${diff}.svg`;
  }
  function symbolUrl(type) {
    return `${SYMBOLS_BASE}symbols-${type}.svg`;
  }
  function routeColorByDifficulty(diff) {
    return DIFF_COL[diff] || "#37394E";
  }

  function readQuery() {
    const p = new URLSearchParams(location.search);
    return { base: p.get("base") || "all", type: p.get("type") || "all", diff: p.get("diff") || "all" };
  }
  function writeQuery(f) {
    const url = new URL(location.href);
    url.searchParams.set("base", f.base);
    url.searchParams.set("type", f.type);
    url.searchParams.set("diff", f.diff);
    history.replaceState({}, "", url.toString());
  }

  function parseDurationToMinutes(s) {
    const str = String(s || "").toLowerCase();
    let h = 0,
      m = 0;
    const hm = str.match(/(\d+)\s*t/);
    if (hm) h = Number(hm[1]) || 0;
    const mm = str.match(/(\d+)\s*min/);
    if (mm) m = Number(mm[1]) || 0;
    return h * 60 + m;
  }
  function minutesToNo(mins) {
    const m = Math.max(0, Math.round(mins));
    const h = Math.floor(m / 60);
    const r = m % 60;
    if (h <= 0) return `${r} min`;
    if (r === 0) return `${h} t`;
    return `${h} t ${r} min`;
  }
  function durationMedian(extras) {
    const d = extras && extras.durationEstimate && extras.durationEstimate.display;
    if (!d) return "";
    const s = String(d).trim();
    const parts = s.split("–").map((x) => x.trim()).filter(Boolean);
    if (parts.length === 2) {
      const a = parseDurationToMinutes(parts[0]);
      const b = parseDurationToMinutes(parts[1]);
      if (a > 0 && b > 0) return minutesToNo((a + b) / 2);
    }
    return s;
  }

  function fmtNum(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return "—";
    return x.toLocaleString("nb-NO", { maximumFractionDigits: 1 });
  }

  function escapeHtml(s) {
    return String(s || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function surfaceParts(route) {
    const cat = (route && route.surface && route.surface.categoryKm) || {};
    const a = Number(cat.asphalt || 0);
    const g = Number(cat.gravel || 0);
    const t = Number(cat.trail || 0);
    const sum = a + g + t;
    if (sum <= 0) return null;
    return {
      aPct: Math.round((a / sum) * 100),
      gPct: Math.round((g / sum) * 100),
      tPct: Math.round((t / sum) * 100),
    };
  }

  function iconDistance() {
    return `<svg class="statIcon" viewBox="0 0 24 24" aria-hidden="true"><path fill="#422426" d="M7 7l-5 5 5 5v-3h10v3l5-5-5-5v3H7V7z"/></svg>`;
  }
  function iconClimb() {
    return `<svg class="statIcon" viewBox="0 0 24 24" aria-hidden="true"><path fill="#422426" d="M4 17h3.2l3.9-6 3 4.2 4.7-7.2 2.2 1.4-6.9 10.6-3-4.2-2.3 3.2H4z"/></svg>`;
  }
  function iconClock() {
    return `<svg class="statIcon" viewBox="0 0 24 24" aria-hidden="true"><path fill="#422426" d="M12 2a10 10 0 1 0 .001 20.001A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16z"/><path fill="#422426" d="M12 6h1.5v6.2l4 2.4-.8 1.3L12 13V6z"/></svg>`;
  }

  function getRouteText(route) {
    const lang = getLang();
    const t = route._text || {};
    const title = asText(t.title, lang) || route.nameNo || route.id;
    const desc = asText(t.description, lang) || "";
    return { title, desc };
  }

  // =========================
  // Data loading
  // =========================
  async function fetchJson(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return await res.json();
  }

  function normalizeRoutes(raw) {
    if (raw && raw.routes && typeof raw.routes === "object") return raw.routes;
    return raw;
  }
  function deriveBases(extras) {
    const b = extras && extras.bases;
    if (Array.isArray(b)) return b.filter(Boolean);
    if (typeof b === "string" && b.trim()) return [b.trim()];
    return [];
  }

  function merge(routesRaw, extrasRaw, textsRaw) {
    const routes = normalizeRoutes(routesRaw);
    const extras = normalizeRoutes(extrasRaw);
    const texts = normalizeRoutes(textsRaw);

    const merged = [];

    for (const [id, r] of Object.entries(routes || {})) {
      const ex = (extras && extras[id]) || {};
      const tx = (texts && texts[id]) || {};

      const diff = normalizeDifficulty(ex.difficultyLegacy || r.difficultyLegacy || r.difficulty);
      const gpx = r.gpx || r.gpxUrl || r.gpx_url || null;

      const nameNo =
        asText(r.name, "no") ||
        asText(r.title, "no") ||
        (typeof r.name === "string" ? r.name : "") ||
        id;

      const image = ex.imageUrl || r.imageUrl || r.image || "";
      const link = ex.articleUrl || r.pageUrl || r.link || r.url || "";

      const bases = deriveBases(ex);
      const routeType = normalizeRouteType(ex.routeShape || ex.routeType || r.routeType || "");

      const stats = r.stats || {};
      const distanceKm = Number(stats.distanceKm || 0);
      const climbHm = Number(stats.climbM || 0); // du viser hm i UI

      const duration = durationMedian(ex);

      merged.push({
        id,
        nameNo,
        gpx,
        difficulty: diff,
        bases,
        routeType,
        symbols: Array.isArray(ex.symbols) ? ex.symbols : Array.isArray(r.symbols) ? r.symbols : [],
        surface: r.surface || null,
        duration,
        image,
        link,
        sortOrder: Number(ex.sortOrder ?? r.sortOrder ?? 9999),
        _stats: { distanceKm, climbM: climbHm },
        _extras: ex,
        _text: tx,
      });
    }

    merged.sort((a, b) => a.sortOrder - b.sortOrder);
    return merged;
  }

  function ensureData() {
    if (dataPromise) return dataPromise;

    dataPromise = (async () => {
      const [r, ex, tx] = await Promise.all([
        fetchJson(DATA_ROUTES_URL),
        fetchJson(DATA_EXTRAS_URL),
        fetchJson(DATA_TEXTS_URL),
      ]);
      allRoutes = merge(r, ex, tx);
      return allRoutes;
    })();

    return dataPromise;
  }

  // =========================
  // Map init (robust)
  // =========================
  function addFullscreenControl() {
    const L = window.L;
    if (!L || !map) return;

    const Fs = L.Control.extend({
      options: { position: "topright" },
      onAdd: function () {
        const btn = L.DomUtil.create("button", "");
        btn.type = "button";
        btn.textContent = "Fullskjerm";
        btn.style.background = "#fff";
        btn.style.border = "1px solid rgba(66,36,38,0.25)";
        btn.style.borderRadius = "12px";
        btn.style.padding = "8px 10px";
        btn.style.cursor = "pointer";
        btn.style.font = "inherit";
        btn.style.color = "#422426";
        btn.style.boxShadow = "0 6px 16px rgba(0,0,0,0.10)";
        L.DomEvent.disableClickPropagation(btn);
        L.DomEvent.on(btn, "click", () => toggleFullscreen());
        return btn;
      },
    });

    map.addControl(new Fs());

    document.addEventListener("fullscreenchange", () => {
      setTimeout(() => {
        try {
          map.invalidateSize();
        } catch (e) {}
      }, 120);
    });
  }

  function toggleFullscreen() {
    const elem = document.getElementById("mapWrapper");
    if (!elem) return;

    if (!document.fullscreenElement) {
      if (elem.requestFullscreen) elem.requestFullscreen();
      else if (elem.webkitRequestFullscreen) elem.webkitRequestFullscreen();
    } else {
      if (document.exitFullscreen) document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    }
  }

  function initMap() {
    const L = window.L;
    const mapDiv = document.getElementById(MAP_DIV_ID);

    if (!L || !mapDiv) return false;

    // Unngå dobbel init
    if (map) return true;

    map = L.map(MAP_DIV_ID, {
      center: [60.1, 9.1],
      zoom: 8,
      scrollWheelZoom: true,
      preferCanvas: true,
    });

    L.tileLayer(OSM_TILES, { attribution: "© OpenStreetMap" }).addTo(map);

    routeLayerGroup = L.featureGroup().addTo(map);
    midMarkerGroup = L.layerGroup().addTo(map);

    addFullscreenControl();

    // zoom-follow liste
    map.on("moveend zoomend", () => updateVisibleList());

    // klikk på “tomt kart” = fjern valgt rute i grid
    map.on("click", () => {
      clearSelectedOnly();
    });

    // Squarespace: ofte trenger du et par invalidateSize
    setTimeout(() => {
      try {
        map.invalidateSize();
      } catch (e) {}
    }, 150);
    setTimeout(() => {
      try {
        map.invalidateSize();
      } catch (e) {}
    }, 600);

    return true;
  }

  function ensureMap() {
    if (mapPromise) return mapPromise;

    mapPromise = (async () => {
      // Vent på Leaflet + GPX-plugin
      await waitForLib("Leaflet", () => window.L && typeof window.L.map === "function");
      await waitForLib("leaflet-gpx", () => window.L && !!window.L.GPX);

      const ok = initMap();
      if (!ok) throw new Error("Map init failed (div missing or Leaflet missing)");
      return map;
    })();

    // Hvis det feiler: ikke dø hele appen – grid/list skal fortsatt fungere
    mapPromise.catch((err) => {
      console.error("[sykkelturer-app] Map failed:", err);
    });

    return mapPromise;
  }

  function clearMapRoutes() {
    if (!routeLayerGroup || !midMarkerGroup) return;
    routeLayerGroup.clearLayers();
    midMarkerGroup.clearLayers();
    routeDrawnById.clear();
    routeMidMarkerById.clear();
    activeRouteId = null;
  }

  function fitToVisible() {
    if (!map || !routeLayerGroup) return;
    try {
      const b = routeLayerGroup.getBounds();
      if (b && b.isValid()) map.fitBounds(b.pad(0.10));
    } catch (e) {}
  }

  function loadRouteToMap(route) {
    return new Promise((resolve) => {
      const L = window.L;
      if (!map || !L || !L.GPX || !routeLayerGroup || !midMarkerGroup) {
        resolve(false);
        return;
      }
      if (!route.gpx) {
        resolve(false);
        return;
      }

      const gpx = new L.GPX(route.gpx, {
        async: true,

        markers: { startIcon: null, endIcon: null },
        marker_options: { startIconUrl: null, endIconUrl: null },

        createMarker: () => null,
        createStartMarker: () => null,
        createEndMarker: () => null,
        createWaypoint: () => null,

        skipWaypoints: true,

        polyline_options: {
          color: routeColorByDifficulty(route.difficulty),
          weight: 5,
          opacity: 1,
          lineCap: "round",
          lineJoin: "round",
        },
      });

      gpx.on("loaded", (e) => {
        const layer = e.target;

        if (typeof layer.eachLayer === "function") {
          layer.eachLayer((child) => {
            if (!(child instanceof L.Polyline)) {
              try {
                layer.removeLayer(child);
              } catch (_) {}
            }
          });
        }

        routeLayerGroup.addLayer(layer);

        // finn polyline
        let poly = null;
        const layers = layer.getLayers && layer.getLayers() ? layer.getLayers() : [];
        for (const l of layers) {
          if (l && l.getLatLngs && typeof l.getLatLngs === "function") {
            const ll = l.getLatLngs();
            const flat = Array.isArray(ll && ll[0]) ? ll.flat() : ll;
            if (Array.isArray(flat) && flat.length > 2) {
              poly = l;
              break;
            }
          }
        }

        if (!poly) {
          resolve(false);
          updateVisibleList();
          return;
        }

        routeDrawnById.set(route.id, poly);

        // mid-marker
        let latlngs = poly.getLatLngs();
        if (Array.isArray(latlngs[0])) latlngs = latlngs.flat();
        const mid = latlngs[Math.floor(latlngs.length / 2)] || layer.getBounds().getCenter();

        const icon = L.icon({
          iconUrl: difficultyIconUrl(route.difficulty),
          iconSize: [32, 32],
          iconAnchor: [16, 32],
        });

        const mm = L.marker(mid, { icon }).addTo(midMarkerGroup);
        routeMidMarkerById.set(route.id, mm);

        mm.on("click", (ev) => {
          if (ev && ev.originalEvent && ev.originalEvent.stopPropagation) ev.originalEvent.stopPropagation();
          selectRoute(route.id);
        });

        poly.on("click", (ev) => {
          if (ev && ev.originalEvent && ev.originalEvent.stopPropagation) ev.originalEvent.stopPropagation();
          selectRoute(route.id);
        });

        poly.on("mouseover", () => {
          if (route.id !== activeRouteId) poly.setStyle({ weight: 8 });
        });
        poly.on("mouseout", () => {
          if (route.id !== activeRouteId) poly.setStyle({ weight: 5 });
        });

        resolve(true);
        updateVisibleList();
      });

      gpx.on("error", () => {
        resolve(false);
        updateVisibleList();
      });
    });
  }

  // =========================
  // UI (filters/list/grid)
  // =========================
  function buildFilters() {
    const lang = getLang();
    const q = readQuery();

    const baseSet = new Set();
    allRoutes.forEach((r) => (r.bases || []).forEach((b) => baseSet.add(b)));
    const bases = Array.from(baseSet).sort((a, b) => a.localeCompare(b, "nb"));
    elBase.innerHTML =
      `<option value="all">Base</option>` + bases.map((b) => `<option value="${b}">${b}</option>`).join("");
    elBase.value = q.base !== "all" && bases.includes(q.base) ? q.base : "all";

    const typeSet = new Set();
    allRoutes.forEach((r) => {
      if (r.routeType) typeSet.add(r.routeType);
    });
    const types = Array.from(typeSet).sort();
    elType.innerHTML =
      `<option value="all">Ruteform</option>` +
      types.map((t) => `<option value="${t}">${typeLabel(t, lang)}</option>`).join("");
    elType.value = q.type !== "all" && types.includes(q.type) ? q.type : "all";

    const diffs = ["enkel", "middels", "krevende"].filter((d) => allRoutes.some((r) => r.difficulty === d));
    const diffLabel = (d) => d.charAt(0).toUpperCase() + d.slice(1);
    elDiff.innerHTML =
      `<option value="all">Vanskelighetsgrad</option>` +
      diffs.map((d) => `<option value="${d}">${diffLabel(d)}</option>`).join("");
    elDiff.value = q.diff !== "all" && diffs.includes(q.diff) ? q.diff : "all";
  }

  function getActiveFilters() {
    return { base: elBase.value || "all", type: elType.value || "all", diff: elDiff.value || "all" };
  }

  function renderList(routes) {
    elList.innerHTML = "";
    routes.forEach((r) => {
      const { title } = getRouteText(r);

      const li = document.createElement("li");
      li.dataset.routeId = r.id;

      const img = document.createElement("img");
      img.src = difficultyIconUrl(r.difficulty);
      img.alt = r.difficulty;

      const name = document.createElement("div");
      name.textContent = title;

      li.appendChild(img);
      li.appendChild(name);

      li.addEventListener("click", () => selectRoute(r.id));
      li.addEventListener("mouseover", () => highlightRoute(r.id, true));
      li.addEventListener("mouseout", () => highlightRoute(r.id, false));

      li.classList.toggle("active", r.id === activeRouteId);
      elList.appendChild(li);
    });
  }

  function updateVisibleList() {
    if (!map) {
      renderList(currentFiltered);
      return;
    }

    const mapBounds = map.getBounds();
    const visible = currentFiltered.filter((r) => {
      const poly = routeDrawnById.get(r.id);
      if (!poly || !poly.getBounds) return true;
      const b = poly.getBounds();
      if (!b) return true;
      return mapBounds.intersects(b);
    });

    renderList(visible);
  }

  function highlightRoute(routeId, on) {
    const poly = routeDrawnById.get(routeId);
    if (!poly) return;
    if (routeId === activeRouteId) return;

    poly.setStyle({ weight: on ? 8 : 5 });
    if (on && poly.bringToFront) poly.bringToFront();
  }

  function setSelectedOnly(routeId) {
    selectedOnlyRouteId = routeId || null;
    renderGridAccordingToSelection();
  }

  function clearSelectedOnly() {
    if (!selectedOnlyRouteId) return;
    selectedOnlyRouteId = null;
    renderGridAccordingToSelection();
  }

  function renderGridAccordingToSelection() {
    let listForGrid = currentFiltered;

    if (selectedOnlyRouteId) {
      const hit = currentFiltered.find((r) => r.id === selectedOnlyRouteId);
      if (hit) listForGrid = [hit];
      else selectedOnlyRouteId = null;
    }

    renderCards(listForGrid);
    elCount.textContent = String(listForGrid.length);
    elStatus.textContent = `${listForGrid.length} sykkelturer`;
  }

  function selectRoute(routeId) {
    const route = allRoutes.find((r) => r.id === routeId);
    if (!route) return;

    activeRouteId = routeId;

    for (const [id, poly] of routeDrawnById.entries()) {
      if (!poly) continue;
      poly.setStyle({ weight: id === routeId ? 8 : 5 });
    }

    updateVisibleList();

    const poly = routeDrawnById.get(routeId);
    if (map && poly && poly.getBounds) {
      map.fitBounds(poly.getBounds(), { padding: [80, 80] });
    }

    setSelectedOnly(routeId);
  }

  function cardHtml(r) {
    const { title, desc } = getRouteText(r);

    const safeTitle = title || r.nameNo || r.id;
    const descSafe = desc ? escapeHtml(desc).replace(/\n/g, "<br>") : "";
    const descHtml = descSafe
      ? `<div class="desc">${descSafe}</div>`
      : `<div class="desc" style="opacity:.7;font-style:italic">Mangler beskrivelse</div>`;

    const img = r.image || "";
    const url = r.link || "#";
    const stats = r._stats || {};
    const durText = r.duration || "";

    const sp = surfaceParts(r);
    const aPct = sp ? sp.aPct : 0;
    const gPct = sp ? sp.gPct : 0;
    const tPct = sp ? sp.tPct : 0;

    const symbols = Array.isArray(r.symbols) ? r.symbols : [];
    const symbolsHtml = symbols.map((s) => `<img loading="lazy" alt="" src="${symbolUrl(s)}">`).join("");

    return `
      <article class="card">
        <div class="img" style="background-image:url('${img}')"></div>

        <div class="body">
          <div>
            <div class="titleRow">
              <h3>${safeTitle}</h3>
              <img class="diffIcon" alt="" src="${difficultyIconUrl(r.difficulty)}">
            </div>

            <div class="statsRow" aria-label="Nøkkeltall">
              <span class="stat">${iconDistance()} ${fmtNum(stats.distanceKm)} km</span>
              <span class="stat">${iconClimb()} ${fmtNum(stats.climbM)} hm</span>
              ${durText ? `<span class="stat">${iconClock()} ${durText}</span>` : ``}
            </div>
          </div>

          ${descHtml}

          <div class="spacer"></div>

          <div>
            <div class="surfacebar" title="Underlag: asfalt / grus / sti">
              <div class="seg asphalt" style="width:${aPct}%"></div>
              <div class="seg gravel"  style="width:${gPct}%"></div>
              <div class="seg trail"   style="width:${tPct}%"></div>
            </div>

            <div class="surfaceLegend" aria-label="Underlag med prosent">
              <span><i class="dot asphalt"></i>Asfalt ${aPct}%</span>
              <span><i class="dot gravel"></i>Grus ${gPct}%</span>
              <span><i class="dot trail"></i>Sti ${tPct}%</span>
            </div>

            ${symbolsHtml ? `<div class="symbols" aria-label="Tilbud underveis">${symbolsHtml}</div>` : ``}

            ${url && url !== "#"
              ? `<div class="actionsRow"><a href="${url}" target="_blank" rel="noopener noreferrer">Les mer</a></div>`
              : ``}
          </div>
        </div>
      </article>
    `;
  }

  function renderCards(routes) {
    elGrid.innerHTML = routes.map(cardHtml).join("");
  }

  async function renderMap(routes) {
    if (!map || !routeLayerGroup || !midMarkerGroup) return;

    clearMapRoutes();

    for (const r of routes) {
      // eslint-disable-next-line no-await-in-loop
      await loadRouteToMap(r);
    }

    fitToVisible();
    updateVisibleList();
  }

  function applyFilters() {
    const f = getActiveFilters();
    writeQuery(f);

    const filtered = allRoutes.filter((r) => {
      if (f.base !== "all" && !(r.bases || []).includes(f.base)) return false;
      if (f.type !== "all" && r.routeType !== f.type) return false;
      if (f.diff !== "all" && r.difficulty !== f.diff) return false;
      return true;
    });

    currentFiltered = filtered;

    if (selectedOnlyRouteId && !currentFiltered.some((r) => r.id === selectedOnlyRouteId)) {
      selectedOnlyRouteId = null;
    }

    renderGridAccordingToSelection();

    // Tegn kart hvis kart er klart, ellers render når mapPromise løser seg
    renderMap(filtered);
    updateVisibleList();
  }

  // =========================
  // Boot
  // =========================
  async function boot() {
    try {
      elStatus.textContent = "Laster sykkelturer…";

      // Start begge parallelt (data først gir UI, kart kommer når libs er klare)
      const dataP = ensureData();
      const mapP = ensureMap();

      await dataP;

      buildFilters();
      applyFilters();

      // Når kartet endelig er klart: tegn for nåværende filter
      mapP
        .then(() => {
          renderMap(currentFiltered);
          updateVisibleList();
        })
        .catch(() => {
          // map-feil håndteres allerede i ensureMap()
        });
    } catch (err) {
      console.error("[sykkelturer-app] boot failed:", err);
      elStatus.textContent = "Feil ved lasting (se Console).";
    }
  }

  // Events
  elBase.addEventListener("change", applyFilters);
  elType.addEventListener("change", applyFilters);
  elDiff.addEventListener("change", applyFilters);

  elReset.addEventListener("click", () => {
    elBase.value = "all";
    elType.value = "all";
    elDiff.value = "all";
    selectedOnlyRouteId = null;
    activeRouteId = null;
    applyFilters();
  });

  elCopy.addEventListener("click", async () => {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      elCopy.textContent = "Kopiert";
      setTimeout(() => (elCopy.textContent = "Kopier lenke"), 900);
    } catch (e) {
      prompt("Kopier lenken:", url);
    }
  });

  if (typeof Weglot !== "undefined" && Weglot.on) {
    Weglot.on("languageChanged", () => {
      buildFilters();
      applyFilters();
      renderMap(currentFiltered);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
