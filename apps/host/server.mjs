import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { SerialPort } from "serialport";
import dotenv from "dotenv";
import { loadConfig } from "./config.mjs";
import { NEUTRAL_STATE, sanitizeDigitalEdges, sanitizeState } from "./controller-state.mjs";
import { encodeEasyConState } from "./easycon.mjs";
import { makeRumbleMessage, parseEsp32RumbleLine } from "./rumble.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, ".env"), quiet: true });
const config = loadConfig();

let currentState = { ...NEUTRAL_STATE };
let lastBrowserInput = 0;
let browserMessagesReceived = 0;
let esp32SerialFramesWritten = 0;
let esp32SerialFramesDropped = 0;
let esp32SerialFramesCoalesced = 0;
let browserDigitalEdgesAccepted = 0;
let esp32DigitalEdgeFramesQueued = 0;
let esp32DigitalEdgeFramesWritten = 0;
let esp32DigitalEdgeFramesDropped = 0;
let esp32BootCount = 0;
let esp32LastReset = null;
let esp32LogTail = "";
let lastBrowserStateChange = 0;
let esp32LastInputLatencyMs = null;
let esp32InputStateChanges = 0;
let esp32BleConnIntervalUnits = null;
let esp32BleConnects = 0;
let esp32BleDisconnects = 0;
let esp32BleConnected = false;
let esp32BleLastDisconnectReason = null;
let esp32HidSubscribes = 0;
let esp32HidUnsubscribes = 0;
let esp32HidTaskStarts = 0;
let esp32BleQueueFree = null;
let esp32BleQueueCeiling = null;
let esp32BleCongestionSkips = 0;
let esp32BlePendingSkips = 0;
let esp32BleNotifyCompletions = 0;
let esp32InputTransitions = null;
let esp32InputPresses = null;
let esp32InputReleases = null;
let esp32HidFramesEnqueued = null;
let esp32HidEnqueueTransitions = null;
let esp32HidFramesDequeued = null;
let esp32HidDequeueTransitions = null;
let esp32HidQueueDrops = null;
let esp32HidDuplicateStates = null;
let esp32HidQueueDepth = null;
let esp32HidQueueHighWater = null;
let esp32HidNotifyFailures = null;
let esp32HidNotifyRecoveries = null;
let esp32BleNotifications = null;
let esp32BleInputTransitions = null;
let esp32RumbleFramesReceived = 0;
let rumbleSequence = 1;
let currentRumble = { type: "rumble", seq: 0, strong: 0, weak: 0, duration: 0 };
let localControllerSocket = null;
let automationSocket = null;
let automationEnabled = false;
let automationLastInputAt = 0;
let inputSource = "browser";
let sourceReady = false;
let transitionNeutralFrame = null;
let esp32Serial = null;
let esp32SerialError = null;
let pendingEsp32Frame = null;
const esp32EdgeFrames = [];
const lastDigitalEdgeBySession = new Map();
let esp32SerialWriteInFlight = false;
let lastEsp32Keepalive = 0;

const ESP32_EDGE_QUEUE_LIMIT = 64;
const AUTOMATION_INPUT_TIMEOUT_MS = 1200;

function isLocalClient(request) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress);
}

function sendAutomationStatus(error = null) {
  if (automationSocket?.readyState !== 1) return;
  automationSocket.send(JSON.stringify({
    type: "automation-status",
    connected: true,
    serialConnected: esp32Serial?.isOpen === true,
    bleConnected: esp32BleConnected,
    enabled: automationEnabled,
    source: inputSource,
    error,
  }));
}

function sendSourceStatus() {
  const socket = localControllerSocket;
  if (socket?.readyState === 1) socket.send(JSON.stringify({ type: "source-status", source: inputSource, ready: sourceReady }));
  sendAutomationStatus();
}

