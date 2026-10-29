import { setupKeyboardBindings } from "./keymap.js";
import { gamepadState, setupGamepadBindings } from "./gamepad-map.js";
import { createHapticsController } from "./haptics.js";
import { DigitalEdgeHistory, highestDigitalEdgeSequence } from "./input-reliability.js";
import {
  DATA_CHANNEL_HIGH_WATER,
  DATA_CHANNEL_LOW_WATER,
  DATA_CHANNEL_OPTIONS,
  P2P_ACK_TIMEOUT_MS,
  TRANSPORT_P2P,
  TRANSPORT_RELAY,
  buildGuestLink,
  normalizeTransportMode,
  transportModeLabel,
} from "./transport.js";
const neutral = () => ({ buttons: 0, hat: 8, lx: 128, ly: 128, rx: 128, ry: 128 });
let state = neutral(), socket, dataChannel, signalSocket, peer, reconnectTimer, signalReconnectTimer, peerStatsTimer, p2pWatchTimer, peerDisconnectTimer, localSocketReplaced = false;
let relaySequence = 0, lastRelaySequence = -1, canControl = true, activeGuestId = null;
let pendingDataPayload = null, pendingRelayState = null, relayInFlightSequence = null, relayAckTimer = null;
let p2pSequence = 0, lastP2pAckAt = 0, lastP2pSendAt = 0;
let localGuestId = null;
let digitalEdges;
const edgeRetryTimers = new Set();
const params = new URLSearchParams(location.search);
const remoteCode = params.get("remote")?.toUpperCase();
const remoteTransportMode = normalizeTransportMode(params.get("transport"));
let hostTransportMode = TRANSPORT_P2P;
const status = document.querySelector("#status");
const gamepadLabel = document.querySelector("#gamepad");
const sourceSelect = document.querySelector("#input-source");
const sourceStatus = document.querySelector("#source-status");
const proDiagnostics = document.querySelector("#pro-diagnostics");
const proRaw = document.querySelector("#pro-raw");
let inputSource = "browser";
let lastProInputAt = 0;
const PRO_TIMEOUT_MS = 1200;
const controller = document.querySelector(".controller");
const heldHats = new Set(), downKeys = new Set();
const heldKeyboardSticks = { left: new Set(), right: new Set() };
const claimControl = document.querySelector("#claim-control");
const topControlState = document.querySelector("#top-control-state");
const rumbleToggle = document.querySelector("#rumble-toggle");
const rumbleStatus = document.querySelector("#rumble-status");
const activeGamepad = () => typeof navigator.getGamepads === "function"
  ? [...navigator.getGamepads()].find((pad) => pad?.connected !== false) : null;
const haptics = createHapticsController({
  getGamepad: activeGamepad,
  storage: localStorage,
  isVisible: () => document.visibilityState === "visible",
  onStatus: (state, enabled) => {
    const labels = { off: "停止中", waiting: "ゲームパッド待ち", ready: "使用可能", unsupported: "非対応" };
    rumbleToggle.textContent = enabled ? "振動 ON" : "振動 OFF";
    rumbleToggle.setAttribute("aria-pressed", String(enabled));
    rumbleToggle.classList.toggle("enabled", enabled);
    rumbleStatus.textContent = labels[state] || "確認中";
  },
});
rumbleToggle.addEventListener("click", () => haptics.toggle());
controller.addEventListener("contextmenu", (event) => event.preventDefault());
controller.addEventListener("selectstart", (event) => event.preventDefault());
controller.addEventListener("dblclick", (event) => event.preventDefault());

function connect(takeover = false) {
  if (socket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(socket.readyState)) return;
  socket = new WebSocket(`ws://${location.host}/control${takeover ? "?takeover=1" : ""}`);
  socket.addEventListener("open", () => {
    localSocketReplaced = false;
    status.textContent = "PC→デバイス接続済み（Switch接続は未確認）";
    status.className = "status waiting";
    socket.send(JSON.stringify({ type: "source", source: inputSource }));
  });
  socket.addEventListener("message", ({ data }) => {
    try {
      const message = JSON.parse(data);
      if (message.type === "edge-ack" && message.sid === digitalEdges?.sessionId) digitalEdges.acknowledge(message.edgeAck);
      if (message.type === "source-status") {
        if (message.source !== inputSource) {
          resetInput(); resetDigitalSession(); inputSource = message.source;
          sourceSelect.value = inputSource; previousGamepad = "";
        }
        sourceStatus.textContent = message.ready
          ? `入力元: ${{ browser: "ブラウザー操作", pro: "Proコントローラー", automation: "自動操作" }[message.source] || message.source}`
          : "ESP32接続待ち / ニュートラル送信中";
      }
      if (message.type === "rumble") routeRumble(message);
    } catch { }
  });
  socket.addEventListener("close", (event) => {
    if (event.code === 4001) {
      localSocketReplaced = true;
      status.textContent = "別タブで操作中（タップして戻す）"; status.className = "status waiting reclaimable";
      return;
    }
    status.textContent = "再接続中"; status.className = "status offline";
    clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connect, 800);
  });
}

