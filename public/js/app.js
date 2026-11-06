/**
 * FLYchat — Frontend App (Neon Postgres + Socket.io)
 * Tidak menggunakan Firebase sama sekali.
 */
'use strict';

/* ════════════════════════════════════════
   CONFIG
   API_BASE diset ke Railway URL saat deploy ke Vercel.
   Saat development lokal, kosong = same-origin.
════════════════════════════════════════ */
const API = window.__FLYCHAT_API__ || '';

/* ════════════════════════════════════════
   STATE
════════════════════════════════════════ */
let currentUser    = null;
let currentChatId  = null;
let currentPartner = null;
let replyingTo     = null;
let contextMsgId   = null;
let contextMsgData = null;
let socket         = null;
let typingTimer    = null;
let notifEnabled   = false;
let allChats       = [];      // cached chat list

/* ════════════════════════════════════════
   BOOT
════════════════════════════════════════ */
window.addEventListener('DOMContentLoaded', () => {
  buildEmojiPicker();
  loadTheme();
  setupFormListeners();   // ← pasang form listeners setelah DOM siap

  const token = localStorage.getItem('fc_token');
  if (token) {
    apiGet('/api/auth/me')
      .then(data => {
        currentUser = normalizeUser(data.user);
        bootApp();
      })
      .catch(() => {
        localStorage.removeItem('fc_token');
        setTimeout(() => showScreen('login-screen'), 2000);
      });
  } else {
    setTimeout(() => showScreen('login-screen'), 2000);
  }
});

function setupFormListeners() {
  /* ── Register ── */
  el('register-form').addEventListener('submit', async e => {
    e.preventDefault();
    clearErr('register-error');
    const name = v('reg-name'), email = v('reg-email'),
          pw   = v('reg-password'), confirm = v('reg-confirm');

    if (name.length < 2)  return showErr('register-error', 'Nama minimal 2 karakter.');
    if (pw !== confirm)   return showErr('register-error', 'Password tidak cocok.');
    if (pw.length < 6)    return showErr('register-error', 'Password minimal 6 karakter.');

    setLoad('register-btn', true);
    try {
      const data = await apiPost('/api/auth/register', { name, email, password: pw });
      localStorage.setItem('fc_token', data.token);
      currentUser = normalizeUser(data.user);
      showToast('Akun berhasil dibuat! 🎉', 'success');
      bootApp();
    } catch (err) {
      showErr('register-error', err.message);
    } finally { setLoad('register-btn', false); }
  });

  /* ── Login ── */
  el('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    clearErr('login-error');
    setLoad('login-btn', true);
    try {
      const data = await apiPost('/api/auth/login', { email: v('login-email'), password: v('login-password') });
      localStorage.setItem('fc_token', data.token);
      currentUser = normalizeUser(data.user);
      bootApp();
    } catch (err) {
      showErr('login-error', err.message);
      setLoad('login-btn', false);
    }
  });
}

function bootApp() {
  connectSocket();
  loadSidebarProfile();
  loadChats();
  registerServiceWorker();
  showScreen('home-screen');
}

/* ════════════════════════════════════════
   SCREENS
════════════════════════════════════════ */
window.showScreen = function(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  el(id).classList.add('active');
  if (id === 'profile-screen') populateProfileForm();
};

/* ════════════════════════════════════════
   AUTH — GOOGLE (via Google Identity Services)
════════════════════════════════════════ */
window.signInWithGoogle = function() {
  // Load Google Identity script once
  if (!window.google) {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = initGoogleAuth;
    document.head.appendChild(s);
  } else {
    initGoogleAuth();
  }
};

function initGoogleAuth() {
  if (!window.google?.accounts) { showToast('Google SDK gagal dimuat', 'error'); return; }
  google.accounts.id.initialize({
    // Isi dengan Google Client ID kamu dari Google Cloud Console
    client_id: 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com',
    callback: handleGoogleCredential,
    auto_select: false
  });
  google.accounts.id.prompt();
}

async function handleGoogleCredential(response) {
  // Decode JWT payload dari Google
  const parts   = response.credential.split('.');
  const payload = JSON.parse(atob(parts[1].replace(/-/g,'+').replace(/_/g,'/')));
  try {
    const data = await apiPost('/api/auth/google', {
      email:      payload.email,
      name:       payload.name,
      photo_url:  payload.picture,
      google_id:  payload.sub
    });
    localStorage.setItem('fc_token', data.token);
    currentUser = normalizeUser(data.user);
    showToast('Login Google berhasil! 🎉', 'success');
    bootApp();
  } catch (err) {
    showToast('Login Google gagal: ' + err.message, 'error');
  }
}

/* ════════════════════════════════════════
   AUTH — LOGOUT
════════════════════════════════════════ */
window.confirmLogout = function() {
  if (!confirm('Yakin ingin keluar dari FLYchat?')) return;
  apiPost('/api/auth/logout').catch(() => {});
  socket?.disconnect();
  localStorage.removeItem('fc_token');
  currentUser = currentChatId = currentPartner = null;
  showScreen('login-screen');
};

/* ════════════════════════════════════════
   AUTH — FORGOT PASSWORD
════════════════════════════════════════ */
window.forgotPassword = async function() {
  const email = prompt('Masukkan email akun kamu:');
  if (!email) return;
  try {
    await apiPost('/api/auth/forgot-password', { email: email.trim() });
    showToast('Jika email terdaftar, link reset akan dikirim.', 'success');
  } catch (err) {
    showToast('Gagal: ' + err.message, 'error');
  }
};

