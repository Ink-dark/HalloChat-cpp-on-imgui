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
const NODE_ENV = process.env.NODE_ENV || 'development';
const DEFAULT_WEB_PORT = NODE_ENV === 'production' ? 4444 : 3333;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || `http://localhost:${DEFAULT_WEB_PORT}`;

const ACCOUNT_DIR = path.join(__dirname, '..', 'Account');
const PAK_FILENAME = 'pak.JSON';
const GROUP_CHAT_FILE = path.join(__dirname, '..', 'group_chat.json');

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

const { spawn } = require('child_process');
let monitorProc = null;
function startMonitorWeb() {
  if (monitorProc) return;
  const monitorDir = path.join(__dirname, '..', 'monitor');
  if (!fs.existsSync(monitorDir)) return;
  const isProd = process.env.NODE_ENV === 'production';
  const run = (cmd, args, opts = {}) =>
    new Promise((resolve, reject) => {
      const p = spawn(cmd, args, { cwd: monitorDir, stdio: 'inherit', ...opts });
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    });
  const ensureInstall = async () => {
    if (!fs.existsSync(path.join(monitorDir, 'node_modules'))) {
      await run('npm', ['install']);
    }
  };
  const startDev = () => {
    // Check if port 3333 is in use? No, let Vite handle it (strictPort: false)
    // Or we could try to kill whatever is on 3333 if we really want to enforce it.
    // For now, let's just spawn.
    monitorProc = spawn('npm', ['run', 'dev', '--', '--port', '3333'], { cwd: monitorDir, stdio: 'inherit' });
    monitorProc.on('close', () => {
      monitorProc = null;
    });
  };
  const startPreview = async () => {
    await run('npm', ['run', 'build']);
    monitorProc = spawn('npm', ['run', 'preview'], { cwd: monitorDir, stdio: 'inherit' });
    monitorProc.on('close', () => {
      monitorProc = null;
    });
  };
  (async () => {
    try {
      await ensureInstall();
      if (isProd) {
        await startPreview();
      } else {
        startDev();
      }
    } catch {}
  })();
}

process.on('exit', () => {
  if (monitorProc && !monitorProc.killed) {
    monitorProc.kill('SIGINT');
  }
});

function ensureAccountDir() {
  if (!fs.existsSync(ACCOUNT_DIR)) {
    fs.mkdirSync(ACCOUNT_DIR, { recursive: true });
  }
}

function writeJsonAtomic(filePath, data) {
  const tmpFile = `${filePath}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
  fs.renameSync(tmpFile, filePath);
}

function sanitizeDirPrefix(username) {
  const sanitized = String(username).trim().replace(/[^a-zA-Z0-9_-]+/g, '_');
  return sanitized.length ? sanitized.slice(0, 32) : 'user';
}

function readPakFile(dirPath) {
  const pakPath = path.join(dirPath, PAK_FILENAME);
  if (!fs.existsSync(pakPath)) return null;
  try {
    const raw = fs.readFileSync(pakPath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

function listUserRecords() {
  ensureAccountDir();
  const entries = fs.readdirSync(ACCOUNT_DIR, { withFileTypes: true });
  const records = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(ACCOUNT_DIR, entry.name);
    const pak = readPakFile(dirPath);
    if (!pak || !pak.uid || !pak.username) continue;
    records.push({ user: pak, dir: dirPath });
  }
  return records;
}

function findUserRecordByUsername(username) {
  const records = listUserRecords();
  return records.find((r) => r.user.username === username) || null;
}

function findUserRecordByUid(uid) {
  const records = listUserRecords();
  return records.find((r) => r.user.uid === uid) || null;
}

function createAccount(username, passwordHash, passwordSalt, uid) {
  ensureAccountDir();
  const dirPrefix = sanitizeDirPrefix(username);
  const dirPath = path.join(ACCOUNT_DIR, `${dirPrefix}_${uid}`);
  fs.mkdirSync(dirPath, { recursive: true });
  const user = {
    uid,
    username,
    passwordHash,
    passwordSalt,
    createdAt: Date.now()
  };
  writeJsonAtomic(path.join(dirPath, PAK_FILENAME), user);
  return { user, dir: dirPath };
}

function listFriendFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => {
      if (!name.toLowerCase().endsWith('.json')) return false;
      if (name.toLowerCase() === PAK_FILENAME.toLowerCase()) return false;
      return true;
    });
}

function readFriendFile(dirPath, friendUid) {
  const filePath = path.join(dirPath, `${friendUid}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

function upsertFriendFile(dirPath, friendUser) {
  const filePath = path.join(dirPath, `${friendUser.uid}.json`);
  const existing = readFriendFile(dirPath, friendUser.uid);
  const payload = {
    uid: friendUser.uid,
    username: friendUser.username,
    messages: Array.isArray(existing?.messages) ? existing.messages : []
  };
  writeJsonAtomic(filePath, payload);
  return payload;
}

function listFriends(dirPath) {
  const files = listFriendFiles(dirPath);
  const friends = [];
  for (const file of files) {
    const filePath = path.join(dirPath, file);
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(raw);
      if (data && data.uid && data.username) {
        friends.push({ uid: data.uid, username: data.username });
      }
    } catch (err) {
      // ignore invalid files
    }
  }
  return friends;
}

