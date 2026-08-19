# Xbox Controller Driver

**Drive assembly mates in real time from a game controller, without leaving Onshape.**

---

## Overview

Xbox Controller Driver opens as a right-side panel inside any assembly. You bind a mate
to a controller input in a table, press **Initialize**, hold the deadman, and fly the
mechanism. Motion is written back as real **mate values** — the same numbers you would
type into a mate's dialog — so limits, the solver and the display all behave exactly as
they do for manual input. The panel adds no geometry, creates no features, and never
edits a feature definition.

Because the panel and the viewport are the same browser tab, you watch the model move
while you drive it.

Typical uses: exercising a robot arm or linkage through its range, checking reach and
interference by hand, demonstrating a mechanism live, and finding the travel limits that
matter before committing them to the model.

---

## Requirements

| | |
|---|---|
| Browser | Chrome or Edge (Chromium). The panel uses the W3C Gamepad API. |
| Controller | Any controller reporting the **standard mapping** with at least 4 axes — Xbox Wireless Controller, Xbox Elite, Series X\|S, and most third-party XInput pads. |
| Document | Must be opened on a **workspace**. Versions are immutable, so the panel goes read-only. |
| Onshape access | Write permission on the document. The panel authorizes over OAuth 2. |

### There is no plugin, driver or download

The controller is read through the **W3C Gamepad API**, which is built into the browser.
Nothing is installed on your machine, no browser extension is required, and no vendor
driver or middleware sits in the path. This is a deliberate choice: an XInput or HID
integration would have been Windows-only, or would have needed a separate per-OS layer.
The Gamepad API is one interface with the same button and axis indices on every platform,
which is what makes the panel work identically on Windows and macOS.

**Windows.** Xbox controllers are supported natively. Connect over USB, Bluetooth, or the
Xbox Wireless Adapter. No setup beyond pairing.

**macOS.** macOS 11 Big Sur and later support Xbox controllers natively over Bluetooth.
Pair from *System Settings → Bluetooth* while holding the controller's pair button.
Note that only Bluetooth-capable models pair with a Mac — the Xbox One controller
model 1708 and later, and all Series X|S controllers. The original 2013 model 1537 has
no Bluetooth radio and needs a USB cable.

**On either platform, press any button on the controller after opening the panel.**
Browsers do not enumerate a gamepad until it sends input. A pad that appears absent is
almost always a pad that has not been touched yet.

---

## Using it

### 1. Bind

Each row of the table pairs one controller input with one mate.

| Column | |
|---|---|
| **Input** | Which control drives this row. |
| **Mate name** | The mate to drive, typed exactly as it appears in the feature list. |
| **Scale** | A multiplier on the input. `1` is normal; `-1` reverses the direction; `0.5` halves the speed. |
| **Home** | Where this joint goes on a home command. **Leave it blank** to return to the exact pose captured at Initialize. |
| **Range** | Read-only. The mate's declared limits, filled in by Initialize. |
| **Commanded / Actual** | Read-only. What the panel is asking for, and what the assembly reports. |

**Sub-assembly mates** are addressed as `<instance>/<mate>`, keeping the occurrence
suffix — for example `Armatron_Grip <1>/Revolute_Grip`. Top-level mates need no prefix.
Two instances of the same sub-assembly are separate joints and are driven independently.

**One input may drive several mates.** Add a second row on the same control — with
`+1` and `-1` scales, for instance, to open a pair of jaws symmetrically. Pointing two
rows at the *same* mate is rejected: they would fight for the write each tick and it
reads as drift.

Bindings are saved in your browser per element, so a table survives a reload.

### 2. Initialize

**Initialize is also Verify.** One button, because the two questions — *does this
binding resolve?* and *did the last session's writes actually land?* — are only worth
asking together. It performs a read; it never writes.

Initialize:

- **Resolves every mate name** against the assembly, including mates reached through
  sub-assembly occurrences. Exact matches win; a name without its occurrence suffix is
  accepted only when it is unambiguous.
- **Reads each mate's limits** from the feature definition of the element that owns it,
  and fills the Range column. A mate with no limits enabled reads `unlimited` and is
  clamped to ±180°.
- **Seeds each joint's commanded value from its current position**, so the first input
  moves the joint from where it actually is. Nothing jumps.
- **Captures the home pose** — a full snapshot of every value of every mate, not just
  the one axis a row drives. This matters for mates whose orientation is not described by
  a single number; replaying the snapshot restores them exactly, where commanding an
  angle cannot.
- **Flags every row that will not work**, with the reason on the row: `no such mate`,
  `ambiguous`, `duplicate`, `not drivable`, or `not moving` — the last meaning the
  previous session's writes were accepted and discarded, which is the signature of a
  joint the solver owns.

Editing a mate name marks the table **dirty** and disables driving until you re-Initialize.
A stale binding is worse than an absent one.

Because the home pose is captured at Initialize, **put the mechanism where you want
"home" to be before you press it.**

