
"use strict";

const http = require("http");
const crypto = require("crypto");
const { Server } = require("socket.io");

const httpServer = http.createServer();

const io = new Server(httpServer, {
  cors: { origin: "*" },
  maxHttpBufferSize: 64 * 1024,
  pingTimeout: 20000
});

const PORT = Number(process.env.PORT) || 3001;
const ROOM_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const MAX_MEMBERS = 20;

const rooms = new Map();
const socketRooms = new Map();
const limits = new Map();

function roomCode() {
  let code;

  do {
    code = Array.from({ length: 6 }, () =>
      ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)]
    ).join("");
  } while (rooms.has(code));

  return code;
}

function validUsername(value) {
  if (typeof value !== "string") return null;

  const name = value.trim();

  return name.length >= 1 &&
    name.length <= 20 &&
    !/[\u0000-\u001f\u007f]/.test(name)
      ? name
      : null;
}

function validRoomCode(value) {
  if (typeof value !== "string") return null;

  const code = value.trim().toUpperCase();

  return /^[A-Z0-9]{6}$/.test(code) ? code : null;
}

function acknowledge(callback, result) {
  if (typeof callback === "function") {
    callback(result);
  }
}

function allow(socket, action, count, windowMs) {
  const now = Date.now();
  const key = `${socket.id}:${action}`;
  const previous = limits.get(key);

  const entry = !previous || now >= previous.resetAt
    ? { count: 0, resetAt: now + windowMs }
    : previous;

  entry.count += 1;
  limits.set(key, entry);

  return entry.count <= count;
}

function membersFor(code) {
  const room = rooms.get(code);

  if (!room) return [];

  return Array.from(
    room.entries(),
    ([socketId, username]) => ({
      socketId,
      username
    })
  );
}

function updateRoom(code) {
  if (!rooms.has(code)) return;

  io.to(code).emit("room-updated", {
    roomCode: code,
    members: membersFor(code)
  });
}

function leaveCurrentRoom(socket) {
  const code = socketRooms.get(socket.id);

  if (!code) return false;

  socketRooms.delete(socket.id);
  socket.leave(code);

  const room = rooms.get(code);

  if (!room) return true;

  room.delete(socket.id);

  socket.to(code).emit("peer-left", {
    roomCode: code,
    socketId: socket.id
  });

  if (room.size === 0) {
    rooms.delete(code);
  } else {
    updateRoom(code);
  }

  return true;
}

function sameRoom(senderId, targetId) {
  if (
    typeof targetId !== "string" ||
    targetId.length > 128 ||
    targetId === senderId
  ) {
    return false;
  }

  const code = socketRooms.get(senderId);

  return !!code &&
    socketRooms.get(targetId) === code &&
    rooms.get(code)?.has(senderId) &&
    rooms.get(code)?.has(targetId);
}

function validDescription(description, expectedType) {
  return !!description &&
    typeof description === "object" &&
    description.type === expectedType &&
    typeof description.sdp === "string" &&
    description.sdp.length > 0 &&
    description.sdp.length <= 32768;
}

function validCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") {
    return false;
  }

  if (
    typeof candidate.candidate !== "string" ||
    candidate.candidate.length > 4096
  ) {
    return false;
  }

  if (
    candidate.sdpMid != null &&
    (
      typeof candidate.sdpMid !== "string" ||
      candidate.sdpMid.length > 128
    )
  ) {
    return false;
  }

  if (
    candidate.sdpMLineIndex != null &&
    (
      !Number.isInteger(candidate.sdpMLineIndex) ||
      candidate.sdpMLineIndex < 0 ||
      candidate.sdpMLineIndex > 65535
    )
  ) {
    return false;
  }

  return true;
}