function reclaimLocalBridge() {
  if (remoteCode || !localSocketReplaced) return;
  localSocketReplaced = false;
  socket = undefined;
  status.textContent = "操作を戻しています"; status.className = "status waiting";
  connect(true);
}
status.addEventListener("click", reclaimLocalBridge);
addEventListener("pointerdown", reclaimLocalBridge, { capture: true });
addEventListener("keydown", reclaimLocalBridge, { capture: true });

function flushDataChannel() {
  const channel = dataChannel;
  if (!pendingDataPayload || channel?.readyState !== "open" || channel.bufferedAmount >= DATA_CHANNEL_HIGH_WATER) return;
  const payload = pendingDataPayload;
  pendingDataPayload = null;
  try {
    channel.send(payload);
    lastP2pSendAt = Date.now();
  } catch {
    pendingDataPayload = payload;
  }
}

function resetRemoteSendQueues() {
  pendingDataPayload = null;
  pendingRelayState = null;
  relayInFlightSequence = null;
  clearTimeout(relayAckTimer);
  relayAckTimer = null;
  clearInterval(peerStatsTimer);
  peerStatsTimer = null;
  clearInterval(p2pWatchTimer);
  p2pWatchTimer = null;
  clearTimeout(peerDisconnectTimer);
  peerDisconnectTimer = null;
  for (const timer of edgeRetryTimers) clearTimeout(timer);
  edgeRetryTimers.clear();
}

function routeRumble(message) {
  if (remoteCode || !activeGuestId) {
    haptics.handle(message);
    return;
  }
  const payload = JSON.stringify(message);
  const stopping = message.duration === 0 || (message.strong === 0 && message.weak === 0);
  if (dataChannel?.readyState === "open") {
    // Haptics are latest-value-wins. Never add them behind a congested input/ack queue.
    if (dataChannel.bufferedAmount < DATA_CHANNEL_LOW_WATER) {
      try { dataChannel.send(payload); } catch { }
    } else if (stopping && signalSocket?.readyState === WebSocket.OPEN) {
      // A stop may bypass a congested P2P queue through the relay. Its higher
      // sequence makes any older unordered P2P vibration harmless on arrival.
      try { signalSocket.send(payload); } catch { }
    }
    return;
  }
  if (signalSocket?.readyState === WebSocket.OPEN) {
    try { signalSocket.send(payload); } catch { }
  }
}

function fallbackGuestToRelay(reason = "P2P応答なし") {
  if (!remoteCode || !canControl) return;
  const oldChannel = dataChannel, oldPeer = peer;
  dataChannel = null;
  peer = null;
  if (oldChannel) oldChannel.onclose = null;
  if (oldPeer) oldPeer.onconnectionstatechange = null;
  try { oldChannel?.close(); } catch { }
  try { oldPeer?.close(); } catch { }
  resetRemoteSendQueues();
  status.textContent = `操作権取得済み（リレー・${reason}）`;
  status.className = "status online";
  pendingRelayState = digitalEdges.envelope(state);
  flushRelay();
}

function startP2pWatch() {
  clearInterval(p2pWatchTimer);
  lastP2pAckAt = Date.now();
  lastP2pSendAt = 0;
  p2pWatchTimer = setInterval(() => {
    if (dataChannel?.readyState !== "open" || !lastP2pSendAt) return;
    if (Date.now() - lastP2pAckAt > P2P_ACK_TIMEOUT_MS) fallbackGuestToRelay("P2P無応答");
  }, 250);
}

function flushRelay() {
  if (!pendingRelayState || relayInFlightSequence !== null || signalSocket?.readyState !== WebSocket.OPEN) return;
  const seq = relaySequence++;
  const nextInput = pendingRelayState;
  pendingRelayState = null;
  relayInFlightSequence = seq;
  signalSocket.send(JSON.stringify({ type: "input", seq, ...nextInput }));
  clearTimeout(relayAckTimer);
  relayAckTimer = setTimeout(() => {
    if (relayInFlightSequence !== seq) return;
    relayInFlightSequence = null;
    pendingRelayState = digitalEdges.envelope(state);
    flushRelay();
  }, 500);
}

function acknowledgeRelay(message) {
  if (Number.isSafeInteger(message?.edgeAck)) digitalEdges.acknowledge(message.edgeAck);
  const seq = message?.seq;
  if (!Number.isSafeInteger(seq) || seq !== relayInFlightSequence) return;
  relayInFlightSequence = null;
  clearTimeout(relayAckTimer);
  relayAckTimer = null;
  flushRelay();
}

