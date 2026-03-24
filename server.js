const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'data', 'db.json');

const defaults = {
  users: {},
  usernames: {},
  rooms: {},
  lastDisbandNoticeByUser: {}
};

const db = loadDb();

function loadDb() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      return structuredClone(defaults);
    }
    const parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    return {
      ...structuredClone(defaults),
      ...parsed
    };
  } catch (error) {
    console.error('Failed to load db, using defaults', error);
    return structuredClone(defaults);
  }
}

function saveDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 5 * 1024 * 1024) {
        reject(new Error('Body too large'));
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function randomCode() {
  return crypto.randomBytes(4).toString('base64url');
}

function now() {
  return new Date().toISOString();
}

function sanitizeUsername(name) {
  return String(name || '').trim().replace(/\s+/g, ' ');
}

function usernameKey(name) {
  return sanitizeUsername(name).toLowerCase();
}

function getUser(deviceId) {
  if (!deviceId) return null;
  return db.users[deviceId] || null;
}

function requireUser(deviceId) {
  const user = getUser(deviceId);
  if (!user || !user.username) {
    const err = new Error('Complete profile setup first.');
    err.statusCode = 401;
    throw err;
  }
  return user;
}

function makeRoomState(roomCode) {
  const room = db.rooms[roomCode];
  if (!room) return null;

  return {
    code: room.code,
    hostDeviceId: room.hostDeviceId,
    started: room.started,
    winnerDeviceId: room.winnerDeviceId || null,
    settings: room.settings,
    players: room.players.map((deviceId) => {
      const user = db.users[deviceId];
      return {
        deviceId,
        username: user?.username || 'Unknown',
        avatarDataUrl: user?.avatarDataUrl || null,
        isHost: deviceId === room.hostDeviceId,
        isBankrupt: !!room.bankruptPlayers[deviceId]
      };
    }),
    tradeRequests: room.tradeRequests,
    events: room.events.slice(-20)
  };
}

function clearUserFromRoom(deviceId, roomCode) {
  const room = db.rooms[roomCode];
  if (!room) return;

  room.players = room.players.filter((id) => id !== deviceId);
  delete room.bankruptPlayers[deviceId];
  room.tradeRequests = room.tradeRequests.filter(
    (trade) => trade.fromDeviceId !== deviceId && trade.toDeviceId !== deviceId
  );

  const user = db.users[deviceId];
  if (user && user.currentRoomCode === roomCode) {
    user.currentRoomCode = null;
  }

  if (room.hostDeviceId === deviceId) {
    room.hostDeviceId = room.players[0] || null;
  }

  if (room.players.length === 0) {
    delete db.rooms[roomCode];
    return;
  }

  room.events.push({
    id: crypto.randomUUID(),
    at: now(),
    message: `${user?.username || 'A player'} left the room.`
  });

  if (room.started) {
    evaluateWinner(roomCode);
  }
}

function evaluateWinner(roomCode) {
  const room = db.rooms[roomCode];
  if (!room || !room.started) return;

  const activePlayers = room.players.filter((deviceId) => !room.bankruptPlayers[deviceId]);

  if (activePlayers.length === 1) {
    const winnerId = activePlayers[0];
    const winnerName = db.users[winnerId]?.username || 'Unknown';
    room.winnerDeviceId = winnerId;
    room.events.push({
      id: crypto.randomUUID(),
      at: now(),
      message: `${winnerName} won the game. Room disbanded.`
    });

    room.players.forEach((deviceId) => {
      db.lastDisbandNoticeByUser[deviceId] = {
        roomCode,
        winnerDeviceId: winnerId,
        winnerName,
        at: now()
      };
      if (db.users[deviceId]) {
        db.users[deviceId].currentRoomCode = null;
      }
    });

    delete db.rooms[roomCode];
  }
}

function withErrorHandling(handler) {
  return async (req, res, url) => {
    try {
      await handler(req, res, url);
      saveDb();
    } catch (error) {
      const statusCode = error.statusCode || 400;
      sendJson(res, statusCode, { error: error.message || 'Request failed' });
    }
  };
}

const apiHandlers = {
  'POST /api/auth/session': withErrorHandling(async (req, res) => {
    const { deviceId } = await parseJsonBody(req);
    if (!deviceId || typeof deviceId !== 'string') {
      throw new Error('deviceId is required');
    }

    if (!db.users[deviceId]) {
      db.users[deviceId] = {
        deviceId,
        username: null,
        avatarDataUrl: null,
        createdAt: now(),
        currentRoomCode: null
      };
    }

    sendJson(res, 200, {
      user: db.users[deviceId],
      disbandNotice: db.lastDisbandNoticeByUser[deviceId] || null
    });
    delete db.lastDisbandNoticeByUser[deviceId];
  }),

  'POST /api/profile': withErrorHandling(async (req, res) => {
    const { deviceId, username, avatarDataUrl } = await parseJsonBody(req);
    if (!deviceId) throw new Error('deviceId required');

    const user = getUser(deviceId);
    if (!user) {
      const err = new Error('Create session first.');
      err.statusCode = 401;
      throw err;
    }

    const cleaned = sanitizeUsername(username);
    const key = usernameKey(cleaned);
    if (!cleaned || cleaned.length < 3 || cleaned.length > 20) {
      throw new Error('Username must be 3-20 chars.');
    }

    const currentKey = user.username ? usernameKey(user.username) : null;
    if (db.usernames[key] && db.usernames[key] !== deviceId) {
      throw new Error('Username is already taken.');
    }

    if (currentKey && db.usernames[currentKey] === deviceId) {
      delete db.usernames[currentKey];
    }

    db.usernames[key] = deviceId;
    user.username = cleaned;
    user.avatarDataUrl = avatarDataUrl || null;

    sendJson(res, 200, { user });
  }),

  'POST /api/rooms/create': withErrorHandling(async (req, res) => {
    const { deviceId } = await parseJsonBody(req);
    const user = requireUser(deviceId);

    if (user.currentRoomCode && db.rooms[user.currentRoomCode]) {
      throw new Error('Already in a room.');
    }

    let code = randomCode();
    while (db.rooms[code]) code = randomCode();

    db.rooms[code] = {
      code,
      hostDeviceId: deviceId,
      players: [deviceId],
      started: false,
      bankruptPlayers: {},
      winnerDeviceId: null,
      settings: {
        maximumPlayers: 6,
        evenBuild: true,
        mortgage: true,
        noRentInPrison: false,
        auction: true,
        vacationCash: false,
        doubleRentOnSet: true,
        startingCash: 1500
      },
      tradeRequests: [],
      events: [{ id: crypto.randomUUID(), at: now(), message: `${user.username} created the room.` }]
    };

    user.currentRoomCode = code;

    sendJson(res, 200, { room: makeRoomState(code) });
  }),

  'POST /api/rooms/join': withErrorHandling(async (req, res) => {
    const { deviceId, roomCode } = await parseJsonBody(req);
    const user = requireUser(deviceId);
    const code = String(roomCode || '').trim();
    const room = db.rooms[code];
    if (!room) throw new Error('Room not found.');

    if (user.currentRoomCode && user.currentRoomCode !== code && db.rooms[user.currentRoomCode]) {
      throw new Error('Leave current room first.');
    }

    if (!room.players.includes(deviceId)) {
      if (room.started) throw new Error('Game already started.');
      if (room.players.length >= room.settings.maximumPlayers) {
        throw new Error('Room is full.');
      }
      room.players.push(deviceId);
      room.events.push({ id: crypto.randomUUID(), at: now(), message: `${user.username} joined.` });
    }

    user.currentRoomCode = code;
    sendJson(res, 200, { room: makeRoomState(code) });
  }),

  'POST /api/rooms/leave': withErrorHandling(async (req, res) => {
    const { deviceId } = await parseJsonBody(req);
    const user = requireUser(deviceId);
    if (!user.currentRoomCode) {
      throw new Error('Not in a room.');
    }

    clearUserFromRoom(deviceId, user.currentRoomCode);
    user.currentRoomCode = null;

    sendJson(res, 200, { ok: true });
  }),

  'POST /api/rooms/settings': withErrorHandling(async (req, res) => {
    const { deviceId, settings } = await parseJsonBody(req);
    const user = requireUser(deviceId);
    const room = db.rooms[user.currentRoomCode];
    if (!room) throw new Error('Room not found.');
    if (room.hostDeviceId !== deviceId) throw new Error('Only room host can update settings.');
    if (room.started) throw new Error('Cannot edit settings after game starts.');

    room.settings = {
      ...room.settings,
      maximumPlayers: Number(settings.maximumPlayers || room.settings.maximumPlayers),
      startingCash: Number(settings.startingCash || room.settings.startingCash),
      evenBuild: !!settings.evenBuild,
      mortgage: !!settings.mortgage,
      noRentInPrison: !!settings.noRentInPrison,
      auction: !!settings.auction,
      vacationCash: !!settings.vacationCash,
      doubleRentOnSet: !!settings.doubleRentOnSet
    };

    sendJson(res, 200, { room: makeRoomState(user.currentRoomCode) });
  }),

  'POST /api/rooms/kick': withErrorHandling(async (req, res) => {
    const { deviceId, targetDeviceId } = await parseJsonBody(req);
    const user = requireUser(deviceId);
    const room = db.rooms[user.currentRoomCode];
    if (!room) throw new Error('Room not found.');
    if (room.hostDeviceId !== deviceId) throw new Error('Only host can kick.');
    if (room.started) throw new Error('Kicking is disabled after game starts.');
    if (targetDeviceId === deviceId) throw new Error('Host cannot kick self.');
    if (!room.players.includes(targetDeviceId)) throw new Error('Target not in room.');

    clearUserFromRoom(targetDeviceId, room.code);
    room.events.push({
      id: crypto.randomUUID(),
      at: now(),
      message: `${db.users[targetDeviceId]?.username || 'A player'} was kicked.`
    });

    sendJson(res, 200, { room: makeRoomState(room.code) });
  }),

  'POST /api/rooms/start': withErrorHandling(async (req, res) => {
    const { deviceId } = await parseJsonBody(req);
    const user = requireUser(deviceId);
    const room = db.rooms[user.currentRoomCode];
    if (!room) throw new Error('Room not found.');
    if (room.hostDeviceId !== deviceId) throw new Error('Only host can start game.');
    if (room.players.length < 2) throw new Error('Need at least 2 players.');

    room.started = true;
    room.events.push({ id: crypto.randomUUID(), at: now(), message: 'Game started.' });

    sendJson(res, 200, { room: makeRoomState(room.code) });
  }),

  'POST /api/rooms/bankrupt': withErrorHandling(async (req, res) => {
    const { deviceId } = await parseJsonBody(req);
    const user = requireUser(deviceId);
    const room = db.rooms[user.currentRoomCode];
    if (!room) throw new Error('Room not found.');
    if (!room.started) throw new Error('Game not started.');

    room.bankruptPlayers[deviceId] = true;
    room.events.push({ id: crypto.randomUUID(), at: now(), message: `${user.username} declared bankruptcy.` });

    evaluateWinner(room.code);

    sendJson(res, 200, { room: db.rooms[room.code] ? makeRoomState(room.code) : null });
  }),

  'POST /api/rooms/trade': withErrorHandling(async (req, res) => {
    const { deviceId, targetDeviceId, offerText } = await parseJsonBody(req);
    const user = requireUser(deviceId);
    const room = db.rooms[user.currentRoomCode];
    if (!room) throw new Error('Room not found.');
    if (!room.started) throw new Error('Game not started.');
    if (!room.players.includes(targetDeviceId)) throw new Error('Target not in room.');

    const trade = {
      id: crypto.randomUUID(),
      fromDeviceId: deviceId,
      toDeviceId: targetDeviceId,
      offerText: String(offerText || '').slice(0, 200),
      status: 'pending',
      createdAt: now()
    };

    room.tradeRequests.unshift(trade);
    room.events.push({
      id: crypto.randomUUID(),
      at: now(),
      message: `${user.username} sent a trade offer to ${db.users[targetDeviceId]?.username || 'player'}.`
    });

    sendJson(res, 200, { room: makeRoomState(room.code) });
  }),

  'POST /api/rooms/trade/respond': withErrorHandling(async (req, res) => {
    const { deviceId, tradeId, action } = await parseJsonBody(req);
    const user = requireUser(deviceId);
    const room = db.rooms[user.currentRoomCode];
    if (!room) throw new Error('Room not found.');

    const trade = room.tradeRequests.find((t) => t.id === tradeId);
    if (!trade) throw new Error('Trade not found.');
    if (trade.toDeviceId !== deviceId) throw new Error('Only recipient can respond.');

    trade.status = action === 'accept' ? 'accepted' : 'declined';
    room.events.push({
      id: crypto.randomUUID(),
      at: now(),
      message: `${user.username} ${trade.status} a trade request.`
    });

    sendJson(res, 200, { room: makeRoomState(room.code) });
  }),

  'GET /api/state': withErrorHandling(async (req, res, url) => {
    const deviceId = url.searchParams.get('deviceId');
    const user = getUser(deviceId);
    if (!user) {
      const err = new Error('Session not found');
      err.statusCode = 401;
      throw err;
    }

    const roomCode = user.currentRoomCode;
    sendJson(res, 200, {
      user,
      room: roomCode ? makeRoomState(roomCode) : null,
      disbandNotice: db.lastDisbandNoticeByUser[deviceId] || null
    });
    delete db.lastDisbandNoticeByUser[deviceId];
  })
};

function serveStatic(req, res, urlPath) {
  const safePath = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(__dirname, 'public', safePath);
  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath);
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8'
    };

    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain; charset=utf-8' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const routeKey = `${req.method.toUpperCase()} ${url.pathname}`;
  const handler = apiHandlers[routeKey];

  if (handler) {
    return handler(req, res, url);
  }

  if (req.method === 'GET') {
    return serveStatic(req, res, url.pathname);
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`BGMonopoly server running on http://localhost:${PORT}`);
});
