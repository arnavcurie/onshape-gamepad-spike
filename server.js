//----------------------------------------------------------------------------------------------------
// server.js — the whole backend for the integrated Onshape panel.
//
// It exists because two things were measured and neither has a browser-side
// workaround:
//
//   1. Onshape's token exchange REQUIRES client_secret (no PKCE), so a browser
//      cannot complete OAuth on its own.
//   2. The Onshape API sends no CORS headers — the preflight itself 401s — so a
//      browser cannot call it even while holding a valid token.
//
// So this process holds the secret, does the OAuth dance, and proxies the three
// calls the panel needs. It also SERVES the panel, which means the page and the
// API share an origin and the CORS problem disappears rather than being worked
// around.
//
// LAB SCOPE. Deliberately single-user: the access token lives in one module
// variable, so every visitor shares one Onshape login. That is fine for one
// person across their own machines and wrong for anyone else. Fixing it means
// real sessions, which is a store-readiness problem, not a today problem.
//
// Zero dependencies on purpose — Node 18+ has fetch and that is all this needs,
// so Render just runs `node server.js` with nothing to install or go stale.
//----------------------------------------------------------------------------------------------------

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8733;

const CLIENT_ID = process.env.ONSHAPE_CLIENT_ID || "";
const CLIENT_SECRET = process.env.ONSHAPE_CLIENT_SECRET || "";
const API = process.env.ONSHAPE_BASE_URL || "https://cad.onshape.com";
const OAUTH = process.env.ONSHAPE_OAUTH_URL || "https://oauth.onshape.com";
const API_VERSION = process.env.ONSHAPE_API_VERSION || "v12";
// Render sets RENDER_EXTERNAL_URL; locally you can override to test.
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`)
  .replace(/\/$/, "");
const REDIRECT_URI = `${PUBLIC_URL}/auth/callback`;

// ---- the single shared login (see LAB SCOPE above) -------------------------
let token = null;        // { access_token, refresh_token, expires_at }

// The mate-values arrays Onshape last gave us, kept so writes can round-trip
// them whole. Never build a mate-values body from scratch: round-tripping the
// server's own payload preserves fields this code does not model, and a Ball
// mate's *Previous bookkeeping is exactly such a field. Refreshed by
// Initialize; mutated in place by /api/drive. Same discipline as the CLI's
// live-mate-driver — one GET up front, then mutate and POST.
//
// Keyed by ELEMENT, because a sub-assembly's mates live in the sub-assembly's
// own element and must be posted back there, not to the parent.
let mateCache = null;    // { key, byEid: Map<eid, { list, label }> }

function authed() {
  return Boolean(token && token.access_token && Date.now() < token.expires_at - 30_000);
}

//----------------------------------------------------------------------------------------------------
// refresh
// Onshape access tokens are short-lived. Refresh transparently rather than
// making the user re-authorise mid-drive — a token expiring behind a live
// controller loop would look exactly like the arm going dead.
//----------------------------------------------------------------------------------------------------
async function refresh() {
  if (!token?.refresh_token) return false;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: token.refresh_token,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  const r = await fetch(`${OAUTH}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) { token = null; return false; }
  const j = await r.json();
  token = {
    access_token: j.access_token,
    refresh_token: j.refresh_token || token.refresh_token,
    expires_at: Date.now() + (j.expires_in ?? 3600) * 1000,
  };
  return true;
}

async function ensureToken() {
  if (authed()) return true;
  return refresh();
}

