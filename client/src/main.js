
"use strict";

// ============================================================
// VOXYCAST - MAIN CLIENT
// Rooms, WebRTC voice, audio devices, settings and updates
// ============================================================

// -------------------- DOM ELEMENTS --------------------

const $ = (id) => document.getElementById(id);

const statusText = $("status");
const voiceStateText = $("voiceState");
const usernameInput = $("username");
const roomCodeInput = $("roomCode");
const createRoomBtn = $("createRoom");
const joinRoomBtn = $("joinRoom");
const leaveRoomBtn = $("leaveRoom");
const muteMicBtn = $("muteMic");
const deafenAudioBtn = $("deafenAudio");
const currentRoomText = $("currentRoom");
const memberList = $("memberList");
const remoteAudioContainer = $("remoteAudioContainer");
const remoteStreamCountText = $("remoteStreamCount");
const minimizeBtn = $("minimizeBtn");
const closeBtn = $("closeBtn");
const preRoomSection = $("preRoomSection");
const roomPanel = $("roomPanel");
const updateSection = $("updateSection");
const updateAppBtn = $("updateApp");

const mainView = $("mainView");
const settingsPanel = $("settingsPanel");
const openSettingsBtn = $("openSettings");
const backFromSettingsBtn = $("backFromSettings");
const microphoneSelect = $("microphoneSelect");
const speakerSelect = $("speakerSelect");
const refreshAudioDevicesBtn = $("refreshAudioDevices");
const audioDeviceStatus = $("audioDeviceStatus");
const muteKeybindBtn = $("muteKeybind");
const deafenKeybindBtn = $("deafenKeybind");
const notificationSoundsCheckbox = $("notificationSounds");

// -------------------- CONSTANTS --------------------

const SERVER_URL =
  "https://voxycast-server-production.up.railway.app";

const SETTINGS_KEY = "voxycast.audioSettings.v1";

const DEFAULT_SETTINGS = {
  inputDeviceId: "default",
  outputDeviceId: "default",
  muteKeybind: "Ctrl+Shift+KeyM",
  deafenKeybind: "Ctrl+Shift+KeyD",
  notificationSounds: true
};

const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" }
  ]
};

// -------------------- APPLICATION STATE --------------------

let currentRoomCode = null;
let socket = null;
let selfSocketId = null;
let roomMembers = [];

let peerConnections = {};
let remoteAudioElements = {};
let remoteAudioSettings = {};

let localStream = null;
let isMicMuted = false;
let isDeafened = false;

let pendingUpdate = null;
let isUpdating = false;

let changingMicrophone = false;
let changingOutput = false;
let recordingKeybind = null;

let audioSettings = { ...DEFAULT_SETTINGS };

try {
  const saved = JSON.parse(
    localStorage.getItem(SETTINGS_KEY) || "{}"
  );

  if (saved && typeof saved === "object") {
    audioSettings = {
      ...DEFAULT_SETTINGS,
      ...saved
    };
  }
} catch (error) {
  console.warn("Could not load audio settings:", error);
}

// ============================================================
// GENERAL HELPERS
// ============================================================

function setStatus(message) {
  if (statusText) {
    statusText.textContent = message;
  }
}

function setVoiceState(message) {
  if (voiceStateText) {
    voiceStateText.textContent = message;
  }
}

function deviceMessage(message) {
  if (audioDeviceStatus) {
    audioDeviceStatus.textContent = message;
  }
}

function saveAudioSettings() {
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify(audioSettings)
    );
  } catch (error) {
    console.warn("Could not save settings:", error);
  }
}

function setCurrentRoom(roomCode) {
  currentRoomText.textContent =
    roomCode || "Not connected";

  leaveRoomBtn.disabled = !roomCode;
}

function updateRemoteStreamCount() {
  remoteStreamCountText.textContent = String(
    Object.keys(remoteAudioElements).length
  );
}

function setUpdateButtonVisible(visible) {
  if (updateSection) {
    updateSection.classList.toggle("hidden", !visible);
  }
}

function updateUpdateUiVisibility() {
  const visible =
    !!pendingUpdate &&
    !currentRoomCode &&
    !isUpdating;

  setUpdateButtonVisible(visible);
}

function updateVoiceButtons() {
  const inRoom = !!currentRoomCode;

  muteMicBtn.disabled = !inRoom || !localStream;
  deafenAudioBtn.disabled = !inRoom;

  muteMicBtn.textContent =
    isMicMuted ? "Unmute Mic" : "Mute Mic";

  deafenAudioBtn.textContent =
    isDeafened ? "Undeafen" : "Deafen";
}

function setInRoomState(inRoom) {
  usernameInput.disabled = inRoom;
  createRoomBtn.disabled = inRoom;
  joinRoomBtn.disabled = inRoom;

  preRoomSection.classList.toggle(
    "hidden",
    inRoom
  );

  roomPanel.classList.toggle(
    "hidden",
    !inRoom
  );

  if (!inRoom) {
    roomCodeInput.value = "";
  }

  updateVoiceButtons();
  updateUpdateUiVisibility();
}

