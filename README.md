# Onshape Xbox Controller — right panel app

Drive an Onshape assembly's mates from a game controller, inside Onshape.

**Lab experiment.** Single user: the OAuth token lives in one server variable,
so everyone shares one login. Fine for one person across their own machines.

## Why there is a server at all

Two things were measured, and neither has a browser-side workaround:

- Onshape's token exchange **requires `client_secret`** (no PKCE), so a browser
  cannot complete OAuth on its own.
- The Onshape API sends **no CORS headers** — the preflight itself 401s — so a
  browser cannot call it even holding a valid token.

This process holds the secret, does OAuth, and proxies the calls. It also serves
the panel, so page and API share an origin and CORS never enters into it.

`http://localhost` cannot be the extension URL either: Chrome's Private Network
Access blocks a public https page from embedding a private-network iframe.

## Deploy (Render)

Web service, Node, `npm start`. Environment:

| var | value |
|---|---|
| `ONSHAPE_CLIENT_ID` | from the Onshape dev portal |
| `ONSHAPE_CLIENT_SECRET` | from the dev portal — never commit it |

`PUBLIC_URL` is taken from Render's `RENDER_EXTERNAL_URL` automatically.

Then in the dev portal set the OAuth **redirect URL** to
`https://<your-service>.onrender.com/auth/callback` and the **extension**
(Element right panel, Inside Assembly) action URL to
`https://<your-service>.onrender.com/`.

## Using it

1. Open an assembly; the panel appears in the right rail.
2. **Connect to Onshape** (opens a popup — Onshape's authorize page refuses to
   be framed).
3. Type mate names against controller inputs, press **Initialize**. It verifies
   each mate is drivable and fills in its limits.
4. Hold **LB** to drive. **LB+Back** homes. Editing a name marks the table dirty
   and Initialize must be run again.

`/spike.html` is the throwaway diagnostic that proved Onshape delegates
`allow="gamepad"` to the panel iframe, and that input keeps flowing while the
CAD viewport has focus.