async function refreshPeerStats() {
  if (!peer || peer.connectionState !== "connected") return;
  try {
    const stats = await peer.getStats();
    let pair;
    for (const report of stats.values()) {
      if (report.type === "transport" && report.selectedCandidatePairId) pair = stats.get(report.selectedCandidatePairId);
    }
    if (!pair) for (const report of stats.values()) {
      if (report.type === "candidate-pair" && report.state === "succeeded" && report.nominated) { pair = report; break; }
    }
    if (!pair) return;
    const remoteCandidate = stats.get(pair.remoteCandidateId);
    const route = remoteCandidate?.candidateType === "relay" ? "TURN" : "direct";
    const rtt = Number.isFinite(pair.currentRoundTripTime) ? `・RTT ${Math.round(pair.currentRoundTripTime * 1000)}ms` : "";
    const label = `P2P/${route}${rtt}`;
    if (remoteCode && canControl && dataChannel?.readyState === "open") status.textContent = `操作権取得済み（${label}）`;
    else if (!remoteCode && dataChannel?.readyState === "open") document.querySelector("#session-code").dataset.transport = `${label}操作中`;
  } catch { }
}

function startPeerStats() {
  clearInterval(peerStatsTimer);
  refreshPeerStats();
  peerStatsTimer = setInterval(refreshPeerStats, 1000);
}

function send() {
  const envelope = digitalEdges.envelope(state);
  if (remoteCode) {
    if (!canControl) return;
    if (dataChannel?.readyState === "open") {
      pendingDataPayload = JSON.stringify({ ...envelope, _p2pSeq: p2pSequence++ });
      flushDataChannel();
    } else if (signalSocket?.readyState === WebSocket.OPEN) {
      pendingRelayState = envelope;
      flushRelay();
    }
  } else if (socket?.readyState === WebSocket.OPEN && inputSource !== "automation") socket.send(JSON.stringify({ type: "input", source: inputSource, ...envelope }));
}
function forwardInput(message) {
  const envelope = {
    state: message?.state && typeof message.state === "object" ? message.state : message,
    sid: message?.sid,
    edges: message?.edges,
  };
  state = envelope.state;
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify({ type: "input", ...envelope }));
  return true;
}
// Input handlers send changes immediately; this 100 Hz refresh keeps held
// buttons/sticks alive and bounds recovery time after a lost network packet.
setInterval(send, 10);

const defaultIce = [{ urls: "stun:stun.cloudflare.com:3478" }];
async function iceServers(base, code) {
  try { const response = await fetch(`${base}/api/ice/${code}`); if (response.ok) return (await response.json()).iceServers; } catch { }
  return defaultIce;
}
function websocketUrl(base, route) {
  const url = new URL(route, base); url.protocol = url.protocol === "https:" ? "wss:" : "ws:"; return url;
}
function randomBase32(length) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((value) => alphabet[value % alphabet.length]).join("");
}
function randomHex(length) { return [...crypto.getRandomValues(new Uint8Array(length))].map(v => v.toString(16).padStart(2, "0")).join(""); }
digitalEdges = new DigitalEdgeHistory(randomHex(8), state);
function resetInput() {
  state = neutral(); heldHats.clear(); downKeys.clear();
  heldKeyboardSticks.left.clear(); heldKeyboardSticks.right.clear();
  digitalEdges.observe(state);
}
function selectInputSource(source) {
  if (source === inputSource) return;
  resetInput();
  resetDigitalSession();
  document.querySelectorAll(".controller-v2 .active").forEach((element) => element.classList.remove("active"));
  document.querySelectorAll(".controller-v2 .stick-knob").forEach((element) => { element.style.transform = ""; });
  inputSource = source;
  previousGamepad = "";
  lastProInputAt = 0;
  sourceStatus.textContent = "ニュートラル送信中";
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "source", source }));
}
sourceSelect.addEventListener("change", () => selectInputSource(sourceSelect.value));
function resetDigitalSession() { digitalEdges.reset(randomHex(8), state); }
function scheduleDigitalRetries() {
  if (!remoteCode || !canControl) return;
  for (const delay of [12, 30]) {
    const timer = setTimeout(() => { edgeRetryTimers.delete(timer); send(); }, delay);
    edgeRetryTimers.add(timer);
  }
}
function sendDigitalChange() {
  const changed = digitalEdges.observe(state);
  send();
  if (changed) scheduleDigitalRetries();
}
function setControlEnabled(enabled) {
  canControl = enabled; if (enabled) previousGamepad = ""; controller.classList.toggle("locked", !enabled);
  if (!enabled) { haptics.stop(); resetInput(); resetRemoteSendQueues(); peer?.close(); peer = null; dataChannel = null; }
  else resetDigitalSession();
  document.querySelector("#control-state").textContent = enabled ? "あなたが操作中です" : "操作権が渡されるまで待機してください";
  if (remoteCode) {
    claimControl.disabled = enabled || signalSocket?.readyState !== WebSocket.OPEN;
    claimControl.textContent = enabled ? "操作中" : "操作権を取る";
    topControlState.textContent = enabled ? "あなたが操作中です" : "全員が操作権を取得できます";
  }
}