function getUsername() {
  return usernameInput.value.trim();
}

function getRoomCode() {
  return roomCodeInput.value.trim().toUpperCase();
}

// ============================================================
// MICROPHONE DIAGNOSTICS
// ============================================================

function describeMicrophoneError(error) {
  const name = error?.name || "UnknownError";

  const messages = {
    NotAllowedError:
      "Microphone access denied or blocked.",
    PermissionDeniedError:
      "Microphone permission denied.",
    NotFoundError:
      "No microphone was detected.",
    DevicesNotFoundError:
      "No microphone was detected.",
    NotReadableError:
      "Microphone unavailable or in use.",
    TrackStartError:
      "Could not start the microphone.",
    OverconstrainedError:
      "Selected microphone unavailable.",
    SecurityError:
      "Microphone blocked by WebView security.",
    TypeError:
      "Microphone API unavailable in this context.",
    AbortError:
      "Microphone initialization was interrupted."
  };

  return {
    name,
    message: messages[name] ||
      `Microphone error: ${name}`
  };
}

function reportMicrophoneError(error) {
  const result = describeMicrophoneError(error);

  console.error("VoxyCast microphone diagnostic:", {
    name: error?.name,
    message: error?.message,
    constraint: error?.constraint,
    origin: window.location.origin,
    secureContext: window.isSecureContext,
    mediaDevicesAvailable:
      !!navigator.mediaDevices,
    getUserMediaAvailable:
      !!navigator.mediaDevices?.getUserMedia
  });

  setVoiceState(result.message);
  setStatus(
    `Microphone error: ${result.name}`
  );

  deviceMessage(
    `${result.message} (${result.name})`
  );
}

// ============================================================
// MICROPHONE CAPTURE
// ============================================================

function getMicrophoneConstraints(deviceId) {
  return {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(deviceId !== "default"
        ? { deviceId: { exact: deviceId } }
        : {})
    },
    video: false
  };
}

function applyMicMuteState() {
  if (!localStream) return;

  for (const track of localStream.getAudioTracks()) {
    track.enabled = !isMicMuted;
  }
}

async function ensureLocalStream() {
  if (
    localStream &&
    localStream.getAudioTracks().some(
      (track) => track.readyState === "live"
    )
  ) {
    return localStream;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    const error = new Error(
      "getUserMedia is unavailable"
    );
    error.name = "TypeError";

    reportMicrophoneError(error);
    throw error;
  }

  try {
    const stream =
      await navigator.mediaDevices.getUserMedia(
        getMicrophoneConstraints(
          audioSettings.inputDeviceId
        )
      );

    localStream = stream;

    applyMicMuteState();
    setVoiceState("Mic ready");
    updateVoiceButtons();

    // Permission may reveal previously hidden devices.
    refreshAudioDevices().catch(console.error);

    return localStream;
  } catch (error) {
    reportMicrophoneError(error);
    throw error;
  }
}

// ============================================================
// REMOTE AUDIO CONTROLS
// ============================================================

function getRemoteSettings(socketId) {
  if (!remoteAudioSettings[socketId]) {
    remoteAudioSettings[socketId] = {
      volume: 1,
      muted: false
    };
  }

  return remoteAudioSettings[socketId];
}

function applySingleRemoteAudioState(socketId) {
  const audio = remoteAudioElements[socketId];

  if (!audio) return;

  const settings = getRemoteSettings(socketId);
  const shouldMute =
    isDeafened || settings.muted;

  audio.muted = shouldMute;
  audio.volume = shouldMute
    ? 0
    : settings.volume;
}

function applyAllRemoteAudioStates() {
  for (
    const socketId of
    Object.keys(remoteAudioElements)
  ) {
    applySingleRemoteAudioState(socketId);
  }
}

function renderMembers(members) {
  roomMembers = members || [];
  memberList.replaceChildren();

  if (!roomMembers.length) {
    const placeholder =
      document.createElement("div");

    placeholder.className = "placeholder";
    placeholder.textContent = "No room joined";

    memberList.appendChild(placeholder);
    return;
  }

  for (const member of roomMembers) {
    const row = document.createElement("div");
    row.className = "member-row";

    const top = document.createElement("div");
    top.className = "member-top";

    const name = document.createElement("div");
    name.className = "member-name";
    name.textContent = member.username;

    if (member.socketId === selfSocketId) {
      const selfTag =
        document.createElement("span");

      selfTag.className = "member-self-tag";
      selfTag.textContent = "(you)";

      name.appendChild(selfTag);
    }

    top.appendChild(name);

    if (member.socketId !== selfSocketId) {
      const controls =
        document.createElement("div");

      controls.className = "member-controls";

      const settings =
        getRemoteSettings(member.socketId);

      const slider =
        document.createElement("input");

      slider.type = "range";
      slider.min = "0";
      slider.max = "100";
      slider.step = "1";
      slider.className = "member-slider";

      slider.value = String(
        Math.round(settings.volume * 100)
      );

      slider.addEventListener("input", () => {
        settings.volume =
          Number(slider.value) / 100;

        applySingleRemoteAudioState(
          member.socketId
        );
      });

      const muteBtn =
        document.createElement("button");

      muteBtn.className = "member-mute-btn";
      muteBtn.textContent = settings.muted
        ? "Unmute"
        : "Mute";

      muteBtn.addEventListener("click", () => {
        settings.muted = !settings.muted;

        muteBtn.textContent = settings.muted
          ? "Unmute"
          : "Mute";

        applySingleRemoteAudioState(
          member.socketId
        );
      });

      controls.appendChild(slider);
      controls.appendChild(muteBtn);
      top.appendChild(controls);
    }

    row.appendChild(top);
    memberList.appendChild(row);
  }
}