/* ════════════════════════════════════════
   SOCKET.IO CONNECTION
════════════════════════════════════════ */
function connectSocket() {
  if (socket) socket.disconnect();
  const token   = localStorage.getItem('fc_token');
  const ioURL   = API || window.location.origin;   // Railway URL atau same-origin
  socket = io(ioURL, {
    auth:       { token },
    transports: ['websocket', 'polling']
  });

  socket.on('connect', () => console.log('🔌 Socket connected'));
  socket.on('connect_error', err => console.warn('Socket error:', err.message));

  /* New message arriving */
  socket.on('message:new', ({ chatId, message }) => {
    if (chatId === currentChatId) appendMessage(message);
    else incrementUnread(chatId);
    refreshChatPreview(chatId, message.content || `[${message.type}]`, message.created_at);
  });

  /* Message deleted */
  socket.on('message:deleted', ({ chatId, msgId }) => {
    if (chatId === currentChatId) {
      const el2 = document.querySelector(`[data-msg-id="${msgId}"]`);
      if (el2) el2.querySelector('.msg-bubble').innerHTML =
        '<em class="msg-deleted">Pesan telah dihapus</em>';
    }
  });

  /* Reactions */
  socket.on('message:reacted', ({ chatId, msgId, userId, emoji }) => {
    if (chatId === currentChatId) refreshMessageReaction(msgId, userId, emoji);
  });

  /* Typing */
  socket.on('typing:start', ({ chatId, userName }) => {
    if (chatId === currentChatId) {
      el('typing-area').innerHTML = `
        <div class="typing-indicator">
          <div class="t-dot"></div><div class="t-dot"></div><div class="t-dot"></div>
          <span style="margin-left:4px;font-size:0.78rem">${esc(userName)} sedang mengetik…</span>
        </div>`;
    }
  });
  socket.on('typing:stop', ({ chatId }) => {
    if (chatId === currentChatId) el('typing-area').innerHTML = '';
  });

  /* Presence */
  socket.on('user:online', ({ userId, online }) => {
    if (currentPartner?.id === userId) {
      updatePartnerStatus({ ...currentPartner, online });
    }
    // Update di chat list
    document.querySelectorAll(`.chat-item[data-partner-id="${userId}"] .online-dot`).forEach(dot => {
      dot.className = 'online-dot' + (online ? '' : ' offline');
    });
  });

  /* Chat updated (unread / last message) */
  socket.on('chat:updated', () => loadChats());
}

/* ════════════════════════════════════════
   SIDEBAR PROFILE
════════════════════════════════════════ */
function loadSidebarProfile() {
  if (!currentUser) return;
  el('sidebar-name').textContent   = currentUser.name || 'User';
  el('sidebar-status').textContent = currentUser.status || '';
  if (currentUser.photo_url) el('sidebar-avatar').src = currentUser.photo_url;
  el('my-online-dot').className = 'online-dot';
}

/* ════════════════════════════════════════
   CHAT LIST
════════════════════════════════════════ */
async function loadChats() {
  try {
    const data = await apiGet('/api/chats');
    allChats = data.chats || [];
    renderChatList(allChats);
  } catch (err) {
    console.error('loadChats error:', err);
  }
}

function renderChatList(chats) {
  const list = el('chat-list');
  list.innerHTML = '';
  if (!chats.length) {
    list.innerHTML = '<div class="empty-list-msg">Belum ada percakapan. Tambah kontak untuk memulai!</div>';
    return;
  }
  chats.forEach(chat => list.appendChild(buildChatItem(chat)));
}

function buildChatItem(chat) {
  const p = chat.partner;
  const isActive = chat.id === currentChatId;
  const online = p.online && p.show_online !== false;

  const div = document.createElement('div');
  div.className = 'chat-item' + (isActive ? ' active' : '');
  div.dataset.chatId    = chat.id;
  div.dataset.partnerId = p.id;
  div.role = 'listitem';
  div.innerHTML = `
    <div class="avatar-container">
      <img src="${esc(p.photo_url || 'assets/default-avatar.svg')}" alt="" class="avatar-sm"/>
      <span class="online-dot ${online ? '' : 'offline'}"></span>
    </div>
    <div class="chat-item-info">
      <div class="chat-item-name">${esc(p.name || 'User')}</div>
      <div class="chat-item-preview">${esc(chat.last_message || '')}</div>
    </div>
    <div class="chat-item-meta">
      <span class="chat-item-time">${chat.last_message_at ? fmtTime(new Date(chat.last_message_at)) : ''}</span>
      ${chat.unread > 0 ? `<span class="unread-badge">${chat.unread > 99 ? '99+' : chat.unread}</span>` : ''}
    </div>
  `;
  div.addEventListener('click', () => openChat(chat.id, p));
  return div;
}

function refreshChatPreview(chatId, text, time) {
  const item = document.querySelector(`.chat-item[data-chat-id="${chatId}"]`);
  if (item) {
    const prev = item.querySelector('.chat-item-preview');
    const tm   = item.querySelector('.chat-item-time');
    if (prev) prev.textContent = text;
    if (tm && time) tm.textContent = fmtTime(new Date(time));
  }
}

function incrementUnread(chatId) {
  const item = document.querySelector(`.chat-item[data-chat-id="${chatId}"]`);
  if (!item) return;
  let badge = item.querySelector('.unread-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'unread-badge';
    item.querySelector('.chat-item-meta').appendChild(badge);
  }
  badge.textContent = (parseInt(badge.textContent) || 0) + 1;
}

/* ════════════════════════════════════════
   CONTACTS TAB
════════════════════════════════════════ */
window.switchTab = function(tab, btn) {
  document.querySelectorAll('.tab-btn').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected','false'); });
  btn.classList.add('active'); btn.setAttribute('aria-selected','true');
  el('chat-list').classList.toggle('hidden', tab !== 'chats');
  el('contacts-list').classList.toggle('hidden', tab !== 'contacts');
  if (tab === 'contacts') loadContacts();
};

async function loadContacts() {
  const list = el('contacts-list');
  list.innerHTML = '<div class="empty-list-msg">Memuat kontak...</div>';
  try {
    const data = await apiGet('/api/users/me/contacts');
    const contacts = data.contacts || [];
    if (!contacts.length) { list.innerHTML = '<div class="empty-list-msg">Belum ada kontak. Tambah via 🔍</div>'; return; }
    list.innerHTML = '';
    contacts.forEach(u => {
      const online = u.online && u.show_online !== false;
      const div = document.createElement('div');
      div.className = 'chat-item';
      div.innerHTML = `
        <div class="avatar-container">
          <img src="${esc(u.photo_url || 'assets/default-avatar.svg')}" alt="" class="avatar-sm"/>
          <span class="online-dot ${online ? '' : 'offline'}"></span>
        </div>
        <div class="chat-item-info">
          <div class="chat-item-name">${esc(u.name)}</div>
          <div class="chat-item-preview">${esc(u.status || '')}</div>
        </div>
        <span class="contact-status ${online ? 'online' : 'offline'}">${online ? 'Online' : 'Offline'}</span>
      `;
      div.addEventListener('click', () => startChatWith(u));
      list.appendChild(div);
    });
  } catch (err) {
    list.innerHTML = '<div class="empty-list-msg">Gagal memuat kontak</div>';
  }
}