claimControl.onclick = () => signalSocket?.send(JSON.stringify({ type: "claim" }));

async function connectGuest() {
  if (signalSocket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(signalSocket.readyState)) return;
  const nameInput = document.querySelector("#guest-name");
  const name = nameInput.value.trim().slice(0, 32);
  if (!name) { nameInput.focus(); return; }
  localStorage.setItem("guestName", name);
  document.querySelector("#join-session").disabled = true;
  const storageKey = `guestId:${remoteCode}`;
  const guestId = sessionStorage.getItem(storageKey) || randomHex(8);
  sessionStorage.setItem(storageKey, guestId);
  localGuestId = guestId;
  const base = location.origin, ice = await iceServers(base, remoteCode);
  const query = new URLSearchParams({ role: "guest", id: guestId, name });
  signalSocket = new WebSocket(websocketUrl(base, `/api/room/${remoteCode}?${query}`));
  const guestSignalSocket = signalSocket;
  signalSocket.onopen = () => {
    document.querySelector("#guest-join-fields").hidden = true;
    status.textContent = "ロビー参加中"; status.className = "status online";
    claimControl.disabled = false;
    topControlState.textContent = "全員が操作権を取得できます";
  };
  signalSocket.onmessage = async ({ data }) => {
    const message = JSON.parse(data);
    if (message.type === "participants") renderGuestParticipants(message.participants);
    if (message.type === "input-ack") acknowledgeRelay(message);
    if (message.type === "rumble" && canControl) haptics.handle(message);
    if (message.type === "control") {
      setControlEnabled(message.active);
      status.textContent = message.active
        ? remoteTransportMode === TRANSPORT_RELAY ? "操作権取得済み（リレー固定）" : "操作権取得済み（P2P接続待ち・一時リレー）"
        : "ロビーで待機中";
      status.className = message.active ? "status online" : "status waiting";
      if (message.active) { relaySequence = 0; resetInput(); send(); }
    } else if (message.type === "offer" && canControl && remoteTransportMode !== TRANSPORT_RELAY) {
      peer?.close(); peer = new RTCPeerConnection({ iceServers: ice });
      peer.onicecandidate = ({ candidate }) => candidate && signalSocket.send(JSON.stringify({ type: "ice", candidate }));
      const channel = peer.createDataChannel("input", DATA_CHANNEL_OPTIONS);
      dataChannel = channel;
      channel.bufferedAmountLowThreshold = DATA_CHANNEL_LOW_WATER;
      channel.onbufferedamountlow = flushDataChannel;
      channel.onmessage = ({ data }) => {
        try {
          const message = JSON.parse(data);
          if (message.type === "input-ack" && Number.isSafeInteger(message.seq)) {
            lastP2pAckAt = Date.now();
            digitalEdges.acknowledge(message.edgeAck);
          }
          if (message.type === "rumble" && canControl) haptics.handle(message);
        } catch { }
      };
      channel.onopen = () => { resetRemoteSendQueues(); p2pSequence = 0; status.textContent = "操作権取得済み（P2P）"; status.className = "status online"; startPeerStats(); startP2pWatch(); send(); };
      channel.onclose = () => {
        if (channel !== dataChannel) return;
        dataChannel = null;
        if (canControl) { resetRemoteSendQueues(); status.textContent = "操作権取得済み（リレー）"; send(); }
      };
      peer.onconnectionstatechange = () => {
        const connectionState = peer?.connectionState;
        if (!canControl) return;
        if (connectionState === "failed") fallbackGuestToRelay("P2P切断");
        else if (connectionState === "disconnected") {
          clearTimeout(peerDisconnectTimer);
          peerDisconnectTimer = setTimeout(() => {
            if (peer?.connectionState === "disconnected") fallbackGuestToRelay("P2P切断");
          }, 1000);
        } else if (connectionState === "connected") clearTimeout(peerDisconnectTimer);
      };
      await peer.setRemoteDescription(message.offer);
      await peer.setLocalDescription(await peer.createAnswer());
      signalSocket.send(JSON.stringify({ type: "answer", answer: peer.localDescription }));
    } else if (message.type === "ice" && peer) await peer.addIceCandidate(message.candidate);
  };
  signalSocket.onclose = (event) => {
    if (signalSocket !== guestSignalSocket) return;
    signalSocket = null;
    setControlEnabled(false); status.textContent = event.reason || "セッション終了"; status.className = "status offline";
    document.querySelector("#join-session").disabled = false;
    if ([1006, 1012, 1013].includes(event.code)) {
      status.textContent = "シグナリング再接続中";
      clearTimeout(signalReconnectTimer);
      signalReconnectTimer = setTimeout(connectGuest, 800);
    }
  };
}