// ============================================================
// REMOTE AUDIO ELEMENTS
// ============================================================

async function routeAudioOutput(audio) {
  if (typeof audio.setSinkId !== "function") {
    if (audioSettings.outputDeviceId !== "default") {
      throw new Error(
        "Speaker selection unsupported by this WebView."
      );
    }

    return;
  }

  await audio.setSinkId(
    audioSettings.outputDeviceId === "default"
      ? ""
      : audioSettings.outputDeviceId
  );
}

function createRemoteAudioElement(socketId) {
  if (remoteAudioElements[socketId]) {
    return remoteAudioElements[socketId];
  }

  const audio = document.createElement("audio");

  audio.autoplay = true;
  audio.playsInline = true;
  audio.setAttribute(
    "data-socket-id",
    socketId
  );

  remoteAudioContainer.appendChild(audio);

  remoteAudioElements[socketId] = audio;

  routeAudioOutput(audio).catch((error) => {
    console.error(
      "Could not route remote audio:",
      error
    );
  });

  applySingleRemoteAudioState(socketId);
  updateRemoteStreamCount();

  return audio;
}

async function safelyPlayAudio(audio) {
  try {
    await audio.play();
  } catch (error) {
    console.error(
      "Remote audio playback failed:",
      error
    );
  }
}

function cleanupRemoteAudio(socketId) {
  const audio = remoteAudioElements[socketId];

  if (audio) {
    audio.pause();
    audio.srcObject = null;
    audio.remove();

    delete remoteAudioElements[socketId];
    updateRemoteStreamCount();
  }

  delete remoteAudioSettings[socketId];
}

function cleanupPeerConnection(socketId) {
  const pc = peerConnections[socketId];

  if (pc) {
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.onconnectionstatechange = null;

    pc.close();
    delete peerConnections[socketId];
  }

  cleanupRemoteAudio(socketId);
}

function cleanupAllPeerConnections() {
  for (
    const socketId of
    Object.keys(peerConnections)
  ) {
    cleanupPeerConnection(socketId);
  }
}

// ============================================================
// WEBRTC CONNECTIONS
// ============================================================

async function createPeerConnection(targetSocketId) {
  if (peerConnections[targetSocketId]) {
    return peerConnections[targetSocketId];
  }

  const stream = await ensureLocalStream();

  const pc = new RTCPeerConnection(rtcConfig);

  stream.getTracks().forEach((track) => {
    pc.addTrack(track, stream);
  });

  pc.onicecandidate = (event) => {
    if (!event.candidate || !socket) return;

    socket.emit("webrtc-ice-candidate", {
      targetSocketId,
      candidate: event.candidate
    });
  };

  pc.ontrack = async (event) => {
    const audio =
      createRemoteAudioElement(targetSocketId);

    const [remoteStream] = event.streams;

    if (remoteStream) {
      audio.srcObject = remoteStream;

      applySingleRemoteAudioState(
        targetSocketId
      );

      await safelyPlayAudio(audio);
    }
  };

  pc.onconnectionstatechange = () => {
    if (
      pc.connectionState === "failed" ||
      pc.connectionState === "closed" ||
      pc.connectionState === "disconnected"
    ) {
      cleanupPeerConnection(targetSocketId);
      renderMembers(roomMembers);
    }
  };

  peerConnections[targetSocketId] = pc;

  return pc;
}

async function callPeer(targetSocketId) {
  if (!socket || !selfSocketId) return;
  if (targetSocketId === selfSocketId) return;

  try {
    const pc =
      await createPeerConnection(targetSocketId);

    const offer = await pc.createOffer();

    await pc.setLocalDescription(offer);

    socket.emit("webrtc-offer", {
      targetSocketId,
      offer: pc.localDescription
    });
  } catch (error) {
    console.error(
      "Failed to call peer:",
      targetSocketId,
      error
    );

    setStatus("Failed to start voice connection");
  }
}