window.filterContacts = function(q) {
  document.querySelectorAll('.chat-item').forEach(item => {
    const name = item.querySelector('.chat-item-name')?.textContent?.toLowerCase() || '';
    item.style.display = name.includes(q.toLowerCase()) ? '' : 'none';
  });
};

/* ════════════════════════════════════════
   OPEN CHAT
════════════════════════════════════════ */
async function openChat(chatId, partner) {
  if (currentChatId) socket?.emit('chat:leave', currentChatId);

  currentChatId  = chatId;
  currentPartner = partner;
  replyingTo     = null;
  el('reply-preview').classList.add('hidden');
  el('typing-area').innerHTML = '';

  // Mark as read
  apiPatch(`/api/chats/${chatId}/read`).catch(() => {});
  // Remove unread badge
  const badge = document.querySelector(`.chat-item[data-chat-id="${chatId}"] .unread-badge`);
  if (badge) badge.remove();

  // Highlight sidebar
  document.querySelectorAll('.chat-item').forEach(i =>
    i.classList.toggle('active', i.dataset.chatId === chatId)
  );

  // Show UI
  el('empty-chat').classList.add('hidden');
  el('active-chat').classList.remove('hidden');
  el('chat-area').classList.add('active');

  // Update header
  el('chat-partner-name').textContent = partner.name || 'User';
  el('chat-partner-avatar').src = partner.photo_url || 'assets/default-avatar.svg';
  updatePartnerStatus(partner);

  // Join socket room
  socket?.emit('chat:join', chatId);

  // Load messages
  await loadMessages(chatId);
}

function updatePartnerStatus(p) {
  const online = p.online && p.show_online !== false;
  const statusEl = el('chat-partner-status');
  const dotEl    = el('partner-online-dot');
  if (online) {
    statusEl.textContent = 'Online';
    statusEl.className   = 'status-text online';
    dotEl.className      = 'online-dot';
  } else {
    const ls = p.last_seen ? fmtTimeRelative(new Date(p.last_seen)) : '';
    statusEl.textContent = ls ? `Terakhir ${ls}` : 'Offline';
    statusEl.className   = 'status-text';
    dotEl.className      = 'online-dot offline';
  }
}

async function startChatWith(partner) {
  try {
    const data = await apiPost('/api/chats', { partner_id: partner.id });
    await openChat(data.chat_id, partner);
    await loadChats(); // refresh list
  } catch (err) {
    showToast('Gagal membuka chat: ' + err.message, 'error');
  }
}

/* ════════════════════════════════════════
   MESSAGES
════════════════════════════════════════ */
async function loadMessages(chatId) {
  const list = el('messages-list');
  list.innerHTML = '';
  try {
    const data = await apiGet(`/api/chats/${chatId}/messages?limit=100`);
    const msgs = data.messages || [];
    let lastDate = null;
    msgs.forEach(msg => {
      const d = msg.created_at ? new Date(msg.created_at) : null;
      if (d) {
        const ds = fmtDate(d);
        if (ds !== lastDate) {
          const sep = document.createElement('div');
          sep.className = 'date-separator';
          sep.innerHTML = `<span>${ds}</span>`;
          list.appendChild(sep);
          lastDate = ds;
        }
      }
      list.appendChild(buildMsgBubble(msg));
    });
    scrollBottom();
  } catch (err) {
    list.innerHTML = '<div class="empty-list-msg">Gagal memuat pesan</div>';
  }
}

function appendMessage(msg) {
  const list = el('messages-list');
  list.appendChild(buildMsgBubble(msg));
  scrollBottom();
}

function buildMsgBubble(msg) {
  const isOut = msg.sender_id === currentUser.id;
  const wrapper = document.createElement('div');
  wrapper.className = `msg-wrapper ${isOut ? 'outgoing' : 'incoming'}`;
  wrapper.dataset.msgId = msg.id;

  if (!isOut) {
    const av = document.createElement('img');
    av.src = currentPartner?.photo_url || 'assets/default-avatar.svg';
    av.className = 'avatar-sm';
    wrapper.appendChild(av);
  }

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  // Reply quote
  if (msg.reply_to_id && msg.reply_to_text) {
    const rq = document.createElement('div');
    rq.className = 'reply-quote';
    rq.innerHTML = `<div class="reply-quote-name">${esc(msg.reply_to_sender)}</div>
                    <div>${esc(truncate(msg.reply_to_text, 80))}</div>`;
    bubble.appendChild(rq);
  }

  // Content
  const content = document.createElement('div');
  content.innerHTML = buildMsgContent(msg);
  bubble.appendChild(content);

  // Meta
  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  const time = msg.created_at ? fmtTimeFull(new Date(msg.created_at)) : '';
  meta.innerHTML = `<span class="msg-time">${time}</span>`;
  if (isOut) {
    const st = document.createElement('span');
    st.className = 'msg-status';
    st.textContent = '✓';
    meta.appendChild(st);
  }
  bubble.appendChild(meta);

  // Reactions
  if (msg.reactions && Object.keys(msg.reactions).length) {
    bubble.appendChild(buildReactionPills(msg.id, msg.reactions));
  }

  wrapper.appendChild(bubble);

  // Context menu
  bubble.addEventListener('contextmenu', e => { e.preventDefault(); showContextMenu(e, msg); });
  let pressTimer;
  bubble.addEventListener('touchstart', () => { pressTimer = setTimeout(() => showContextMenu(null, msg, bubble), 600); });
  bubble.addEventListener('touchend',   () => clearTimeout(pressTimer));

  return wrapper;
}