function switchInputSource(source, force = false) {
  if (!["browser", "pro", "automation"].includes(source) || (source === inputSource && !force)) return;
  inputSource = source;
  automationEnabled = source === "automation";
  automationLastInputAt = Date.now();
  sourceReady = false;
  forceNeutral();
  // A neutral frame is a barrier after any serial write already in flight.
  transitionNeutralFrame = encodeEasyConState(NEUTRAL_STATE);
  if (esp32Serial?.isOpen) {
    pendingEsp32Frame = null;
    esp32EdgeFrames.push(transitionNeutralFrame);
    pumpEsp32Serial();
  } else {
    transitionNeutralFrame = null;
  }
  sendSourceStatus();
}

function forceNeutral() {
  currentState = { ...NEUTRAL_STATE };
  pendingEsp32Frame = null;
  esp32EdgeFrames.length = 0;
  queueEsp32State(currentState, false);
}

function disableAutomation(error = null) {
  if (!automationEnabled) return;
  switchInputSource("automation", true);
  automationLastInputAt = 0;
  sendAutomationStatus(error);
}

function publishRumble(raw) {
  const message = makeRumbleMessage(raw, rumbleSequence++);
  if (!message) return;
  currentRumble = message;
  esp32RumbleFramesReceived += 1;
  const socket = localControllerSocket;
  if (socket?.readyState === 1) {
    try { socket.send(JSON.stringify(message)); } catch { }
  }
}

function stopRumble() {
  if (currentRumble.strong === 0 && currentRumble.weak === 0) return;
  publishRumble({ firmwareSequence: 0, strongRaw: 0, weakRaw: 0 });
}

function sameState(left, right) {
  return left.buttons === right.buttons && left.hat === right.hat &&
    left.lx === right.lx && left.ly === right.ly && left.rx === right.rx && left.ry === right.ry;
}

function pumpEsp32Serial() {
  const serial = esp32Serial;
  if (!serial?.isOpen || esp32SerialWriteInFlight || (!esp32EdgeFrames.length && !pendingEsp32Frame)) return;

  const isDigitalEdge = esp32EdgeFrames.length > 0;
  const frame = isDigitalEdge ? esp32EdgeFrames.shift() : pendingEsp32Frame;
  if (!esp32EdgeFrames.length && frame === pendingEsp32Frame) pendingEsp32Frame = null;
  esp32SerialWriteInFlight = true;
  serial.write(frame, (writeError) => {
    if (writeError) {
      esp32SerialError = writeError.message;
      esp32SerialFramesDropped += 1;
      currentState = { ...NEUTRAL_STATE };
      sourceReady = false;
      pendingEsp32Frame = null;
      esp32EdgeFrames.length = 0;
      transitionNeutralFrame = null;
      sendSourceStatus();
      if (serial.isOpen) serial.close();
    } else {
      esp32SerialFramesWritten += 1;
      if (isDigitalEdge) esp32DigitalEdgeFramesWritten += 1;
    }
    // SerialPort completes one overlapped write at a time. Keep at most one
    // newer frame while it is pending; calling drain() here adds a Windows USB
    // flush delay of roughly 20 ms and needlessly limits this 8-byte stream.
    esp32SerialWriteInFlight = false;
    if (frame === transitionNeutralFrame) {
      transitionNeutralFrame = null;
      sourceReady = !writeError;
      sendSourceStatus();
    }
    setImmediate(pumpEsp32Serial);
  });
}

function queueEsp32State(state, countCoalesced = true) {
  if (!esp32Serial?.isOpen) return;
  if (pendingEsp32Frame && countCoalesced) esp32SerialFramesCoalesced += 1;
  pendingEsp32Frame = encodeEasyConState(state);
  pumpEsp32Serial();
}

function queueEsp32Edges(states) {
  if (!esp32Serial?.isOpen) return;
  for (let index = 0; index < states.length; index += 1) {
    const state = states[index];
    if (esp32EdgeFrames.length >= ESP32_EDGE_QUEUE_LIMIT) {
      esp32SerialFramesDropped += 1;
      esp32DigitalEdgeFramesDropped += states.length - index;
      break;
    }
    esp32EdgeFrames.push(encodeEasyConState(state));
    esp32DigitalEdgeFramesQueued += 1;
  }
  pumpEsp32Serial();
}