### 3. Drive

```
LB (left bumper)     DEADMAN. Nothing moves unless it is held.
LB + Back            Home all joints.
LB + Start           Re-initialize.
```

**The deadman is not optional and has no bypass.** Release it and every joint stops
where it is. Homing sits behind it too, deliberately: a home is the largest motion the
mechanism makes, and it is exactly the command you least want firing from a controller
left on a desk.

Everything else is bindable:

```
sticks     left X / left Y / right X / right Y
triggers   left / right
buttons    A, B, X, Y, RB, left stick click, right stick click
D-pad      up / down / left / right
Guide      offered, but Windows usually claims it for the Game Bar first
```

Two per-row tools need no controller at all:

- **Sweep** runs one joint from limit to limit and back over about 4 seconds. This is the
  setup tool — it proves a binding actually moves the model, and shows you the real
  travel, before anyone tries to fly it.
- **Home** returns one joint on its own. **Home all** works from the panel as well as
  from the controller.

---

## How input becomes motion

### Deadzone, per control

A stick that rests slightly off-center would creep. Sticks use a **0.2** deadzone,
triggers **0.12**, buttons none — a trigger rests hard against zero, so a wide band there
would only cost usable travel, and a button has no rest drift at all.

Past the threshold the value is **rescaled, not offset**: `(v − sign(v)·t) / (1 − t)`.
Motion therefore ramps from zero at the edge of the deadzone rather than jumping straight
to a deadzone's worth of speed, and full deflection still reaches full speed.

### Rate control, normalized to the joint's range

Sticks, buttons and the D-pad are **rate** controls: deflection is angular *velocity*,
integrated over time. This is required for anything self-centering — a stick mapped to an
absolute angle would snap its joint back to center every time you let go.

The rate is derived from the mate's own limits:

```
deg/sec = |maxDeg − minDeg| / 3
```

**Full deflection therefore crosses any joint's entire travel in about three seconds,
whether it travels 20° or 300°.** One consequence is that `scale = 1` feels correct on
every joint without tuning, and another is that two joints bound to the same stick arrive
at their limits together instead of one finishing long before the other. A mate that
declares no limits falls back to 60 °/s and clamps at ±180°.

Elapsed time per frame is clamped to 100 ms, so a stall or a backgrounded tab cannot
integrate into a large jump when sampling resumes.

### Position control, with soft takeover

Triggers are **position** controls: the pull *is* the angle, mapped across the joint's
full travel. `minDeg..maxDeg` here is the travel, not a safety clamp. Rate and home are
not used.

A trigger cannot be moved to match the joint, so on the first sample its physical
position would teleport the joint to wherever the trigger happens to be — and a released
trigger maps to the low end, so a jaw sitting at its high end would slam through its whole
range. Instead the binding stays **inert until the trigger's implied angle passes within
2° of where the joint already is**, then picks up smoothly. Until then the row reads
`hold`, and tells you which value to sweep through to engage.

---

## Write behavior

The panel samples the controller at display rate — roughly 60 Hz — but does not write at
anything like that rate. Three gates sit between input and the API:

1. **An epsilon gate.** A joint whose commanded value has moved less than **0.15°** since
   its last write is not written. This absorbs the residual noise a deadzone leaves.
2. **A throttle.** At most one write every **150 ms**, capping the write rate at about
   6–7 per second regardless of how fast input arrives.
3. **Batching.** Every joint that moved goes into a **single** request. Six joints moving
   together cost one write, not six.

This matters because **every write to an Onshape document creates a microversion**, and
the API is rate-limited per account. Batching keeps a six-axis mechanism at one
microversion per flush.

Writes are round-tripped, never synthesized: the panel reads the whole mate-value array,
changes only the fields it drives, and posts the array back — so fields it does not model
are preserved untouched. Values are snapshotted at the moment a request is sent, and a
joint's pending flag is cleared only if it did not move again while that request was in
flight, so a fast input cannot lose its newest position to a slower write.

---

## Limitations

Read this section before binding a mechanism. Every limitation below was measured against
a real assembly, and most of them fail *silently* — the API returns success and the model
does not move.

### Joints inside a closed kinematic loop cannot be driven

**This is the significant one.** If a mate's value is determined by a closed loop — a
four-bar linkage, a pair of cylindricals closing a chain, two linkages tied by a gear
relation — then that value is a solver **output**, not an input. Onshape's own UI can drag
such a mechanism, because dragging runs the solver. The mate-values API cannot set it.

The failure mode is silent. The write returns **HTTP 200**, no error and no warning, and
the joint does not move:

```
loop closed    82.5775°  ->  commanded 79.5775°  ->  reads back 82.5775°    ignored
loop open      59.8643°  ->  commanded 56.8643°  ->  reads back 56.8643°    DRIVABLE
```