function renderParticipants(participants) {
  const list = document.querySelector("#participant-list"); list.replaceChildren();
  document.querySelector("#participant-count").textContent = `${participants.length}人参加中`;
  for (const participant of participants) {
    const row = document.createElement("div"); row.className = `participant${participant.active ? " active" : ""}`;
    const label = document.createElement("span"); label.textContent = participant.active ? `${participant.name}（操作中）` : participant.name;
    const button = document.createElement("button"); button.textContent = participant.active ? "操作中" : "操作権を渡す";
    button.disabled = participant.active;
    button.onclick = () => signalSocket?.send(JSON.stringify({ type: "grant", guestId: participant.id }));
    row.append(label, button); list.append(row);
  }
  if (!participants.length) { const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "参加者を待っています"; list.append(empty); }
}

function renderGuestParticipants(participants) {
  const list = document.querySelector("#guest-participant-list"); list.replaceChildren();
  document.querySelector("#guest-participant-count").textContent = `${participants.length}人参加中`;
  for (const participant of participants) {
    const row = document.createElement("div"); row.className = `participant${participant.active ? " active" : ""}`;
    const label = document.createElement("span");
    label.textContent = `${participant.name}${participant.id === localGuestId ? "（自分）" : ""}${participant.active ? "（操作中）" : ""}`;
    const button = document.createElement("button");
    if (participant.active) { button.textContent = "操作中"; button.disabled = true; }
    else {
      button.textContent = participant.id === localGuestId ? "操作権を取る" : "この人に渡す";
      button.onclick = () => signalSocket?.send(JSON.stringify(participant.id === localGuestId ? { type: "claim" } : { type: "grant", guestId: participant.id }));
    }
    row.append(label, button); list.append(row);
  }
  if (!participants.length) { const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "参加者を待っています"; list.append(empty); }
}

async function startPeer(base, code, guestId) {
  activeGuestId = guestId; haptics.stop(); lastRelaySequence = -1; resetRemoteSendQueues(); resetInput(); send();
  const ice = await iceServers(base, code);
  peer?.close(); peer = new RTCPeerConnection({ iceServers: ice });
  const hostPeer = peer;
  dataChannel = peer.createDataChannel("input", DATA_CHANNEL_OPTIONS);
  const hostChannel = dataChannel;
  dataChannel.bufferedAmountLowThreshold = DATA_CHANNEL_LOW_WATER;
  dataChannel.onbufferedamountlow = flushDataChannel;
  dataChannel.onmessage = ({ data }) => {
    try {
      const message = JSON.parse(data);
      const forwarded = forwardInput(message);
      if (Number.isSafeInteger(message._p2pSeq) && hostChannel.readyState === "open") {
        hostChannel.send(JSON.stringify({
          type: "input-ack",
          seq: message._p2pSeq,
          edgeAck: forwarded ? highestDigitalEdgeSequence(message) : null,
        }));
      }
      document.querySelector("#session-code").dataset.transport = "P2P操作中";
    } catch { }
  };
  dataChannel.onopen = () => { document.querySelector("#session-code").dataset.transport = "P2P操作中"; startPeerStats(); };
  dataChannel.onclose = () => {
    if (dataChannel === hostChannel) dataChannel = null;
    resetInput(); send();
    if (signalSocket?.readyState === WebSocket.OPEN) document.querySelector("#session-code").dataset.transport = "リレー待機";
  };
  const returnHostToRelay = () => {
    if (peer !== hostPeer) return;
    dataChannel = null;
    peer = null;
    hostChannel.onclose = null;
    hostPeer.onconnectionstatechange = null;
    try { hostChannel.close(); } catch { }
    try { hostPeer.close(); } catch { }
    resetInput(); send();
    document.querySelector("#session-code").dataset.transport = "リレー操作中";
  };
  peer.onconnectionstatechange = () => {
    if (peer !== hostPeer) return;
    if (hostPeer.connectionState === "failed") returnHostToRelay();
    else if (hostPeer.connectionState === "disconnected") {
      clearTimeout(peerDisconnectTimer);
      peerDisconnectTimer = setTimeout(() => {
        if (hostPeer.connectionState === "disconnected") returnHostToRelay();
      }, 1000);
    } else if (hostPeer.connectionState === "connected") clearTimeout(peerDisconnectTimer);
  };
  peer.onicecandidate = ({ candidate }) => candidate && signalSocket.send(JSON.stringify({ type: "ice", candidate }));
  await peer.setLocalDescription(await peer.createOffer());
  signalSocket.send(JSON.stringify({ type: "offer", offer: peer.localDescription }));
}

function startRelayGuest(guestId) {
  activeGuestId = guestId;
  haptics.stop();
  lastRelaySequence = -1;
  peer?.close();
  peer = null;
  dataChannel = null;
  resetRemoteSendQueues();
  resetInput();
  send();
  document.querySelector("#session-code").dataset.transport = "リレー待機";
}