function acceptDigitalEdges(message) {
  const parsed = sanitizeDigitalEdges(message);
  if (!parsed.sid) return { states: [], sid: null, edgeAck: null };
  const previous = lastDigitalEdgeBySession.get(parsed.sid) ?? -1;
  const accepted = parsed.edges.filter((edge) => edge.sequence > previous);
  if (parsed.highestSequence !== null && parsed.highestSequence > previous) {
    lastDigitalEdgeBySession.set(parsed.sid, parsed.highestSequence);
    if (lastDigitalEdgeBySession.size > 64) lastDigitalEdgeBySession.delete(lastDigitalEdgeBySession.keys().next().value);
  }
  return { states: accepted.map((edge) => edge.state), sid: parsed.sid, edgeAck: parsed.highestSequence };
}

function openEsp32Serial() {
  if (!config.esp32SerialPort || esp32Serial) return;
  const serial = new SerialPort({ path: config.esp32SerialPort, baudRate: 115200, autoOpen: false });
  esp32Serial = serial;
  serial.open((error) => {
    if (error) {
      esp32SerialError = error.message;
      esp32Serial = null;
      sendAutomationStatus(`ESP32 serial open failed: ${error.message}`);
      setTimeout(openEsp32Serial, 2000).unref();
      return;
    }
    esp32SerialError = null;
    console.log(`ESP32 BLE controller: ${config.esp32SerialPort}`);
    if (!sourceReady) {
      transitionNeutralFrame = encodeEasyConState(NEUTRAL_STATE);
      esp32EdgeFrames.push(transitionNeutralFrame);
      pumpEsp32Serial();
    } else queueEsp32State(currentState);
    sendAutomationStatus();
  });
  serial.on("error", (error) => {
    esp32SerialError = error.message;
    esp32BleConnected = false;
    currentState = { ...NEUTRAL_STATE };
    sourceReady = false;
    pendingEsp32Frame = null;
    esp32EdgeFrames.length = 0;
    transitionNeutralFrame = null;
    if (serial.isOpen) serial.close();
    sendAutomationStatus(esp32SerialError);
    sendSourceStatus();
  });
  serial.on("data", (data) => {
    const lines = (esp32LogTail + data.toString("utf8")).split(/\r?\n/);
    esp32LogTail = (lines.pop() || "").slice(-2048);
    for (const line of lines) {
      const rumble = parseEsp32RumbleLine(line);
      if (rumble) {
        publishRumble(rumble);
        continue;
      }
      const reset = line.match(/rst:([^,\r\n]+)/);
      if (reset) {
        esp32BootCount += 1;
        esp32LastReset = reset[1].trim();
      }
      if (line.trim() === "DI" && lastBrowserStateChange) {
        esp32LastInputLatencyMs = Date.now() - lastBrowserStateChange;
        lastBrowserStateChange = 0;
      }
      if (line.trim() === "DI") esp32InputStateChanges += 1;
      if (line.includes("connected, set nintendo switch addr")) {
        esp32BleConnects += 1;
        esp32BleConnected = true;
        sendAutomationStatus();
      }
      const disconnect = line.match(/disconnected, reason=(\d+)/);
      if (disconnect) {
        esp32BleDisconnects += 1;
        esp32BleLastDisconnectReason = Number(disconnect[1]);
        esp32BleConnected = false;
        sendAutomationStatus();
      }
      const subscribe = line.match(/subscribe event;.*attr_handle=0x00(?:0e|0E).*prevn=(\d+) curn=(\d+)/);
      if (subscribe) {
        if (Number(subscribe[2]) === 1 && Number(subscribe[1]) === 0) esp32HidSubscribes += 1;
        if (Number(subscribe[2]) === 0 && Number(subscribe[1]) === 1) esp32HidUnsubscribes += 1;
      }
      if (line.includes("controller report task start")) esp32HidTaskStarts += 1;
      const connection = line.match(/^DC:(\d+)$/);
      if (connection) esp32BleConnIntervalUnits = Number(connection[1]);
      const queue = line.match(/^DQ:(\d+):(\d+):(\d+)(?::(\d+):(\d+))?$/);
      if (queue) {
        esp32BleQueueFree = Number(queue[1]);
        esp32BleQueueCeiling = Number(queue[2]);
        esp32BleCongestionSkips = Number(queue[3]);
        if (queue[4] !== undefined) esp32BlePendingSkips = Number(queue[4]);
        if (queue[5] !== undefined) esp32BleNotifyCompletions = Number(queue[5]);
      }
      const input = line.match(/^DX:(\d+):(\d+):(\d+)$/);
      if (input) {
        esp32InputTransitions = Number(input[1]);
        esp32InputPresses = Number(input[2]);
        esp32InputReleases = Number(input[3]);
      }
      const hid = line.match(/^DH:(\d+):(\d+):(\d+):(\d+):(\d+)$/);
      if (hid) {
        esp32HidFramesEnqueued = Number(hid[1]);
        esp32HidEnqueueTransitions = Number(hid[2]);
        esp32HidFramesDequeued = Number(hid[3]);
        esp32HidDequeueTransitions = Number(hid[4]);
        esp32HidQueueDrops = Number(hid[5]);
      }
      const notify = line.match(/^DB:(\d+):(\d+)$/);
      if (notify) {
        esp32BleNotifications = Number(notify[1]);
        esp32BleInputTransitions = Number(notify[2]);
      }
      const reliability = line.match(/^DR:(\d+):(\d+):(\d+):(\d+):(\d+)$/);
      if (reliability) {
        esp32HidDuplicateStates = Number(reliability[1]);
        esp32HidQueueDepth = Number(reliability[2]);
        esp32HidQueueHighWater = Number(reliability[3]);
        esp32HidNotifyFailures = Number(reliability[4]);
        esp32HidNotifyRecoveries = Number(reliability[5]);
      }
    }
  });
  serial.on("close", () => {
    if (esp32Serial === serial) esp32Serial = null;
    esp32BleConnected = false;
    disableAutomation("ESP32 serial connection closed");
    stopRumble();
    currentState = { ...NEUTRAL_STATE };
    sourceReady = false;
    transitionNeutralFrame = null;
    pendingEsp32Frame = null;
    esp32EdgeFrames.length = 0;
    esp32SerialWriteInFlight = false;
    sendAutomationStatus("ESP32 serial connection closed");
    sendSourceStatus();
    setTimeout(openEsp32Serial, 2000).unref();
  });
}

