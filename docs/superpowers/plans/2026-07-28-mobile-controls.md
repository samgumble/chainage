# Mobile Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Chainage playable in a mobile browser — draw roads with a finger, drive the camera with two, and reach every keyboard-only action from an on-screen control.

**Architecture:** Gesture recognition becomes a pure, tested module that turns a stream of pointer events into named gestures. `roadScene.ts` keeps only the wiring. Nothing about touch is allowed to add arithmetic to the integration file, because that file is where every defect in this project's history has lived and it is the one without unit tests.

**Tech Stack:** TypeScript `strict: true`, `noUncheckedIndexedAccess: true`, vitest 4, three.js `^0.185.1`. Pointer Events (not Touch Events) — one API covers mouse, pen and touch, and the existing handlers already use it.

## Global Constraints

- **No three.js** in `src/geometry/`, `src/terrain/`, `src/network/`, `src/mesh/`, `src/tool/`, `src/traffic/`. `src/traffic/` may import ONLY `src/geometry/` and `src/network/`.
- **`src/debug/roadScene.ts` must gain no arithmetic.** Gesture maths, snap-radius derivation and layout geometry all belong in pure modules.
- **Report rather than approximate.** Named channels, never a silently substituted plausible value.
- The desktop experience must not regress. Mouse and keyboard keep working exactly as they do today; every existing test stays green.
- Every task ends with `npx vitest run` fully green with ZERO skipped and `npx tsc --noEmit` clean. State actual counts.
- Do not start or stop the dev server without checking with the controller — one is usually running.

## What Already Exists

Read these before writing anything; this plan describes intent, and the code has moved repeatedly.

- `src/debug/roadScene.ts` — pointer handlers, the keydown handler (keys `1`–`4` pick draw class, `Enter` commits, `Escape` cancels, plus undo), `setMessage`, the mode indicator, `CameraRig` wiring.
- `src/render/cameraRig.ts` — `pan`, orbit and zoom, no three.js.
- `src/tool/drawTool.ts` — `hover(position, suppressSnap)`, `place(position, suppressSnap)`, `commit()`, `undoLastPoint()`, `cancel()`, `preview`, `SNAP_RADIUS = 15`.
- `src/tool/snap.ts` — `resolveSnap(network, position, radius)`.
- `src/tool/selectTool.ts` — `PICK_RADIUS = 20`.

## The Three Problems That Are Not Ports

Stated up front because each one is a design decision, not a translation:

1. **There is no hover on touch.** The preview, the snap marker and the rejection message all currently appear *before* the player commits, driven by `hover()`. A finger has no hover state. The first tap must therefore do double duty, and a held-and-dragged finger must move the pending point so the player can see the preview before lifting.
2. **A fingertip is about 10mm.** `SNAP_RADIUS` is 15 metres of world space, which at diorama framing is a few pixels. A radius that is comfortable with a 1px cursor is unusable with a thumb. The radius has to be derived from screen pixels and the current camera distance, not left as a fixed world distance.
3. **One finger draws; two fingers drive the camera.** The alternative — one finger for camera, a mode button for drawing — is more common in 3D viewers but puts a mode switch between the player and every single road. This is a drawing game.

---

### Task 1: Gesture recognition as a pure module

**Files:**
- Create: `src/tool/gestures.ts`
- Test: `src/tool/gestures.test.ts`

**Interfaces:**
- Consumes: nothing outside itself. Deliberately — this module must be testable by feeding it synthetic pointer events with no DOM and no renderer.
- Produces, consumed by Task 4:
  - `class GestureRecogniser` with `down(id, x, y, time)`, `move(id, x, y, time)`, `up(id, time)`, `cancel(id)`
  - a discriminated-union `Gesture` type covering at minimum: `tap`, `doubleTap`, `dragStart` / `dragMove` / `dragEnd` (one pointer), `pinch` (scale delta), `twoFingerPan` (dx, dy), `twist` (angle delta)

- [ ] **Step 1: Write the failing tests**

Feed synthetic events. No DOM. Cover, each as its own test:
  - a down/up inside the tap slop and inside the tap timeout is a `tap`
  - a down/up that moves beyond the slop is a drag, **not** a tap — this is the one that stops a shaky finger placing a point the player did not mean
  - two taps inside the double-tap window at nearly the same place are a `doubleTap`, and the second tap must NOT also be reported as a `tap`
  - two taps separated by more than the window are two separate taps
  - two taps at the same time but far apart are two taps, not a double tap
  - a second pointer going down mid-drag ends the drag and starts a two-finger gesture — and the in-progress drag must be **cancelled, not committed**, so a road point is never placed by the act of starting a pinch
  - moving two pointers apart is a `pinch` with a scale above 1; together, below 1
  - moving two pointers in the same direction is a `twoFingerPan` with no significant scale change
  - rotating two pointers about their midpoint is a `twist`
  - lifting one of two pointers does not resume the single-finger drag with a jump
  - `cancel(id)` (the browser stealing the pointer) leaves no gesture in progress

Choose the slop, tap timeout and double-tap window deliberately and justify each in a comment with a real number — platform conventions exist for all three.

