const STORAGE_KEY = "switch2GamepadBindingsV1";

const actions = [
  { id: "lstick-up", label: "左スティック ↑", type: "stick", side: "left", direction: "up", binding: null },
  { id: "lstick-left", label: "左スティック ←", type: "stick", side: "left", direction: "left", binding: null },
  { id: "lstick-down", label: "左スティック ↓", type: "stick", side: "left", direction: "down", binding: null },
  { id: "lstick-right", label: "左スティック →", type: "stick", side: "left", direction: "right", binding: null },
  { id: "up", label: "十字 ↑", type: "hat", value: 0, binding: 12 },
  { id: "left", label: "十字 ←", type: "hat", value: 6, binding: 14 },
  { id: "down", label: "十字 ↓", type: "hat", value: 4, binding: 13 },
  { id: "right", label: "十字 →", type: "hat", value: 2, binding: 15 },
  { id: "rstick-up", label: "右スティック ↑", type: "stick", side: "right", direction: "up", binding: null },
  { id: "rstick-left", label: "右スティック ←", type: "stick", side: "right", direction: "left", binding: null },
  { id: "rstick-down", label: "右スティック ↓", type: "stick", side: "right", direction: "down", binding: null },
  { id: "rstick-right", label: "右スティック →", type: "stick", side: "right", direction: "right", binding: null },
  { id: "a", label: "A", type: "button", value: 2, binding: 1 },
  { id: "b", label: "B", type: "button", value: 1, binding: 0 },
  { id: "x", label: "X", type: "button", value: 3, binding: 3 },
  { id: "y", label: "Y", type: "button", value: 0, binding: 2 },
  { id: "l", label: "L", type: "button", value: 4, binding: 4 },
  { id: "zl", label: "ZL", type: "button", value: 6, binding: 6 },
  { id: "zr", label: "ZR", type: "button", value: 7, binding: 7 },
  { id: "r", label: "R", type: "button", value: 5, binding: 5 },
  { id: "minus", label: "−", type: "button", value: 8, binding: 8 },
  { id: "plus", label: "＋", type: "button", value: 9, binding: 9 },
  { id: "home", label: "HOME", type: "button", value: 12, binding: 16 },
  { id: "capture", label: "スクショ", type: "button", value: 13, binding: null },
  { id: "lstick", label: "左スティック押し込み", type: "button", value: 10, binding: 10 },
  { id: "rstick", label: "右スティック押し込み", type: "button", value: 11, binding: 11 },
  { id: "claim", label: "操作権を取る", type: "claim", binding: null },
];

const defaults = () => Object.fromEntries(actions.map(({ id, binding }) => [id, binding]));

export function defaultGamepadBindings() {
  return defaults();
}

function validBinding(binding) {
  return binding === null || (Number.isInteger(binding) && binding >= 0);
}

function loadBindings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && actions.every(({ id }) => validBinding(saved[id]))) return saved;
  } catch { }
  return defaults();
}

export function assignGamepadButton(bindings, targetId, buttonIndex) {
  if (!actions.some(({ id }) => id === targetId) || !Number.isInteger(buttonIndex) || buttonIndex < 0) return bindings;
  const next = { ...bindings };
  const previousBinding = next[targetId];
  const duplicate = actions.find(({ id }) => id !== targetId && next[id] === buttonIndex);
  if (duplicate) next[duplicate.id] = validBinding(previousBinding) ? previousBinding : null;
  next[targetId] = buttonIndex;
  return next;
}

export function resolveGamepadActions(bindings, buttons, suppressedButtons = new Set()) {
  return actions.filter(({ id }) => {
    const buttonIndex = bindings[id];
    return buttonIndex !== null && !suppressedButtons.has(buttonIndex) && Boolean(buttons[buttonIndex]?.pressed);
  });
}

