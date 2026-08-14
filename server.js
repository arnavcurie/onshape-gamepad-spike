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
// One array, the PARENT's — nested mates included, tagged with the occurrence
// they belong to. See /api/mates for why the sub-assembly's own element is
// never written.
let mateCache = null;    // { key, list, nameById }

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

// Limit parameters are named per AXIS, and which pair applies is determined by
// the mate's drivable field — not guessable. Read off a real revolute:
//
//   limitsEnabled   value=true
//   limitAxialZMin  expr="0 deg"     <- the angular limits
//   limitAxialZMax  expr="60 deg"
//   limitZMin/Max   expr="0 in"      <- a LENGTH on the same mate
//
// Two traps here. There is no limitAngleMin/Max, and limitZMin/Max looks like a
// match for rotationZ but is a translation limit — pairing by axis letter alone
// would report a joint's travel in millimetres as its angle. And these carry an
// `expression` string, not a numeric `value`, so reading .value finds nothing
// and quietly reports "unlimited".
const LIMIT_PARAM = {
  rotationX: ["limitAxialXMin", "limitAxialXMax", "angle"],
  rotationY: ["limitAxialYMin", "limitAxialYMax", "angle"],
  rotationZ: ["limitAxialZMin", "limitAxialZMax", "angle"],
  translationX: ["limitXMin", "limitXMax", "length"],
  translationY: ["limitYMin", "limitYMax", "length"],
  translationZ: ["limitZMin", "limitZMax", "length"],
};

const ANGLE_TO_RAD = { deg: Math.PI / 180, degree: Math.PI / 180, rad: 1, radian: 1 };
const LENGTH_TO_M = { m: 1, meter: 1, metre: 1, cm: 0.01, mm: 0.001, in: 0.0254, ft: 0.3048 };

// "60 deg" / "0.25 in" -> SI. Onshape evaluates these itself, so anything more
// exotic than a number and a unit is left alone rather than half-parsed.
function parseQuantity(text) {
  if (typeof text !== "string") return null;
  const m = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/);
  if (!m) return null;
  const n = Number(m[1]);
  const u = m[2].toLowerCase();
  if (!u) return n;
  if (u in ANGLE_TO_RAD) return n * ANGLE_TO_RAD[u];
  if (u in LENGTH_TO_M) return n * LENGTH_TO_M[u];
  return null;
}

