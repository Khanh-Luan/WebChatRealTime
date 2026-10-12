'use strict';

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3001;
const HISTORY_LIMIT = 100;
const STORE_DIR = process.env.WEBCHAT_DATA_DIR ? path.resolve(process.env.WEBCHAT_DATA_DIR) : path.join(__dirname, 'data');
const STORE_PATH = path.join(STORE_DIR, 'store.json');
const DEFAULT_ROOMS = [
  { id: 'general', name: 'sảnh-chung', description: 'Không gian trò chuyện chung của mọi thành viên', type: 'channel', members: [] },
  { id: 'cong-viec', name: 'công-việc', description: 'Trao đổi công việc, tài liệu & dự án nhóm', type: 'channel', members: [] },
  { id: 'random', name: 'tán-gẫu', description: 'Chia sẻ tự do & giải trí mỗi ngày', type: 'channel', members: [] },
];
const DEMO_USERS = [
  { username: 'minhtuan', password: '123456', displayName: 'Minh Tuấn', avatar: '😎', bio: 'Thiết kế sản phẩm · TP.HCM' },
  { username: 'lananh', password: '123456', displayName: 'Lan Anh', avatar: '🌷', bio: 'Quản lý dự án · Hà Nội' },
  { username: 'hoangnam', password: '123456', displayName: 'Hoàng Nam', avatar: '🚀', bio: 'Kỹ sư phần mềm · Đà Nẵng' },
];

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const [algorithm, salt, expectedHex] = String(stored || '').split('$');
  if (algorithm !== 'scrypt' || !salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function loadStore() {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  if (!fs.existsSync(STORE_PATH)) {
    return { users: [], rooms: DEFAULT_ROOMS, messages: {}, tokens: {} };
  }
  try {
    const value = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return {
      users: Array.isArray(value.users) ? value.users : [],
      rooms: Array.isArray(value.rooms) ? value.rooms : DEFAULT_ROOMS,
      messages: value.messages && typeof value.messages === 'object' ? value.messages : {},
      tokens: value.tokens && typeof value.tokens === 'object' ? value.tokens : {},
    };
  } catch (error) {
    throw new Error(`Không đọc được ${STORE_PATH}: ${error.message}`);
  }
}

const store = loadStore();
store.rooms = store.rooms.filter((r) => r.id !== 'dev-team' && r.name !== 'kỹ-thuật-ai');
for (const room of DEFAULT_ROOMS) {
  const existing = store.rooms.find((item) => item.id === room.id);
  if (!existing) {
    store.rooms.push(room);
  } else {
    existing.name = room.name;
    existing.description = room.description;
  }
}
for (const demo of DEMO_USERS) {
  const existingUser = store.users.find((user) => user.username === demo.username);
  if (!existingUser) {
    store.users.push({
      username: demo.username,
      passwordHash: hashPassword(demo.password),
      displayName: demo.displayName,
      avatar: demo.avatar,
      bio: demo.bio,
      settings: {},
      createdAt: new Date().toISOString(),
    });
  } else if (!existingUser.bio) {
    existingUser.bio = demo.bio;
  }
}

function saveStore() {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  const payload = `${JSON.stringify(store, null, 2)}\n`;
  try {
    fs.writeFileSync(STORE_PATH, payload, 'utf8');
  } catch {
    setTimeout(() => {
      try {
        fs.writeFileSync(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
      } catch {
        // Ignore transient OneDrive sync lock
      }
    }, 150);
  }
}
saveStore();

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const safeText = (value, maxLength) => typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
const tokenDigest = (token) => crypto.createHash('sha256').update(token).digest('hex');
const publicUser = (user) => ({
  username: user.username,
  displayName: user.displayName,
  avatar: user.avatar,
  bio: user.bio,
  settings: user.settings || {},
});
const findUser = (username) => store.users.find((user) => user.username === username);

function authenticateToken(token) {
  if (typeof token !== 'string' || !token) return null;
  const username = store.tokens[tokenDigest(token)];
  return username ? findUser(username) || null : null;
}

function issueToken(user) {
  const token = crypto.randomBytes(32).toString('base64url');
  store.tokens[tokenDigest(token)] = user.username;
  saveStore();
  return token;
}

function sendAuthError(res, status, error) {
  res.status(status).json({ ok: false, error });
}

function normalizeUsername(raw) {
  const clean = safeText(raw, 32)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
  return clean || '';
}

app.get('/api/auth/me', (req, res) => {
  const authHeader = String(req.headers.authorization || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const user = authenticateToken(token);
  if (!user) return sendAuthError(res, 401, 'Phiên đăng nhập đã hết hạn.');
  res.json({ ok: true, user: publicUser(user) });
});

app.post('/api/auth/register', (req, res) => {
  const rawName = safeText(req.body?.username, 32);
  const username = normalizeUsername(rawName);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const displayName = safeText(req.body?.displayName, 48) || rawName || username;
  const avatar = safeText(req.body?.avatar, 16) || '😎';
  const bio = safeText(req.body?.bio, 240) || 'Thành viên Mây Chat';
  if (username.length < 2) {
    return sendAuthError(res, 400, 'Tên đăng nhập cần có ít nhất 2 ký tự chữ hoặc số.');
  }
  if (password.length < 1) {
    return sendAuthError(res, 400, 'Vui lòng nhập mật khẩu.');
  }
  if (findUser(username)) return sendAuthError(res, 409, 'Tên tài khoản này đã tồn tại, hãy chuyển sang tab Đăng nhập.');
  const user = {
    username,
    passwordHash: hashPassword(password),
    displayName,
    avatar,
    bio,
    settings: {},
    createdAt: new Date().toISOString(),
  };
  store.users.push(user);
  const token = issueToken(user);
  broadcastUsers();
  res.status(201).json({ ok: true, token, user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const user = findUser(username);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return sendAuthError(res, 401, 'Tên tài khoản hoặc mật khẩu không đúng.');
  }
  const token = issueToken(user);
  broadcastUsers();
  res.json({ ok: true, token, user: publicUser(user) });
});

app.post('/api/profile', (req, res) => {
  const authHeader = String(req.headers.authorization || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const user = authenticateToken(token);
  if (!user) return sendAuthError(res, 401, 'Phiên đăng nhập đã hết hạn.');
  const displayName = safeText(req.body?.displayName, 48);
  const bio = safeText(req.body?.bio, 240);
  const avatar = safeText(req.body?.avatar, 16);
  if (displayName) user.displayName = displayName;
  if (bio !== undefined) user.bio = bio;
  if (avatar) user.avatar = avatar;
  saveStore();
  broadcastUsers();
  res.json({ ok: true, user: publicUser(user) });
});

app.post('/api/settings', (req, res) => {
  const authHeader = String(req.headers.authorization || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const user = authenticateToken(token);
  if (!user) return sendAuthError(res, 401, 'Phiên đăng nhập đã hết hạn.');
  const theme = safeText(req.body?.theme, 16) || 'dark';
  const accent = safeText(req.body?.accent, 16) || '#0ea5e9';
  const fontSize = safeText(req.body?.fontSize, 16) || 'normal';
  const sound = req.body?.sound !== false;
  const sendTyping = req.body?.sendTyping !== false;
  const enterToSend = req.body?.enterToSend !== false;
  user.settings = { theme, accent, fontSize, sound, sendTyping, enterToSend };
  saveStore();
  res.json({ ok: true, settings: user.settings, user: publicUser(user) });
});

function connectedUsernames() {
  const online = new Set();
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.user) online.add(socket.data.user.username);
  }
  return online;
}

function getUsers() {
  const online = connectedUsernames();
  return store.users.map((user) => ({ ...publicUser(user), online: online.has(user.username) }));
}

function roomsFor(user) {
  return store.rooms.filter((room) => room.type !== 'dm' || room.members.includes(user.username));
}

function broadcastUsers() {
  io.emit('users', getUsers());
}

function emitRooms(user) {
  io.to(`user:${user.username}`).emit('rooms', roomsFor(user));
}

function emitToRoomEligible(room, event, payload) {
  if (!room) return;
  if (room.type === 'dm' && Array.isArray(room.members)) {
    for (const username of room.members) {
      io.to(`user:${username}`).emit(event, payload);
    }
  } else {
    io.emit(event, payload);
  }
}

function emitPresence(roomId) {
  const onlineMembers = new Map();
  for (const socket of io.sockets.sockets.values()) {
    const state = socket.data.member;
    if (state?.roomId === roomId) onlineMembers.set(state.user.username, publicUser(state.user));
  }
  io.to(roomId).emit('presence', [...onlineMembers.values()]);
}

function emitRoomLists() {
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.user) emitRooms(socket.data.user);
  }
}

function roomById(roomId) {
  return store.rooms.find((room) => room.id === roomId);
}

function getHistory(roomId) {
  if (!Array.isArray(store.messages[roomId])) store.messages[roomId] = [];
  return store.messages[roomId];
}

function sendError(socket, message) {
  socket.emit('error', { message });
}

function setSocketUser(socket, user) {
  socket.data.user = user;
  socket.join(`user:${user.username}`);
  broadcastUsers();
  emitRooms(user);
}

io.on('connection', (socket) => {
  const handshakeUser = authenticateToken(socket.handshake.auth?.token);
  if (handshakeUser) setSocketUser(socket, handshakeUser);

  socket.on('join', (data = {}) => {
    const user = authenticateToken(data.token) || socket.data.user;
    if (!user) return sendError(socket, 'Phiên đăng nhập không hợp lệ. Vui lòng đăng nhập lại.');
    setSocketUser(socket, user);
    const roomId = safeText(data.roomId || data.room, 100);
    const room = roomById(roomId);
    if (!room || (room.type === 'dm' && !room.members.includes(user.username))) {
      return sendError(socket, 'Bạn không có quyền tham gia phòng chat này.');
    }

    const previous = socket.data.member;
    if (previous) {
      socket.leave(previous.roomId);
      socket.data.member = null;
      emitPresence(previous.roomId);
    }
    socket.join(room.id);
    socket.data.member = { user, roomId: room.id };
    socket.emit('history', {
      roomId: room.id,
      pinnedMessageId: room.pinnedMessageId || null,
      messages: getHistory(room.id),
    });
    emitPresence(room.id);
  });

  socket.on('profile:update', (data = {}) => {
    const user = socket.data.user;
    if (!user) return sendError(socket, 'Vui lòng đăng nhập để cập nhật hồ sơ.');
    const displayName = safeText(data.displayName, 48);
    const bio = safeText(data.bio, 240);
    const avatar = safeText(data.avatar, 16);
    if (displayName) user.displayName = displayName;
    if (bio !== undefined) user.bio = bio;
    if (avatar) user.avatar = avatar;
    saveStore();
    broadcastUsers();
  });

  socket.on('dm:open', (data = {}) => {
    const user = socket.data.user || authenticateToken(data.token);
    const targetName = safeText(data.targetUsername, 24).toLowerCase();
    const target = findUser(targetName);
    if (!user) return sendError(socket, 'Vui lòng đăng nhập để mở tin nhắn riêng.');
    if (!target || target.username === user.username) return sendError(socket, 'Tài khoản nhận không hợp lệ.');
    const pair = [user.username, target.username].sort();
    const id = `dm:${pair[0]}:${pair[1]}`;
    let room = roomById(id);
    if (!room) {
      room = {
        id,
        name: `${pair[0]} & ${pair[1]}`,
        description: 'Trò chuyện riêng 1-1',
        type: 'dm',
        members: pair,
        createdAt: new Date().toISOString(),
      };
      store.rooms.push(room);
      saveStore();
    }
    emitRooms(user);
    emitRooms(target);
    socket.emit('room:joined', { room });
  });

  socket.on('room:create', (data = {}) => {
    const user = socket.data.user;
    if (!user) return sendError(socket, 'Vui lòng đăng nhập để tạo phòng.');
    const name = safeText(data.name, 48);
    const description = safeText(data.description, 240);
    if (!name) return sendError(socket, 'Tên phòng không được để trống.');
    const idBase = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'room';
    let id = idBase;
    let suffix = 2;
    while (roomById(id)) id = `${idBase}-${suffix++}`;
    const room = { id, name, description, type: 'channel', members: [], createdBy: user.username, createdAt: new Date().toISOString() };
    store.rooms.push(room);
    saveStore();
    emitRoomLists();
    socket.emit('room:joined', { room });
  });

  socket.on('message:send', (data = {}) => {
    const member = socket.data.member;
    if (!member) return sendError(socket, 'Tham gia một phòng trước khi gửi tin nhắn.');
    const text = safeText(data.text || data.content, 4000);
    if (!text) return;
    const room = roomById(member.roomId);
    const message = {
      id: `m-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`,
      roomId: member.roomId,
      username: member.user.username,
      displayName: member.user.displayName,
      avatar: member.user.avatar,
      text,
      replyTo: data.replyTo && typeof data.replyTo === 'object' ? data.replyTo : null,
      timestamp: new Date().toISOString(),
      reactions: {},
    };
    const history = getHistory(member.roomId);
    history.push(message);
    if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
    saveStore();
    emitToRoomEligible(room, 'message:new', message);
  });

  socket.on('message:edit', (data = {}) => {
    const member = socket.data.member;
    if (!member) return sendError(socket, 'Tham gia một phòng trước khi sửa tin nhắn.');
    const roomId = safeText(data.roomId || member.roomId, 100);
    const messageId = safeText(data.messageId || data.id, 100);
    const newText = safeText(data.text, 4000);
    if (roomId !== member.roomId) return sendError(socket, 'Bạn không có quyền sửa tin nhắn trong phòng này.');
    if (!newText) return;
    const history = getHistory(roomId);
    const message = history.find((item) => item.id === messageId);
    if (!message || message.username !== member.user.username || message.recalled) return;
    message.text = newText;
    message.edited = true;
    message.editedAt = new Date().toISOString();
    saveStore();
    io.to(roomId).emit('message:updated', {
      roomId,
      id: message.id,
      messageId: message.id,
      text: message.text,
      edited: true,
      editedAt: message.editedAt,
    });
  });

  socket.on('message:pin', (data = {}) => {
    const member = socket.data.member;
    if (!member) return sendError(socket, 'Tham gia một phòng trước khi ghim tin nhắn.');
    const roomId = safeText(data.roomId || member.roomId, 100);
    if (roomId !== member.roomId) return sendError(socket, 'Bạn không có quyền ghim tin nhắn trong phòng này.');
    const room = roomById(roomId);
    if (!room) return;
    const pinned = Boolean(data.pinned);
    const messageId = pinned ? safeText(data.messageId || data.id, 100) : null;
    if (pinned && !getHistory(roomId).some((item) => item.id === messageId)) return;
    room.pinnedMessageId = messageId;
    const history = getHistory(roomId);
    for (const item of history) {
      item.pinned = Boolean(messageId && item.id === messageId);
    }
    saveStore();
    io.to(roomId).emit('room:pinned', { roomId, messageId });
    emitRoomLists();
  });

  socket.on('poll:create', (data = {}) => {
    const member = socket.data.member;
    if (!member) return sendError(socket, 'Tham gia một phòng trước khi tạo bình chọn.');
    const roomId = safeText(data.roomId || member.roomId, 100);
    if (roomId !== member.roomId) return sendError(socket, 'Bạn không có quyền tạo bình chọn trong phòng này.');
    const room = roomById(roomId);
    if (!room) return;
    const question = safeText(data.question, 200);
    const rawOptions = Array.isArray(data.options) ? data.options : [];
    const options = rawOptions
      .map((opt) => safeText(typeof opt === 'string' ? opt : opt?.text, 120))
      .filter(Boolean)
      .slice(0, 10)
      .map((text) => ({ text, voters: [] }));
    if (!question || options.length < 2) return sendError(socket, 'Bình chọn cần câu hỏi và ít nhất 2 lựa chọn.');
    const message = {
      id: `m-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`,
      roomId,
      username: member.user.username,
      displayName: member.user.displayName,
      avatar: member.user.avatar,
      text: `📊 Bình chọn: ${question}`,
      poll: { question, options },
      timestamp: new Date().toISOString(),
      reactions: {},
    };
    const history = getHistory(roomId);
    history.push(message);
    if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
    saveStore();
    emitToRoomEligible(room, 'message:new', message);
  });

  socket.on('poll:vote', (data = {}) => {
    const member = socket.data.member;
    if (!member) return sendError(socket, 'Tham gia một phòng trước khi bình chọn.');
    const roomId = safeText(data.roomId || member.roomId, 100);
    if (roomId !== member.roomId) return sendError(socket, 'Bạn không có quyền bỏ phiếu trong phòng này.');
    const messageId = safeText(data.messageId || data.id, 100);
    const optionIndex = Number(data.optionIndex);
    const history = getHistory(roomId);
    const message = history.find((item) => item.id === messageId);
    if (!message || !message.poll || !Array.isArray(message.poll.options)) return;
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= message.poll.options.length) return;
    const opt = message.poll.options[optionIndex];
    if (!Array.isArray(opt.voters)) opt.voters = [];
    const uname = member.user.username;
    const idx = opt.voters.indexOf(uname);
    if (idx >= 0) {
      opt.voters.splice(idx, 1);
    } else {
      opt.voters.push(uname);
    }
    saveStore();
    io.to(roomId).emit('poll:updated', {
      roomId,
      id: message.id,
      messageId: message.id,
      poll: message.poll,
    });
  });

  socket.on('message:delete', (data = {}) => {
    const member = socket.data.member;
    if (!member) return sendError(socket, 'Tham gia một phòng trước khi thu hồi tin nhắn.');
    const history = getHistory(member.roomId);
    const message = history.find((item) => item.id === safeText(data.messageId || data.id, 100));
    if (!message || message.username !== member.user.username) return;
    message.recalled = true;
    message.text = '';
    message.pinned = false;
    const room = roomById(member.roomId);
    if (room && room.pinnedMessageId === message.id) {
      room.pinnedMessageId = null;
      io.to(member.roomId).emit('room:pinned', { roomId: member.roomId, messageId: null });
      emitRoomLists();
    }
    saveStore();
    io.to(member.roomId).emit('message:updated', { roomId: member.roomId, id: message.id, recalled: true, pinned: false });
  });

  socket.on('reaction:add', (data = {}) => {
    const member = socket.data.member;
    if (!member) return sendError(socket, 'Tham gia một phòng trước khi thả cảm xúc.');
    const messageId = safeText(data.messageId || data.id, 100);
    const emoji = safeText(data.emoji, 16);
    const message = getHistory(member.roomId).find((item) => item.id === messageId);
    if (!message || !emoji) return;
    message.reactions[emoji] = (Number(message.reactions[emoji]) || 0) + 1;
    saveStore();
    io.to(member.roomId).emit('reaction:updated', { roomId: member.roomId, messageId, reactions: message.reactions });
  });

  for (const event of ['typing:start', 'typing:stop']) {
    socket.on(event, () => {
      const member = socket.data.member;
      if (member) socket.to(member.roomId).emit(event, {
        username: member.user.username,
        displayName: member.user.displayName,
        roomId: member.roomId,
      });
    });
  }

  socket.on('disconnect', () => {
    const member = socket.data.member;
    if (member) {
      emitPresence(member.roomId);
      socket.to(member.roomId).emit('typing:stop', { username: member.user.username, roomId: member.roomId });
    }
    broadcastUsers();
  });
});

server.listen(PORT, () => {
  console.log(`Mây Chat server running at http://localhost:${PORT}`);
});