io.on("connection", (socket) => {
  socket.on("create-room", (data, callback) => {
    if (!allow(socket, "create", 5, 60000)) {
      return acknowledge(callback, {
        ok: false,
        error: "Too many room requests. Try again later."
      });
    }

    const username = validUsername(data?.username);

    if (!username) {
      return acknowledge(callback, {
        ok: false,
        error: "Enter a valid username (1-20 characters)."
      });
    }

    if (socketRooms.has(socket.id)) {
      return acknowledge(callback, {
        ok: false,
        error: "Leave current room first"
      });
    }

    const code = roomCode();

    rooms.set(
      code,
      new Map([[socket.id, username]])
    );

    socketRooms.set(socket.id, code);
    socket.join(code);

    acknowledge(callback, {
      ok: true,
      roomCode: code,
      selfSocketId: socket.id,
      members: membersFor(code)
    });
  });

  socket.on("join-room", (data, callback) => {
    if (!allow(socket, "join", 10, 60000)) {
      return acknowledge(callback, {
        ok: false,
        error: "Too many join attempts. Try again later."
      });
    }

    const username = validUsername(data?.username);
    const code = validRoomCode(data?.roomCode);

    if (!username) {
      return acknowledge(callback, {
        ok: false,
        error: "Enter a valid username (1-20 characters)."
      });
    }

    if (!code) {
      return acknowledge(callback, {
        ok: false,
        error: "Enter a valid 6-character room code."
      });
    }

    if (socketRooms.has(socket.id)) {
      return acknowledge(callback, {
        ok: false,
        error: "Leave current room first"
      });
    }

    const room = rooms.get(code);

    if (!room) {
      return acknowledge(callback, {
        ok: false,
        error: "Room not found"
      });
    }

    if (room.size >= MAX_MEMBERS) {
      return acknowledge(callback, {
        ok: false,
        error: "Room is full"
      });
    }

    room.set(socket.id, username);
    socketRooms.set(socket.id, code);
    socket.join(code);

    acknowledge(callback, {
      ok: true,
      roomCode: code,
      selfSocketId: socket.id,
      members: membersFor(code)
    });

    socket.to(code).emit("peer-joined", {
      roomCode: code,
      peer: {
        socketId: socket.id,
        username
      }
    });

    updateRoom(code);
  });

  socket.on("leave-room", (data, callback) => {
    const code = validRoomCode(data?.roomCode);

    if (!code || socketRooms.get(socket.id) !== code) {
      return acknowledge(callback, {
        ok: false,
        error: "You are not in that room"
      });
    }

    leaveCurrentRoom(socket);
    acknowledge(callback, { ok: true });
  });

  socket.on("webrtc-offer", (data) => {
    if (!allow(socket, "signal", 240, 60000)) return;
    if (!sameRoom(socket.id, data?.targetSocketId)) return;
    if (!validDescription(data?.offer, "offer")) return;

    io.to(data.targetSocketId).emit("webrtc-offer", {
      fromSocketId: socket.id,
      offer: data.offer
    });
  });

  socket.on("webrtc-answer", (data) => {
    if (!allow(socket, "signal", 240, 60000)) return;
    if (!sameRoom(socket.id, data?.targetSocketId)) return;
    if (!validDescription(data?.answer, "answer")) return;

    io.to(data.targetSocketId).emit("webrtc-answer", {
      fromSocketId: socket.id,
      answer: data.answer
    });
  });

  socket.on("webrtc-ice-candidate", (data) => {
    if (!allow(socket, "signal", 240, 60000)) return;
    if (!sameRoom(socket.id, data?.targetSocketId)) return;
    if (!validCandidate(data?.candidate)) return;

    io.to(data.targetSocketId).emit(
      "webrtc-ice-candidate",
      {
        fromSocketId: socket.id,
        candidate: data.candidate
      }
    );
  });

  socket.on("disconnect", () => {
    leaveCurrentRoom(socket);

    for (const key of limits.keys()) {
      if (key.startsWith(`${socket.id}:`)) {
        limits.delete(key);
      }
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(
    `VoxyCast signaling server listening on port ${PORT}`
  );
});