function buildReactionPills(msgId, reactions) {
  const rDiv = document.createElement('div');
  rDiv.className = 'msg-reactions';
  rDiv.id = `reactions-${msgId}`;
  const counts = {};
  Object.values(reactions).forEach(r => { counts[r] = (counts[r] || 0) + 1; });
  Object.entries(counts).forEach(([emoji, count]) => {
    const pill = document.createElement('button');
    pill.className   = 'reaction-pill';
    pill.textContent = `${emoji} ${count}`;
    pill.addEventListener('click', e => { e.stopPropagation(); addReaction(msgId, emoji); });
    rDiv.appendChild(pill);
  });
  return rDiv;
}

function refreshMessageReaction(msgId, userId, emoji) {
  const wrapper = document.querySelector(`[data-msg-id="${msgId}"]`);
  if (!wrapper) return;
  const bubble = wrapper.querySelector('.msg-bubble');
  let rDiv = document.getElementById(`reactions-${msgId}`);

  // Rebuild reactions from existing pills + new
  const counts = {};
  rDiv?.querySelectorAll('.reaction-pill').forEach(p => {
    const [e, c] = p.textContent.trim().split(' ');
    counts[e] = parseInt(c) || 1;
  });
  counts[emoji] = (counts[emoji] || 0) + 1;

  if (rDiv) rDiv.remove();
  const newReactions = {};
  Object.entries(counts).forEach(([e, c]) => { for (let i=0;i<c;i++) newReactions[`${userId}_${i}`] = e; });
  bubble.appendChild(buildReactionPills(msgId, newReactions));
}

function buildMsgContent(msg) {
  if (msg.is_deleted) return '<em class="msg-deleted">Pesan telah dihapus</em>';

  switch (msg.type) {
    case 'image':
      return `<img src="${esc(msg.file_url)}" alt="foto" class="msg-image" loading="lazy"
                   onclick="openLightbox('${esc(msg.file_url)}','${esc(msg.file_name||'')}')" />
              ${msg.caption ? `<div class="msg-caption">${esc(msg.caption)}</div>` : ''}`;

    case 'video':
      return `<video src="${esc(msg.file_url)}" class="msg-video" controls preload="metadata"></video>`;

    case 'document': {
      const icon = fileIcon(msg.file_name);
      return `<div class="msg-file">
        <span class="msg-file-icon">${icon}</span>
        <div class="msg-file-info">
          <div class="msg-file-name">${esc(msg.file_name || 'Dokumen')}</div>
          <div class="msg-file-size">${msg.file_size || ''}</div>
        </div>
        <a href="${esc(msg.file_url)}" target="_blank" rel="noopener" download="${esc(msg.file_name||'file')}"
           class="msg-file-dl">⬇</a>
      </div>`;
    }

    case 'location': {
      const lat = msg.lat, lng = msg.lng;
      return `<div class="msg-location">
        <div class="msg-location-name">📍 ${esc(msg.location_name || 'Lokasi')}</div>
        <div class="msg-location-map">
          <iframe src="https://www.openstreetmap.org/export/embed.html?bbox=${lng-.005}%2C${lat-.005}%2C${lng+.005}%2C${lat+.005}&layer=mapnik&marker=${lat}%2C${lng}"
            title="Peta" loading="lazy" sandbox="allow-scripts allow-same-origin"></iframe>
        </div>
        <a href="https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=15/${lat}/${lng}"
           target="_blank" rel="noopener" class="msg-location-link">🗺 Buka di OpenStreetMap →</a>
      </div>`;
    }

    default:
      return `<div>${esc(msg.content || '').replace(/\n/g, '<br>')}</div>`;
  }
}

/* ════════════════════════════════════════
   SEND MESSAGE
════════════════════════════════════════ */
window.sendMessage = async function() {
  const input = el('message-input');
  const text  = input.value.trim();
  if (!currentChatId || !text) return;

  input.value = '';
  const payload = { type: 'text', content: text };
  if (replyingTo) {
    payload.reply_to_id     = replyingTo.id;
    payload.reply_to_sender = replyingTo.senderName;
    payload.reply_to_text   = replyingTo.text;
  }
  cancelReply();

  try {
    const data = await apiPost(`/api/chats/${currentChatId}/messages`, payload);
    appendMessage(data.message);
    refreshChatPreview(currentChatId, text, data.message.created_at);
    // Broadcast via socket
    socket?.emit('message:new', { chatId: currentChatId, message: data.message });
    sendPushNotif(text);
  } catch (err) {
    showToast('Gagal kirim pesan: ' + err.message, 'error');
  }
};

/* ════════════════════════════════════════
   TYPING
════════════════════════════════════════ */
window.handleTyping = function() {
  if (!currentChatId) return;
  socket?.emit('typing:start', { chatId: currentChatId });
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    socket?.emit('typing:stop', { chatId: currentChatId });
  }, 2500);
};

/* ════════════════════════════════════════
   FILE UPLOAD & SEND
════════════════════════════════════════ */
window.toggleAttachMenu = function() {
  const menu = el('attach-menu');
  menu.classList.toggle('hidden');
  el('emoji-picker').classList.add('hidden');
};

window.triggerFileInput = function(type) {
  el('attach-menu').classList.add('hidden');
  el(`file-${type}`).click();
};

window.handleFileSelect = async function(input, type) {
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  if (!currentChatId) { showToast('Pilih percakapan dulu', 'error'); return; }
  if (type === 'image' || type === 'video') showMediaPreview(file, type);
  else await uploadAndSend(file, type);
};