async function handleIncomingOffer(
  fromSocketId,
  offer
) {
  try {
    const pc =
      await createPeerConnection(fromSocketId);

    await pc.setRemoteDescription(
      new RTCSessionDescription(offer)
    );

    const answer = await pc.createAnswer();

    await pc.setLocalDescription(answer);

    socket.emit("webrtc-answer", {
      targetSocketId: fromSocketId,
      answer: pc.localDescription
    });
  } catch (error) {
    console.error(
      "Failed handling incoming offer:",
      error
    );

    setStatus("Failed handling voice offer");
  }
}

async function handleIncomingAnswer(
  fromSocketId,
  answer
) {
  try {
    const pc = peerConnections[fromSocketId];

    if (!pc) return;

    if (pc.signalingState !== "have-local-offer") {
      return;
    }

    await pc.setRemoteDescription(
      new RTCSessionDescription(answer)
    );
  } catch (error) {
    console.error(
      "Failed handling incoming answer:",
      error
    );
  }
}

async function handleIncomingIceCandidate(
  fromSocketId,
  candidate
) {
  try {
    const pc = peerConnections[fromSocketId];

    if (!pc) return;

    await pc.addIceCandidate(
      new RTCIceCandidate(candidate)
    );
  } catch (error) {
    console.error(
      "Failed adding ICE candidate:",
      error
    );
  }
}

async function connectToExistingPeers() {
  const otherMembers = roomMembers.filter(
    (member) => member.socketId !== selfSocketId
  );

  for (const member of otherMembers) {
    await callPeer(member.socketId);
  }
}

// ============================================================
// MICROPHONE / DEAFEN BUTTONS
// ============================================================

function toggleMicrophone() {
  if (!currentRoomCode || !localStream) {
    return;
  }

  isMicMuted = !isMicMuted;

  applyMicMuteState();
  updateVoiceButtons();

  setStatus(
    isMicMuted
      ? "Microphone muted"
      : "Microphone unmuted"
  );
}

function toggleDeafen() {
  if (!currentRoomCode) return;

  isDeafened = !isDeafened;

  applyAllRemoteAudioStates();
  updateVoiceButtons();

  setStatus(
    isDeafened
      ? "Audio deafened"
      : "Audio undeafened"
  );
}

muteMicBtn.addEventListener(
  "click",
  toggleMicrophone
);

deafenAudioBtn.addEventListener(
  "click",
  toggleDeafen
);

// ============================================================
// SOCKET.IO SERVER
// ============================================================

function initializeSocket() {
  if (typeof io === "undefined") {
    setStatus("Socket.IO failed to load");
    return;
  }

  socket = io(SERVER_URL, {
    transports: ["websocket"]
  });

  socket.on("connect", () => {
    selfSocketId = socket.id;
    setStatus("Connected");
  });

  socket.on("connect_error", (error) => {
    console.error(
      "Socket connection failed:",
      error
    );

    setStatus(
      "Connect error: " + error.message
    );
  });

  socket.on("disconnect", () => {
    currentRoomCode = null;
    selfSocketId = null;
    roomMembers = [];

    cleanupAllPeerConnections();

    setCurrentRoom(null);
    renderMembers([]);
    setInRoomState(false);

    setStatus("Disconnected");
    setVoiceState("Mic not initialized");
  });

  socket.on(
    "room-updated",
    ({ roomCode, members }) => {
      if (roomCode !== currentRoomCode) {
        return;
      }

      renderMembers(members);
      setStatus(`Room updated: ${roomCode}`);
    }
  );

  socket.on(
    "peer-joined",
    ({ roomCode, peer }) => {
      if (roomCode !== currentRoomCode) {
        return;
      }

      setStatus(`${peer.username} joined`);
    }
  );

  socket.on(
    "peer-left",
    ({ roomCode, socketId }) => {
      if (roomCode !== currentRoomCode) {
        return;
      }

      cleanupPeerConnection(socketId);

      renderMembers(
        roomMembers.filter(
          (member) =>
            member.socketId !== socketId
        )
      );

      setStatus("A peer left");
    }
  );

  socket.on(
    "webrtc-offer",
    async ({ fromSocketId, offer }) => {
      await handleIncomingOffer(
        fromSocketId,
        offer
      );
    }
  );

  socket.on(
    "webrtc-answer",
    async ({ fromSocketId, answer }) => {
      await handleIncomingAnswer(
        fromSocketId,
        answer
      );
    }
  );

  socket.on(
    "webrtc-ice-candidate",
    async ({ fromSocketId, candidate }) => {
      await handleIncomingIceCandidate(
        fromSocketId,
        candidate
      );
    }
  );
}

// ============================================================
// CREATE ROOM
// ============================================================