openEsp32Serial();

function sendState(state = currentState, sendSerial = true) {
  if (sendSerial && esp32Serial?.isOpen) {
    queueEsp32State(state);
  }
}

// Keep the ESP32 watchdog fresh while a local controller page is connected.
setInterval(() => {
  if (sourceReady && (automationEnabled || localControllerSocket?.readyState === 1) && Date.now() - lastEsp32Keepalive >= 500) {
    lastEsp32Keepalive = Date.now();
    queueEsp32State(currentState, false);
  }
}, 10).unref();

const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
]);
const publicDir = path.join(here, "public");
const server = http.createServer((request, response) => {
  if (request.url === "/api/status") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({
      browserMessagesReceived,
      browserDigitalEdgesAccepted,
      lastBrowserInputAgeMs: lastBrowserInput ? Date.now() - lastBrowserInput : null,
      localControllerConnected: localControllerSocket?.readyState === 1,
      automationConnected: automationSocket?.readyState === 1,
      automationEnabled,
      inputSource,
      sourceReady,
      esp32SerialPort: config.esp32SerialPort || null,
      esp32SerialConnected: esp32Serial?.isOpen === true,
      esp32SerialError,
      esp32SerialFramesWritten,
      esp32SerialFramesDropped,
      esp32SerialFramesCoalesced,
      esp32DigitalEdgeFramesQueued,
      esp32DigitalEdgeFramesWritten,
      esp32DigitalEdgeFramesDropped,
      esp32SerialQueueBytes: esp32Serial ? esp32Serial.writableLength + (pendingEsp32Frame?.length ?? 0) + esp32EdgeFrames.length * 8 : null,
      esp32BootCount,
      esp32LastReset,
      esp32LastInputLatencyMs,
      esp32InputStateChanges,
      esp32BleConnIntervalUnits,
      esp32BleConnIntervalMs: esp32BleConnIntervalUnits == null ? null : esp32BleConnIntervalUnits * 1.25,
      esp32BleConnects,
      esp32BleDisconnects,
      esp32BleConnected,
      esp32BleLastDisconnectReason,
      esp32HidSubscribes,
      esp32HidUnsubscribes,
      esp32HidTaskStarts,
      esp32BleQueueFree,
      esp32BleQueueCeiling,
      esp32BleCongestionSkips,
      esp32BlePendingSkips,
      esp32BleNotifyCompletions,
      esp32InputTransitions,
      esp32InputPresses,
      esp32InputReleases,
      esp32HidFramesEnqueued,
      esp32HidEnqueueTransitions,
      esp32HidFramesDequeued,
      esp32HidDequeueTransitions,
      esp32HidQueueDrops,
      esp32HidDuplicateStates,
      esp32HidQueueDepth,
      esp32HidQueueHighWater,
      esp32HidNotifyFailures,
      esp32HidNotifyRecoveries,
      esp32BleNotifications,
      esp32BleInputTransitions,
      esp32RumbleFramesReceived,
      currentRumble,
    }));
    return;
  }
  const pathname = request.url === "/" ? "/index.html" : new URL(request.url, "http://localhost").pathname;
  const candidate = path.resolve(publicDir, `.${pathname}`);
  if (!candidate.startsWith(`${publicDir}${path.sep}`)) {
    response.writeHead(403).end();
    return;
  }
  fs.readFile(candidate, (error, data) => {
    if (error) {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(200, { "content-type": mime.get(path.extname(candidate)) || "application/octet-stream" });
    response.end(data);
  });
});