async function createHostSession() {
  signalSocket?.close(); peer?.close(); activeGuestId = null; dataChannel = null; haptics.stop(); renderParticipants([]);
  const baseInput = document.querySelector("#signal-base"), base = baseInput.value.replace(/\/$/, "");
  if (!/^https:\/\//.test(base)) { alert("HTTPSのCloudflare Worker URLを入力してください"); return; }
  localStorage.setItem("signalBase", base);
  hostTransportMode = normalizeTransportMode(document.querySelector("#transport-mode").value);
  localStorage.setItem("transportMode", hostTransportMode);
  const code = randomBase32(10), secret = randomHex(16);
  signalSocket = new WebSocket(websocketUrl(base, `/api/room/${code}?role=host&secret=${secret}`));
  const hostSignalSocket = signalSocket;
  signalSocket.onmessage = async ({ data }) => {
    if (signalSocket !== hostSignalSocket) return;
    const message = JSON.parse(data);
    if (message.type === "participants") renderParticipants(message.participants);
    else if (message.type === "control-released") {
      activeGuestId = null; peer?.close(); peer = null; dataChannel = null; haptics.stop(); resetInput(); send();
      document.querySelector("#session-code").dataset.transport = "操作権未割当";
    } else if (message.type === "peer-ready") {
      if (hostTransportMode === TRANSPORT_RELAY) startRelayGuest(message.guestId);
      else await startPeer(base, code, message.guestId);
    }
    else if (message.type === "answer" && peer) await peer.setRemoteDescription(message.answer);
    else if (message.type === "ice" && peer) await peer.addIceCandidate(message.candidate);
    else if (message.type === "input" && dataChannel?.readyState !== "open") {
      if (Number.isSafeInteger(message.seq) && message.seq > lastRelaySequence) {
        lastRelaySequence = message.seq; forwardInput(message);
        document.querySelector("#session-code").dataset.transport = "リレー操作中";
      }
      hostSignalSocket.send(JSON.stringify({ type: "input-ack", seq: message.seq, edgeAck: highestDigitalEdgeSequence(message) }));
    }
  };
  signalSocket.onclose = () => {
    if (signalSocket !== hostSignalSocket) return;
    signalSocket = null;
    peer?.close(); activeGuestId = null; dataChannel = null; haptics.stop(); resetInput(); send(); renderParticipants([]);
    document.querySelector("#session-code").textContent = `${code}（セッション切断）`;
  };
  const link = buildGuestLink(base, code, hostTransportMode);
  const codeLabel = document.querySelector("#session-code"); codeLabel.textContent = code; codeLabel.dataset.transport = "操作権未割当";
  const anchor = document.querySelector("#guest-link"); anchor.href = link; anchor.textContent = link;
  document.querySelector("#release-control").disabled = false;
  document.querySelector("#revoke-session").disabled = false;
}

document.querySelector("#signal-base").value = localStorage.getItem("signalBase") || "https://switch2-remote-signal.y52en.workers.dev";
document.querySelector("#transport-mode").value = normalizeTransportMode(localStorage.getItem("transportMode"));
document.querySelector("#new-session").onclick = createHostSession;
document.querySelector("#release-control").onclick = () => signalSocket?.send(JSON.stringify({ type: "release" }));
document.querySelector("#revoke-session").onclick = () => {
  signalSocket?.send(JSON.stringify({ type: "revoke" })); peer?.close(); activeGuestId = null; dataChannel = null; lastRelaySequence = -1;
  resetRemoteSendQueues(); resetInput(); send(); renderParticipants([]); document.querySelector("#session-code").textContent = "終了済み（新しいセッションを発行してください）";
};
document.querySelector("#join-session").onclick = connectGuest;
document.querySelector("#guest-name").value = localStorage.getItem("guestName") || "";
const guestNameInput = document.querySelector("#guest-name");
let guestJoinTimer;
function scheduleGuestJoin() {
  clearTimeout(guestJoinTimer);
  if (guestNameInput.value.trim()) guestJoinTimer = setTimeout(connectGuest, 450);
}
guestNameInput.addEventListener("input", scheduleGuestJoin);
guestNameInput.addEventListener("change", connectGuest);
guestNameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); clearTimeout(guestJoinTimer); connectGuest(); guestNameInput.blur(); }
});
if (remoteCode && guestNameInput.value.trim()) queueMicrotask(connectGuest);