createRoomBtn.addEventListener(
  "click",
  async () => {
    if (!socket?.connected) {
      setStatus("Socket not connected");
      return;
    }

    if (currentRoomCode) {
      setStatus(
        "Leave your current room first"
      );
      return;
    }

    const username = getUsername();

    if (!username) {
      setStatus("Enter your name first");
      return;
    }

    createRoomBtn.disabled = true;

    try {
      setStatus("Preparing microphone...");

      await ensureLocalStream();
    } catch (error) {
      // ensureLocalStream already reports
      // the exact microphone error.
      console.error(
        "Cannot create room:",
        error
      );

      createRoomBtn.disabled = false;
      return;
    }

    setStatus("Creating room...");

    socket.timeout(10000).emit(
      "create-room",
      { username },
      (error, response) => {
        createRoomBtn.disabled = false;

        if (error) {
          setStatus(
            "Room creation timed out"
          );
          return;
        }

        if (!response?.ok) {
          setStatus(
            response?.error ||
            "Failed to create room"
          );
          return;
        }

        currentRoomCode = response.roomCode;
        selfSocketId = response.selfSocketId;

        setCurrentRoom(response.roomCode);
        renderMembers(response.members);
        setInRoomState(true);

        setStatus(
          `Room created: ${response.roomCode}`
        );
      }
    );
  }
);

// ============================================================
// JOIN ROOM
// ============================================================

joinRoomBtn.addEventListener(
  "click",
  async () => {
    if (!socket?.connected) {
      setStatus("Socket not connected");
      return;
    }

    if (currentRoomCode) {
      setStatus(
        "Leave your current room first"
      );
      return;
    }

    const username = getUsername();
    const roomCode = getRoomCode();

    if (!username || !roomCode) {
      setStatus(
        "Enter name and room code"
      );
      return;
    }

    joinRoomBtn.disabled = true;

    try {
      setStatus("Preparing microphone...");

      await ensureLocalStream();
    } catch (error) {
      console.error(
        "Cannot join room:",
        error
      );

      joinRoomBtn.disabled = false;
      return;
    }

    setStatus("Joining room...");

    socket.timeout(10000).emit(
      "join-room",
      { username, roomCode },
      async (error, response) => {
        joinRoomBtn.disabled = false;

        if (error) {
          setStatus("Room join timed out");
          return;
        }

        if (!response?.ok) {
          setStatus(
            response?.error ||
            "Failed to join room"
          );
          return;
        }

        currentRoomCode = response.roomCode;
        selfSocketId = response.selfSocketId;

        setCurrentRoom(response.roomCode);
        renderMembers(response.members);
        setInRoomState(true);

        setStatus(
          `Joined room: ${response.roomCode}`
        );

        await connectToExistingPeers();
      }
    );
  }
);

// ============================================================
// LEAVE ROOM
// ============================================================

leaveRoomBtn.addEventListener(
  "click",
  () => {
    if (!socket?.connected) {
      setStatus("Socket not connected");
      return;
    }

    if (!currentRoomCode) {
      setStatus("You are not in a room");
      return;
    }

    const roomCode = currentRoomCode;

    socket.timeout(10000).emit(
      "leave-room",
      { roomCode },
      (error, response) => {
        if (error) {
          setStatus("Leave room timed out");
          return;
        }

        if (!response?.ok) {
          setStatus(
            response?.error ||
            "Failed to leave room"
          );
          return;
        }

        currentRoomCode = null;
        roomMembers = [];

        cleanupAllPeerConnections();

        setCurrentRoom(null);
        renderMembers([]);
        setInRoomState(false);

        setStatus("Left room");
      }
    );
  }
);

// ============================================================
// SETTINGS NAVIGATION
// ============================================================

openSettingsBtn.addEventListener(
  "click",
  async () => {
    mainView.classList.add("hidden");
    settingsPanel.classList.remove("hidden");

    await refreshAudioDevices();
  }
);

backFromSettingsBtn.addEventListener(
  "click",
  () => {
    settingsPanel.classList.add("hidden");
    mainView.classList.remove("hidden");
  }
);

// ============================================================
// AUDIO DEVICE DISCOVERY
// ============================================================

async function refreshAudioDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    deviceMessage(
      "Audio device enumeration unavailable."
    );
    return;
  }

  try {
    const devices =
      await navigator.mediaDevices.enumerateDevices();

    function populate(
      select,
      kind,
      selectedId
    ) {
      select.replaceChildren();

      select.add(
        new Option(
          "System Default",
          "default"
        )
      );

      let count = 0;

      for (const device of devices) {
        if (device.kind !== kind) continue;

        if (
          !device.deviceId ||
          device.deviceId === "default" ||
          device.deviceId === "communications"
        ) {
          continue;
        }

        count++;

        const typeName =
          kind === "audioinput"
            ? "Microphone"
            : "Speaker";

        const label =
          device.label ||
          `${typeName} ${count}`;

        select.add(
          new Option(
            label,
            device.deviceId
          )
        );
      }

      if (
        selectedId !== "default" &&
        !Array.from(select.options).some(
          (option) =>
            option.value === selectedId
        )
      ) {
        select.add(
          new Option(
            "Unavailable device",
            selectedId
          )
        );
      }

      select.value = selectedId;
    }

    populate(
      microphoneSelect,
      "audioinput",
      audioSettings.inputDeviceId
    );

    populate(
      speakerSelect,
      "audiooutput",
      audioSettings.outputDeviceId
    );

    const inputs = devices.filter(
      (device) =>
        device.kind === "audioinput"
    ).length;

    const outputs = devices.filter(
      (device) =>
        device.kind === "audiooutput"
    ).length;

    console.info(
      "VoxyCast audio devices:",
      { inputs, outputs }
    );

    deviceMessage(
      `Detected ${inputs} input(s), ${outputs} output(s).`
    );
  } catch (error) {
    console.error(
      "Device enumeration failed:",
      error
    );

    deviceMessage(
      `Device list error: ${error.name || "Unknown"}`
    );
  }
}