Step size is not the issue — 0.1°, 0.25°, 0.5°, 1°, 2° and 5° steps all read back
unchanged to four decimal places, and ten accumulating steps produce zero net movement.
Addressing is not the issue either: writing the sub-assembly's own element is ignored
identically. In some states the loop's mates stop being reported at all, which is the
solver declining to expose values it owns.

Three things that do **not** work around it, all tested:

- **Flattening the sub-assembly.** The loop comes up to the top level intact and the joint
  stays a solver output. The boundary was never the discriminator; open-chain versus
  closed-loop is.
- **Suppressing only the gear relation.** The API has no problem with advanced mates. Every
  mate in the linkage stays ignored while open-chain joints in the same write move normally.
- **Moving the instance by transform.** The assembly-modify endpoint exists and accepts a
  full 4×4 affine, but any transform that would actually displace a *mated* instance
  returns **HTTP 500**. A *fixed* instance returns a clean 400 for the same request — the
  contrast confirms the endpoint validates properly in cases it understands, and that the
  solver simply cannot reconcile the displacement.

**The only fix is to open the loop.** Suppressing the mates that close it makes the joint
writable immediately, with no other change. Remodelling the mechanism as an open chain
driven by a relation is the durable version. The panel reports an unusable joint as
`not drivable`, or as `not moving` once it has watched a write get discarded, rather than
leaving you to guess.

### Only the Default configuration can be driven

The mate-values endpoint **does not honor a configuration parameter.** It accepts one
without complaint and operates on the **Default** variant regardless — including
reporting mates for instances that the requested configuration suppresses. There is no
error to catch; the write simply applies to a different variant of the assembly than the
one you are looking at.

**Consequence:** a mate that exists only in a non-default configuration cannot be driven.
If a sub-assembly is unsuppressed in configuration `OpenLoopGrip` but not in Default, its
mates will not actuate no matter how they are addressed. Move the instance you intend to
drive into the **Default** configuration.

The panel reads limits correctly per configuration — the feature-definition endpoint does
honor it — so a row can legitimately show a correct range for a joint that will not move.

### Ball mates

Onshape's documentation states that mate values may be specified for all mate types
*except* Ball, Fastened, Tangent and Width. A Ball mate exposes one drivable field over
the API rather than three, writes to it are unsupported even though they do not error, and
commanded and read-back values diverge away from zero because the orientation is
path-dependent.

Binding a Ball mate is possible and roughly usable, but it is not a trustworthy 3-DOF
control. Model a shoulder as stacked revolutes if it needs to be precise. Blank-Home
snapshot restore is the reliable way to return a Ball to a known pose.

### Other constraints

- **Workspaces only.** Versions and microversions are immutable; the panel detects this
  and goes read-only rather than letting writes fail.
- **Mate names must match exactly**, and they are case-sensitive. Names can also differ
  between an assembly's feature list and its mate values, and the same name may refer to
  different joints in different workspaces.
- **The Guide button** is usually intercepted by the OS before the browser sees it. It is
  offered in the dropdown and labelled, so a dead binding is not a mystery.
- **Not every device the browser calls a gamepad is one.** Some USB speakerphones
  enumerate as gamepads because their call-control keys are HID buttons, and can sort
  ahead of the real controller. The panel requires 4 axes before accepting a device.

---

## Hosting, data and privacy

The panel runs against a small backend that holds the OAuth client secret, exchanges the
authorization code for a token, and proxies Onshape API calls. A backend is required
rather than preferred: Onshape's token exchange needs the client secret and does not
support PKCE, and the Onshape API sends no CORS headers, so a browser cannot call it
directly even holding a valid token.

Nothing about your model is stored. The backend keeps the current assembly's mate values
in memory for the duration of a session — needed to round-trip the array on write — and
that is discarded when the service restarts. Your bindings live in your own browser's
local storage. No geometry, document content or credentials are retained.

The service is hosted on a tier that sleeps after a period of inactivity, so the first
request after an idle spell takes about 30 seconds to wake, and a restart clears the
session. When that happens the panel says so and asks you to press Initialize again,
rather than surfacing a raw error.

---

## Design notes

A few decisions worth stating, because they are what the panel is actually made of:

**Range-normalized rates** mean the controller feels the same on a 20° wrist and a 300°
turntable, and that `scale` stays a preference rather than a calibration.

**Initialize doubles as Verify** because the useful moment to check whether the last
session's writes landed is exactly the moment you are about to start another one.

**Home defaults to the captured pose, not to zero.** A mate's zero is frequently an *end*
of travel rather than a rest position, and for path-dependent joints no single number
describes the pose at all. Capturing and replaying the state is the only formulation that
is correct for every mate type.

**Errors are reported on the row that owns them**, in the language of the cause —
`not drivable` for a solver-owned joint, `not moving` for a write that was accepted and
discarded. Nearly every failure this app can encounter is a system politely doing nothing:
HTTP 200, no error, no movement. Surfacing that distinction is most of the work.