function setButton(bit, pressed) {
  if (!remoteCode && inputSource !== "browser") return;
  state.buttons = pressed ? state.buttons | (1 << bit) : state.buttons & ~(1 << bit);
  document.querySelector(`[data-button="${bit}"]`)?.classList.toggle("active", pressed); sendDigitalChange();
}
function combinedHat() {
  const up = heldHats.has(0), right = heldHats.has(2), down = heldHats.has(4), left = heldHats.has(6);
  if (up && right) return 1; if (right && down) return 3; if (down && left) return 5; if (left && up) return 7;
  if (up) return 0; if (right) return 2; if (down) return 4; if (left) return 6; return 8;
}
function setHat(direction, pressed) {
  if (!remoteCode && inputSource !== "browser") return;
  pressed ? heldHats.add(direction) : heldHats.delete(direction); state.hat = combinedHat();
  document.querySelector(`[data-hat="${direction}"]`)?.classList.toggle("active", pressed); sendDigitalChange();
}
function setKeyboardStick(side, direction, pressed) {
  if (!remoteCode && inputSource !== "browser") return;
  const held = heldKeyboardSticks[side];
  pressed ? held.add(direction) : held.delete(direction);
  const horizontal = held.has("left") === held.has("right") ? 128 : held.has("left") ? 0 : 255;
  const vertical = held.has("up") === held.has("down") ? 128 : held.has("up") ? 0 : 255;
  if (side === "left") { state.lx = horizontal; state.ly = vertical; }
  else { state.rx = horizontal; state.ry = vertical; }
  send();
}
for (const button of document.querySelectorAll("[data-button], [data-hat]")) {
  const update = (pressed) => button.dataset.button !== undefined ? setButton(Number(button.dataset.button), pressed) : setHat(Number(button.dataset.hat), pressed);
  button.addEventListener("pointerdown", (event) => { event.preventDefault(); button.setPointerCapture(event.pointerId); update(true); });
  button.addEventListener("pointerup", () => update(false)); button.addEventListener("pointercancel", () => update(false));
  button.addEventListener("lostpointercapture", () => update(false));
}
const handleKeyboard = setupKeyboardBindings((action, pressed) => {
  if (action.type === "claim") {
    if (pressed && remoteCode && !canControl && signalSocket?.readyState === WebSocket.OPEN) {
      signalSocket.send(JSON.stringify({ type: "claim" }));
    }
    return;
  }
  if (remoteCode && !canControl) return;
  if (!remoteCode && inputSource !== "browser") return;
  if (action.type === "hat") setHat(action.value, pressed);
  else if (action.type === "stick") setKeyboardStick(action.side, action.direction, pressed);
  else setButton(action.value, pressed);
});
function keyboard(event, pressed) {
  if (pressed && downKeys.has(event.code)) return;
  const handled = handleKeyboard(event, pressed);
  if (!pressed) downKeys.delete(event.code);
  if (!handled) return;
  if (pressed) downKeys.add(event.code);
}
addEventListener("keydown", (event) => keyboard(event, true));
addEventListener("keyup", (event) => keyboard(event, false));
const readGamepad = setupGamepadBindings((action, pressed) => {
  if (action.type === "claim" && pressed && remoteCode && !canControl && signalSocket?.readyState === WebSocket.OPEN) {
    signalSocket.send(JSON.stringify({ type: "claim" }));
  }
});
let previousGamepad = "";
function pollGamepad() {
  const pad = activeGamepad();
  const activeActions = readGamepad(pad);
  if (pad) {
    gamepadLabel.textContent = `ゲームパッド: ${pad.id}`;
    if ((remoteCode && canControl) || (!remoteCode && inputSource === "pro" && pad.buttons.length >= 16 && pad.axes.length >= 4)) {
      const next = gamepadState(pad, activeActions, { dpadFromLeftStick: remoteCode !== undefined });
      if (!remoteCode) {
        lastProInputAt = Date.now();
        proDiagnostics.textContent = `Gamepad API: ${pad.id} / mapping=${pad.mapping || "不明"} / ${pad.buttons.length}ボタン / ${pad.axes.length}軸`;
        proRaw.textContent = `押下: ${pad.buttons.map((button, index) => button.pressed ? index : null).filter((index) => index !== null).join(", ") || "なし"}\n軸: ${pad.axes.map((axis) => axis.toFixed(2)).join(", ")}\n変換後: ${JSON.stringify(next)}`;
      }
      const serialized = JSON.stringify(next); if (serialized !== previousGamepad) {
        state = next; previousGamepad = serialized;
        const digitalChanged = digitalEdges.observe(state);
        send();
        if (digitalChanged) scheduleDigitalRetries();
      }
    }
    if (!remoteCode && inputSource === "pro" && (pad.buttons.length < 16 || pad.axes.length < 4)) {
      proDiagnostics.textContent = `Gamepad API: 入力形式が不足（${pad.buttons.length}ボタン / ${pad.axes.length}軸）。中継停止中`;
      proRaw.textContent = `押下: ${pad.buttons.map((button, index) => button.pressed ? index : null).filter((index) => index !== null).join(", ")}\n軸: ${pad.axes.join(", ")}`;
      if (lastProInputAt) { resetInput(); lastProInputAt = 0; send(); }
    }
  } else {
    gamepadLabel.textContent = "ゲームパッド未接続";
    proDiagnostics.textContent = typeof navigator.getGamepads === "function"
      ? "Gamepad API: ゲームパッド未接続。Bluetooth接続後にボタンを押してください。"
      : "Gamepad API: このブラウザーでは利用できません。中継停止中";
    proRaw.textContent = "";
    if (!remoteCode && inputSource === "pro" && lastProInputAt) {
      resetInput(); previousGamepad = ""; lastProInputAt = 0; send();
    }
  }
  if (!remoteCode && inputSource === "pro" && lastProInputAt && Date.now() - lastProInputAt > PRO_TIMEOUT_MS) {
    resetInput(); previousGamepad = ""; lastProInputAt = 0; send();
  }
  haptics.refresh();
  requestAnimationFrame(pollGamepad);
}
addEventListener("blur", () => { resetInput(); send(); });
addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { haptics.stop(); resetInput(); send(); }
  if (!remoteCode && document.visibilityState === "visible" && localSocketReplaced) connect(true);
});
addEventListener("pagehide", () => { haptics.stop(); resetInput(); send(); });
if (remoteCode) {
  document.querySelector("#input-source-panel").hidden = true;
  canControl = false; controller.classList.add("locked"); document.querySelector("#session-panel").hidden = true;
  document.querySelector("#top-control-bar").hidden = false;
  document.querySelector("#guest-panel").hidden = false; document.querySelector("#remote-code").textContent = remoteCode;
  document.querySelector("#remote-transport").textContent = transportModeLabel(remoteTransportMode);
} else { document.querySelector("#guest-panel").hidden = true; connect(); renderParticipants([]); }
pollGamepad();