refreshAudioDevicesBtn.addEventListener(
  "click",
  refreshAudioDevices
);

// ============================================================
// MICROPHONE DEVICE SWITCHING
// ============================================================

async function changeMicrophone(deviceId) {
  if (changingMicrophone) return;

  const previousDevice =
    audioSettings.inputDeviceId;

  if (!localStream) {
    audioSettings.inputDeviceId = deviceId;
    saveAudioSettings();

    deviceMessage(
      "Microphone saved. It will be used when joining a room."
    );
    return;
  }

  changingMicrophone = true;
  microphoneSelect.disabled = true;

  let newStream = null;

  try {
    newStream =
      await navigator.mediaDevices.getUserMedia(
        getMicrophoneConstraints(deviceId)
      );

    const newTrack =
      newStream.getAudioTracks()[0];

    const oldTrack =
      localStream.getAudioTracks()[0];

    if (!newTrack) {
      throw new Error(
        "Selected device provided no audio track."
      );
    }

    newTrack.enabled = !isMicMuted;

    const replacedSenders = [];

    try {
      for (
        const pc of
        Object.values(peerConnections)
      ) {
        const sender = pc
          .getSenders()
          .find(
            (sender) =>
              sender.track?.kind === "audio"
          );

        if (!sender) continue;

        await sender.replaceTrack(newTrack);

        replacedSenders.push(sender);
      }
    } catch (error) {
      await Promise.allSettled(
        replacedSenders.map(
          (sender) =>
            sender.replaceTrack(oldTrack)
        )
      );

      throw error;
    }

    localStream = newStream;

    audioSettings.inputDeviceId = deviceId;
    saveAudioSettings();

    if (oldTrack) {
      oldTrack.stop();
    }

    setVoiceState("Mic ready");
    updateVoiceButtons();

    deviceMessage(
      "Microphone changed successfully."
    );
  } catch (error) {
    if (newStream) {
      newStream.getTracks().forEach(
        (track) => track.stop()
      );
    }

    audioSettings.inputDeviceId =
      previousDevice;

    microphoneSelect.value =
      previousDevice;

    console.error(
      "Microphone switching failed:",
      error
    );

    reportMicrophoneError(error);
  } finally {
    changingMicrophone = false;
    microphoneSelect.disabled = false;
  }
}

microphoneSelect.addEventListener(
  "change",
  () => {
    changeMicrophone(
      microphoneSelect.value
    );
  }
);

// ============================================================
// SPEAKER / OUTPUT DEVICE SWITCHING
// ============================================================

async function changeOutput(deviceId) {
  if (changingOutput) return;

  changingOutput = true;
  speakerSelect.disabled = true;

  const previousDevice =
    audioSettings.outputDeviceId;

  try {
    if (
      deviceId !== "default" &&
      typeof HTMLMediaElement.prototype.setSinkId !==
        "function"
    ) {
      throw new Error(
        "Output selection is unsupported by WebView2."
      );
    }

    audioSettings.outputDeviceId = deviceId;

    await Promise.all(
      Object.values(remoteAudioElements).map(
        (audio) => routeAudioOutput(audio)
      )
    );

    saveAudioSettings();

    deviceMessage(
      "Audio output selected."
    );
  } catch (error) {
    audioSettings.outputDeviceId =
      previousDevice;

    speakerSelect.value = previousDevice;

    await Promise.allSettled(
      Object.values(remoteAudioElements).map(
        (audio) => routeAudioOutput(audio)
      )
    );

    console.error(
      "Audio output selection failed:",
      error
    );

    deviceMessage(
      `Output error: ${error.message}`
    );
  } finally {
    changingOutput = false;
    speakerSelect.disabled = false;
  }
}

speakerSelect.addEventListener(
  "change",
  () => {
    changeOutput(
      speakerSelect.value
    );
  }
);

// ============================================================
// KEYBIND FORMATTING
// ============================================================

function formatKeybind(shortcut) {
  if (!shortcut) {
    return "Not Assigned";
  }

  return shortcut
    .replace(/Key([A-Z])/g, "$1")
    .replace(/Digit([0-9])/g, "$1")
    .replaceAll("Meta", "Win")
    .replaceAll("+", " + ");
}

