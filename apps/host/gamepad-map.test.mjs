import assert from "node:assert/strict";
import test from "node:test";
import {
  assignGamepadButton,
  defaultGamepadBindings,
  gamepadState,
  resolveGamepadActions,
} from "./public/gamepad-map.js";

test("uses standard gamepad buttons by default and leaves claim configurable", () => {
  const bindings = defaultGamepadBindings();
  assert.deepEqual(
    Object.fromEntries(Object.entries(bindings).filter(([, button]) => button !== null)),
    {
      up: 12, left: 14, down: 13, right: 15,
      a: 1, b: 0, x: 3, y: 2,
      l: 4, zl: 6, zr: 7, r: 5,
      minus: 8, plus: 9, home: 16,
      lstick: 10, rstick: 11,
    },
  );
  assert.equal(bindings.claim, null);
});

test("can assign a gamepad button to taking control", () => {
  const bindings = assignGamepadButton(defaultGamepadBindings(), "claim", 9);
  assert.equal(bindings.claim, 9);
  assert.equal(bindings.plus, null);
  assert.deepEqual(resolveGamepadActions(bindings, Array.from({ length: 10 }, (_, index) => ({ pressed: index === 9 }))).map(({ id }) => id), ["claim"]);
});

test("converts configurable gamepad buttons into controller state", () => {
  const bindings = defaultGamepadBindings();
  const buttons = Array.from({ length: 17 }, (_, index) => ({ pressed: index === 1 || index === 12 }));
  const pad = { buttons, axes: [0, 0, 0, 0] };
  const state = gamepadState(pad, resolveGamepadActions(bindings, buttons));
  assert.deepEqual(state, { buttons: 1 << 2, hat: 0, lx: 128, ly: 128, rx: 128, ry: 128 });
});

test("Pro controller keeps the left stick separate from the D-pad", () => {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false }));
  const pad = { buttons, axes: [1, -1, 0, 0] };
  const actions = resolveGamepadActions(defaultGamepadBindings(), buttons);
  assert.equal(gamepadState(pad, actions, { dpadFromLeftStick: false }).hat, 8);
  assert.equal(gamepadState(pad, actions, { dpadFromLeftStick: false }).lx, 255);
  assert.equal(gamepadState(pad, actions, { dpadFromLeftStick: false }).ly, 0);
});