function appendPrivateMessage(fromRecord, toRecord, message) {
  const fromFriend = upsertFriendFile(fromRecord.dir, toRecord.user);
  const toFriend = upsertFriendFile(toRecord.dir, fromRecord.user);

  fromFriend.messages.push(message);
  toFriend.messages.push(message);

  writeJsonAtomic(path.join(fromRecord.dir, `${toRecord.user.uid}.json`), fromFriend);
  writeJsonAtomic(path.join(toRecord.dir, `${fromRecord.user.uid}.json`), toFriend);
}

function readGroupChat() {
  if (!fs.existsSync(GROUP_CHAT_FILE)) return [];
  try {
    const raw = fs.readFileSync(GROUP_CHAT_FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    return [];
  }
}

function appendGroupMessage(message) {
  const messages = readGroupChat();
  messages.push(message);
  writeJsonAtomic(GROUP_CHAT_FILE, messages);
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
  const record = findUserRecordByUid(uid);
  if (!record) {
    return res.status(401).json({ success: false, message: 'User not found' });
  }
  req.user = record.user;
  req.userRecord = record;
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

  const existing = findUserRecordByUsername(username);
  if (existing) {
    return res.status(409).json({ success: false, message: 'Username already exists' });
  }

  const uid = crypto.randomUUID();
  const { salt, hash } = hashPassword(password);
  const record = createAccount(username, hash, salt, uid);

  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, uid);

  res.json({ success: true, uid, username: record.user.username, token });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Missing username or password' });
  }

  const record = findUserRecordByUsername(username);
  if (!record) {
    return res.status(401).json({ success: false, message: 'Invalid credentials' });
  }

  if (!verifyPassword(password, record.user.passwordSalt, record.user.passwordHash)) {
    return res.status(401).json({ success: false, message: 'Invalid credentials' });
  }

  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, record.user.uid);

  res.json({ success: true, uid: record.user.uid, username: record.user.username, token });
});

app.post('/api/friends/add', requireAuth, (req, res) => {
  const { uid } = req.body || {};
  if (!uid || typeof uid !== 'string') {
    return res.status(400).json({ success: false, message: 'Missing uid' });
  }
  if (uid === req.user.uid) {
    return res.status(400).json({ success: false, message: 'Cannot add yourself' });
  }

  const target = findUserRecordByUid(uid);
  if (!target) {
    return res.status(404).json({ success: false, message: 'User not found' });
  }

  const me = req.userRecord;
  upsertFriendFile(me.dir, target.user);
  upsertFriendFile(target.dir, me.user);

  res.json({ success: true, friend: { uid: target.user.uid, username: target.user.username } });
});

app.get('/api/friends/list', requireAuth, (req, res) => {
  const me = req.userRecord;
  const friends = listFriends(me.dir);
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

        const record = findUserRecordByUid(uid);
        if (!record) {
          ws.send(JSON.stringify({ type: 'auth', success: false, message: 'User not found' }));
          ws.close();
          return;
        }

        ws.meta.authenticated = true;
        ws.meta.id = record.user.uid;
        ws.meta.name = record.user.username;
        onlineUsers.set(record.user.uid, ws);

        ws.send(JSON.stringify({ type: 'auth', success: true, uid: record.user.uid, name: record.user.username }));
        broadcast({
          type: 'system',
          message: `${record.user.username} joined`,
          uid: record.user.uid,
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
      appendGroupMessage(message);
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
      const fromRecord = findUserRecordByUid(ws.meta.id);
      const toRecord = findUserRecordByUid(payload.toUid);
      if (fromRecord && toRecord) {
        appendPrivateMessage(fromRecord, toRecord, message);
      }
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

function getUserCount() {
  if (!fs.existsSync(ACCOUNT_DIR)) return 0;
  return fs.readdirSync(ACCOUNT_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .length;
}

app.get('/stats', (_req, res) => {
  pruneMessages();
  res.json({
    activeConnections,
    totalConnections,
    totalMessages,
    totalUsers: getUserCount(),
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
  startMonitorWeb();
});