async function uploadAndSend(file, type, caption = '') {
  const MAX = type === 'video' ? 100 : 50;
  if (file.size > MAX * 1024 * 1024) { showToast(`File terlalu besar (maks ${MAX}MB)`, 'error'); return; }

  const toastEl = showPersistentToast('Mengunggah 0%…');
  try {
    // Upload file
    const formData = new FormData();
    formData.append('file', file);
    const xhr = new XMLHttpRequest();
    const uploadResult = await new Promise((res, rej) => {
      xhr.upload.onprogress = e => {
        if (e.lengthComputable)
          toastEl.textContent = `Mengunggah ${Math.round(e.loaded/e.total*100)}%…`;
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) res(JSON.parse(xhr.responseText));
        else rej(new Error(JSON.parse(xhr.responseText).error || 'Upload gagal'));
      };
      xhr.onerror = () => rej(new Error('Network error'));
      xhr.open('POST', `${API}/api/upload/file`);
      xhr.setRequestHeader('Authorization', `Bearer ${localStorage.getItem('fc_token')}`);
      xhr.send(formData);
    });

    const msgPayload = {
      type,
      content:   caption || `[${type === 'image' ? '📷 Foto' : type === 'video' ? '🎥 Video' : '📄 ' + file.name}]`,
      file_url:  uploadResult.fileURL,
      file_name: uploadResult.fileName,
      file_size: uploadResult.fileSize,
      caption
    };
    if (replyingTo) {
      msgPayload.reply_to_id     = replyingTo.id;
      msgPayload.reply_to_sender = replyingTo.senderName;
      msgPayload.reply_to_text   = replyingTo.text;
    }
    cancelReply();

    const data = await apiPost(`/api/chats/${currentChatId}/messages`, msgPayload);
    appendMessage(data.message);
    refreshChatPreview(currentChatId, msgPayload.content, data.message.created_at);
    socket?.emit('message:new', { chatId: currentChatId, message: data.message });
    hideToast(toastEl);
    showToast('File terkirim! ✓', 'success');
  } catch (err) {
    hideToast(toastEl);
    showToast('Gagal: ' + err.message, 'error');
  }
}

function showMediaPreview(file, type) {
  document.getElementById('media-preview-modal')?.remove();
  const modal = document.createElement('div');
  modal.id    = 'media-preview-modal';
  modal.className = 'media-preview-modal';
  const url  = URL.createObjectURL(file);
  modal.innerHTML = `
    <div style="color:white;font-size:.9rem;opacity:.8;align-self:flex-start">
      ${type === 'image' ? '🖼️ Pratinjau Foto' : '🎥 Pratinjau Video'}
      <span style="margin-left:8px;opacity:.6">${fmtSize(file.size)}</span>
    </div>
    ${type === 'image' ? `<img src="${url}" alt="preview"/>` : `<video src="${url}" controls style="max-width:85vw;max-height:60vh;border-radius:12px"></video>`}
    <input type="text" id="media-caption" class="caption-input" placeholder="Tambahkan keterangan… (opsional)" maxlength="300" style="max-width:85vw"/>
    <div class="media-preview-actions">
      <button id="cancel-media-btn" class="btn-secondary" style="width:auto;padding:10px 22px;margin:0;border-color:rgba(255,255,255,.3);color:white">Batal</button>
      <button id="send-media-btn"   class="btn-primary"   style="width:auto;padding:10px 22px;margin:0">✈️ Kirim</button>
    </div>`;
  document.body.appendChild(modal);
  document.getElementById('cancel-media-btn').addEventListener('click', () => { URL.revokeObjectURL(url); modal.remove(); });
  document.getElementById('send-media-btn').addEventListener('click', async () => {
    const caption = document.getElementById('media-caption')?.value.trim() || '';
    URL.revokeObjectURL(url);
    modal.remove();
    await uploadAndSend(file, type, caption);
  });
}

