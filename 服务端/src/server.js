const express = require('express');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { monitorEventLoopDelay } = require('perf_hooks');

const PORT = Number(process.env.PORT || 3001);
const WS_PATH = process.env.WS_PATH || '/ws';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:5173';

const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: WS_PATH });

const startTime = Date.now();
let totalConnections = 0;
let activeConnections = 0;
let totalMessages = 0;
let errorCount = 0;
let lastMessageAt = null;
const messageTimestamps = [];

const sessions = new Map();
const onlineUsers = new Map();

const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadUsers() {
  ensureDataDir();
  if (!fs.existsSync(USERS_FILE)) {
    return { users: [] };
  }
  try {
    const raw = fs.readFileSync(USERS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return { users: [] };
  }
}

function saveUsers(data) {
  ensureDataDir();
  const tmpFile = `${USERS_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
  fs.renameSync(tmpFile, USERS_FILE);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expectedHash, 'hex'));
}

function pruneMessages() {
  const cutoff = Date.now() - 60_000;
  while (messageTimestamps.length && messageTimestamps[0] < cutoff) {
    messageTimestamps.shift();
  }
}

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1 && client.meta?.authenticated) {
      client.send(data);
    }
  }
}

function getToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  if (req.body && typeof req.body.token === 'string') return req.body.token;
  return null;
}

function requireAuth(req, res, next) {
  const token = getToken(req);
  if (!token || !sessions.has(token)) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  const uid = sessions.get(token);
  const usersData = loadUsers();
  const user = usersData.users.find((u) => u.uid === uid);
  if (!user) {
    return res.status(401).json({ success: false, message: 'User not found' });
  }
  req.user = user;
  req.usersData = usersData;
  req.token = token;
  next();
}

app.post('/api/auth/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Missing username or password' });
  }
  if (username.length < 3 || password.length < 6) {
    return res.status(400).json({ success: false, message: 'Username >=3, password >=6' });
  }

  const data = loadUsers();
  if (data.users.some((u) => u.username === username)) {
    return res.status(409).json({ success: false, message: 'Username already exists' });
  }

  const uid = crypto.randomUUID();
  const { salt, hash } = hashPassword(password);
  const user = {
    uid,
    username,
    passwordHash: hash,
    passwordSalt: salt,
    friends: [],
    createdAt: Date.now()
  };
  data.users.push(user);
  saveUsers(data);

  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, uid);

  res.json({ success: true, uid, username, token });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Missing username or password' });
  }

  const data = loadUsers();
  const user = data.users.find((u) => u.username === username);
  if (!user) {
    return res.status(401).json({ success: false, message: 'Invalid credentials' });
  }

  if (!verifyPassword(password, user.passwordSalt, user.passwordHash)) {
    return res.status(401).json({ success: false, message: 'Invalid credentials' });
  }

  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, user.uid);

  res.json({ success: true, uid: user.uid, username: user.username, token });
});

app.post('/api/friends/add', requireAuth, (req, res) => {
  const { uid } = req.body || {};
  if (!uid || typeof uid !== 'string') {
    return res.status(400).json({ success: false, message: 'Missing uid' });
  }
  if (uid === req.user.uid) {
    return res.status(400).json({ success: false, message: 'Cannot add yourself' });
  }

  const data = req.usersData;
  const target = data.users.find((u) => u.uid === uid);
  if (!target) {
    return res.status(404).json({ success: false, message: 'User not found' });
  }

  const me = data.users.find((u) => u.uid === req.user.uid);
  if (!me.friends.includes(uid)) me.friends.push(uid);
  if (!target.friends.includes(me.uid)) target.friends.push(me.uid);
  saveUsers(data);

  res.json({ success: true, friend: { uid: target.uid, username: target.username } });
});

app.get('/api/friends/list', requireAuth, (req, res) => {
  const data = req.usersData;
  const me = data.users.find((u) => u.uid === req.user.uid);
  const friends = me.friends
    .map((uid) => data.users.find((u) => u.uid === uid))
    .filter(Boolean)
    .map((u) => ({ uid: u.uid, username: u.username }));
  res.json({ success: true, friends });
});

wss.on('connection', (ws, req) => {
  activeConnections += 1;
  totalConnections += 1;

  ws.meta = {
    authenticated: false,
    id: null,
    name: null,
    connectedAt: Date.now(),
    ip: req.socket.remoteAddress || 'unknown'
  };

  ws.on('message', (raw) => {
    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch (err) {
      errorCount += 1;
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    if (!ws.meta.authenticated) {
      if (payload.type === 'auth' && typeof payload.token === 'string') {
        const uid = sessions.get(payload.token);
        if (!uid) {
          ws.send(JSON.stringify({ type: 'auth', success: false, message: 'Invalid token' }));
          ws.close();
          return;
        }

        const data = loadUsers();
        const user = data.users.find((u) => u.uid === uid);
        if (!user) {
          ws.send(JSON.stringify({ type: 'auth', success: false, message: 'User not found' }));
          ws.close();
          return;
        }

        ws.meta.authenticated = true;
        ws.meta.id = user.uid;
        ws.meta.name = user.username;
        onlineUsers.set(user.uid, ws);

        ws.send(JSON.stringify({ type: 'auth', success: true, uid: user.uid, name: user.username }));
        broadcast({
          type: 'system',
          message: `${user.username} joined`,
          uid: user.uid,
          ts: Date.now()
        });
        return;
      }

      ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
      return;
    }

    if (payload.type === 'message' && typeof payload.text === 'string') {
      const text = payload.text.trim();
      if (!text) return;

      const message = {
        type: 'message',
        uid: ws.meta.id,
        name: ws.meta.name,
        text,
        ts: Date.now()
      };

      totalMessages += 1;
      lastMessageAt = message.ts;
      messageTimestamps.push(message.ts);
      pruneMessages();

      broadcast(message);
      return;
    }

    if (payload.type === 'private' && typeof payload.text === 'string' && typeof payload.toUid === 'string') {
      const text = payload.text.trim();
      if (!text) return;

      const message = {
        type: 'private',
        fromUid: ws.meta.id,
        fromName: ws.meta.name,
        toUid: payload.toUid,
        text,
        ts: Date.now()
      };

      totalMessages += 1;
      lastMessageAt = message.ts;
      messageTimestamps.push(message.ts);
      pruneMessages();

      const target = onlineUsers.get(payload.toUid);
      if (target && target.readyState === 1) {
        target.send(JSON.stringify(message));
      }

      ws.send(JSON.stringify(message));
      return;
    }

    errorCount += 1;
    ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
  });

  ws.on('close', () => {
    activeConnections = Math.max(0, activeConnections - 1);
    if (ws.meta?.authenticated) {
      onlineUsers.delete(ws.meta.id);
      broadcast({
        type: 'system',
        message: `${ws.meta.name} left`,
        uid: ws.meta.id,
        ts: Date.now()
      });
    }
  });

  ws.on('error', () => {
    errorCount += 1;
  });
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    now: Date.now(),
    startTime,
    uptimeSec: Math.floor((Date.now() - startTime) / 1000)
  });
});

app.get('/stats', (_req, res) => {
  pruneMessages();
  res.json({
    activeConnections,
    totalConnections,
    totalMessages,
    messagesLastMinute: messageTimestamps.length,
    lastMessageAt,
    errorCount,
    startTime,
    uptimeSec: Math.floor((Date.now() - startTime) / 1000)
  });
});

app.get('/metrics', (_req, res) => {
  pruneMessages();
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  res.json({
    nodeVersion: process.version,
    pid: process.pid,
    platform: process.platform,
    uptimeSec: Math.floor((Date.now() - startTime) / 1000),
    eventLoopDelayMs: Number((loopDelay.mean / 1e6).toFixed(2)),
    loadAvg: os.loadavg(),
    totalMem: os.totalmem(),
    freeMem: os.freemem(),
    rss: mem.rss,
    heapTotal: mem.heapTotal,
    heapUsed: mem.heapUsed,
    external: mem.external,
    arrayBuffers: mem.arrayBuffers,
    cpuUserMicros: cpu.user,
    cpuSystemMicros: cpu.system,
    activeConnections,
    totalConnections,
    totalMessages,
    messagesLastMinute: messageTimestamps.length,
    errorCount
  });
});

app.get('/', (_req, res) => {
  res.type('text').send('HalloChat server is running.');
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`WebSocket path: ws://localhost:${PORT}${WS_PATH}`);
});