const websocket = new WebSocketServer({ noServer: true, maxPayload: 2048 });
websocket.on("connection", (socket, request) => {
  // The local bridge is intentionally loopback-only. Remote users terminate at the host browser via WebRTC.
  if (!isLocalClient(request)) {
    socket.close(1008, "local clients only");
    return;
  }
  // Keep the first tab stable. Reconnecting background tabs are rejected and
  // cannot create an ownership loop. A user gesture can explicitly take over.
  const takeover = new URL(request.url, "http://localhost").searchParams.get("takeover") === "1";
  if (localControllerSocket?.readyState === 1) {
    if (!takeover) {
      socket.close(4001, "controller is active in another tab");
      return;
    }
    const previousSocket = localControllerSocket;
    localControllerSocket = socket;
    previousSocket.close(4001, "controller moved by explicit takeover");
  } else {
    localControllerSocket = socket;
  }
  if (socket.readyState === 1) socket.send(JSON.stringify(currentRumble));
  sendSourceStatus();
  socket.bridgeAlive = true;
  socket.on("pong", () => { socket.bridgeAlive = true; });
  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.type === "source" && typeof message.source === "string") {
        switchInputSource(message.source);
        return;
      }
      if (message.type !== "input") return;
      if (!sourceReady || inputSource !== (message.source === "pro" ? "pro" : "browser")) {
        const digital = acceptDigitalEdges(message);
        if (digital.sid && digital.edgeAck !== null && socket.readyState === 1) {
          socket.send(JSON.stringify({ type: "edge-ack", sid: digital.sid, edgeAck: digital.edgeAck }));
        }
        return;
      }
      const nextState = sanitizeState(message.state);
      const stateChanged = JSON.stringify(nextState) !== JSON.stringify(currentState);
      if (stateChanged) {
        lastBrowserStateChange = Date.now();
      }
      const digital = acceptDigitalEdges(message);
      if (digital.states.length) {
        browserDigitalEdgesAccepted += digital.states.length;
        lastBrowserStateChange = Date.now();
        queueEsp32Edges(digital.states);
      }
      currentState = nextState;
      lastBrowserInput = Date.now();
      browserMessagesReceived += 1;
      const finalEdgeState = digital.states.at(-1);
      const finalStateAlreadyQueued = finalEdgeState && sameState(finalEdgeState, currentState);
      // Analog states remain latest-value-wins. Digital transitions are queued
      // separately above, so a release can never overwrite an unsent press.
      sendState(currentState, stateChanged && !finalStateAlreadyQueued);
      if (digital.sid && digital.edgeAck !== null && socket.readyState === 1) {
        socket.send(JSON.stringify({ type: "edge-ack", sid: digital.sid, edgeAck: digital.edgeAck }));
      }
    } catch {
      socket.close(1003, "invalid message");
    }
  });
  socket.on("close", () => {
    if (socket !== localControllerSocket) return;
    localControllerSocket = null;
    lastBrowserInput = 0;
    switchInputSource("browser", true);
  });
});

