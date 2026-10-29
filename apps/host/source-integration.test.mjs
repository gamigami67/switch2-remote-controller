import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("local source selection controls the automation route without a serial device", async () => {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));

  const child = spawn(process.execPath, [fileURLToPath(new URL("./server.mjs", import.meta.url))], {
    env: {
      ...process.env,
      HTTP_PORT: String(port),
      ESP32_SERIAL_PORT: "C:/switch2-v2-test/no-device",
    },
    stdio: "ignore",
    windowsHide: true,
  });
  let control;
  let automation;
  const status = async () => (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
  const waitFor = async (predicate) => {
    for (let i = 0; i < 80; i += 1) {
      try { if (await predicate()) return; } catch { }
      await pause(50);
    }
    throw new Error("host status did not reach expected state");
  };
  try {
    await waitFor(async () => (await status()).inputSource === "browser");
    control = new WebSocket(`ws://127.0.0.1:${port}/control`);
    automation = new WebSocket(`ws://127.0.0.1:${port}/automation`);
    await Promise.all([once(control, "open"), once(automation, "open")]);
    automation.send(JSON.stringify({ type: "automation", enabled: true }));
    await pause(50);
    assert.equal((await status()).inputSource, "browser");
    control.send(JSON.stringify({ type: "source", source: "automation" }));
    await waitFor(async () => (await status()).inputSource === "automation");
    assert.equal((await status()).sourceReady, false);
    control.send(JSON.stringify({ type: "source", source: "browser" }));
    await waitFor(async () => (await status()).inputSource === "browser");
  } finally {
    control?.terminate();
    automation?.terminate();
    child.kill();
    if (child.exitCode === null) await once(child, "exit");
  }
});
