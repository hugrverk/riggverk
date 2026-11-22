# Motion

Read this when a change adds, changes or removes animation or transitions. The values are defaults: the product's own motion tokens (durations, curves, spring settings) and its established motion win over them, and so does a brief that asks for something else.

## Decide in order

1. **Animate at all?** The more often a user triggers something, the less it should move. Keyboard-driven actions, command palettes and list navigation respond instantly; occasional surfaces (dialogs, drawers, menus, toasts) may get a short transition; rare moments such as onboarding may carry more.
2. **What does it explain?** Where something came from or went, that a state changed, that input was received, or a change that would otherwise jump. "It looks nice" on something seen many times a day is not a reason.
3. **Which curve?** Entering and leaving: ease-out, so movement starts at once. Moving or resizing on screen: ease-in-out. Color and hover: ease or ease-out. Continuous progress: linear. Avoid ease-in for UI; its slow start lands where the user is looking.
4. **How long?** See below. Shorter is usually better.

## Timing

- Ordinary UI transitions stay between about 120 and 250 ms: press feedback 100–160 ms, tooltips and small popovers 120–200 ms, menus and selects 150–250 ms.
- Dialogs, drawers and sheets may run to about 400 ms. Beyond 300 ms on a small control reads as lag.
- Exit is shorter than enter, for example 200 ms in and 150 ms out.
- The CSS keyword curves are mild. Define a stronger ease-out `cubic-bezier` once as a token and reuse it; never scatter literal durations and curves across components.
- If list entrances are staggered, use 30–80 ms per item, cap the total, and keep it for entrances that happen rarely.
- Input is never blocked while an animation plays.

## Enter, exit and origin

- Start close to the final state: a small offset (4–12 px) or a scale of 0.95–0.98, together with opacity. Never grow from `scale(0)`.
- Anchored surfaces (popovers, menus, tooltips) grow from their trigger, so `transform-origin` points at it. Centered dialogs keep a centered origin.
- A surface leaves along the path it came in on.
- A pressable control may acknowledge a press with a slight scale (0.96–0.98) on `:active`.
- Once one tooltip is open, neighboring tooltips open without delay or animation.

## Interruptibility

- State that can flip quickly (toggles, hover, expand and collapse, stacked toasts) uses CSS transitions, which retarget from the current value. Keyframe animations, and scripted ones with a fixed first keyframe, restart from the beginning and jump.
- Drag and swipe follow the pointer directly and finish on velocity: a quick flick dismisses even short of the distance threshold. Springs suit gestures because they keep velocity when interrupted.

## Properties and performance

- Animate `transform` and `opacity`. Animating `width`, `height`, `top`, `left`, `margin` or `padding` runs layout on every frame.
- Name the transitioned properties; never `transition: all`.
- `filter`, `clip-path` and `backdrop-filter` are for a specific effect only; keep blur small and check the frame rate with a throttled CPU.
- Put hover motion behind `@media (hover: hover) and (pointer: fine)` so a tap on a touch screen does not trigger it.
- Move the animated element itself; changing a CSS variable on a parent restyles every child.

## Reduced motion

- Under `prefers-reduced-motion: reduce`, remove movement: translation, scaling, parallax, autoplay and loops. Keep brief opacity or color changes that still show a state change.
- Honor an in-app motion setting too when the product has one.
- Nothing depends on an animation finishing: focus moves and content becomes usable either way.

Check by slowing animations down (the browser's animation inspector, or durations temporarily multiplied) to see origin, overlap and easing, then test with reduced motion on.
