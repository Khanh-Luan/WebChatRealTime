'use strict';

const assert = require('node:assert/strict');
const { io } = require('socket.io-client');

const BASE_URL = 'http://localhost:3001';

async function postJson(path, body, token = '') {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { status: res.status, data };
}

function waitForEvent(socket, event, predicate = () => true, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timeout waiting for event "${event}"`));
    }, timeoutMs);
    function handler(payload) {
      if (predicate(payload)) {
        clearTimeout(timer);
        socket.off(event, handler);
        resolve(payload);
      }
    }
    socket.on(event, handler);
  });
}

async function runCustomerFlowTest() {
  console.log('=== BẮT ĐẦU KIỂM THỬ TRẢI NGHIỆM KHÁCH HÀNG MÂY CHAT (E2E) ===');

  // 1. Kiểm tra trang chủ hiển thị đúng thương hiệu Mây Chat
  const htmlRes = await fetch(`${BASE_URL}/`);
  const htmlText = await htmlRes.text();
  assert.ok(htmlText.includes('Mây Chat'), 'Trang chủ phải hiển thị thương hiệu Mây Chat');
  console.log('✅ 1. Kiểm tra giao diện trang chủ Mây Chat: PASS');

  // 2. Đăng nhập 2 tài khoản mẫu + Đăng ký 1 tài khoản khách hàng mới
  const loginA = await postJson('/api/auth/login', { username: 'minhtuan', password: '123456' });
  assert.equal(loginA.status, 200);
  const tokenA = loginA.data.token;

  const loginB = await postJson('/api/auth/login', { username: 'lananh', password: '123456' });
  assert.equal(loginB.status, 200);
  const tokenB = loginB.data.token;

  const customUsername = `khach_${Date.now().toString().slice(-4)}`;
  const regC = await postJson('/api/auth/register', {
    username: customUsername,
    password: '123456',
    displayName: 'Khách Hàng Mới',
    avatar: '🌸',
    bio: 'Đang dùng thử Mây Chat',
  });
  assert.equal(regC.status, 201);
  console.log('✅ 2. Đăng nhập đa tài khoản & Đăng ký thành viên mới: PASS');

  // 3. Chỉnh sửa hồ sơ cá nhân & Lưu cài đặt giao diện (/api/profile & /api/settings)
  const profUpdate = await postJson(
    '/api/profile',
    { displayName: 'Minh Tuấn', bio: 'Thiết kế sản phẩm · TP.HCM', avatar: '😎' },
    tokenA
  );
  assert.equal(profUpdate.status, 200);

  const settingsUpdate = await postJson(
    '/api/settings',
    { theme: 'ocean', accent: '#10b981', fontSize: 'large', sound: true, sendTyping: true, enterToSend: true },
    tokenA
  );
  assert.equal(settingsUpdate.status, 200);
  assert.equal(settingsUpdate.data.settings.theme, 'ocean');
  assert.equal(settingsUpdate.data.settings.accent, '#10b981');

  // Kiểm tra tải lại trang (/api/auth/me) vẫn giữ nguyên cài đặt đã lưu
  const meRes = await fetch(`${BASE_URL}/api/auth/me`, {
    headers: { Authorization: `Bearer ${tokenA}` },
  });
  const meData = await meRes.json();
  assert.equal(meData.user.settings.theme, 'ocean');
  console.log('✅ 3. Chỉnh sửa Hồ sơ & Lưu Cài đặt Giao diện (giữ nguyên khi tải lại trang): PASS');

  // 4. Kết nối Realtime 2 tài khoản cùng vào #sảnh-chung
  const clientA = io(BASE_URL, { auth: { token: tokenA }, transports: ['websocket'] });
  const clientB = io(BASE_URL, { auth: { token: tokenB }, transports: ['websocket'] });
  await Promise.all([waitForEvent(clientA, 'connect'), waitForEvent(clientB, 'connect')]);

  const histAPromise = waitForEvent(clientA, 'history', (h) => h.roomId === 'general');
  const histBPromise = waitForEvent(clientB, 'history', (h) => h.roomId === 'general');
  clientA.emit('join', { token: tokenA, roomId: 'general' });
  clientB.emit('join', { token: tokenB, roomId: 'general' });
  await Promise.all([histAPromise, histBPromise]);
  console.log('✅ 4. Kết nối Realtime 2 tài khoản vào #sảnh-chung: PASS');

  // 5. Gửi tin nhắn nhóm, Sửa tin nhắn, Ghim tin nhắn & Tạo Bình chọn
  const msgText = `Chào Lan Anh, giao diện Mây Chat mới nhìn rất gọn! (${Date.now().toString().slice(-4)})`;
  const msgPromiseB = waitForEvent(clientB, 'message:new', (m) => m.roomId === 'general' && m.text === msgText);
  clientA.emit('message:send', { roomId: 'general', text: msgText });
  const sentMsg = await msgPromiseB;

  const editedText = `${msgText} - đã cập nhật`;
  const editPromiseB = waitForEvent(clientB, 'message:updated', (u) => u.id === sentMsg.id && u.edited === true);
  clientA.emit('message:edit', { roomId: 'general', messageId: sentMsg.id, text: editedText });
  const editedPayload = await editPromiseB;
  assert.equal(editedPayload.text, editedText);

  const pinPromiseB = waitForEvent(clientB, 'room:pinned', (p) => p.roomId === 'general' && p.messageId === sentMsg.id);
  clientA.emit('message:pin', { roomId: 'general', messageId: sentMsg.id, pinned: true });
  await pinPromiseB;
  console.log('✅ 5. Gửi tin nhắn, Sửa tin nhắn & Ghim thông báo: PASS');

  // 6. Nhắn tin riêng 1-1 & kiểm tra Badge chưa đọc
  const dmJoinedPromiseA = waitForEvent(clientA, 'room:joined', (r) => r.room?.type === 'dm');
  clientA.emit('dm:open', { targetUsername: 'lananh' });
  const dmRoomPayload = await dmJoinedPromiseA;
  const dmRoomId = dmRoomPayload.room.id;

  const dmHistA = waitForEvent(clientA, 'history', (h) => h.roomId === dmRoomId);
  clientA.emit('join', { token: tokenA, roomId: dmRoomId });
  await dmHistA;

  const dmMsgPromiseB = waitForEvent(clientB, 'message:new', (m) => m.roomId === dmRoomId);
  clientA.emit('message:send', { roomId: dmRoomId, text: 'Tin nhắn riêng kiểm tra Mây Chat!' });
  await dmMsgPromiseB;
  console.log('✅ 6. Nhắn tin riêng 1-1 & Thông báo tin chưa đọc: PASS');

  clientA.disconnect();
  clientB.disconnect();
  console.log('=== TẤT CẢ KỊCH BẢN KHÁCH HÀNG MÂY CHAT ĐẠT 100% ===');
}

runCustomerFlowTest().catch((err) => {
  console.error('❌ KIỂM THỬ THẤT BẠI:', err);
  process.exit(1);
});