function updateKeybindLabels() {
  muteKeybindBtn.textContent =
    formatKeybind(
      audioSettings.muteKeybind
    );

  deafenKeybindBtn.textContent =
    formatKeybind(
      audioSettings.deafenKeybind
    );
}

function getKeybindFromEvent(event) {
  if (
    [
      "Control",
      "Shift",
      "Alt",
      "Meta"
    ].includes(event.key)
  ) {
    return null;
  }

  const modifiers = [];

  if (event.ctrlKey) {
    modifiers.push("Ctrl");
  }

  if (event.altKey) {
    modifiers.push("Alt");
  }

  if (event.shiftKey) {
    modifiers.push("Shift");
  }

  if (event.metaKey) {
    modifiers.push("Meta");
  }

  if (!modifiers.length) {
    return null;
  }

  return [
    ...modifiers,
    event.code
  ].join("+");
}

// ============================================================
// KEYBIND RECORDING
// ============================================================

muteKeybindBtn.addEventListener(
  "click",
  () => {
    recordingKeybind = "muteKeybind";

    muteKeybindBtn.textContent =
      "Press shortcut (Esc to cancel)";

    muteKeybindBtn.classList.add(
      "recording"
    );

    deafenKeybindBtn.classList.remove(
      "recording"
    );
  }
);

deafenKeybindBtn.addEventListener(
  "click",
  () => {
    recordingKeybind = "deafenKeybind";

    deafenKeybindBtn.textContent =
      "Press shortcut (Esc to cancel)";

    deafenKeybindBtn.classList.add(
      "recording"
    );

    muteKeybindBtn.classList.remove(
      "recording"
    );
  }
);

document.addEventListener(
  "keydown",
  (event) => {
    if (recordingKeybind) {
      event.preventDefault();

      if (event.key === "Escape") {
        recordingKeybind = null;
      } else {
        const shortcut =
          getKeybindFromEvent(event);

        if (!shortcut) return;

        const otherKeybind =
          recordingKeybind === "muteKeybind"
            ? "deafenKeybind"
            : "muteKeybind";

        if (
          shortcut ===
          audioSettings[otherKeybind]
        ) {
          deviceMessage(
            "This shortcut is already assigned."
          );
          return;
        }

        audioSettings[recordingKeybind] =
          shortcut;

        saveAudioSettings();
        recordingKeybind = null;
      }

      muteKeybindBtn.classList.remove(
        "recording"
      );

      deafenKeybindBtn.classList.remove(
        "recording"
      );

      updateKeybindLabels();
      return;
    }

    if (
      event.repeat ||
      !currentRoomCode
    ) {
      return;
    }

    if (
      !settingsPanel.classList.contains(
        "hidden"
      )
    ) {
      return;
    }

    const activeTag =
      document.activeElement?.tagName;

    if (
      [
        "INPUT",
        "TEXTAREA",
        "SELECT"
      ].includes(activeTag)
    ) {
      return;
    }

    const shortcut =
      getKeybindFromEvent(event);

    if (
      shortcut ===
      audioSettings.muteKeybind
    ) {
      event.preventDefault();
      toggleMicrophone();
    }

    if (
      shortcut ===
      audioSettings.deafenKeybind
    ) {
      event.preventDefault();
      toggleDeafen();
    }
  }
);

// ============================================================
// NOTIFICATION SOUND PREFERENCE
// ============================================================

notificationSoundsCheckbox.checked =
  !!audioSettings.notificationSounds;

notificationSoundsCheckbox.addEventListener(
  "change",
  () => {
    audioSettings.notificationSounds =
      notificationSoundsCheckbox.checked;

    saveAudioSettings();
  }
);

// Actual sound files will be connected in a later step.

// ============================================================
// AUTOMATIC DEVICE REFRESH
// ============================================================

if (navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener(
    "devicechange",
    () => {
      refreshAudioDevices().catch(
        console.error
      );
    }
  );
}

// ============================================================
// TAURI WINDOW CONTROLS
// ============================================================

async function setupWindowControls() {
  try {
    const appWindow =
      window.__TAURI__.window.getCurrentWindow();

    minimizeBtn.addEventListener(
      "click",
      async () => {
        await appWindow.minimize();
      }
    );

    closeBtn.addEventListener(
      "click",
      async () => {
        await appWindow.close();
      }
    );
  } catch (error) {
    console.error(
      "Window controls setup failed:",
      error
    );

    minimizeBtn.style.display = "none";
    closeBtn.style.display = "none";
  }
}

// ============================================================
// TAURI UPDATER
// ============================================================

async function checkForUpdatesOnStartup() {
  try {
    if (
      !window.__TAURI__?.updater?.check
    ) {
      console.warn(
        "Updater API is not available"
      );
      return;
    }

    const update =
      await window.__TAURI__.updater.check();

    if (update) {
      pendingUpdate = update;

      setStatus(
        `Update available: ${update.version}`
      );
    } else {
      pendingUpdate = null;
    }

    updateUpdateUiVisibility();
  } catch (error) {
    console.error(
      "Update check failed:",
      error
    );
  }
}