/* ════════════════════════════════════════
   LOCATION
════════════════════════════════════════ */
window.shareLocation = function() {
  el('attach-menu').classList.add('hidden');
  if (!navigator.geolocation) { showToast('Geolokasi tidak didukung', 'error'); return; }
  const t = showPersistentToast('📍 Mendapatkan lokasi...');
  navigator.geolocation.getCurrentPosition(async pos => {
    const { latitude: lat, longitude: lng } = pos.coords;
    let locationName = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    try {
      const res  = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=id`);
      const data = await res.json();
      if (data.display_name) locationName = data.display_name.split(',').slice(0,3).join(', ');
    } catch {}

    const payload = { type: 'location', content: `📍 ${locationName}`, lat, lng, location_name: locationName };
    if (replyingTo) { payload.reply_to_id = replyingTo.id; payload.reply_to_sender = replyingTo.senderName; payload.reply_to_text = replyingTo.text; }
    cancelReply();

    try {
      const data = await apiPost(`/api/chats/${currentChatId}/messages`, payload);
      appendMessage(data.message);
      refreshChatPreview(currentChatId, `📍 ${locationName}`, data.message.created_at);
      socket?.emit('message:new', { chatId: currentChatId, message: data.message });
      hideToast(t);
      showToast('Lokasi dibagikan!', 'success');
    } catch (err) {
      hideToast(t);
      showToast('Gagal: ' + err.message, 'error');
    }
  }, err => { hideToast(t); showToast('Lokasi gagal: ' + err.message, 'error'); },
  { timeout: 10000, enableHighAccuracy: true });
};

/* ════════════════════════════════════════
   REPLY / COPY / DELETE
════════════════════════════════════════ */
window.replyToMsg = function() {
  closeContextMenu();
  if (!contextMsgData) return;
  const msg = contextMsgData;
  const senderName = msg.sender_id === currentUser.id
    ? (currentUser.name || 'Kamu')
    : (currentPartner?.name || 'Pengguna');
  const text = msg.content || (msg.type !== 'text' ? `[${msg.type}]` : '');
  replyingTo = { id: msg.id, senderName, text };
  el('reply-preview-name').textContent = senderName;
  el('reply-preview-text').textContent = truncate(text, 80);
  el('reply-preview').classList.remove('hidden');
  el('message-input').focus();
};
window.cancelReply = function() { replyingTo = null; el('reply-preview').classList.add('hidden'); };

window.copyMsg = function() {
  closeContextMenu();
  navigator.clipboard?.writeText(contextMsgData?.content || '').then(() => showToast('Pesan disalin!'));
};

window.deleteMsg = async function() {
  closeContextMenu();
  if (!contextMsgData || !currentChatId) return;
  if (contextMsgData.sender_id !== currentUser.id) { showToast('Hanya bisa hapus pesan sendiri', 'error'); return; }
  if (!confirm('Hapus pesan ini?')) return;
  try {
    await apiDelete(`/api/chats/${currentChatId}/messages/${contextMsgData.id}`);
    socket?.emit('message:deleted', { chatId: currentChatId, msgId: contextMsgData.id });
    const wrapper = document.querySelector(`[data-msg-id="${contextMsgData.id}"]`);
    if (wrapper) wrapper.querySelector('.msg-bubble').innerHTML = '<em class="msg-deleted">Pesan telah dihapus</em>';
    showToast('Pesan dihapus');
  } catch (err) {
    showToast('Gagal hapus: ' + err.message, 'error');
  }
};

async function addReaction(msgId, emoji) {
  if (!currentChatId) return;
  await apiPatch(`/api/chats/${currentChatId}/messages/${msgId}/reactions`, { emoji });
  socket?.emit('message:reacted', { chatId: currentChatId, msgId, userId: currentUser.id, emoji });
}

/* ════════════════════════════════════════
   CONTEXT MENU
════════════════════════════════════════ */
function showContextMenu(e, msg, refEl) {
  contextMsgId = msg.id; contextMsgData = msg;
  const menu = el('msg-context-menu');
  menu.classList.remove('hidden');
  el('ctx-delete').style.display = msg.sender_id === currentUser.id ? '' : 'none';
  let x, y;
  if (e)        { x = e.clientX; y = e.clientY; }
  else if (refEl){ const r = refEl.getBoundingClientRect(); x = r.left + r.width/2; y = r.top; }
  else           { x = 100; y = 200; }
  menu.style.left = Math.min(x, window.innerWidth  - 180) + 'px';
  menu.style.top  = Math.min(y, window.innerHeight - 120) + 'px';
}
function closeContextMenu() { el('msg-context-menu').classList.add('hidden'); }
window.closeAllMenus = function() { closeContextMenu(); el('attach-menu').classList.add('hidden'); el('emoji-picker').classList.add('hidden'); el('chat-dropdown').classList.add('hidden'); };

/* ════════════════════════════════════════
   CHAT HEADER MENU
════════════════════════════════════════ */
window.toggleChatMenu  = function() { el('chat-dropdown').classList.toggle('hidden'); };

window.clearChatHistory = async function() {
  el('chat-dropdown').classList.add('hidden');
  if (!currentChatId || !confirm('Hapus semua riwayat pesan?')) return;
  await apiDelete(`/api/chats/${currentChatId}/messages`);
  el('messages-list').innerHTML = '';
  showToast('Riwayat chat dihapus');
};

window.showPartnerProfile = async function() {
  el('chat-dropdown').classList.add('hidden');
  if (!currentPartner) return;
  try {
    const data = await apiGet(`/api/users/${currentPartner.id}`);
    const u = data.user;
    el('partner-profile-content').innerHTML = `
      <img src="${esc(u.photo_url || 'assets/default-avatar.svg')}" class="avatar-lg" style="margin:0 auto 12px" alt=""/>
      <div style="font-size:1.15rem;font-weight:700;color:var(--text-h)">${esc(u.name)}</div>
      <div style="font-size:.85rem;color:var(--primary);margin:4px 0 12px">${esc(u.email)}</div>
      ${u.status ? `<div style="font-size:.88rem;color:var(--text-m);padding:8px 16px;background:var(--bg-app);border-radius:10px">"${esc(u.status)}"</div>` : ''}
      ${u.about  ? `<div style="font-size:.85rem;color:var(--text-m);margin-top:8px">${esc(u.about)}</div>` : ''}
      <button class="btn-primary" style="width:auto;padding:10px 24px;margin-top:16px" onclick="closeModal('partner-profile-modal')">Tutup</button>
    `;
    el('partner-profile-modal').classList.remove('hidden');
  } catch {}
};

/* ════════════════════════════════════════
   ADD CONTACT / SEARCH
════════════════════════════════════════ */
window.showAddContact = function() {
  el('search-user-input').value = '';
  el('search-result').innerHTML = '';
  el('add-contact-modal').classList.remove('hidden');
  el('search-user-input').focus();
};
window.closeModal = function(id) { el(id).classList.add('hidden'); };

window.searchUser = async function() {
  const email = v('search-user-input');
  const res   = el('search-result');
  if (!email) { res.innerHTML = '<p style="color:var(--text-m);font-size:.88rem">Masukkan email.</p>'; return; }
  res.innerHTML = '<p style="color:var(--text-m);font-size:.88rem">Mencari...</p>';
  try {
    const data = await apiGet(`/api/users/search?email=${encodeURIComponent(email)}`);
    const u = data.user;
    res.innerHTML = `
      <div class="user-result-card">
        <img src="${esc(u.photo_url || 'assets/default-avatar.svg')}" class="avatar-sm" alt=""/>
        <div class="user-result-info" style="flex:1">
          <div class="name">${esc(u.name)}</div>
          <div class="email">${esc(u.email)}</div>
        </div>
        <button class="btn-primary small" onclick="addContactAndChat('${u.id}')">💬 Chat</button>
      </div>`;
  } catch (err) {
    res.innerHTML = `<p style="color:var(--text-m);font-size:.88rem">${err.message}</p>`;
  }
};

window.addContactAndChat = async function(uid) {
  await apiPost('/api/users/me/contacts', { contact_id: uid }).catch(() => {});
  closeModal('add-contact-modal');
  try {
    const data = await apiGet(`/api/users/${uid}`);
    await startChatWith(data.user);
  } catch (err) {
    showToast('Gagal: ' + err.message, 'error');
  }
};

/* ════════════════════════════════════════
   PROFILE
════════════════════════════════════════ */
async function populateProfileForm() {
  if (!currentUser) return;
  try {
    const data = await apiGet('/api/auth/me');
    const u = data.user;
    el('profile-name').value   = u.name || '';
    el('profile-status').value = u.status || '';
    el('profile-about').value  = u.about  || '';
    el('profile-phone').value  = u.phone  || '';
    el('profile-email').value  = u.email  || '';
    if (u.photo_url) el('profile-avatar-img').src = u.photo_url;
    el('status-count').textContent = `${(u.status||'').length}/100`;
    el('toggle-online-status').checked = u.show_online !== false;
  } catch {}
}

window.saveProfile = async function() {
  const name = el('profile-name').value.trim();
  if (!name) { showToast('Nama tidak boleh kosong', 'error'); return; }
  try {
    const data = await apiPatch('/api/users/me', {
      name,
      status: el('profile-status').value.trim(),
      about:  el('profile-about').value.trim(),
      phone:  el('profile-phone').value.trim()
    });
    currentUser = { ...currentUser, ...normalizeUser(data.user) };
    el('sidebar-name').textContent   = currentUser.name;
    el('sidebar-status').textContent = data.user.status || '';
    showToast('Profil disimpan! ✓', 'success');
  } catch (err) {
    showToast('Gagal: ' + err.message, 'error');
  }
};

window.saveOnlinePreference = async function(checked) {
  await apiPatch('/api/users/me', { show_online: checked }).catch(() => {});
};

window.triggerAvatarUpload = function() { el('avatar-upload').click(); };

window.uploadAvatar = async function(input) {
  const file = input.files[0];
  if (!file || !file.type.startsWith('image/')) { showToast('Pilih file gambar', 'error'); return; }
  if (file.size > 5 * 1024 * 1024) { showToast('Gambar terlalu besar (maks 5MB)', 'error'); return; }

  const progress = el('profile-upload-progress');
  const bar      = el('avatar-progress-bar');
  progress.classList.remove('hidden');

  const formData = new FormData();
  formData.append('avatar', file);
  const xhr = new XMLHttpRequest();
  xhr.upload.onprogress = e => { if (e.lengthComputable) bar.style.width = Math.round(e.loaded/e.total*100) + '%'; };

  try {
    const result = await new Promise((res, rej) => {
      xhr.onload = () => xhr.status < 300 ? res(JSON.parse(xhr.responseText)) : rej(new Error(JSON.parse(xhr.responseText).error));
      xhr.onerror = () => rej(new Error('Network error'));
      xhr.open('POST', `${API}/api/upload/avatar`);
      xhr.setRequestHeader('Authorization', `Bearer ${localStorage.getItem('fc_token')}`);
      xhr.send(formData);
    });
    await apiPatch('/api/users/me', { photo_url: result.photoURL });
    el('profile-avatar-img').src = result.photoURL;
    el('sidebar-avatar').src     = result.photoURL;
    currentUser.photo_url = result.photoURL;
    showToast('Foto profil diperbarui! ✓', 'success');
  } catch (err) {
    showToast('Gagal: ' + err.message, 'error');
  } finally {
    setTimeout(() => { progress.classList.add('hidden'); bar.style.width = '0%'; }, 1000);
  }
};

/* ════════════════════════════════════════
   EMOJI PICKER
════════════════════════════════════════ */
const EMOJI_CATEGORIES = {
  'Ekspresi': ['😀','😂','😍','🥰','😎','🤔','😢','😭','😡','🤩','😊','😇','🥳','😜','😴','🤗','😏','🙄','😬'],
  'Gestur':   ['👍','👎','👏','🙏','🤝','✌️','👋','🫶','💪','🤜','👌','🤌','✋'],
  'Simbol':   ['❤️','🔥','💯','✅','⭐','🎉','💡','💰','🏆','🎯','💎','🌟','✨','⚡','❄️'],
  'Alam':     ['🐶','🐱','🦋','🌸','🌈','☀️','🌙','🌍','🍕','🍔','🍦','🎂','☕','🥤'],
  'Objek':    ['📱','💻','📷','🎵','🎮','✈️','🚗','🏠','📚','🎁','🔒','🎬','🎤']
};

function buildEmojiPicker() {
  const picker = el('emoji-picker');
  picker.innerHTML = '';
  for (const [cat, emojis] of Object.entries(EMOJI_CATEGORIES)) {
    const title = document.createElement('div');
    title.className = 'emoji-cat-title';
    title.textContent = cat;
    picker.appendChild(title);
    const grid = document.createElement('div');
    grid.className = 'emoji-grid';
    emojis.forEach(emoji => {
      const btn = document.createElement('button');
      btn.className = 'emoji-btn-item';
      btn.textContent = emoji;
      btn.addEventListener('click', () => {
        const inp = el('message-input');
        const pos = inp.selectionStart;
        inp.value = inp.value.slice(0,pos) + emoji + inp.value.slice(pos);
        inp.focus();
        inp.setSelectionRange(pos + emoji.length, pos + emoji.length);
      });
      grid.appendChild(btn);
    });
    picker.appendChild(grid);
  }
}

window.toggleEmojiPicker = function() {
  el('emoji-picker').classList.toggle('hidden');
  el('attach-menu').classList.add('hidden');
};

/* ════════════════════════════════════════
   DARK MODE
════════════════════════════════════════ */
window.toggleTheme = function() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  document.documentElement.setAttribute('data-theme', isDark ? 'light' : 'dark');
  el('theme-btn').textContent = isDark ? '🌙' : '☀️';
  localStorage.setItem('fc-theme', isDark ? 'light' : 'dark');
};
function loadTheme() {
  const t = localStorage.getItem('fc-theme');
  if (t) { document.documentElement.setAttribute('data-theme', t); }
  const btn = el('theme-btn');
  if (btn) btn.textContent = (t === 'dark') ? '☀️' : '🌙';
}

/* ════════════════════════════════════════
   NOTIFICATIONS
════════════════════════════════════════ */
async function registerServiceWorker() {
  if ('serviceWorker' in navigator) await navigator.serviceWorker.register('sw.js').catch(() => {});
}

window.toggleNotifications = async function(checked) {
  if (!checked) { notifEnabled = false; return; }
  const perm = await Notification.requestPermission();
  notifEnabled = perm === 'granted';
  if (!notifEnabled) { showToast('Izin notifikasi ditolak', 'error'); el('toggle-notif').checked = false; }
  else showToast('Notifikasi diaktifkan!', 'success');
};

function sendPushNotif(text) {
  if (!notifEnabled || document.visibilityState === 'visible') return;
  new Notification(`FLYchat — ${currentPartner?.name || 'Pesan baru'}`, {
    body: text.substring(0,100), icon: 'assets/icon.svg'
  });
}

/* ════════════════════════════════════════
   MOBILE / MISC
════════════════════════════════════════ */
window.closeChatMobile = function() { el('chat-area').classList.remove('active'); };
window.startVideoCall  = function() { showToast('📹 Video call segera hadir!'); };
window.startVoiceCall  = function() { showToast('📞 Voice call segera hadir!'); };

window.openLightbox = function(src, name) {
  el('lightbox-img').src    = src;
  el('lightbox-download').href = src;
  if (name) el('lightbox-download').download = name;
  el('lightbox').classList.remove('hidden');
};
window.closeLightbox = function() { el('lightbox').classList.add('hidden'); };

/* Online/offline tracking */
document.addEventListener('visibilitychange', () => {
  if (!currentUser) return;
  apiPatch('/api/users/me/presence', { online: !document.hidden }).catch(() => {});
});
window.addEventListener('beforeunload', () => {
  if (currentUser) navigator.sendBeacon(`${API}/api/users/me/presence`,
    new Blob([JSON.stringify({ online: false })], { type: 'application/json' }));
});

/* Close menus on outside click */
document.addEventListener('click', e => {
  if (!e.target.closest('#attach-btn') && !e.target.closest('#attach-menu'))
    el('attach-menu')?.classList.add('hidden');
  if (!e.target.closest('.emoji-toggle-btn') && !e.target.closest('#emoji-picker'))
    el('emoji-picker')?.classList.add('hidden');
  if (!e.target.closest('#chat-menu-btn') && !e.target.closest('#chat-dropdown'))
    el('chat-dropdown')?.classList.add('hidden');
  if (!e.target.closest('#msg-context-menu') && !e.target.closest('.msg-bubble'))
    closeContextMenu();
});

/* Keyboard shortcuts */
document.addEventListener('keydown', e => {
  if ((e.ctrlKey||e.metaKey) && e.key === 'k') { e.preventDefault(); el('search-contacts')?.focus(); }
  if (e.key === 'Escape') {
    closeContextMenu();
    el('attach-menu')?.classList.add('hidden');
    el('emoji-picker')?.classList.add('hidden');
    el('chat-dropdown')?.classList.add('hidden');
    document.getElementById('media-preview-modal')?.remove();
    document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
    el('lightbox')?.classList.add('hidden');
  }
});

/* ════════════════════════════════════════
   API HELPERS
════════════════════════════════════════ */
function getToken() { return localStorage.getItem('fc_token') || ''; }

async function apiFetch(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` }
  };
  if (body) opts.body = JSON.stringify(body);
  const res  = await fetch(`${API}${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const apiGet    = (path)         => apiFetch('GET',    path);
const apiPost   = (path, body)   => apiFetch('POST',   path, body);
const apiPatch  = (path, body)   => apiFetch('PATCH',  path, body);
const apiDelete = (path)         => apiFetch('DELETE', path);

/* ════════════════════════════════════════
   UTILITIES
════════════════════════════════════════ */
function el(id)  { return document.getElementById(id); }
function v(id)   { return (el(id)?.value || '').trim(); }
function esc(s)  { return s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : ''; }
function truncate(s, n) { return s && s.length > n ? s.slice(0, n) + '…' : (s || ''); }
function scrollBottom() { const c = el('messages-container'); if (c) c.scrollTop = c.scrollHeight; }

window.togglePassword = function(id, btn) {
  const inp = el(id);
  inp.type = inp.type === 'password' ? 'text' : 'password';
  btn.textContent = inp.type === 'password' ? '👁' : '🙈';
};

function setLoad(btnId, loading) {
  const btn = el(btnId); if (!btn) return;
  btn.disabled = loading;
  btn.querySelector('.btn-text')?.style.setProperty('display', loading ? 'none' : '');
  btn.querySelector('.spinner')?.classList.toggle('hidden', !loading);
}

function showErr(id, msg) { const e = el(id); if (e) { e.textContent = msg; e.classList.remove('hidden'); } }
function clearErr(id) { el(id)?.classList.add('hidden'); }

let _toastTimer = null;
function showToast(msg, type = '', duration = 2800) {
  const t = el('toast');
  t.textContent = msg;
  t.className = `toast show ${type}`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), duration);
  return t;
}
function showPersistentToast(msg) { const t = el('toast'); t.textContent = msg; t.className = 'toast show'; clearTimeout(_toastTimer); return t; }
function hideToast(t) { if (t) t.classList.remove('show'); }

function fmtTime(date) {
  if (!date) return '';
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString('id-ID', { hour:'2-digit', minute:'2-digit' });
  const y = new Date(now); y.setDate(now.getDate()-1);
  if (date.toDateString() === y.toDateString()) return 'Kemarin';
  return date.toLocaleDateString('id-ID', { day:'2-digit', month:'2-digit', year:'2-digit' });
}
function fmtTimeFull(d)     { return d ? d.toLocaleTimeString('id-ID',{ hour:'2-digit', minute:'2-digit' }) : ''; }
function fmtTimeRelative(d) {
  if (!d) return '';
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 60)    return 'baru saja';
  if (diff < 3600)  return Math.floor(diff/60) + ' menit lalu';
  if (diff < 86400) return Math.floor(diff/3600) + ' jam lalu';
  return d.toLocaleDateString('id-ID', { day:'numeric', month:'short' });
}
function fmtDate(date) {
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return 'Hari Ini';
  const y = new Date(now); y.setDate(now.getDate()-1);
  if (date.toDateString() === y.toDateString()) return 'Kemarin';
  return date.toLocaleDateString('id-ID', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
}
function fmtSize(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b/1024).toFixed(1)} KB`;
  return `${(b/1048576).toFixed(1)} MB`;
}
function fileIcon(name) {
  if (!name) return '📎';
  const ext = name.split('.').pop().toLowerCase();
  return ({pdf:'📕',doc:'📘',docx:'📘',xls:'📗',xlsx:'📗',ppt:'📙',pptx:'📙',zip:'🗜️',rar:'🗜️',txt:'📄',csv:'📊'})[ext] || '📎';
}

/* Normalize user object dari berbagai format backend */
function normalizeUser(u) {
  return {
    id:          u.id,
    name:        u.name || u.displayName,
    email:       u.email,
    photo_url:   u.photo_url || u.photoURL || '',
    status:      u.status || '',
    about:       u.about || '',
    phone:       u.phone || '',
    show_online: u.show_online !== false,
    online:      u.online !== false
  };
}
