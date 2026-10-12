// Mây Chat — Nền tảng nhắn tin và trò chuyện nhóm trực tuyến

const $ = (id) => document.getElementById(id);

const DEFAULT_CHANNELS = [
  { id: 'general', name: 'sảnh-chung', description: 'Không gian trò chuyện chung của mọi thành viên', type: 'channel' },
  { id: 'cong-viec', name: 'công-việc', description: 'Trao đổi công việc, tài liệu & dự án nhóm', type: 'channel' },
  { id: 'random', name: 'tán-gẫu', description: 'Chia sẻ tự do & giải trí mỗi ngày', type: 'channel' },
];

const SETTINGS_KEY = 'maychat_settings_v1';
const DEFAULT_SETTINGS = {
  theme: 'dark',
  accent: '#0ea5e9',
  fontSize: 'normal',
  sound: true,
  sendTyping: true,
  enterToSend: true,
};

let userSettings = loadUserSettings();
let authMode = 'login';
let selectedAvatar = '😎';
let profileAvatar = '😎';
let authToken = sessionStorage.getItem('mc_token') || '';
let currentUser = loadSessionUser();

let currentRoomId = 'general';
let roomsList = [...DEFAULT_CHANNELS];
let usersDirectory = [];
let messagesByRoom = new Map();
let pinnedByRoom = new Map();
let unreadByRoom = new Map();
let typingUsers = new Set();
let typingTimeout = null;
let replyingToMessage = null;
let editingMessage = null;
let messageSearchQuery = '';
let socket = null;

function loadUserSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveUserSettings(nextSettings) {
  userSettings = { ...userSettings, ...nextSettings };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(userSettings));
  } catch {
    // ignore
  }
  applySettingsToDOM();
}

function applySettingsToDOM() {
  document.documentElement.setAttribute('data-theme', userSettings.theme || 'dark');
  document.documentElement.style.setProperty('--accent', userSettings.accent || '#0ea5e9');
  const fontMap = { small: '13px', normal: '14.5px', large: '16px' };
  document.documentElement.style.setProperty('--msg-font-size', fontMap[userSettings.fontSize] || '14.5px');
}

function playNotificationSound() {
  if (!userSettings.sound) return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.11);
    gain.gain.setValueAtTime(0.06, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.19);
  } catch {
    // ignore audio autoplay restriction
  }
}

function loadSessionUser() {
  try {
    const raw = sessionStorage.getItem('mc_user');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveSession(token, user) {
  authToken = token || '';
  currentUser = user || null;
  if (authToken && currentUser) {
    sessionStorage.setItem('mc_token', authToken);
    sessionStorage.setItem('mc_user', JSON.stringify(currentUser));
    if (currentUser.settings && typeof currentUser.settings === 'object') {
      saveUserSettings(currentUser.settings);
    }
  } else {
    sessionStorage.removeItem('mc_token');
    sessionStorage.removeItem('mc_user');
  }
}

function showError(msg) {
  const el = $('error-toast');
  el.textContent = `⚠️ ${msg}`;
  el.hidden = false;
  setTimeout(() => {
    el.hidden = true;
  }, 3600);
}

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

function findUserByUsername(username) {
  if (!username) return null;
  return usersDirectory.find((u) => u.username === username) || null;
}

function normalizeRoom(r) {
  if (typeof r === 'string') {
    return { id: r, name: r, description: `Kênh #${r}`, type: r.startsWith('dm:') ? 'dm' : 'channel', members: [] };
  }
  const id = r.id || r.roomId || r.name || 'general';
  const isDm = r.type === 'dm' || id.startsWith('dm:');
  let displayName = r.name || r.title || id;
  let description = r.description || r.topic || (isDm ? 'Trò chuyện riêng 1-1' : `Kênh #${displayName}`);

  if (isDm && currentUser && Array.isArray(r.members)) {
    const other = r.members.find((u) => {
      const uname = typeof u === 'string' ? u : u.username;
      return uname && uname !== currentUser.username;
    });
    if (other) {
      const otherUser = typeof other === 'string' ? findUserByUsername(other) : other;
      displayName = otherUser?.displayName || otherUser?.username || (typeof other === 'string' ? other : 'Người dùng');
    }
  }
  return {
    id,
    name: displayName,
    description,
    type: isDm ? 'dm' : 'channel',
    members: r.members || [],
    pinnedMessageId: r.pinnedMessageId || null,
  };
}

function normalizeMessage(m) {
  return {
    id: m.id || m.messageId || `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    roomId: m.roomId || m.room || currentRoomId,
    username: m.username || m.sender || m.user?.username || 'user',
    displayName: m.displayName || m.user?.displayName || m.senderName || m.username || m.sender || 'Thành viên',
    avatar: m.avatar || m.user?.avatar || '💬',
    text: m.text || m.content || m.message || '',
    replyTo: m.replyTo || null,
    poll: m.poll || null,
    edited: Boolean(m.edited || m.editedAt),
    pinned: Boolean(m.pinned),
    recalled: Boolean(m.recalled),
    timestamp: m.timestamp || m.createdAt || new Date().toISOString(),
    reactions: m.reactions || {},
  };
}

// ---------------------------------------------------------------------------
// UI Rendering
// ---------------------------------------------------------------------------

function updateProfileBar() {
  if (currentUser) {
    $('my-name').textContent = currentUser.displayName || currentUser.username;
    $('my-username').textContent = `@${currentUser.username}`;
    $('my-avatar').textContent = currentUser.avatar || '😎';
  } else {
    $('my-name').textContent = 'Chưa đăng nhập';
    $('my-username').textContent = '@guest';
    $('my-avatar').textContent = '👤';
  }
}

function renderSidebarLists(filterText = '') {
  const chNav = $('channel-list');
  const dmNav = $('dm-list');
  chNav.textContent = '';
  dmNav.textContent = '';

  const q = filterText.trim().toLowerCase();
  const normalized = roomsList.map(normalizeRoom);

  for (const r of normalized) {
    if (q && !r.name.toLowerCase().includes(q)) continue;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `room-item ${r.id === currentRoomId ? 'active' : ''}`;

    const label = document.createElement('span');
    label.textContent = r.type === 'dm' ? `💬 ${r.name}` : `# ${r.name}`;
    btn.appendChild(label);

    const unread = unreadByRoom.get(r.id) || 0;
    if (unread > 0 && r.id !== currentRoomId) {
      const badge = document.createElement('span');
      badge.className = 'unread-badge';
      badge.textContent = unread > 99 ? '99+' : String(unread);
      btn.appendChild(badge);
    }

    btn.addEventListener('click', () => switchRoom(r.id));
    if (r.type === 'dm') {
      dmNav.appendChild(btn);
    } else {
      chNav.appendChild(btn);
    }
  }

  const active = normalized.find((r) => r.id === currentRoomId) || normalized[0] || DEFAULT_CHANNELS[0];
  $('active-room-icon').textContent = active.type === 'dm' ? '💬' : '#';
  $('active-room-name').textContent = active.name;
  $('active-room-type').textContent = active.type === 'dm' ? 'Chat 1-1' : 'Nhóm chung';
  $('active-room-desc').textContent = active.description;
  $('message-input').placeholder = editingMessage
    ? 'Nhập nội dung mới để sửa tin nhắn... (Enter để lưu)'
    : `Nhập tin nhắn tới ${active.name}... (Enter để gửi)`;
}

function renderUsersDirectory() {
  const ul = $('users-directory-list');
  ul.textContent = '';
  $('total-users-count').textContent = String(usersDirectory.length);

  for (const u of usersDirectory) {
    const isMe = currentUser && u.username === currentUser.username;
    const li = document.createElement('li');
    li.className = 'user-dir-item';

    const left = document.createElement('div');
    left.className = 'user-dir-left';

    const dot = document.createElement('span');
    dot.className = `status-dot ${u.online ? 'online' : ''}`;

    const av = document.createElement('span');
    av.textContent = u.avatar || '🙂';

    const info = document.createElement('div');
    const title = document.createElement('div');
    title.style.fontWeight = '600';
    title.textContent = `${u.displayName || u.username}${isMe ? ' (Bạn)' : ''}`;
    const sub = document.createElement('div');
    sub.className = 'muted small';
    sub.textContent = `@${u.username} · ${u.online ? 'Đang online' : 'Offline'}${u.bio ? ` · ${u.bio}` : ''}`;
    info.appendChild(title);
    info.appendChild(sub);

    left.appendChild(dot);
    left.appendChild(av);
    left.appendChild(info);
    li.appendChild(left);

    if (!isMe) {
      const dmBtn = document.createElement('button');
      dmBtn.type = 'button';
      dmBtn.className = 'dm-badge-btn';
      dmBtn.textContent = 'Nhắn tin';
      dmBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openDirectMessageWith(u.username);
      });
      li.appendChild(dmBtn);
      li.addEventListener('click', () => openDirectMessageWith(u.username));
    }

    ul.appendChild(li);
  }
}