export function gamepadState(pad, activeActions, { dpadFromLeftStick = true } = {}) {
  let buttons = 0;
  for (const action of activeActions) {
    if (action.type === "button") buttons |= 1 << action.value;
  }

  const x = pad.axes[0] ?? 0, y = pad.axes[1] ?? 0;
  let hat = 8;
  const hats = new Set(activeActions.filter(({ type }) => type === "hat").map(({ value }) => value));
  if (hats.size) {
    const up = hats.has(0), right = hats.has(2), down = hats.has(4), left = hats.has(6);
    if (up && right) hat = 1; else if (right && down) hat = 3; else if (down && left) hat = 5; else if (left && up) hat = 7;
    else if (up) hat = 0; else if (right) hat = 2; else if (down) hat = 4; else if (left) hat = 6;
  } else if (dpadFromLeftStick) {
    if (y < -.5) hat = x > .5 ? 1 : x < -.5 ? 7 : 0;
    else if (y > .5) hat = x > .5 ? 3 : x < -.5 ? 5 : 4;
    else if (x > .5) hat = 2;
    else if (x < -.5) hat = 6;
  }

  const stickValue = (side, axis, fallback) => {
    const negative = activeActions.some((action) => action.type === "stick" && action.side === side && action.direction === (axis === "x" ? "left" : "up"));
    const positive = activeActions.some((action) => action.type === "stick" && action.side === side && action.direction === (axis === "x" ? "right" : "down"));
    return negative === positive ? fallback : negative ? 0 : 255;
  };
  return {
    buttons,
    hat,
    lx: stickValue("left", "x", Math.round((x + 1) * 127.5)),
    ly: stickValue("left", "y", Math.round((y + 1) * 127.5)),
    rx: stickValue("right", "x", Math.round(((pad.axes[2] ?? 0) + 1) * 127.5)),
    ry: stickValue("right", "y", Math.round(((pad.axes[3] ?? 0) + 1) * 127.5)),
  };
}

function buttonLabel(buttonIndex) {
  return buttonIndex === null ? "未割り当て" : `ボタン ${buttonIndex}`;
}

export function setupGamepadBindings(onAction) {
  let bindings = loadBindings(), capturing = null;
  let previousButtons = new Set(), previousActions = new Set();
  const suppressedButtons = new Set();
  const grid = document.querySelector("#gamepad-bindings");

  function saveAndRender() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings));
    grid.replaceChildren();
    for (const action of actions) {
      const row = document.createElement("div"); row.className = "key-binding";
      const label = document.createElement("span"); label.textContent = action.label;
      const button = document.createElement("button"); button.type = "button";
      button.textContent = capturing === action.id ? "ボタンを押す…" : buttonLabel(bindings[action.id]);
      button.classList.toggle("capturing", capturing === action.id);
      button.onclick = () => { capturing = action.id; saveAndRender(); };
      row.append(label, button); grid.append(row);
    }
  }

  document.querySelector("#reset-gamepad-bindings").onclick = () => {
    capturing = null; bindings = defaults(); previousActions.clear(); suppressedButtons.clear(); saveAndRender();
  };
  saveAndRender();

  return (pad) => {
    const currentButtons = new Set();
    pad?.buttons.forEach((button, index) => { if (button.pressed) currentButtons.add(index); });
    for (const buttonIndex of [...suppressedButtons]) {
      if (!currentButtons.has(buttonIndex)) suppressedButtons.delete(buttonIndex);
    }

    if (capturing) {
      const pressedButton = [...currentButtons].find((buttonIndex) => !previousButtons.has(buttonIndex));
      if (pressedButton !== undefined) {
        bindings = assignGamepadButton(bindings, capturing, pressedButton);
        capturing = null;
        suppressedButtons.add(pressedButton);
        saveAndRender();
      }
    }

    const activeActions = resolveGamepadActions(bindings, pad?.buttons || [], suppressedButtons);
    const activeIds = new Set(activeActions.map(({ id }) => id));
    for (const action of actions) {
      const wasActive = previousActions.has(action.id), isActive = activeIds.has(action.id);
      if (wasActive !== isActive) onAction(action, isActive);
    }
    previousButtons = currentButtons;
    previousActions = activeIds;
    return activeActions;
  };
}