async function installPendingUpdate() {
  if (!pendingUpdate || isUpdating) {
    return;
  }

  try {
    isUpdating = true;
    updateUpdateUiVisibility();

    updateAppBtn.disabled = true;
    updateAppBtn.textContent = "Updating...";

    setStatus(
      `Downloading update ${pendingUpdate.version}...`
    );

    await pendingUpdate.downloadAndInstall();

    setStatus(
      "Update installed. Restarting..."
    );

    if (
      window.__TAURI__?.process?.relaunch
    ) {
      await window.__TAURI__.process.relaunch();
    }
  } catch (error) {
    console.error(
      "Update installation failed:",
      error
    );

    setStatus("Update failed");

    isUpdating = false;
    updateAppBtn.disabled = false;
    updateAppBtn.textContent =
      "Update Available";

    updateUpdateUiVisibility();
  }
}

updateAppBtn.addEventListener(
  "click",
  installPendingUpdate
);

// ============================================================
// INITIALIZATION
// ============================================================

function initializeVoxyCast() {
  setCurrentRoom(null);
  renderMembers([]);
  setInRoomState(false);

  setVoiceState(
    "Mic not initialized"
  );

  updateRemoteStreamCount();
  updateVoiceButtons();
  setUpdateButtonVisible(false);

  updateKeybindLabels();

  initializeSocket();
  setupWindowControls();
  checkForUpdatesOnStartup();

  refreshAudioDevices().catch(
    console.error
  );

  console.info(
    "VoxyCast client initialized"
  );
}

initializeVoxyCast();


/* ============================================================
   VOXYCAST - MICROPHONE PERMISSION RECOVERY
   ============================================================ */

const resetMicrophonePermissionBtn =
  document.getElementById("resetMicrophonePermission");

const microphonePermissionStatus =
  document.getElementById("microphonePermissionStatus");

function setMicrophonePermissionStatus(message, type = "") {
  if (!microphonePermissionStatus) return;

  microphonePermissionStatus.textContent = message;

  microphonePermissionStatus.classList.remove(
    "success",
    "error"
  );

  if (type) {
    microphonePermissionStatus.classList.add(type);
  }
}

async function resetMicrophonePermission() {
  if (!resetMicrophonePermissionBtn) return;

  // Avoid interrupting an active voice-chat session.
  if (currentRoomCode) {
    setMicrophonePermissionStatus(
      "Leave your voice room before resetting permissions.",
      "error"
    );
    return;
  }

  const confirmed = window.confirm(
    "Reset Microphone Permission?\n\n" +
    "VoxyCast will clear its saved microphone permission " +
    "and ask you to allow microphone access again.\n\n" +
    "Your settings and keybinds will be preserved."
  );

  if (!confirmed) return;

  resetMicrophonePermissionBtn.disabled = true;
  resetMicrophonePermissionBtn.textContent =
    "Resetting Permission...";

  try {
    const invoke = window.__TAURI__?.core?.invoke;

    if (typeof invoke !== "function") {
      throw new Error(
        "Tauri native command API is unavailable."
      );
    }

    setMicrophonePermissionStatus(
      "Resetting saved microphone permission..."
    );

    // Release an existing microphone stream before
    // requesting fresh permission.
    if (localStream) {
      localStream.getTracks().forEach(
        (track) => track.stop()
      );

      localStream = null;
      updateVoiceButtons();
    }

    // Native Rust command implemented in lib.rs.
    await invoke("reset_microphone_permission");

    setMicrophonePermissionStatus(
      "Permission reset. Requesting microphone access..."
    );

    // Request permission again through WebView2.
    // This should trigger the Allow / Block prompt
    // when the saved decision has been reset.
    await ensureLocalStream();

    await refreshAudioDevices();

    setMicrophonePermissionStatus(
      "Microphone permission granted! Your audio devices have been refreshed.",
      "success"
    );

    setStatus("Microphone access restored");
  } catch (error) {
    console.error(
      "Microphone permission recovery failed:",
      error
    );

    const errorName = error?.name || "";
    const errorMessage =
      error?.message || String(error);

    if (
      errorName === "NotAllowedError" ||
      errorName === "PermissionDeniedError"
    ) {
      setMicrophonePermissionStatus(
        "Microphone access was denied. Click Reset again if you want to retry.",
        "error"
      );
    } else {
      setMicrophonePermissionStatus(
        `Permission recovery failed: ${errorMessage}`,
        "error"
      );
    }
  } finally {
    resetMicrophonePermissionBtn.disabled = false;
    resetMicrophonePermissionBtn.textContent =
      "Reset Microphone Permission";
  }
}

if (resetMicrophonePermissionBtn) {
  resetMicrophonePermissionBtn.addEventListener(
    "click",
    resetMicrophonePermission
  );
}