//----------------------------------------------------------------------------------------------------
// onshape
// One place that talks to Onshape, so the bearer token and the API version are
// not sprinkled through the handlers.
//----------------------------------------------------------------------------------------------------
async function onshape(path, init = {}) {
  if (!(await ensureToken())) { const e = new Error("not authorised"); e.status = 401; throw e; }
  const r = await fetch(`${API}/api/${API_VERSION}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      Accept: "application/json;charset=UTF-8; qs=0.09",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await r.text();
  if (!r.ok) {
    const e = new Error(`Onshape ${r.status}: ${text.slice(0, 400)}`);
    e.status = r.status;
    throw e;
  }
  return text ? JSON.parse(text) : null;
}

//----------------------------------------------------------------------------------------------------
// normalizeFeature
// Onshape returns feature JSON in two shapes depending on API version — an
// envelope { message: {...} } and a flat { btType: "BTMMate-64", ... }. Code
// that assumes one silently produces an empty mate list, which reads as
// "mate not found" and wastes an afternoon. Ported from the CLI's assembly.ts.
//----------------------------------------------------------------------------------------------------
function normalizeFeature(node) {
  const b = node?.message ?? node ?? {};
  return {
    featureId: b.featureId,
    name: b.name,
    featureType: b.featureType,
    parameters: (b.parameters ?? []).map((p) => {
      const pb = p?.message ?? p ?? {};
      return {
        parameterId: pb.parameterId ?? "",
        expression: pb.expression,
        value: pb.value,
      };
    }),
  };
}

//----------------------------------------------------------------------------------------------------
// limitsFor
// A mate only reports limits if the modeller enabled them, so "no limits" is
// the common case and must degrade gracefully rather than look like an error.
// Angle limits come back as expressions ("30 deg"); values are radians.
//----------------------------------------------------------------------------------------------------
const RAD = 180 / Math.PI;

function limitsFor(feature) {
  const get = (id) => feature.parameters.find((p) => p.parameterId === id);
  const enabled = get("limitsEnabled");
  if (enabled && enabled.value === false) return null;

  const pairs = [
    ["limitAngleMin", "limitAngleMax", "angle"],
    ["limitZMin", "limitZMax", "length"],
    ["limitAxialZMin", "limitAxialZMax", "length"],
  ];
  for (const [minId, maxId, kind] of pairs) {
    const lo = get(minId), hi = get(maxId);
    if (!lo && !hi) continue;
    const num = (p) => (typeof p?.value === "number" ? p.value : null);
    const loV = num(lo), hiV = num(hi);
    if (loV === null && hiV === null) continue;
    return kind === "angle"
      ? { kind, minDeg: loV === null ? null : loV * RAD, maxDeg: hiV === null ? null : hiV * RAD,
          text: `${(loV * RAD).toFixed(1)}° … ${(hiV * RAD).toFixed(1)}°` }
      : { kind, minMm: loV === null ? null : loV * 1000, maxMm: hiV === null ? null : hiV * 1000,
          text: `${(loV * 1000).toFixed(1)} … ${(hiV * 1000).toFixed(1)} mm` };
  }
  return null;
}

//----------------------------------------------------------------------------------------------------
// Drivable fields. Mate values are axis-named; there is no generic "value".
// Fields ending in "Previous" are Onshape bookkeeping for path-dependent
// orientation and are NOT drivable, though they must round-trip untouched.
//----------------------------------------------------------------------------------------------------
const SKIP = new Set(["jsonType", "mateName", "featureId", "ownerOccurrencePath"]);

function drivableFields(mv) {
  return Object.keys(mv).filter(
    (k) => !SKIP.has(k) && !k.endsWith("Previous") && typeof mv[k] === "number",
  );
}

// ---- routing ---------------------------------------------------------------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };

function json(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(s);
}

async function serveFile(res, name) {
  try {
    const buf = await readFile(join(HERE, name));
    res.writeHead(200, {
      "Content-Type": MIME[extname(name)] || "application/octet-stream",
      // The panel is iterated on constantly; a cached copy inside an iframe is
      // very hard to notice and wasted real time during the spike.
      "Cache-Control": "no-store",
    });
    res.end(buf);
  } catch {
    res.writeHead(404).end("not found");
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 5e6) reject(new Error("body too large")); });
    req.on("end", () => resolve(b));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, PUBLIC_URL);
  const p = url.pathname;

  try {
    // ---- panel ----
    // Also served for a path carrying the document context, because Onshape's
    // right panel substitutes {$documentId} etc into the ACTION URL and its own
    // documented example puts them in the path rather than the query string —
    // which the field appears to drop. The page parses them back out.
    //   /d/{did}/{w|v}/{wvmid}/e/{eid}
    if (req.method === "GET" && (p === "/" || p === "/index.html" || /^\/d\/[^/]+\/[wvm]\/[^/]+\/e\/[^/]+\/?$/.test(p))) {
      return serveFile(res, "index.html");
    }
    if (req.method === "GET" && p === "/spike.html") return serveFile(res, "spike.html");

    // ---- auth ----
    if (p === "/auth/status") {
      return json(res, 200, { authed: authed() || Boolean(token?.refresh_token), configured: Boolean(CLIENT_ID && CLIENT_SECRET), redirectUri: REDIRECT_URI });
    }

    if (p === "/auth/login") {
      if (!CLIENT_ID) return json(res, 500, { error: "ONSHAPE_CLIENT_ID is not set on the server" });
      const a = new URL(`${OAUTH}/oauth/authorize`);
      a.searchParams.set("response_type", "code");
      a.searchParams.set("client_id", CLIENT_ID);
      a.searchParams.set("redirect_uri", REDIRECT_URI);
      res.writeHead(302, { Location: a.toString() }).end();
      return;
    }

    if (p === "/auth/callback") {
      const code = url.searchParams.get("code");
      if (!code) { res.writeHead(400).end("no code"); return; }
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
      });
      const r = await fetch(`${OAUTH}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      const t = await r.text();
      if (!r.ok) { res.writeHead(500, { "Content-Type": "text/plain" }).end(`token exchange failed: ${t}`); return; }
      const j = JSON.parse(t);
      token = {
        access_token: j.access_token,
        refresh_token: j.refresh_token,
        expires_at: Date.now() + (j.expires_in ?? 3600) * 1000,
      };
      // Login runs in a popup, because Onshape's authorize page refuses to be
      // framed — navigating the panel's own iframe there would just go blank.
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
        `<!doctype html><meta charset="utf-8"><title>Connected</title>
         <body style="font:14px system-ui;padding:2rem;background:#0e1116;color:#e6ecf3">
         Connected to Onshape. You can close this window.
         <script>try{window.close()}catch(e){}</script></body>`);
      return;
    }

    if (p === "/auth/logout") { token = null; return json(res, 200, { ok: true }); }

    // ---- api ----
    // Initialize: verify the named mates exist and are drivable, and hand back
    // their limits. Verification uses matevalues (the definitive list of what
    // can actually be driven); limits come from the feature definition.
    if (req.method === "GET" && p === "/api/mates") {
      const did = url.searchParams.get("did");
      const wvm = url.searchParams.get("wvm") || "w";
      const wvmid = url.searchParams.get("wvmid");
      const eid = url.searchParams.get("eid");
      if (!did || !wvmid || !eid) return json(res, 400, { error: "did, wvmid and eid are required" });

      const base = `/assemblies/d/${did}/${wvm}/${wvmid}/e/${eid}`;
      const values = await onshape(`${base}/matevalues`);
      const byEid = new Map();
      byEid.set(eid, { list: values?.mateValues ?? [], label: null });

      // Sub-assemblies. Their mates are NOT returned by the parent's matevalues
      // call, so each has to be asked for its own — and written back to its own
      // element too. Only sub-assemblies living in this same document and
      // workspace can be driven: another document would need its own workspace,
      // which we do not have.
      const subs = [];
      try {
        const def = await onshape(`${base}?includeMateFeatures=false&includeMateConnectors=false`);
        const seen = new Set();
        for (const inst of def?.rootAssembly?.instances ?? []) {
          if (inst?.type !== "Assembly" || !inst?.elementId) continue;
          const sameDoc = !inst.documentId || inst.documentId === did;
          const keyName = `${inst.name}`;
          if (seen.has(keyName)) continue;
          seen.add(keyName);
          subs.push({ name: keyName, eid: inst.elementId, sameDoc });
        }
      } catch { /* no sub-assembly listing — top level still works */ }

      for (const s of subs) {
        if (!s.sameDoc) continue;
        try {
          const sv = await onshape(`/assemblies/d/${did}/${wvm}/${wvmid}/e/${s.eid}/matevalues`);
          byEid.set(s.eid, { list: sv?.mateValues ?? [], label: s.name });
        } catch { /* unreadable sub-assembly — skip rather than fail Initialize */ }
      }
      mateCache = { key: `${did}/${wvm}/${wvmid}/${eid}`, byEid };

      // Limits are a nice-to-have: if the features call fails (permissions, a
      // version rather than a workspace), still return the drivable list rather
      // than failing Initialize outright.
      let byId = new Map();
      try {
        const feats = await onshape(`${base}/features`);
        for (const node of feats?.features ?? []) {
          const f = normalizeFeature(node);
          if (f.featureId) byId.set(f.featureId, f);
        }
      } catch { /* limits unavailable — degrade, do not fail */ }

      // One flat list. Top-level mates keep their bare name; a sub-assembly's
      // are addressed "<sub-assembly>/<mate>" so the two can never collide.
      const mates = [];
      for (const [thisEid, entry] of byEid) {
        for (const mv of entry.list) {
          const fields = drivableFields(mv);
          const feat = entry.label ? null : byId.get(mv.featureId);
          const bare = String(mv.mateName ?? "");
          mates.push({
            mateName: entry.label ? `${entry.label}/${bare}` : bare,
            bareName: bare,
            parent: entry.label,
            eid: thisEid,
            featureId: mv.featureId,
            jsonType: mv.jsonType,
            fields,
            currentDeg: fields.length ? Number((mv[fields[0]] * RAD).toFixed(4)) : null,
            limits: feat ? limitsFor(feat) : null,
            // Occurrence-owned mates reached through the PARENT's list are a
            // different thing again, and are not drivable from here.
            viaOccurrence: Array.isArray(mv.ownerOccurrencePath) && mv.ownerOccurrencePath.length > 0,
          });
        }
      }
      return json(res, 200, {
        mates,
        subAssemblies: subs.map((s) => ({ name: s.name, drivable: s.sameDoc })),
      });
    }

    // Drive: the panel sends only what moved, as { mateName, valueSi }. The
    // whole array is round-tripped here from the cache Initialize populated, so
    // the browser never has to reassemble a payload it does not fully model.
    if (req.method === "POST" && p === "/api/drive") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const { did, wvm = "w", wvmid, eid, targets } = b;
      if (!did || !wvmid || !eid || !Array.isArray(targets)) {
        return json(res, 400, { error: "did, wvmid, eid and targets[] are required" });
      }
      // Writes need a workspace. Versions and microversions are immutable and
      // the API's error for it is opaque, so refuse early and say why.
      if (wvm !== "w") return json(res, 400, { error: "writes need a workspace (/w/), not a version" });

      const key = `${did}/${wvm}/${wvmid}/${eid}`;
      if (!mateCache || mateCache.key !== key) {
        return json(res, 409, { error: "not initialised for this element — press Initialize" });
      }

      // Group by element: a sub-assembly's mates must be posted back to the
      // sub-assembly's own element, not to the parent's.
      const touched = new Set();
      const applied = [];
      for (const t of targets) {
        const parent = t.mateName.includes("/") ? t.mateName.split("/")[0] : null;
        const bare = parent ? t.mateName.slice(parent.length + 1) : t.mateName;
        for (const [thisEid, entry] of mateCache.byEid) {
          if ((entry.label || null) !== parent) continue;
          const mv = entry.list.find((m) => String(m.mateName ?? "") === bare);
          if (!mv) continue;
          const field = drivableFields(mv)[0];
          if (!field) continue;
          mv[field] = t.valueSi;
          touched.add(thisEid);
          applied.push({ mateName: t.mateName, field, valueSi: t.valueSi });
          break;
        }
      }
      if (applied.length === 0) return json(res, 200, { ok: true, applied: [] });

      // One POST per element that actually changed — still one microversion per
      // element per flush, however many of its joints moved.
      for (const thisEid of touched) {
        await onshape(`/assemblies/d/${did}/w/${wvmid}/e/${thisEid}/matevalues`, {
          method: "POST",
          body: JSON.stringify({ mateValues: mateCache.byEid.get(thisEid).list }),
        });
      }
      return json(res, 200, { ok: true, applied, elements: touched.size });
    }

    res.writeHead(404).end("not found");
  } catch (err) {
    const status = err.status || 500;
    json(res, status, { error: String(err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`panel + proxy on ${PUBLIC_URL} (port ${PORT})`);
  console.log(`redirect URI: ${REDIRECT_URI}`);
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.log("WARNING: ONSHAPE_CLIENT_ID / ONSHAPE_CLIENT_SECRET are not set — /auth/login will fail.");
  }
});