- [ ] **Step 2: Run to verify they fail.** `npx vitest run src/tool/gestures.test.ts` — expected FAIL, module not found.

- [ ] **Step 3: Implement.** Pure state machine. No `Date.now()` — time arrives as a parameter, so the tests are deterministic.

- [ ] **Step 4: Run to verify they pass.**

- [ ] **Step 5: Prove the tests discriminate.** MANDATORY. Break the slop check, the double-tap window, and the mid-drag cancellation, one at a time; confirm the named test fails for each; revert. Report a table. A surviving mutation means the test is not testing its subject — fix the test.

- [ ] **Step 6: Commit.**

---

### Task 2: Snap radius in screen space

**Files:**
- Create: `src/tool/snapRadius.ts`
- Test: `src/tool/snapRadius.test.ts`
- Modify: `src/debug/roadScene.ts` (pass the derived radius where `SNAP_RADIUS` is used)

**Interfaces:**
- Produces: a function turning a screen-space radius in CSS pixels plus the camera's current distance (and whatever else the projection needs) into a world-space radius in metres.

- [ ] **Step 1: Write the failing tests.**
  - the world radius grows with camera distance — the same finger covers more ground when zoomed out
  - at the default framing it is close to today's 15m, so desktop behaviour does not lurch
  - it never returns zero or a negative number for any plausible input
  - a coarse pointer gets a larger radius than a fine one

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** Derive from the camera's vertical FOV and distance; do not curve-fit a constant. `SNAP_RADIUS` stays as the desktop default so nothing silently changes for mouse users.

- [ ] **Step 4: Run.** — [ ] **Step 5: Mutate and revert, reporting results.** — [ ] **Step 6: Commit.**

---

### Task 3: On-screen controls

**Files:**
- Create: `src/render/controlBar.ts` (or the project's established UI location — check how the message line and mode indicator are built and follow it)
- Test: whatever is testable without a DOM; state plainly what is not
- Modify: `src/debug/roadScene.ts`

Every keyboard-only action needs a control: the four road classes, draw/select mode, build, undo last point, cancel.

- [ ] **Step 1: Build the controls.** Requirements:
  - hit targets **at least 44 × 44 CSS px** — the platform accessibility minimum, not a preference
  - positioned clear of the tilt-shift blur band and clear of the message line
  - the current draw class and the current mode are both **visibly indicated**, not just settable — on desktop the player knows because they pressed the key; on mobile there is no such memory
  - the buttons drive the *same* functions the keyboard handler drives. Do not duplicate the logic — if that means extracting a named action from the keydown handler, extract it.

- [ ] **Step 2: Do not break the keyboard.** Every existing key must still work. Verify and say so.

- [ ] **Step 3: Commit.**

---

### Task 4: Wire gestures to the tool and camera

**Files:** Modify `src/debug/roadScene.ts`, and whatever pure module the wiring needs.

- [ ] **Step 1: Route the gestures.**
  - one-finger tap → `place`
  - one-finger drag → move the pending point and update the preview live, so the player sees the snap marker and any rejection **before** lifting
  - double tap → `commit`
  - two-finger pan → `CameraRig.pan`; pinch → zoom; twist → orbit
  - a two-finger gesture must never place a point (Task 1 guarantees the cancellation; verify it end to end here)

- [ ] **Step 2: Handle the no-hover case explicitly.** Decide and document what the player sees before their first tap. State the decision in a comment.

- [ ] **Step 3: `touch-action`.** Set it so the browser does not steal the gestures for scrolling or page zoom. Getting this wrong makes the canvas feel broken in a way that looks like a bug in the game.

- [ ] **Step 4: Commit.**

---

### Task 5: Responsive layout, and verification on a real viewport

**Files:** Modify the page's CSS/HTML and `src/debug/roadScene.ts` as needed.

- [ ] **Step 1: Portrait phone.** The canvas must fill the viewport with no page scroll, the hint must not cover the play area, and the controls must not overlap the message line.

- [ ] **Step 2: Device pixel ratio.** Confirm the renderer's pixel ratio is handled — a phone at DPR 3 rendering at DPR 1 looks soft, and rendering at full DPR on a phone GPU may not hold frame rate. Measure rather than assume, and say what you chose.

- [ ] **Step 3: Verification is the controller's job.** Implementers cannot test touch without a device. The controller resizes the browser pane to a mobile preset and drives the gestures. Write down in your report exactly what should happen for each gesture so the controller knows what to check.

- [ ] **Step 4: Commit.**

---

## Self-Review

**Coverage.** Gestures → Task 1. Fingertip precision → Task 2. Keyboard-only actions → Task 3. Hover-free preview → Task 4. Layout and DPR → Task 5.

**Known gap, stated rather than hidden.** Tasks 3, 4 and 5 are largely unverifiable by their implementers — touch input and layout need a real viewport. The controller must verify each in the browser pane at a mobile preset before merge. Task 1 and Task 2 carry the load-bearing logic precisely so that the untestable part is thin wiring.

**Deliberately not in scope.** Haptics; a tutorial; landscape-specific layout; a settings panel; anything that changes desktop behaviour.