function limitsFor(feature, field) {
  if (!feature || !field) return null;
  const get = (id) => feature.parameters.find((p) => p.parameterId === id);
  const enabled = get("limitsEnabled");
  if (!enabled || enabled.value !== true) return null;   // limits are opt-in per mate

  const spec = LIMIT_PARAM[field];
  if (!spec) return null;
  const [minId, maxId, kind] = spec;
  // EXPRESSION FIRST. Measured on a real limited revolute:
  //
  //   limitAxialZMax   value=0   expression="60 deg"
  //
  // `value` is present, numeric, and wrong — a stale 0 — while the expression
  // carries the truth. Preferring `value` because it is "already a number"
  // yields 0…0, which reads as an unset pair and reports "unlimited". Feature
  // parameters are unit-bearing strings that Onshape evaluates; the expression
  // is the authority.
  const si = (p) => {
    const fromExpr = parseQuantity(p?.expression);
    if (fromExpr !== null && fromExpr !== undefined) return fromExpr;
    return typeof p?.value === "number" ? p.value : null;
  };
  const lo = si(get(minId)), hi = si(get(maxId));
  if (lo === null || hi === null || lo === undefined || hi === undefined) return null;
  if (lo === 0 && hi === 0) return null;                 // an unset pair, not a zero-width joint

  return kind === "angle"
    ? { kind, minDeg: lo * RAD, maxDeg: hi * RAD,
        text: `${(lo * RAD).toFixed(1)}° … ${(hi * RAD).toFixed(1)}°` }
    : { kind, minMm: lo * 1000, maxMm: hi * 1000,
        text: `${(lo * 1000).toFixed(1)} … ${(hi * 1000).toFixed(1)} mm` };
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
      const list = values?.mateValues ?? [];

      // Sub-assembly mates come back in the PARENT's list, tagged with the
      // occurrence they belong to. MEASURED, and it overturned the obvious
      // approach: a mate has TWO independent values — the one in the
      // sub-assembly's own element (the definition) and the one here (this
      // occurrence inside this assembly). The parent's geometry follows the
      // OCCURRENCE value. Writing the definition succeeds, reads back happily,
      // and moves nothing in the parent.
      //
      //   parent   Revolute_Grip owner=[MP1rJ5...]  34.6101 -> 41.6101  writable
      //   sub-asm  Revolute_Grip (own element)      60.3855  unchanged
      //
      // So everything is driven through the parent's element, and the
      // sub-assembly's own element is never written.
      //
      // Occurrence entries also only appear while the joint is actually
      // actuatable — when the grip's loop was closed they vanished from this
      // list entirely. So presence here is itself a signal that it can be driven.
      const nameById = new Map();
      const subs = [];
      let subError = null;
      try {
        const def = await onshape(`${base}?includeMateFeatures=false&includeMateConnectors=false`);
        for (const inst of def?.rootAssembly?.instances ?? []) {
          if (!inst?.id) continue;
          nameById.set(inst.id, String(inst.name ?? inst.id));
          if (inst.type === "Assembly") {
            subs.push({ id: inst.id, name: String(inst.name ?? inst.id) });
          }
        }
      } catch (e) {
        // Without the instance list the occurrence ids cannot be turned into
        // readable names. Say so rather than silently addressing by raw id.
        subError = String(e.message || e);
      }

      // An occurrence path is a chain of instance ids; render it with the names
      // the CAD tree shows, keeping the occurrence suffix because that is the
      // instance's identity.
      const prefixOf = (mv) => {
        const p = Array.isArray(mv.ownerOccurrencePath) ? mv.ownerOccurrencePath : [];
        if (!p.length) return null;
        return p.map((id) => nameById.get(id) ?? id).join("/");
      };

      mateCache = { key: `${did}/${wvm}/${wvmid}/${eid}`, list, nameById };

      // Limits are a nice-to-have: if the features call fails (permissions, a
      // version rather than a workspace), still return the drivable list rather
      // than failing Initialize outright.
      // Features come from the parent AND from every sub-assembly element. A
      // nested mate's featureId is the same in both places (verified), so one
      // flat featureId -> feature map serves everything. Without the
      // sub-assembly pass, every nested mate reports "unlimited" no matter what
      // limits it has — which is exactly what it used to do.
      let byId = new Map();
      const featureElements = [eid, ...new Set(
        (subs ?? []).map((sub) => sub.eid).filter(Boolean),
      )];
      for (const fe of featureElements) {
        try {
          const feats = await onshape(`/assemblies/d/${did}/${wvm}/${wvmid}/e/${fe}/features`);
          for (const node of feats?.features ?? []) {
            const f = normalizeFeature(node);
            if (f.featureId) byId.set(f.featureId, f);
          }
        } catch { /* limits unavailable for this element — degrade, do not fail */ }
      }

      // One flat list, all of it from the PARENT's element. Top-level mates
      // keep their bare name; occurrence-owned ones are prefixed with the
      // instance path, e.g. "Armatron_Grip <1>/Revolute_Grip".
      const mates = [];
      const perSub = new Map();
      for (const mv of list) {
        const fields = drivableFields(mv);
        const prefix = prefixOf(mv);
        const bare = String(mv.mateName ?? "");
        if (prefix) perSub.set(prefix, (perSub.get(prefix) ?? 0) + 1);
        mates.push({
          mateName: prefix ? `${prefix}/${bare}` : bare,
          bareName: bare,
          parent: prefix,
          occurrencePath: Array.isArray(mv.ownerOccurrencePath) ? mv.ownerOccurrencePath : [],
          featureId: mv.featureId,
          jsonType: mv.jsonType,
          fields,
          currentDeg: fields.length ? Number((mv[fields[0]] * RAD).toFixed(4)) : null,
          // Limits come from the parent's feature list, which only describes the
          // parent's own mates. A nested one simply has none to report.
          limits: limitsFor(byId.get(mv.featureId), fields[0]),
        });
      }
      return json(res, 200, {
        mates,
        subAssemblies: subs.map((s) => ({
          name: s.name,
          drivable: perSub.has(s.name),
          mateCount: perSub.get(s.name) ?? 0,
        })),
        subError,
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

      // Everything is driven through the PARENT's element, including nested
      // mates — measured: the occurrence entry here is what the assembly's
      // geometry follows, while the sub-assembly's own element holds a separate
      // definition value that moves nothing in the parent.
      //
      // The name carries the occurrence path, so match on both the bare mate
      // name AND the path. Two occurrences of one sub-assembly have distinct
      // paths and are therefore independently drivable from here — unlike the
      // definition, which they share.
      const norm = (x) => String(x ?? "").replace(/\s*<\d+>\s*(?=\/|$)/g, "").trim();
      const applied = [];
      for (const t of targets) {
        const slash = t.mateName.lastIndexOf("/");
        const prefix = slash >= 0 ? t.mateName.slice(0, slash) : null;
        const bare = slash >= 0 ? t.mateName.slice(slash + 1) : t.mateName;

        const pathOf = (mv) => {
          const pp = Array.isArray(mv.ownerOccurrencePath) ? mv.ownerOccurrencePath : [];
          return pp.length ? pp.map((id) => mateCache.nameById.get(id) ?? id).join("/") : null;
        };
        let mv = mateCache.list.find(
          (m) => String(m.mateName ?? "") === bare && pathOf(m) === prefix,
        );
        // Occurrence suffix optional, but only when it is unambiguous.
        if (!mv) {
          const hits = mateCache.list.filter(
            (m) => String(m.mateName ?? "") === bare && norm(pathOf(m)) === norm(prefix),
          );
          if (hits.length === 1) mv = hits[0];
        }
        if (!mv) continue;
        const field = drivableFields(mv)[0];
        if (!field) continue;
        mv[field] = t.valueSi;
        applied.push({ mateName: t.mateName, field, valueSi: t.valueSi });
      }
      if (applied.length === 0) return json(res, 200, { ok: true, applied: [] });

      // One POST for everything, nested or not — one microversion per flush
      // however many joints moved.
      await onshape(`/assemblies/d/${did}/w/${wvmid}/e/${eid}/matevalues`, {
        method: "POST",
        body: JSON.stringify({ mateValues: mateCache.list }),
      });
      return json(res, 200, { ok: true, applied });
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