function renderRoomPresence(rawPresence) {
  let list = [];
  if (Array.isArray(rawPresence)) {
    list = rawPresence;
  } else if (rawPresence && Array.isArray(rawPresence.users)) {
    list = rawPresence.users;
  } else if (rawPresence && Array.isArray(rawPresence.members)) {
    list = rawPresence.members;
  }

  $('online-count-badge').textContent = `🟢 ${list.length} trong phòng`;
  const ul = $('room-presence-list');
  ul.textContent = '';

  for (const item of list) {
    const li = document.createElement('li');
    li.className = 'user-dir-left';
    const name = typeof item === 'string' ? item : item.displayName || item.username || item.name || 'Thành viên';
    const av = typeof item === 'object' && item.avatar ? item.avatar : '🟢';
    li.textContent = `${av} ${name}`;
    ul.appendChild(li);
  }
}

function renderPinnedBanner() {
  const banner = $('pinned-banner');
  const list = messagesByRoom.get(currentRoomId) || [];
  const pinnedId = pinnedByRoom.get(currentRoomId);
  const pinnedMsg = pinnedId ? list.find((m) => m.id === pinnedId) || null : null;

  if (!pinnedMsg || pinnedMsg.recalled) {
    banner.hidden = true;
    return;
  }

  banner.hidden = false;
  $('pinned-author').textContent = pinnedMsg.displayName || pinnedMsg.username;
  $('pinned-text').textContent = pinnedMsg.text.slice(0, 90);
  $('pinned-jump-btn').onclick = () => {
    const el = document.getElementById(`msg-dom-${pinnedMsg.id}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('search-match');
      setTimeout(() => el.classList.remove('search-match'), 1800);
    }
  };
}

function renderMessages() {
  const feed = $('message-feed');
  feed.textContent = '';
  const list = messagesByRoom.get(currentRoomId) || [];
  const q = messageSearchQuery.trim().toLowerCase();
  const currentPinnedId = pinnedByRoom.get(currentRoomId) || null;
  let firstMatchEl = null;

  for (const raw of list) {
    const m = normalizeMessage(raw);
    const isMine = currentUser && m.username === currentUser.username;
    const isMatch = Boolean(q && !m.recalled && m.text.toLowerCase().includes(q));
    const isPinned = Boolean(currentPinnedId && m.id === currentPinnedId);

    const row = document.createElement('article');
    row.id = `msg-dom-${m.id}`;
    row.className = `msg-row ${isMine ? 'mine' : ''} ${isMatch ? 'search-match' : ''}`;
    if (isMatch && !firstMatchEl) firstMatchEl = row;

    const av = document.createElement('div');
    av.className = 'msg-avatar';
    av.title = `Nhắn tin riêng với ${m.displayName}`;
    av.textContent = m.avatar || '💬';
    if (!isMine && m.username) {
      av.addEventListener('click', () => openDirectMessageWith(m.username));
    }

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';

    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    const author = document.createElement('span');
    author.className = 'msg-author';
    author.textContent = `${m.displayName} (@${m.username})`;
    const time = document.createElement('span');
    try {
      time.textContent = new Date(m.timestamp).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    } catch {
      time.textContent = '';
    }
    meta.appendChild(author);
    meta.appendChild(time);

    if (m.edited && !m.recalled) {
      const editedTag = document.createElement('span');
      editedTag.className = 'edited-tag';
      editedTag.textContent = '(đã chỉnh sửa)';
      meta.appendChild(editedTag);
    }
    bubble.appendChild(meta);

    if (m.replyTo && m.replyTo.text) {
      const quote = document.createElement('div');
      quote.className = 'msg-reply-quote';
      quote.title = 'Bấm để cuộn tới tin nhắn gốc';
      quote.textContent = `↩ ${m.replyTo.displayName || m.replyTo.username || 'Tin nhắn'}: ${m.replyTo.text}`;
      if (m.replyTo.id) {
        quote.addEventListener('click', () => {
          const targetEl = document.getElementById(`msg-dom-${m.replyTo.id}`);
          if (targetEl) {
            targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            targetEl.classList.add('search-match');
            setTimeout(() => targetEl.classList.remove('search-match'), 1800);
          }
        });
      }
      bubble.appendChild(quote);
    }

    const body = document.createElement('div');
    body.className = `msg-text ${m.recalled ? 'recalled' : ''}`;
    body.textContent = m.recalled ? '🚫 Tin nhắn đã được thu hồi' : m.text;
    bubble.appendChild(body);

    // Poll Rendering
    if (m.poll && !m.recalled && Array.isArray(m.poll.options)) {
      const pollBox = document.createElement('div');
      pollBox.className = 'poll-box';
      const pollTitle = document.createElement('div');
      pollTitle.className = 'poll-title';
      pollTitle.textContent = `📊 ${m.poll.question}`;
      pollBox.appendChild(pollTitle);

      m.poll.options.forEach((opt, idx) => {
        const voters = Array.isArray(opt.voters) ? opt.voters : [];
        const votedByMe = currentUser && voters.includes(currentUser.username);
        const optBtn = document.createElement('button');
        optBtn.type = 'button';
        optBtn.className = `poll-option-btn ${votedByMe ? 'voted' : ''}`;
        const txtSpan = document.createElement('span');
        txtSpan.textContent = opt.text || String(opt);
        const cntSpan = document.createElement('span');
        cntSpan.textContent = `${voters.length} phiếu`;
        optBtn.appendChild(txtSpan);
        optBtn.appendChild(cntSpan);
        optBtn.addEventListener('click', () => votePoll(m.id, idx));
        pollBox.appendChild(optBtn);
      });

      bubble.appendChild(pollBox);
    }

    if (!m.recalled) {
      const reactBar = document.createElement('div');
      reactBar.className = 'reaction-bar';

      const reactionsObj = m.reactions || {};
      for (const [emoji, countOrUsers] of Object.entries(reactionsObj)) {
        const count = Array.isArray(countOrUsers) ? countOrUsers.length : Number(countOrUsers) || 0;
        if (count <= 0) continue;
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'react-chip';
        chip.textContent = `${emoji} ${count}`;
        chip.addEventListener('click', () => sendReaction(m.id, emoji));
        reactBar.appendChild(chip);
      }

      for (const quickEmoji of ['❤️', '👍', '😂']) {
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'react-trigger';
        trigger.textContent = `+${quickEmoji}`;
        trigger.addEventListener('click', () => sendReaction(m.id, quickEmoji));
        reactBar.appendChild(trigger);
      }

      const replyBtn = document.createElement('button');
      replyBtn.type = 'button';
      replyBtn.className = 'msg-action-btn';
      replyBtn.textContent = '↩ Trả lời';
      replyBtn.addEventListener('click', () => setReplyTarget(m));
      reactBar.appendChild(replyBtn);

      const pinBtn = document.createElement('button');
      pinBtn.type = 'button';
      pinBtn.className = `msg-action-btn ${isPinned ? 'pinned-active' : ''}`;
      pinBtn.textContent = isPinned ? '📌 Bỏ ghim' : '📌 Ghim';
      pinBtn.addEventListener('click', () => pinMessage(m.id, !isPinned));
      reactBar.appendChild(pinBtn);

      if (isMine) {
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'msg-action-btn';
        editBtn.textContent = '✏️ Sửa';
        editBtn.addEventListener('click', () => startEditMessage(m));
        reactBar.appendChild(editBtn);

        const recallBtn = document.createElement('button');
        recallBtn.type = 'button';
        recallBtn.className = 'msg-action-btn';
        recallBtn.textContent = '🗑️ Thu hồi';
        recallBtn.addEventListener('click', () => recallMessage(m.id));
        reactBar.appendChild(recallBtn);
      }

      bubble.appendChild(reactBar);
    }

    row.appendChild(av);
    row.appendChild(bubble);
    feed.appendChild(row);
  }

  renderPinnedBanner();

  if (firstMatchEl) {
    firstMatchEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else {
    feed.scrollTop = feed.scrollHeight;
  }
}

function setReplyTarget(msg) {
  editingMessage = null;
  replyingToMessage = {
    id: msg.id,
    username: msg.username,
    displayName: msg.displayName,
    text: msg.text.slice(0, 80),
  };
  $('reply-mode-label').textContent = `↩ Đang trả lời ${msg.displayName}: `;
  $('reply-target-text').textContent = replyingToMessage.text;
  $('reply-bar').hidden = false;
  $('btn-submit-msg').textContent = 'Gửi ➤';
  $('message-input').focus();
}

function startEditMessage(msg) {
  replyingToMessage = null;
  editingMessage = msg;
  $('reply-mode-label').textContent = '✏️ Đang sửa tin nhắn: ';
  $('reply-target-text').textContent = msg.text.slice(0, 80);
  $('reply-bar').hidden = false;
  $('message-input').value = msg.text;
  $('btn-submit-msg').textContent = 'Lưu sửa ✓';
  $('message-input').focus();
}

function clearReplyOrEditTarget() {
  replyingToMessage = null;
  if (editingMessage) {
    editingMessage = null;
    $('message-input').value = '';
  }
  $('reply-mode-label').textContent = '↩ Đang trả lời:';
  $('reply-target-text').textContent = '';
  $('btn-submit-msg').textContent = 'Gửi ➤';
  $('reply-bar').hidden = true;
}

function renderTyping() {
  const bar = $('typing-indicator');
  const txt = $('typing-text');
  const others = [...typingUsers].filter((u) => u && (!currentUser || u !== currentUser.username));
  if (others.length === 0) {
    bar.hidden = true;
  } else {
    bar.hidden = false;
    txt.textContent = `${others.join(', ')} đang nhập tin nhắn…`;
  }
}

// ---------------------------------------------------------------------------
// Auth, Profile, Settings & Browser Realtime Engine
// ---------------------------------------------------------------------------

const STATIC_STORE_KEY = 'maychat_store_v1';
const staticBus = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('maychat_realtime_bus') : null;

function normalizeStaticUsername(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
}

function loadStaticStore() {
  try {
    const raw = localStorage.getItem(STATIC_STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.users) && Array.isArray(parsed.rooms)) {
        return parsed;
      }
    }
  } catch {
    // ignore
  }
  const initial = {
    users: [
      { username: 'minhtuan', password: '123456', displayName: 'Minh Tuấn', avatar: '😎', bio: 'Thiết kế sản phẩm · TP.HCM', online: true },
      { username: 'lananh', password: '123456', displayName: 'Lan Anh', avatar: '🌷', bio: 'Quản lý dự án · Hà Nội', online: true },
      { username: 'hoangnam', password: '123456', displayName: 'Hoàng Nam', avatar: '🚀', bio: 'Kỹ sư phần mềm · Đà Nẵng', online: true },
    ],
    rooms: [...DEFAULT_CHANNELS],
    messages: {
      general: [
        {
          id: 'm-welcome-mc',
          roomId: 'general',
          username: 'minhtuan',
          displayName: 'Minh Tuấn',
          avatar: '😎',
          text: 'Chào mừng mọi người đến với Mây Chat! Hãy chọn kênh bên trái hoặc nhắn tin riêng với các thành viên trong danh bạ.',
          timestamp: new Date().toISOString(),
          reactions: { '🎉': 1, '❤️': 1 },
        },
      ],
    },
    tokens: {},
  };
  saveStaticStore(initial);
  return initial;
}

function saveStaticStore(storeObj) {
  try {
    localStorage.setItem(STATIC_STORE_KEY, JSON.stringify(storeObj));
  } catch {
    // ignore
  }
}

function isStaticMode() {
  return typeof window.io !== 'function';
}

function staticApiCall(endpoint, body = {}, token = '') {
  const store = loadStaticStore();
  if (endpoint === '/api/auth/me') {
    const uname = store.tokens[token];
    const u = store.users.find((x) => x.username === uname);
    if (!u) return { ok: false, error: 'Phiên đăng nhập đã hết hạn.' };
    return { ok: true, user: u };
  }
  if (endpoint === '/api/auth/login') {
    const uname = normalizeStaticUsername(body.username);
    const u = store.users.find((x) => x.username === uname && x.password === String(body.password || ''));
    if (!u) return { ok: false, error: 'Tên tài khoản hoặc mật khẩu không đúng.' };
    const newToken = `tk_${uname}_${Date.now()}`;
    store.tokens[newToken] = uname;
    u.online = true;
    saveStaticStore(store);
    return { ok: true, token: newToken, user: u };
  }
  if (endpoint === '/api/auth/register') {
    const uname = normalizeStaticUsername(body.username);
    if (uname.length < 2) return { ok: false, error: 'Tên đăng nhập cần ít nhất 2 ký tự.' };
    if (store.users.some((x) => x.username === uname)) {
      return { ok: false, error: 'Tên tài khoản này đã tồn tại, hãy chuyển sang tab Đăng nhập.' };
    }
    const newUser = {
      username: uname,
      password: String(body.password || '123456'),
      displayName: body.displayName || body.username || uname,
      avatar: body.avatar || '😎',
      bio: body.bio || 'Thành viên Mây Chat',
      online: true,
    };
    store.users.push(newUser);
    const newToken = `tk_${uname}_${Date.now()}`;
    store.tokens[newToken] = uname;
    saveStaticStore(store);
    return { ok: true, token: newToken, user: newUser };
  }
  if (endpoint === '/api/profile') {
    const uname = store.tokens[token] || currentUser?.username;
    const u = store.users.find((x) => x.username === uname);
    if (!u) return { ok: false, error: 'Không tìm thấy tài khoản.' };
    if (body.displayName) u.displayName = body.displayName;
    if (body.bio !== undefined) u.bio = body.bio;
    if (body.avatar) u.avatar = body.avatar;
    saveStaticStore(store);
    return { ok: true, user: u };
  }
  if (endpoint === '/api/settings') {
    const uname = store.tokens[token] || currentUser?.username;
    const u = store.users.find((x) => x.username === uname);
    if (u) {
      u.settings = { ...(u.settings || {}), ...body };
      saveStaticStore(store);
      return { ok: true, settings: u.settings, user: u };
    }
    return { ok: true, settings: body };
  }
  return { ok: false, error: 'API không xác định' };
}

function createStaticSocket() {
  const handlers = new Map();
  const trigger = (event, payload) => {
    const list = handlers.get(event) || [];
    for (const fn of list) fn(payload);
  };

  const broadcast = (event, payload) => {
    trigger(event, payload);
    if (staticBus) {
      staticBus.postMessage({ event, payload });
    }
  };

  if (staticBus) {
    staticBus.onmessage = (ev) => {
      const { event, payload } = ev.data || {};
      if (event) trigger(event, payload);
    };
  }

  setTimeout(() => trigger('connect'), 10);

  return {
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    },
    disconnect() {
      handlers.clear();
    },
    emit(event, data = {}) {
      const store = loadStaticStore();
      const me = store.users.find((u) => u.username === currentUser?.username) || currentUser;

      if (event === 'join') {
        const rId = data.roomId || data.room || currentRoomId;
        const room = store.rooms.find((r) => r.id === rId);
        const myRooms = store.rooms.filter((r) => r.type !== 'dm' || (r.members && r.members.includes(me?.username)));
        trigger('users', store.users);
        trigger('rooms', myRooms);
        trigger('presence', store.users.filter((u) => u.online));
        trigger('history', {
          roomId: rId,
          pinnedMessageId: room?.pinnedMessageId || null,
          messages: store.messages[rId] || [],
        });
      } else if (event === 'profile:update') {
        if (me) {
          if (data.displayName) me.displayName = data.displayName;
          if (data.bio !== undefined) me.bio = data.bio;
          if (data.avatar) me.avatar = data.avatar;
          saveStaticStore(store);
          broadcast('users', store.users);
        }
      } else if (event === 'dm:open') {
        const target = data.targetUsername;
        if (!me || !target || target === me.username) return;
        const pair = [me.username, target].sort();
        const id = `dm:${pair[0]}:${pair[1]}`;
        let room = store.rooms.find((r) => r.id === id);
        if (!room) {
          room = { id, name: `${pair[0]} & ${pair[1]}`, description: 'Trò chuyện riêng 1-1', type: 'dm', members: pair };
          store.rooms.push(room);
          saveStaticStore(store);
        }
        broadcast('rooms', store.rooms);
        trigger('room:joined', { room });
      } else if (event === 'room:create') {
        const name = (data.name || '').trim();
        if (!name) return;
        const id = `room-${Date.now().toString(36)}`;
        const room = { id, name, description: data.description || '', type: 'channel', members: [] };
        store.rooms.push(room);
        saveStaticStore(store);
        broadcast('rooms', store.rooms);
        trigger('room:joined', { room });
      } else if (event === 'message:send') {
        const rId = data.roomId || currentRoomId;
        const msg = {
          id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          roomId: rId,
          username: me?.username || 'user',
          displayName: me?.displayName || 'Thành viên',
          avatar: me?.avatar || '😎',
          text: data.text || data.content || '',
          replyTo: data.replyTo || null,
          timestamp: new Date().toISOString(),
          reactions: {},
        };
        if (!store.messages[rId]) store.messages[rId] = [];
        store.messages[rId].push(msg);
        saveStaticStore(store);
        broadcast('message:new', msg);
      } else if (event === 'message:edit') {
        const rId = data.roomId || currentRoomId;
        const list = store.messages[rId] || [];
        const msg = list.find((x) => x.id === (data.messageId || data.id));
        if (msg && msg.username === me?.username) {
          msg.text = data.text;
          msg.edited = true;
          msg.editedAt = new Date().toISOString();
          saveStaticStore(store);
          broadcast('message:updated', { roomId: rId, id: msg.id, messageId: msg.id, text: msg.text, edited: true });
        }
      } else if (event === 'message:pin') {
        const rId = data.roomId || currentRoomId;
        const room = store.rooms.find((r) => r.id === rId);
        if (room) {
          room.pinnedMessageId = data.pinned ? data.messageId : null;
          const list = store.messages[rId] || [];
          for (const item of list) {
            item.pinned = Boolean(room.pinnedMessageId && item.id === room.pinnedMessageId);
          }
          saveStaticStore(store);
          broadcast('room:pinned', { roomId: rId, messageId: room.pinnedMessageId });
          broadcast('rooms', store.rooms);
        }
      } else if (event === 'poll:create') {
        const rId = data.roomId || currentRoomId;
        const msg = {
          id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          roomId: rId,
          username: me?.username || 'user',
          displayName: me?.displayName || 'Thành viên',
          avatar: me?.avatar || '😎',
          text: `📊 Bình chọn: ${data.question}`,
          poll: {
            question: data.question,
            options: (data.options || []).map((t) => ({ text: t, voters: [] })),
          },
          timestamp: new Date().toISOString(),
          reactions: {},
        };
        if (!store.messages[rId]) store.messages[rId] = [];
        store.messages[rId].push(msg);
        saveStaticStore(store);
        broadcast('message:new', msg);
      } else if (event === 'poll:vote') {
        const rId = data.roomId || currentRoomId;
        const list = store.messages[rId] || [];
        const msg = list.find((x) => x.id === data.messageId);
        const opt = msg?.poll?.options?.[data.optionIndex];
        if (opt && me) {
          const idx = opt.voters.indexOf(me.username);
          if (idx >= 0) opt.voters.splice(idx, 1);
          else opt.voters.push(me.username);
          saveStaticStore(store);
          broadcast('poll:updated', { roomId: rId, id: msg.id, messageId: msg.id, poll: msg.poll });
        }
      } else if (event === 'message:delete') {
        const rId = data.roomId || currentRoomId;
        const list = store.messages[rId] || [];
        const msg = list.find((x) => x.id === data.messageId);
        if (msg && msg.username === me?.username) {
          msg.recalled = true;
          msg.text = '';
          msg.pinned = false;
          const room = store.rooms.find((r) => r.id === rId);
          if (room && room.pinnedMessageId === msg.id) {
            room.pinnedMessageId = null;
            broadcast('room:pinned', { roomId: rId, messageId: null });
          }
          saveStaticStore(store);
          broadcast('message:updated', { roomId: rId, id: msg.id, recalled: true, pinned: false });
        }
      } else if (event === 'reaction:add') {
        const rId = data.roomId || currentRoomId;
        const list = store.messages[rId] || [];
        const msg = list.find((x) => x.id === (data.messageId || data.id));
        if (msg && data.emoji) {
          msg.reactions[data.emoji] = (Number(msg.reactions[data.emoji]) || 0) + 1;
          saveStaticStore(store);
          broadcast('reaction:updated', { roomId: rId, messageId: msg.id, reactions: msg.reactions });
        }
      } else if (event === 'typing:start' || event === 'typing:stop') {
        if (staticBus) {
          staticBus.postMessage({
            event,
            payload: { roomId: data.roomId || currentRoomId, username: me?.username, displayName: me?.displayName },
          });
        }
      }
    },
  };
}

async function submitAuth({ username, password, displayName, avatar, bio, isRegister }) {
  const endpoint = isRegister ? '/api/auth/register' : '/api/auth/login';
  try {
    let data = null;
    if (isStaticMode()) {
      data = staticApiCall(endpoint, { username, password, displayName, avatar, bio });
      if (!data.ok) throw new Error(data.error);
    } else {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, displayName, avatar, bio }),
      });
      data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || data.message || 'Đăng nhập/Đăng ký thất bại');
      }
    }
    saveSession(data.token, data.user);
    updateProfileBar();
    $('auth-dialog').close();
    connectSocket();
  } catch (err) {
    const errEl = $('auth-error');
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
}

async function saveProfileChanges({ displayName, bio, avatar }) {
  try {
    if (isStaticMode()) {
      const data = staticApiCall('/api/profile', { displayName, bio, avatar }, authToken);
      if (data.ok && data.user) {
        saveSession(authToken, data.user);
        updateProfileBar();
      }
      if (socket) socket.emit('profile:update', { displayName, bio, avatar });
      $('profile-dialog').close();
      return;
    }
    const res = await fetch('/api/profile', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ displayName, bio, avatar }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.user) {
      saveSession(authToken, data.user);
      updateProfileBar();
    } else if (socket) {
      socket.emit('profile:update', { displayName, bio, avatar });
      currentUser = { ...currentUser, displayName, bio, avatar };
      saveSession(authToken, currentUser);
      updateProfileBar();
    }
    $('profile-dialog').close();
  } catch (err) {
    showError(err.message);
  }
}

// ---------------------------------------------------------------------------
// Socket.IO Realtime Events
// ---------------------------------------------------------------------------

function joinCurrentRoom() {
  if (!socket || !currentUser) return;
  unreadByRoom.set(currentRoomId, 0);
  socket.emit('join', {
    token: authToken,
    username: currentUser.username,
    displayName: currentUser.displayName,
    avatar: currentUser.avatar,
    roomId: currentRoomId,
    room: currentRoomId,
  });
}

function switchRoom(newRoomId) {
  currentRoomId = newRoomId;
  unreadByRoom.set(currentRoomId, 0);
  typingUsers.clear();
  clearReplyOrEditTarget();
  renderTyping();
  renderSidebarLists($('sidebar-search').value);
  renderMessages();
  joinCurrentRoom();
}

function openDirectMessageWith(targetUsername) {
  if (!socket || !currentUser || targetUsername === currentUser.username) return;
  socket.emit('dm:open', {
    targetUsername,
    username: currentUser.username,
  });
}

function sendReaction(messageId, emoji) {
  if (!socket || !currentUser) return;
  socket.emit('reaction:add', {
    roomId: currentRoomId,
    room: currentRoomId,
    messageId,
    id: messageId,
    emoji,
    username: currentUser.username,
  });
}

function recallMessage(messageId) {
  if (!socket || !currentUser) return;
  if (replyingToMessage?.id === messageId || editingMessage?.id === messageId) {
    clearReplyOrEditTarget();
  }
  if (pinnedByRoom.get(currentRoomId) === messageId) {
    pinnedByRoom.set(currentRoomId, null);
    renderPinnedBanner();
  }
  socket.emit('message:delete', {
    roomId: currentRoomId,
    messageId,
  });
}

function pinMessage(messageId, pinned) {
  if (!socket || !currentUser) return;
  const nextPinnedId = pinned && messageId ? messageId : null;
  pinnedByRoom.set(currentRoomId, nextPinnedId);
  const roomObj = roomsList.find((r) => (r.id || r.roomId) === currentRoomId);
  if (roomObj && typeof roomObj === 'object') {
    roomObj.pinnedMessageId = nextPinnedId;
  }
  const list = messagesByRoom.get(currentRoomId) || [];
  for (const m of list) {
    m.pinned = Boolean(nextPinnedId && m.id === nextPinnedId);
  }
  renderPinnedBanner();
  renderMessages();
  socket.emit('message:pin', {
    roomId: currentRoomId,
    messageId: nextPinnedId,
    pinned: Boolean(nextPinnedId),
  });
}

function votePoll(messageId, optionIndex) {
  if (!socket || !currentUser) return;
  socket.emit('poll:vote', {
    roomId: currentRoomId,
    messageId,
    optionIndex,
  });
}

function connectSocket() {
  if (socket) {
    socket.disconnect();
  }

  if (isStaticMode()) {
    socket = createStaticSocket();
  } else {
    socket = window.io({
      auth: {
        token: authToken,
        username: currentUser?.username,
      },
    });
  }

  socket.on('connect', () => {
    $('conn-status').classList.add('online');
    $('conn-text').textContent = isStaticMode() ? 'Trực tuyến (GitHub Pages)' : 'Trực tuyến (Realtime)';
    if (currentUser) {
      joinCurrentRoom();
    }
  });

  socket.on('disconnect', () => {
    $('conn-status').classList.remove('online');
    $('conn-text').textContent = 'Mất kết nối…';
  });

  socket.on('rooms', (payload) => {
    const arr = Array.isArray(payload) ? payload : payload?.rooms;
    if (Array.isArray(arr) && arr.length > 0) {
      roomsList = arr;
      for (const r of arr) {
        if (r.pinnedMessageId !== undefined) {
          pinnedByRoom.set(r.id, r.pinnedMessageId);
        }
      }
      renderSidebarLists($('sidebar-search').value);
      renderPinnedBanner();
    }
  });

  socket.on('users', (payload) => {
    const arr = Array.isArray(payload) ? payload : payload?.users;
    if (Array.isArray(arr)) {
      usersDirectory = arr;
      if (currentUser) {
        const freshMe = arr.find((u) => u.username === currentUser.username);
        if (freshMe) {
          currentUser = { ...currentUser, ...freshMe };
          saveSession(authToken, currentUser);
          updateProfileBar();
        }
      }
      renderUsersDirectory();
      renderSidebarLists($('sidebar-search').value);
    }
  });

  socket.on('presence', (payload) => {
    renderRoomPresence(payload);
  });

  socket.on('room:joined', (payload) => {
    const roomObj = payload?.room || payload;
    if (roomObj && (roomObj.id || roomObj.roomId)) {
      const norm = normalizeRoom(roomObj);
      if (!roomsList.some((r) => (r.id || r) === norm.id)) {
        roomsList.push(roomObj);
      }
      switchRoom(norm.id);
    }
  });

  socket.on('history', (payload) => {
    const targetRoom = payload?.roomId || payload?.room || currentRoomId;
    const arr = Array.isArray(payload) ? payload : payload?.messages || [];
    if (payload?.pinnedMessageId !== undefined) {
      pinnedByRoom.set(targetRoom, payload.pinnedMessageId);
    }
    messagesByRoom.set(targetRoom, arr.map(normalizeMessage));
    if (targetRoom === currentRoomId) {
      renderMessages();
    }
  });

  socket.on('message:new', (msg) => {
    const normalized = normalizeMessage(msg);
    const rId = normalized.roomId || currentRoomId;
    const list = messagesByRoom.get(rId) || [];
    const existingIdx = list.findIndex((x) => x.id === normalized.id);
    const isNew = existingIdx < 0;
    if (existingIdx >= 0) {
      list[existingIdx] = normalized;
    } else {
      list.push(normalized);
    }
    messagesByRoom.set(rId, list);
    if (isNew && (!currentUser || normalized.username !== currentUser.username)) {
      playNotificationSound();
    }
    if (rId === currentRoomId) {
      renderMessages();
    } else {
      unreadByRoom.set(rId, (unreadByRoom.get(rId) || 0) + 1);
      renderSidebarLists($('sidebar-search').value);
    }
  });

  const applyMessageUpdate = (payload) => {
    if (!payload) return;
    const rId = payload.roomId || payload.room || currentRoomId;
    const msgId = payload.messageId || payload.id;
    const list = messagesByRoom.get(rId) || [];
    const target = list.find((x) => x.id === msgId);
    if (target) {
      if (payload.reactions) target.reactions = payload.reactions;
      if (payload.recalled !== undefined) target.recalled = Boolean(payload.recalled);
      if (payload.text !== undefined) target.text = payload.text;
      if (payload.edited !== undefined || payload.editedAt) target.edited = true;
      if (payload.poll) target.poll = payload.poll;
      if (payload.pinned !== undefined) target.pinned = Boolean(payload.pinned);
      renderMessages();
    }
  };

  socket.on('reaction:add', applyMessageUpdate);
  socket.on('reaction:updated', applyMessageUpdate);
  socket.on('message:updated', applyMessageUpdate);
  socket.on('message:edited', applyMessageUpdate);
  socket.on('poll:updated', applyMessageUpdate);

  socket.on('room:pinned', (payload) => {
    if (!payload) return;
    const rId = payload.roomId || currentRoomId;
    const nextPinnedId = payload.messageId || null;
    pinnedByRoom.set(rId, nextPinnedId);
    const roomObj = roomsList.find((r) => (r.id || r.roomId) === rId);
    if (roomObj && typeof roomObj === 'object') {
      roomObj.pinnedMessageId = nextPinnedId;
    }
    const list = messagesByRoom.get(rId) || [];
    for (const m of list) {
      m.pinned = Boolean(nextPinnedId && m.id === nextPinnedId);
    }
    if (rId === currentRoomId) {
      renderMessages();
    }
  });

  socket.on('typing:start', (data) => {
    const rId = data?.roomId || currentRoomId;
    if (rId !== currentRoomId) return;
    const u = typeof data === 'string' ? data : data?.displayName || data?.username;
    if (u) {
      typingUsers.add(u);
      renderTyping();
    }
  });

  socket.on('typing:stop', (data) => {
    const u = typeof data === 'string' ? data : data?.displayName || data?.username;
    if (u) {
      typingUsers.delete(u);
      renderTyping();
    }
  });

  socket.on('error', (err) => {
    const msg = typeof err === 'string' ? err : err?.message || 'Lỗi từ máy chủ';
    showError(msg);
    if (msg.includes('đăng nhập') || msg.includes('Phiên')) {
      saveSession('', null);
      updateProfileBar();
      openAuthModal();
    }
  });
}

// ---------------------------------------------------------------------------
// Init & Event Listeners
// ---------------------------------------------------------------------------

function setAuthTab(mode) {
  authMode = mode;
  $('auth-error').hidden = true;
  $('tab-login').classList.toggle('active', mode === 'login');
  $('tab-register').classList.toggle('active', mode === 'register');
  $('register-extra-fields').hidden = mode === 'login';
  $('auth-title').textContent = mode === 'login' ? 'Chào mừng trở lại' : 'Tạo Tài khoản Mới';
  $('auth-submit-btn').textContent = mode === 'login' ? 'Đăng nhập ngay ➤' : 'Tạo tài khoản & Vào trò chuyện ➤';
}

function openAuthModal() {
  const dlg = $('auth-dialog');
  $('auth-error').hidden = true;
  if (typeof dlg.showModal === 'function' && !dlg.open) {
    dlg.showModal();
  }
}

function openProfileModal() {
  if (!currentUser) {
    openAuthModal();
    return;
  }
  $('prof-displayname').value = currentUser.displayName || currentUser.username;
  $('prof-bio').value = currentUser.bio || '';
  profileAvatar = currentUser.avatar || '😎';
  document.querySelectorAll('.prof-avatar-opt').forEach((btn) => {
    btn.classList.toggle('selected', btn.dataset.avatar === profileAvatar);
  });
  $('profile-dialog').showModal();
}

function openSettingsModal() {
  document.querySelectorAll('.theme-chip').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.themeVal === (userSettings.theme || 'dark'));
  });
  document.querySelectorAll('.accent-dot').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.accent === (userSettings.accent || '#0ea5e9'));
  });
  $('setting-fontsize').value = userSettings.fontSize || 'normal';
  $('setting-sound').checked = userSettings.sound !== false;
  $('setting-typing').checked = userSettings.sendTyping !== false;
  $('setting-enter-send').checked = userSettings.enterToSend !== false;
  $('settings-dialog').showModal();
}

async function persistSettingsToServer(newSettings) {
  saveUserSettings(newSettings);
  if (!authToken) return;
  if (isStaticMode()) {
    staticApiCall('/api/settings', newSettings, authToken);
    return;
  }
  try {
    await fetch('/api/settings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(newSettings),
    });
  } catch {
    // ignore
  }
}

function init() {
  applySettingsToDOM();
  renderSidebarLists();
  renderUsersDirectory();
  updateProfileBar();

  $('tab-login').addEventListener('click', () => setAuthTab('login'));
  $('tab-register').addEventListener('click', () => setAuthTab('register'));

  document.querySelectorAll('.avatar-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.avatar-option').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedAvatar = btn.dataset.avatar;
    });
  });

  document.querySelectorAll('.prof-avatar-opt').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.prof-avatar-opt').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      profileAvatar = btn.dataset.avatar;
    });
  });

  $('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('auth-username').value.trim();
    const password = $('auth-password').value;
    const displayName = $('auth-displayname').value.trim() || username;
    const bio = $('auth-bio').value.trim();
    await submitAuth({
      username,
      password,
      displayName,
      avatar: selectedAvatar,
      bio,
      isRegister: authMode === 'register',
    });
  });

  document.querySelectorAll('.demo-acc-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const username = btn.dataset.user;
      const password = btn.dataset.pass;
      const displayName = btn.dataset.name;
      const avatar = btn.dataset.avatar;
      if (isStaticMode()) {
        const data = staticApiCall('/api/auth/login', { username, password });
        if (data.ok && data.user) {
          saveSession(data.token, data.user);
          updateProfileBar();
          $('auth-dialog').close();
          connectSocket();
          return;
        }
      } else {
        try {
          const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password }),
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok && data.ok !== false && data.user) {
            saveSession(data.token, data.user);
            updateProfileBar();
            $('auth-dialog').close();
            connectSocket();
            return;
          }
        } catch {
          // Fallback to register
        }
      }
      await submitAuth({
        username,
        password,
        displayName,
        avatar,
        bio: 'Thành viên Mây Chat',
        isRegister: true,
      });
    });
  });

  $('btn-edit-profile').addEventListener('click', openProfileModal);
  $('my-avatar').addEventListener('click', openProfileModal);
  $('btn-cancel-profile').addEventListener('click', () => $('profile-dialog').close());
  $('profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveProfileChanges({
      displayName: $('prof-displayname').value.trim(),
      bio: $('prof-bio').value.trim(),
      avatar: profileAvatar,
    });
  });

  // Settings modal handlers
  let draftTheme = userSettings.theme || 'dark';
  let draftAccent = userSettings.accent || '#0ea5e9';
  $('btn-open-settings').addEventListener('click', () => {
    draftTheme = userSettings.theme || 'dark';
    draftAccent = userSettings.accent || '#0ea5e9';
    openSettingsModal();
  });
  $('btn-cancel-settings').addEventListener('click', () => {
    applySettingsToDOM();
    $('settings-dialog').close();
  });
  document.querySelectorAll('.theme-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.theme-chip').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      draftTheme = btn.dataset.themeVal;
      document.documentElement.setAttribute('data-theme', draftTheme);
    });
  });
  document.querySelectorAll('.accent-dot').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.accent-dot').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      draftAccent = btn.dataset.accent;
      document.documentElement.style.setProperty('--accent', draftAccent);
    });
  });
  $('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const next = {
      theme: draftTheme,
      accent: draftAccent,
      fontSize: $('setting-fontsize').value,
      sound: $('setting-sound').checked,
      sendTyping: $('setting-typing').checked,
      enterToSend: $('setting-enter-send').checked,
    };
    await persistSettingsToServer(next);
    $('settings-dialog').close();
  });

  $('btn-switch-account').addEventListener('click', () => {
    saveSession('', null);
    updateProfileBar();
    openAuthModal();
  });

  $('btn-new-room').addEventListener('click', () => {
    $('new-room-name').value = '';
    $('new-room-desc').value = '';
    $('create-room-dialog').showModal();
  });
  $('btn-cancel-room').addEventListener('click', () => $('create-room-dialog').close());
  $('create-room-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('new-room-name').value.trim();
    const description = $('new-room-desc').value.trim();
    if (!name || !socket) return;
    socket.emit('room:create', { name, description });
    $('create-room-dialog').close();
  });

  // Poll dialog
  $('btn-open-poll').addEventListener('click', () => {
    $('poll-question').value = '';
    $('poll-options').value = '';
    $('create-poll-dialog').showModal();
  });
  $('btn-cancel-poll').addEventListener('click', () => $('create-poll-dialog').close());
  $('create-poll-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const question = $('poll-question').value.trim();
    const options = $('poll-options')
      .value.split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!question || options.length < 2 || !socket) return;
    socket.emit('poll:create', {
      roomId: currentRoomId,
      question,
      options,
    });
    $('create-poll-dialog').close();
  });

  $('btn-unpin').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    pinMessage(null, false);
  });
  $('btn-cancel-reply').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    clearReplyOrEditTarget();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (replyingToMessage || editingMessage)) {
      clearReplyOrEditTarget();
    }
  });

  $('sidebar-search').addEventListener('input', (e) => {
    renderSidebarLists(e.target.value);
  });

  $('msg-search-input').addEventListener('input', (e) => {
    messageSearchQuery = e.target.value;
    renderMessages();
  });

  document.querySelectorAll('.emoji-insert-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = $('message-input');
      input.value += btn.dataset.emoji;
      input.focus();
    });
  });

  $('message-input').addEventListener('input', () => {
    if (!socket || !currentUser || userSettings.sendTyping === false) return;
    socket.emit('typing:start', {
      roomId: currentRoomId,
      room: currentRoomId,
      username: currentUser.username,
      displayName: currentUser.displayName,
    });
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      socket.emit('typing:stop', {
        roomId: currentRoomId,
        room: currentRoomId,
        username: currentUser.username,
        displayName: currentUser.displayName,
      });
    }, 1200);
  });

  $('composer-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('message-input');
    const text = input.value.trim();
    if (!text) return;
    if (!currentUser) {
      openAuthModal();
      return;
    }
    input.value = '';
    if (socket) {
      if (editingMessage) {
        socket.emit('message:edit', {
          roomId: currentRoomId,
          messageId: editingMessage.id,
          id: editingMessage.id,
          text,
        });
      } else {
        socket.emit('message:send', {
          roomId: currentRoomId,
          room: currentRoomId,
          text,
          content: text,
          replyTo: replyingToMessage,
        });
      }
      socket.emit('typing:stop', {
        roomId: currentRoomId,
        room: currentRoomId,
        username: currentUser.username,
        displayName: currentUser.displayName,
      });
    }
    clearReplyOrEditTarget();
  });

  if (currentUser && authToken) {
    if (isStaticMode()) {
      const data = staticApiCall('/api/auth/me', {}, authToken);
      if (data && data.ok && data.user) {
        saveSession(authToken, data.user);
        updateProfileBar();
        connectSocket();
      } else {
        saveSession('', null);
        updateProfileBar();
        openAuthModal();
      }
    } else {
      fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${authToken}` },
      })
        .then((r) => r.json())
        .then((data) => {
          if (data && data.ok && data.user) {
            saveSession(authToken, data.user);
            updateProfileBar();
            connectSocket();
          } else {
            saveSession('', null);
            updateProfileBar();
            openAuthModal();
          }
        })
        .catch(() => {
          connectSocket();
        });
    }
  } else {
    openAuthModal();
  }
}

init();