// A second local connection supplies automation while the browser keeps its
// manual controller connection. Only one source is forwarded to COM at a time.
const automationWebsocket = new WebSocketServer({ noServer: true, maxPayload: 2048 });
server.on("upgrade", (request, socket, head) => {
  // Browsers on other websites must not control a loopback service.
  if (request.headers.origin && request.headers.origin !== `http://127.0.0.1:${config.httpPort}`) {
    socket.destroy();
    return;
  }
  let pathname;
  try { pathname = new URL(request.url, "http://localhost").pathname; } catch {
    socket.destroy();
    return;
  }
  const target = pathname === "/control" ? websocket : pathname === "/automation" ? automationWebsocket : null;
  if (!target) {
    socket.destroy();
    return;
  }
  target.handleUpgrade(request, socket, head, (client) => target.emit("connection", client, request));
});
automationWebsocket.on("connection", (socket, request) => {
  if (!isLocalClient(request)) {
    socket.close(1008, "local clients only");
    return;
  }
  if (automationSocket?.readyState === 1) {
    socket.close(4001, "automation client is already connected");
    return;
  }
  automationSocket = socket;
  sendAutomationStatus();
  socket.on("message", (raw) => {
    if (socket !== automationSocket) return;
    let message;
    try { message = JSON.parse(raw.toString()); } catch {
      socket.close(1003, "invalid message");
      return;
    }
    if (message.type !== "input" || !automationEnabled || !sourceReady) return;
    const nextState = sanitizeState(message.state);
    const digital = acceptDigitalEdges(message);
    if (digital.states.length) queueEsp32Edges(digital.states);
    currentState = nextState;
    automationLastInputAt = Date.now();
    const lastEdge = digital.states.at(-1);
    sendState(currentState, !lastEdge || !sameState(lastEdge, currentState));
    if (digital.sid && digital.edgeAck !== null) {
      socket.send(JSON.stringify({ type: "edge-ack", sid: digital.sid, edgeAck: digital.edgeAck }));
    }
  });
  socket.on("close", () => {
    if (socket !== automationSocket) return;
    disableAutomation();
    automationSocket = null;
  });
});

setInterval(() => {
  if (inputSource !== "automation" && lastBrowserInput && Date.now() - lastBrowserInput > 1200) {
    lastBrowserInput = 0;
    switchInputSource(inputSource, true);
  }
  if (automationEnabled && automationLastInputAt && Date.now() - automationLastInputAt > AUTOMATION_INPUT_TIMEOUT_MS) {
    disableAutomation("Python input timeout");
  }
}, 100).unref();

setInterval(() => {
  const socket = localControllerSocket;
  if (!socket || socket.readyState !== 1) return;
  if (!socket.bridgeAlive) {
    socket.terminate();
    return;
  }
  socket.bridgeAlive = false;
  socket.ping();
}, 1000).unref();

server.listen(config.httpPort, "127.0.0.1", () => {
  console.log(`Controller host: http://127.0.0.1:${config.httpPort}`);
  console.log(`ESP32 serial port: ${config.esp32SerialPort}`);
});

function shutdown() {
  automationEnabled = false;
  forceNeutral();
  setTimeout(() => process.exit(0), 30);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