async function refreshDeviceDiagnostics() {
  if (remoteCode) {
    document.querySelector("#device-diagnostics").hidden = true;
    return;
  }
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    const device = await response.json();
    document.querySelector("#diag-browser").textContent = device.localControllerConnected ? "接続" : "切断";
    const serialPort = device.esp32SerialPort || "未設定";
    document.querySelector("#diag-serial").textContent = device.esp32SerialConnected
      ? `${serialPort} 接続`
      : `${serialPort}: ${device.esp32SerialError || "切断"}`;
    document.querySelector("#diag-frames").textContent = `${device.esp32SerialFramesWritten.toLocaleString()} / 破棄 ${device.esp32SerialFramesDropped.toLocaleString()}`;
    document.querySelector("#diag-queue").textContent = `${device.esp32SerialQueueBytes ?? 0} byte`;
    document.querySelector("#diag-input-latency").textContent = device.esp32LastInputLatencyMs == null ? "計測待ち" : `${device.esp32LastInputLatencyMs} ms`;
    document.querySelector("#diag-ble-interval").textContent = device.esp32BleConnIntervalMs == null ? "接続待ち" : `${device.esp32BleConnIntervalMs} ms`;
    document.querySelector("#diag-ble-queue").textContent = device.esp32BleQueueFree == null ? "計測待ち" : `${device.esp32BleQueueFree}/${device.esp32BleQueueCeiling}・待機 ${device.esp32BleCongestionSkips}`;
  } catch {
    document.querySelector("#diag-browser").textContent = "取得失敗";
  }
}
refreshDeviceDiagnostics();
setInterval(refreshDeviceDiagnostics, 1000);

function setupVirtualStick(element) {
  const side = element.dataset.stick;
  const ring = element.querySelector(".stick-ring"), knob = element.querySelector(".stick-knob");
  const xKey = side === "left" ? "lx" : "rx", yKey = side === "left" ? "ly" : "ry";
  let pointerId = null;
  function update(event) {
    if (!remoteCode && inputSource !== "browser") return;
    const rect = ring.getBoundingClientRect();
    let x = (event.clientX - (rect.left + rect.width / 2)) / (rect.width * .42);
    let y = (event.clientY - (rect.top + rect.height / 2)) / (rect.height * .42);
    const magnitude = Math.hypot(x, y);
    if (magnitude > 1) { x /= magnitude; y /= magnitude; }
    state[xKey] = Math.round((x + 1) * 127.5);
    state[yKey] = Math.round((y + 1) * 127.5);
    knob.style.transform = `translate(${x * 54}%, ${y * 54}%)`;
    send();
  }
  function reset(event) {
    if (pointerId === null || (event?.pointerId !== undefined && event.pointerId !== pointerId)) return;
    pointerId = null; state[xKey] = 128; state[yKey] = 128;
    knob.style.transform = ""; element.classList.remove("active"); send();
  }
  element.addEventListener("pointerdown", (event) => {
    if (pointerId !== null) return;
    event.preventDefault(); pointerId = event.pointerId; element.setPointerCapture(pointerId);
    element.classList.add("active"); update(event);
  });
  element.addEventListener("pointermove", (event) => { if (event.pointerId === pointerId) update(event); });
  element.addEventListener("pointerup", reset);
  element.addEventListener("pointercancel", reset);
  element.addEventListener("lostpointercapture", reset);
}
document.querySelectorAll(".controller-v2 [data-stick]").forEach(setupVirtualStick);
