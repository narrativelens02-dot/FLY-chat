/**
 * FLYchat — Main Application Logic
 * Firebase Firestore + Storage + Auth
 */

import { auth, db, storage, googleProvider } from './firebase-config.js';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  updateProfile
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  doc, setDoc, getDoc, getDocs, addDoc, updateDoc, deleteDoc,
  collection, query, where, orderBy, limit,
  onSnapshot, serverTimestamp, arrayUnion
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import {
  ref as storageRef,
  uploadBytesResumable,
  getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

/* ════════════════════════════════════════
   STATE
════════════════════════════════════════ */
let currentUser     = null;
let currentChatId   = null;
let currentPartner  = null;
let replyingTo      = null;   // { id, senderName, text }
let contextMsgId    = null;   // for context menu
let contextMsgData  = null;

let unsubMessages   = null;
let unsubChats      = null;
let unsubPartner    = null;
let typingTimer     = null;
let notifEnabled    = false;

/* ════════════════════════════════════════
   BOOT
════════════════════════════════════════ */
window.addEventListener('DOMContentLoaded', () => {
  buildEmojiPicker();
  setTimeout(() => {
    onAuthStateChanged(auth, async user => {
      if (user) {
        currentUser = user;
        await ensureUserDoc(user);
        await loadSidebarProfile();
        showScreen('home-screen');
        listenChats();
        registerServiceWorker();
      } else {
        showScreen('login-screen');
      }
    });
  }, 2000);
});

/* ════════════════════════════════════════
   SCREENS
════════════════════════════════════════ */
window.showScreen = function(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  if (id === 'profile-screen') populateProfileForm();
};

/* ════════════════════════════════════════
   AUTH — REGISTER
════════════════════════════════════════ */
document.getElementById('register-form').addEventListener('submit', async e => {
  e.preventDefault();
  const name    = v('reg-name');
  const email   = v('reg-email');
  const pw      = v('reg-password');
  const confirm = v('reg-confirm');

  clearErr('register-error');
  if (name.length < 2)     return showErr('register-error', 'Nama minimal 2 karakter.');
  if (pw !== confirm)      return showErr('register-error', 'Password tidak cocok.');
  if (pw.length < 6)       return showErr('register-error', 'Password minimal 6 karakter.');

  setLoad('register-btn', true);
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, pw);
    await updateProfile(cred.user, { displayName: name });
    await ensureUserDoc(cred.user, name);
    showToast('Akun berhasil dibuat! 🎉', 'success');
  } catch (err) {
    showErr('register-error', authErrMsg(err.code));
  } finally { setLoad('register-btn', false); }
});

/* ════════════════════════════════════════
   AUTH — LOGIN
════════════════════════════════════════ */
document.getElementById('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  clearErr('login-error');
  setLoad('login-btn', true);
  try {
    await signInWithEmailAndPassword(auth, v('login-email'), v('login-password'));
  } catch (err) {
    showErr('login-error', authErrMsg(err.code));
    setLoad('login-btn', false);
  }
});

/* ════════════════════════════════════════
   AUTH — GOOGLE
════════════════════════════════════════ */
window.signInWithGoogle = async function() {
  try {
    const res  = await signInWithPopup(auth, googleProvider);
    await ensureUserDoc(res.user);
  } catch (err) {
    if (err.code !== 'auth/popup-closed-by-user')
      showToast('Login Google gagal. Coba lagi.', 'error');
  }
};

/* ════════════════════════════════════════
   AUTH — LOGOUT
════════════════════════════════════════ */
window.confirmLogout = function() {
  if (!confirm('Yakin ingin keluar dari FLYchat?')) return;
  setOnlineStatus(false);
  signOut(auth).then(() => {
    unsubChats?.();
    unsubMessages?.();
    unsubPartner?.();
    currentUser = currentChatId = currentPartner = null;
    showScreen('login-screen');
  });
};

/* ════════════════════════════════════════
   USER DOC
════════════════════════════════════════ */
async function ensureUserDoc(user, displayName) {
  const ref = doc(db, 'users', user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      uid:         user.uid,
      displayName: displayName || user.displayName || user.email.split('@')[0],
      email:       user.email,
      photoURL:    user.photoURL || '',
      status:      'Hei, aku pakai FLYchat! 🦋',
      about:       '',
      phone:       '',
      online:      true,
      showOnline:  true,
      contacts:    [],
      lastSeen:    serverTimestamp(),
      createdAt:   serverTimestamp()
    });
  } else {
    await updateDoc(ref, { online: true, lastSeen: serverTimestamp() });
  }
}

async function setOnlineStatus(online) {
  if (!currentUser) return;
  await updateDoc(doc(db, 'users', currentUser.uid), {
    online,
    lastSeen: serverTimestamp()
  }).catch(() => {});
}

/* ════════════════════════════════════════
   SIDEBAR PROFILE
════════════════════════════════════════ */
async function loadSidebarProfile() {
  if (!currentUser) return;
  const snap = await getDoc(doc(db, 'users', currentUser.uid));
  if (!snap.exists()) return;
  const d = snap.data();
  el('sidebar-name').textContent    = d.displayName || 'User';
  el('sidebar-status').textContent  = d.status || '';
  if (d.photoURL) el('sidebar-avatar').src = d.photoURL;
  el('my-online-dot').className = 'online-dot';
}

/* ════════════════════════════════════════
   CHAT LIST (real-time)
════════════════════════════════════════ */
function listenChats() {
  if (!currentUser) return;
  unsubChats?.();
  const q = query(
    collection(db, 'chats'),
    where('participants', 'array-contains', currentUser.uid),
    orderBy('lastMessageTime', 'desc')
  );
  unsubChats = onSnapshot(q, snap => renderChatList(snap.docs), () => {});
}

function renderChatList(docs) {
  const list = el('chat-list');
  list.innerHTML = '';
  if (docs.length === 0) {
    list.innerHTML = `<div class="empty-list-msg">
      Belum ada percakapan. Tambah kontak untuk memulai!
    </div>`;
    return;
  }
  const promises = docs.map(async docSnap => {
    const chat = docSnap.data();
    const pid = chat.participants?.find(id => id !== currentUser.uid);
    if (!pid) return null;
    const pSnap = await getDoc(doc(db, 'users', pid));
    if (!pSnap.exists()) return null;
    return { chatId: docSnap.id, chat, partner: pSnap.data() };
  });
  Promise.all(promises).then(items => {
    list.innerHTML = '';
    items.filter(Boolean).forEach(({ chatId, chat, partner }) => {
      list.appendChild(buildChatItem(chatId, chat, partner));
    });
  });
}

function buildChatItem(chatId, chat, partner) {
  const unread = chat.unreadCount?.[currentUser.uid] || 0;
  const preview = chat.lastMessage || '';
  const time = chat.lastMessageTime ? fmtTime(chat.lastMessageTime.toDate()) : '';
  const isActive = chatId === currentChatId;

  const div = document.createElement('div');
  div.className = 'chat-item' + (isActive ? ' active' : '');
  div.dataset.chatId = chatId;
  div.role = 'listitem';
  div.innerHTML = `
    <div class="avatar-container">
      <img src="${esc(partner.photoURL || 'assets/default-avatar.svg')}" alt="" class="avatar-sm" />
      <span class="online-dot ${partner.online && partner.showOnline !== false ? '' : 'offline'}"></span>
    </div>
    <div class="chat-item-info">
      <div class="chat-item-name">${esc(partner.displayName || 'User')}</div>
      <div class="chat-item-preview">${esc(preview)}</div>
    </div>
    <div class="chat-item-meta">
      <span class="chat-item-time">${time}</span>
      ${unread > 0 ? `<span class="unread-badge">${unread > 99 ? '99+' : unread}</span>` : ''}
    </div>
  `;
  div.addEventListener('click', () => openChat(chatId, partner));
  return div;
}

/* ════════════════════════════════════════
   CONTACTS TAB
════════════════════════════════════════ */
window.switchTab = function(tab, btn) {
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.remove('active');
    b.setAttribute('aria-selected', 'false');
  });
  btn.classList.add('active');
  btn.setAttribute('aria-selected', 'true');
  el('chat-list').classList.toggle('hidden', tab !== 'chats');
  el('contacts-list').classList.toggle('hidden', tab !== 'contacts');
  if (tab === 'contacts') loadContacts();
};

async function loadContacts() {
  const list = el('contacts-list');
  list.innerHTML = '<div class="empty-list-msg">Memuat kontak...</div>';
  const snap = await getDoc(doc(db, 'users', currentUser.uid));
  const contacts = snap.data()?.contacts || [];
  if (contacts.length === 0) {
    list.innerHTML = '<div class="empty-list-msg">Belum ada kontak. Tambah via tombol 🔍</div>';
    return;
  }
  list.innerHTML = '';
  for (const uid of contacts) {
    const cs = await getDoc(doc(db, 'users', uid));
    if (!cs.exists()) continue;
    const u = cs.data();
    const div = document.createElement('div');
    div.className = 'chat-item';
    div.innerHTML = `
      <div class="avatar-container">
        <img src="${esc(u.photoURL || 'assets/default-avatar.svg')}" alt="" class="avatar-sm"/>
        <span class="online-dot ${u.online && u.showOnline !== false ? '' : 'offline'}"></span>
      </div>
      <div class="chat-item-info">
        <div class="chat-item-name">${esc(u.displayName)}</div>
        <div class="chat-item-preview">${esc(u.status || '')}</div>
      </div>
      <span class="contact-status ${u.online && u.showOnline !== false ? 'online' : 'offline'}">
        ${u.online && u.showOnline !== false ? 'Online' : 'Offline'}
      </span>
    `;
    div.addEventListener('click', () => startChatWith(u));
    list.appendChild(div);
  }
}

/* ════════════════════════════════════════
   OPEN / CREATE CHAT
════════════════════════════════════════ */
async function openChat(chatId, partner) {
  // cleanup old subscription
  unsubMessages?.();
  unsubPartner?.();

  currentChatId  = chatId;
  currentPartner = partner;
  replyingTo     = null;
  el('reply-preview').classList.add('hidden');

  // Mark as read
  updateDoc(doc(db, 'chats', chatId), {
    [`unreadCount.${currentUser.uid}`]: 0
  }).catch(() => {});

  // Highlight sidebar item
  document.querySelectorAll('.chat-item').forEach(i =>
    i.classList.toggle('active', i.dataset.chatId === chatId)
  );

  // Show chat panel
  el('empty-chat').classList.add('hidden');
  el('active-chat').classList.remove('hidden');
  el('chat-area').classList.add('active');

  // Header
  el('chat-partner-name').textContent = partner.displayName || 'User';
  el('chat-partner-avatar').src = partner.photoURL || 'assets/default-avatar.svg';
  updatePartnerStatus(partner);

  // Listen partner online status
  unsubPartner = onSnapshot(doc(db, 'users', partner.uid), snap => {
    if (snap.exists()) updatePartnerStatus(snap.data());
  });

  // Load messages
  listenMessages(chatId);
  listenTyping(chatId);
}

function updatePartnerStatus(p) {
  const online = p.online && p.showOnline !== false;
  const statusEl = el('chat-partner-status');
  const dotEl    = el('partner-online-dot');
  if (online) {
    statusEl.textContent = 'Online';
    statusEl.className   = 'status-text online';
    dotEl.className      = 'online-dot';
  } else {
    const ls = p.lastSeen ? fmtTimeRelative(p.lastSeen.toDate()) : '';
    statusEl.textContent = ls ? `Terakhir ${ls}` : 'Offline';
    statusEl.className   = 'status-text';
    dotEl.className      = 'online-dot offline';
  }
}

async function startChatWith(partner) {
  const chatId = await findOrCreateChat(partner.uid);
  openChat(chatId, partner);
}

async function findOrCreateChat(partnerId) {
  const q = query(
    collection(db, 'chats'),
    where('participants', 'array-contains', currentUser.uid)
  );
  const snap = await getDocs(q);
  for (const d of snap.docs) {
    if (d.data().participants.includes(partnerId)) return d.id;
  }
  const ref = await addDoc(collection(db, 'chats'), {
    participants:    [currentUser.uid, partnerId],
    lastMessage:     '',
    lastMessageTime: serverTimestamp(),
    unreadCount:     { [currentUser.uid]: 0, [partnerId]: 0 },
    createdAt:       serverTimestamp()
  });
  return ref.id;
}

/* ════════════════════════════════════════
   MESSAGES (real-time)
════════════════════════════════════════ */
function listenMessages(chatId) {
  const q = query(
    collection(db, 'chats', chatId, 'messages'),
    orderBy('createdAt', 'asc'),
    limit(200)
  );
  unsubMessages = onSnapshot(q, snap => renderMessages(snap.docs), () => {});
}

function renderMessages(docs) {
  const list = el('messages-list');
  list.innerHTML = '';
  let lastDate = null;

  docs.forEach(docSnap => {
    const msg  = { id: docSnap.id, ...docSnap.data() };
    const date = msg.createdAt?.toDate();

    if (date) {
      const ds = fmtDate(date);
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
}

function buildMsgBubble(msg) {
  const isOut = msg.senderId === currentUser.uid;
  const wrapper = document.createElement('div');
  wrapper.className = `msg-wrapper ${isOut ? 'outgoing' : 'incoming'}`;
  wrapper.dataset.msgId = msg.id;

  if (!isOut) {
    const av = document.createElement('img');
    av.src = currentPartner?.photoURL || 'assets/default-avatar.svg';
    av.className = 'avatar-sm';
    wrapper.appendChild(av);
  }

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  // Reply quote
  if (msg.replyTo) {
    const rq = document.createElement('div');
    rq.className = 'reply-quote';
    rq.innerHTML = `<div class="reply-quote-name">${esc(msg.replyTo.senderName)}</div>
                    <div>${esc(truncate(msg.replyTo.text, 80))}</div>`;
    bubble.appendChild(rq);
  }

  // Content
  const content = document.createElement('div');
  content.innerHTML = buildMsgContent(msg);
  bubble.appendChild(content);

  // Meta
  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  const time = msg.createdAt ? fmtTimeFull(msg.createdAt.toDate()) : '';
  meta.innerHTML = `<span class="msg-time">${time}</span>`;
  if (isOut) {
    const st = document.createElement('span');
    st.className = `msg-status ${msg.read ? 'read' : ''}`;
    st.textContent = msg.read ? '✓✓' : '✓';
    meta.appendChild(st);
  }
  bubble.appendChild(meta);

  // Reactions display
  if (msg.reactions && Object.keys(msg.reactions).length > 0) {
    const rDiv = document.createElement('div');
    rDiv.className = 'msg-reactions';
    const counts = {};
    Object.values(msg.reactions).forEach(r => { counts[r] = (counts[r] || 0) + 1; });
    Object.entries(counts).forEach(([emoji, count]) => {
      const pill = document.createElement('button');
      pill.className = 'reaction-pill';
      pill.textContent = `${emoji} ${count}`;
      pill.title = 'Reaksi';
      pill.addEventListener('click', e => { e.stopPropagation(); addReaction(msg.id, emoji); });
      rDiv.appendChild(pill);
    });
    bubble.appendChild(rDiv);
  }

  wrapper.appendChild(bubble);

  // Context menu on long-press / right-click
  bubble.addEventListener('contextmenu', e => {
    e.preventDefault();
    showContextMenu(e, msg);
  });
  // Long press for mobile
  let pressTimer;
  bubble.addEventListener('touchstart', () => {
    pressTimer = setTimeout(() => showContextMenu(null, msg, bubble), 600);
  });
  bubble.addEventListener('touchend', () => clearTimeout(pressTimer));

  return wrapper;
}

function buildMsgContent(msg) {
  switch (msg.type) {
    case 'image':
      return `<img src="${esc(msg.fileURL)}" alt="foto" class="msg-image"
                   loading="lazy"
                   onclick="openLightbox('${esc(msg.fileURL)}','${esc(msg.fileName||'')}')" />
              ${msg.caption ? `<div class="msg-caption">${esc(msg.caption)}</div>` : ''}`;

    case 'video':
      return `<video src="${esc(msg.fileURL)}" class="msg-video" controls preload="metadata"></video>`;

    case 'document': {
      const icon = fileIcon(msg.fileName);
      return `<div class="msg-file">
        <span class="msg-file-icon">${icon}</span>
        <div class="msg-file-info">
          <div class="msg-file-name">${esc(msg.fileName || 'Dokumen')}</div>
          <div class="msg-file-size">${msg.fileSize || ''}</div>
        </div>
        <a href="${esc(msg.fileURL)}" target="_blank" rel="noopener" download="${esc(msg.fileName||'file')}"
           class="msg-file-dl" title="Unduh">⬇</a>
      </div>`;
    }

    case 'location':
      return `<div class="msg-location">
        <div class="msg-location-name">📍 ${esc(msg.locationName || 'Lokasi')}</div>
        <div class="msg-location-map">
          <iframe
            src="https://www.openstreetmap.org/export/embed.html?bbox=${msg.lng-0.005}%2C${msg.lat-0.005}%2C${msg.lng+0.005}%2C${msg.lat+0.005}&layer=mapnik&marker=${msg.lat}%2C${msg.lng}"
            title="Peta lokasi" loading="lazy" sandbox="allow-scripts allow-same-origin"></iframe>
        </div>
        <a href="https://www.openstreetmap.org/?mlat=${msg.lat}&mlon=${msg.lng}#map=15/${msg.lat}/${msg.lng}"
           target="_blank" rel="noopener" class="msg-location-link">🗺 Buka di OpenStreetMap →</a>
      </div>`;

    default:
      return `<div>${esc(msg.text || '').replace(/\n/g, '<br>')}</div>`;
  }
}

/* ════════════════════════════════════════
   SEND MESSAGE
════════════════════════════════════════ */
window.sendMessage = async function() {
  const input = el('message-input');
  const text  = input.value.trim();
  if (!currentChatId || !text) return;

  const msgData = {
    type:      'text',
    text,
    senderId:  currentUser.uid,
    createdAt: serverTimestamp(),
    read:      false
  };
  if (replyingTo) {
    msgData.replyTo = {
      id:         replyingTo.id,
      senderName: replyingTo.senderName,
      text:       replyingTo.text
    };
  }

  input.value = '';
  cancelReply();

  await addDoc(collection(db, 'chats', currentChatId, 'messages'), msgData);
  await updateChatMeta(text);
  sendPushNotif(text);
};

async function updateChatMeta(preview) {
  if (!currentChatId || !currentPartner) return;
  const chatSnap = await getDoc(doc(db, 'chats', currentChatId));
  const curUnread = chatSnap.data()?.unreadCount?.[currentPartner.uid] || 0;
  await updateDoc(doc(db, 'chats', currentChatId), {
    lastMessage:     preview.substring(0, 80),
    lastMessageTime: serverTimestamp(),
    [`unreadCount.${currentPartner.uid}`]: curUnread + 1
  });
}

/* ════════════════════════════════════════
   FILE UPLOAD & SEND
════════════════════════════════════════ */
window.toggleAttachMenu = function() {
  const menu = el('attach-menu');
  const btn  = el('attach-btn');
  const isHidden = menu.classList.toggle('hidden');
  btn.setAttribute('aria-expanded', String(!isHidden));
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
  // Images & videos get a preview modal; documents go straight through
  if (type === 'image' || type === 'video') {
    showMediaPreview(file, type);
  } else {
    await uploadAndSend(file, type);
  }
};

/**
 * Upload file ke Firebase Storage lalu kirim sebagai pesan.
 * @param {File}   file
 * @param {string} type     'image' | 'video' | 'document'
 * @param {string} caption  optional caption for image/video
 */
async function uploadAndSend(file, type, caption = '') {
  const MAX = type === 'video' ? 100 : 50; // MB
  if (file.size > MAX * 1024 * 1024) {
    showToast(`File terlalu besar (maks ${MAX}MB)`, 'error');
    return;
  }

  const toastEl = showPersistentToast('Mengunggah 0%…');
  try {
    const path = `chats/${currentChatId}/${type}/${Date.now()}_${file.name}`;
    const sRef = storageRef(storage, path);
    const task = uploadBytesResumable(sRef, file);

    await new Promise((res, rej) => {
      task.on('state_changed',
        snap => {
          const pct = Math.round((snap.bytesTransferred / snap.totalBytes) * 100);
          toastEl.textContent = `Mengunggah ${pct}%…`;
        },
        rej, res
      );
    });

    const url     = await getDownloadURL(sRef);
    const preview = type === 'image' ? '📷 Foto' : type === 'video' ? '🎥 Video' : `📄 ${file.name}`;
    const msgData = {
      type,
      senderId:  currentUser.uid,
      fileURL:   url,
      fileName:  file.name,
      fileSize:  fmtSize(file.size),
      caption:   caption || '',
      text:      caption || `[${preview}]`,
      createdAt: serverTimestamp(),
      read:      false
    };
    if (replyingTo) { msgData.replyTo = { ...replyingTo }; cancelReply(); }

    await addDoc(collection(db, 'chats', currentChatId, 'messages'), msgData);
    await updateChatMeta(caption || `[${preview}]`);
    hideToast(toastEl);
    showToast(`${preview} terkirim! ✓`, 'success');
  } catch (err) {
    hideToast(toastEl);
    showToast('Gagal mengunggah: ' + err.message, 'error');
  }
}

/* ════════════════════════════════════════
   SHARE LOCATION
════════════════════════════════════════ */
window.shareLocation = async function() {
  el('attach-menu').classList.add('hidden');
  if (!navigator.geolocation) { showToast('Geolokasi tidak didukung', 'error'); return; }

  const t = showPersistentToast('📍 Mendapatkan lokasi...');
  navigator.geolocation.getCurrentPosition(
    async pos => {
      const { latitude: lat, longitude: lng } = pos.coords;
      let locationName = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      try {
        const res  = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=id`);
        const data = await res.json();
        if (data.display_name) {
          locationName = data.display_name.split(',').slice(0, 3).join(', ');
        }
      } catch {}

      const msgData = {
        type:         'location',
        lat, lng,
        locationName,
        senderId:     currentUser.uid,
        text:         `📍 ${locationName}`,
        createdAt:    serverTimestamp(),
        read:         false
      };
      if (replyingTo) msgData.replyTo = { ...replyingTo };
      cancelReply();

      await addDoc(collection(db, 'chats', currentChatId, 'messages'), msgData);
      await updateChatMeta(`📍 ${locationName}`);
      hideToast(t);
      showToast('Lokasi dibagikan!', 'success');
    },
    err => {
      hideToast(t);
      showToast('Tidak bisa mendapat lokasi: ' + err.message, 'error');
    },
    { timeout: 10000, enableHighAccuracy: true }
  );
};

/* ════════════════════════════════════════
   TYPING INDICATOR (real-time)
════════════════════════════════════════ */
window.handleTyping = function() {
  if (!currentChatId || !currentUser) return;
  updateDoc(doc(db, 'chats', currentChatId), {
    [`typing.${currentUser.uid}`]: true
  }).catch(() => {});
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    updateDoc(doc(db, 'chats', currentChatId), {
      [`typing.${currentUser.uid}`]: false
    }).catch(() => {});
  }, 2500);
};

function listenTyping(chatId) {
  onSnapshot(doc(db, 'chats', chatId), snap => {
    const data = snap.data();
    const typing = data?.typing || {};
    const isTyping = currentPartner && typing[currentPartner.uid];
    const area = el('typing-area');
    if (isTyping) {
      area.innerHTML = `<div class="typing-indicator">
        <div class="t-dot"></div><div class="t-dot"></div><div class="t-dot"></div>
        <span style="margin-left:4px;font-size:0.78rem">${esc(currentPartner.displayName)} sedang mengetik…</span>
      </div>`;
    } else {
      area.innerHTML = '';
    }
  });
}

/* ════════════════════════════════════════
   REPLY
════════════════════════════════════════ */
window.replyToMsg = function() {
  closeContextMenu();
  if (!contextMsgData) return;
  const msg = contextMsgData;
  const senderName = msg.senderId === currentUser.uid
    ? (currentUser.displayName || 'Kamu')
    : (currentPartner?.displayName || 'Pengguna');
  const text = msg.text || (msg.type === 'image' ? '[Foto]' : msg.type === 'video' ? '[Video]' : `[${msg.type}]`);

  replyingTo = { id: msg.id, senderName, text };
  el('reply-preview-name').textContent = senderName;
  el('reply-preview-text').textContent = truncate(text, 80);
  el('reply-preview').classList.remove('hidden');
  el('message-input').focus();
};

window.cancelReply = function() {
  replyingTo = null;
  el('reply-preview').classList.add('hidden');
};

/* ════════════════════════════════════════
   COPY MESSAGE
════════════════════════════════════════ */
window.copyMsg = function() {
  closeContextMenu();
  if (!contextMsgData) return;
  const text = contextMsgData.text || '';
  navigator.clipboard?.writeText(text).then(() => showToast('Pesan disalin!'));
};

/* ════════════════════════════════════════
   DELETE MESSAGE
════════════════════════════════════════ */
window.deleteMsg = async function() {
  closeContextMenu();
  if (!contextMsgData || !currentChatId) return;
  if (contextMsgData.senderId !== currentUser.uid) {
    showToast('Hanya bisa hapus pesan sendiri', 'error'); return;
  }
  if (!confirm('Hapus pesan ini?')) return;
  await deleteDoc(doc(db, 'chats', currentChatId, 'messages', contextMsgData.id));
  showToast('Pesan dihapus');
};

/* ════════════════════════════════════════
   REACTIONS
════════════════════════════════════════ */
async function addReaction(msgId, emoji) {
  if (!currentChatId) return;
  await updateDoc(doc(db, 'chats', currentChatId, 'messages', msgId), {
    [`reactions.${currentUser.uid}`]: emoji
  });
}

/* ════════════════════════════════════════
   CONTEXT MENU
════════════════════════════════════════ */
function showContextMenu(e, msg, refEl) {
  contextMsgId   = msg.id;
  contextMsgData = msg;
  const menu = el('msg-context-menu');
  menu.classList.remove('hidden');

  // Show/hide delete based on ownership
  el('ctx-delete').style.display = msg.senderId === currentUser.uid ? '' : 'none';

  let x, y;
  if (e) {
    x = e.clientX; y = e.clientY;
  } else if (refEl) {
    const r = refEl.getBoundingClientRect();
    x = r.left + r.width / 2; y = r.top;
  } else { x = 100; y = 200; }

  // Clamp to viewport
  menu.style.left = Math.min(x, window.innerWidth  - 180) + 'px';
  menu.style.top  = Math.min(y, window.innerHeight - 120) + 'px';
}

function closeContextMenu() {
  el('msg-context-menu').classList.add('hidden');
}

window.closeAllMenus = function() {
  closeContextMenu();
  el('attach-menu').classList.add('hidden');
  el('emoji-picker').classList.add('hidden');
  el('chat-dropdown').classList.add('hidden');
};

/* ════════════════════════════════════════
   CHAT DROPDOWN (header menu)
════════════════════════════════════════ */
window.toggleChatMenu = function() {
  el('chat-dropdown').classList.toggle('hidden');
};

window.clearChatHistory = async function() {
  el('chat-dropdown').classList.add('hidden');
  if (!currentChatId) return;
  if (!confirm('Hapus semua riwayat pesan? Ini tidak bisa dibatalkan.')) return;
  const q = query(collection(db, 'chats', currentChatId, 'messages'));
  const snap = await getDocs(q);
  const batch = [];
  snap.docs.forEach(d => batch.push(deleteDoc(d.ref)));
  await Promise.all(batch);
  await updateDoc(doc(db, 'chats', currentChatId), { lastMessage: '', lastMessageTime: serverTimestamp() });
  showToast('Riwayat chat dihapus');
};

/* ════════════════════════════════════════
   PARTNER PROFILE MODAL
════════════════════════════════════════ */
window.showPartnerProfile = async function() {
  if (!currentPartner) return;
  el('chat-dropdown').classList.add('hidden');
  const snap = await getDoc(doc(db, 'users', currentPartner.uid));
  const u = snap.exists() ? snap.data() : currentPartner;
  el('partner-profile-content').innerHTML = `
    <img src="${esc(u.photoURL || 'assets/default-avatar.svg')}" class="avatar-lg" style="margin:0 auto 12px" alt="" />
    <div style="font-size:1.15rem;font-weight:700;color:var(--text-h)">${esc(u.displayName)}</div>
    <div style="font-size:0.85rem;color:var(--primary);margin:4px 0 12px">${esc(u.email)}</div>
    ${u.status ? `<div style="font-size:0.88rem;color:var(--text-m);padding:8px 16px;background:var(--bg-app);border-radius:10px;margin-bottom:8px">"${esc(u.status)}"</div>` : ''}
    ${u.about  ? `<div style="font-size:0.85rem;color:var(--text-m)">${esc(u.about)}</div>` : ''}
    <button class="btn-primary" style="width:auto;padding:10px 24px;margin-top:16px"
      onclick="closeModal('partner-profile-modal')">Tutup</button>
  `;
  el('partner-profile-modal').classList.remove('hidden');
};

/* ════════════════════════════════════════
   ADD CONTACT / SEARCH USER
════════════════════════════════════════ */
window.showAddContact = function() {
  el('search-user-input').value = '';
  el('search-result').innerHTML = '';
  el('add-contact-modal').classList.remove('hidden');
  el('search-user-input').focus();
};

window.closeModal = function(id) {
  el(id).classList.add('hidden');
};

window.searchUser = async function() {
  const email = v('search-user-input').toLowerCase();
  const res   = el('search-result');
  if (!email) { res.innerHTML = '<p style="color:var(--text-m);font-size:0.88rem">Masukkan email terlebih dahulu.</p>'; return; }
  if (email === currentUser.email.toLowerCase()) { res.innerHTML = '<p style="color:var(--text-m);font-size:0.88rem">Itu email kamu sendiri 😄</p>'; return; }

  res.innerHTML = '<p style="color:var(--text-m);font-size:0.88rem">Mencari...</p>';
  const q = query(collection(db, 'users'), where('email', '==', email), limit(1));
  const snap = await getDocs(q);
  if (snap.empty) { res.innerHTML = '<p style="color:var(--text-m);font-size:0.88rem">Pengguna tidak ditemukan.</p>'; return; }

  const u = snap.docs[0].data();
  res.innerHTML = `
    <div class="user-result-card">
      <img src="${esc(u.photoURL||'assets/default-avatar.svg')}" class="avatar-sm" alt="" />
      <div class="user-result-info" style="flex:1">
        <div class="name">${esc(u.displayName)}</div>
        <div class="email">${esc(u.email)}</div>
      </div>
      <button class="btn-primary small" onclick="addContactAndChat('${u.uid}')">💬 Chat</button>
    </div>
  `;
};

window.addContactAndChat = async function(uid) {
  // Save to contacts
  await updateDoc(doc(db, 'users', currentUser.uid), { contacts: arrayUnion(uid) }).catch(() => {});
  closeModal('add-contact-modal');
  const pSnap = await getDoc(doc(db, 'users', uid));
  if (pSnap.exists()) await startChatWith(pSnap.data());
};

window.filterContacts = function(q) {
  document.querySelectorAll('.chat-item').forEach(item => {
    const name = item.querySelector('.chat-item-name')?.textContent?.toLowerCase() || '';
    item.style.display = name.includes(q.toLowerCase()) ? '' : 'none';
  });
};

/* ════════════════════════════════════════
   PROFILE SCREEN
════════════════════════════════════════ */
async function populateProfileForm() {
  if (!currentUser) return;
  const snap = await getDoc(doc(db, 'users', currentUser.uid));
  if (!snap.exists()) return;
  const d = snap.data();
  el('profile-name').value  = d.displayName || '';
  el('profile-status').value= d.status || '';
  el('profile-about').value = d.about  || '';
  el('profile-phone').value = d.phone  || '';
  el('profile-email').value = d.email  || '';
  if (d.photoURL) el('profile-avatar-img').src = d.photoURL;
  el('status-count').textContent = `${(d.status||'').length}/100`;
  el('toggle-online-status').checked = d.showOnline !== false;
  // Check notification permission
  el('toggle-notif').checked = notifEnabled;
}

window.saveProfile = async function() {
  if (!currentUser) return;
  const name   = el('profile-name').value.trim();
  const status = el('profile-status').value.trim();
  const about  = el('profile-about').value.trim();
  const phone  = el('profile-phone').value.trim();
  if (!name) { showToast('Nama tidak boleh kosong', 'error'); return; }

  try {
    await updateDoc(doc(db, 'users', currentUser.uid), { displayName: name, status, about, phone });
    await updateProfile(currentUser, { displayName: name });
    el('sidebar-name').textContent   = name;
    el('sidebar-status').textContent = status;
    showToast('Profil disimpan! ✓', 'success');
  } catch (err) {
    showToast('Gagal simpan: ' + err.message, 'error');
  }
};

window.saveOnlinePreference = async function(checked) {
  if (!currentUser) return;
  await updateDoc(doc(db, 'users', currentUser.uid), { showOnline: checked }).catch(() => {});
};

window.triggerAvatarUpload = function() { el('avatar-upload').click(); };

window.uploadAvatar = async function(input) {
  const file = input.files[0];
  if (!file || !file.type.startsWith('image/')) { showToast('Pilih file gambar', 'error'); return; }
  if (file.size > 5 * 1024 * 1024) { showToast('Gambar terlalu besar (maks 5MB)', 'error'); return; }

  const progress = el('profile-upload-progress');
  const bar      = el('avatar-progress-bar');
  progress.classList.remove('hidden');

  try {
    const sRef = storageRef(storage, `avatars/${currentUser.uid}`);
    const task = uploadBytesResumable(sRef, file);
    await new Promise((res, rej) => {
      task.on('state_changed',
        snap => { bar.style.width = Math.round((snap.bytesTransferred/snap.totalBytes)*100) + '%'; },
        rej, res
      );
    });
    const url = await getDownloadURL(sRef);
    await Promise.all([
      updateDoc(doc(db, 'users', currentUser.uid), { photoURL: url }),
      updateProfile(currentUser, { photoURL: url })
    ]);
    el('profile-avatar-img').src = url;
    el('sidebar-avatar').src     = url;
    showToast('Foto profil diperbarui! ✓', 'success');
  } catch (err) {
    showToast('Gagal unggah foto: ' + err.message, 'error');
  } finally {
    setTimeout(() => { progress.classList.add('hidden'); bar.style.width = '0%'; }, 1000);
  }
};

/* ════════════════════════════════════════
   EMOJI PICKER
════════════════════════════════════════ */
const EMOJI_CATEGORIES = {
  'Ekspresi': ['😀','😂','😍','🥰','😎','🤔','😢','😭','😡','🤩','😊','😇','🥳','😜','😴','🤗','😏','🤭','🙄','😬','🥹','🫠','🤧','🥸','😶'],
  'Gestur':   ['👍','👎','👏','🙏','🤝','✌️','👋','🫶','💪','🤜','🤛','🫰','✋','🤙','👌','🤌'],
  'Simbol':   ['❤️','🔥','💯','✅','⭐','🎉','💡','💰','🏆','🎯','🔑','💎','🌟','✨','⚡','❄️'],
  'Alam':     ['🐶','🐱','🦋','🌸','🌈','☀️','🌙','🌍','🍕','🍔','🍦','🎂','🍎','🥤','☕'],
  'Objek':    ['📱','💻','📷','🎵','🎮','✈️','🚗','🏠','📚','🎁','🔒','🎭','🎨','🎬','🎤']
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
        inp.value = inp.value.slice(0, pos) + emoji + inp.value.slice(pos);
        inp.focus();
        inp.setSelectionRange(pos + emoji.length, pos + emoji.length);
      });
      grid.appendChild(btn);
    });
    picker.appendChild(grid);
  }
}

window.toggleEmojiPicker = function() {
  const p = el('emoji-picker');
  const isHidden = p.classList.toggle('hidden');
  el('attach-menu').classList.add('hidden');
  document.querySelector('.emoji-toggle-btn')?.setAttribute('aria-expanded', String(!isHidden));
};

/* ════════════════════════════════════════
   LIGHTBOX
════════════════════════════════════════ */
window.openLightbox = function(src, name) {
  el('lightbox-img').src    = src;
  el('lightbox-download').href = src;
  el('lightbox-download').download = name || 'gambar';
  el('lightbox').classList.remove('hidden');
};
window.closeLightbox = function() { el('lightbox').classList.add('hidden'); };

/* ════════════════════════════════════════
   DARK MODE
════════════════════════════════════════ */
window.toggleTheme = function() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  document.documentElement.setAttribute('data-theme', isDark ? 'light' : 'dark');
  el('theme-btn').textContent = isDark ? '🌙' : '☀️';
  localStorage.setItem('flychat-theme', isDark ? 'light' : 'dark');
};

// Load saved theme
(function() {
  const t = localStorage.getItem('flychat-theme');
  if (t) {
    document.documentElement.setAttribute('data-theme', t);
    document.addEventListener('DOMContentLoaded', () => {
      const btn = el('theme-btn');
      if (btn) btn.textContent = t === 'dark' ? '☀️' : '🌙';
    });
  }
})();

/* ════════════════════════════════════════
   BROWSER NOTIFICATIONS
════════════════════════════════════════ */
async function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('sw.js');
    } catch {}
  }
}

window.toggleNotifications = async function(checked) {
  if (!checked) { notifEnabled = false; return; }
  const perm = await Notification.requestPermission();
  notifEnabled = perm === 'granted';
  if (!notifEnabled) {
    showToast('Izin notifikasi ditolak', 'error');
    el('toggle-notif').checked = false;
  } else {
    showToast('Notifikasi diaktifkan!', 'success');
  }
};

function sendPushNotif(text) {
  if (!notifEnabled || document.visibilityState === 'visible') return;
  if (Notification.permission !== 'granted') return;
  new Notification(`FLYchat — ${currentPartner?.displayName || 'Pesan baru'}`, {
    body: text.substring(0, 100),
    icon: 'assets/default-avatar.svg'
  });
}

/* ════════════════════════════════════════
   MOBILE
════════════════════════════════════════ */
window.closeChatMobile = function() {
  el('chat-area').classList.remove('active');
};

/* ════════════════════════════════════════
   CALL PLACEHOLDERS
════════════════════════════════════════ */
window.startVideoCall = function() { showToast('📹 Video call segera hadir!'); };
window.startVoiceCall = function() { showToast('📞 Panggilan suara segera hadir!'); };

/* ════════════════════════════════════════
   ONLINE / OFFLINE TRACKING
════════════════════════════════════════ */
document.addEventListener('visibilitychange', () => {
  if (currentUser) setOnlineStatus(!document.hidden);
});
window.addEventListener('beforeunload', () => {
  if (currentUser) setOnlineStatus(false);
});
window.addEventListener('online',  () => { if (currentUser) setOnlineStatus(true); });
window.addEventListener('offline', () => { if (currentUser) setOnlineStatus(false); });

/* ════════════════════════════════════════
   CLOSE MENUS ON OUTSIDE CLICK
════════════════════════════════════════ */
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

/* ════════════════════════════════════════
   UTILITIES
════════════════════════════════════════ */
function el(id) { return document.getElementById(id); }
function v(id)  { return (el(id)?.value || '').trim(); }

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

function truncate(str, n) { return str && str.length > n ? str.slice(0, n) + '…' : (str || ''); }

window.togglePassword = function(id, btn) {
  const inp = el(id);
  inp.type = inp.type === 'password' ? 'text' : 'password';
  btn.textContent = inp.type === 'password' ? '👁' : '🙈';
};

function setLoad(btnId, loading) {
  const btn = el(btnId);
  if (!btn) return;
  btn.disabled = loading;
  btn.querySelector('.btn-text')?.style.setProperty('display', loading ? 'none' : '');
  btn.querySelector('.spinner')?.classList.toggle('hidden', !loading);
}

function showErr(id, msg) {
  const e = el(id);
  if (e) { e.textContent = msg; e.classList.remove('hidden'); }
}
function clearErr(id) { el(id)?.classList.add('hidden'); }

let _toastTimer = null;
function showToast(msg, type = '', duration = 2800) {
  const t = el('toast');
  t.textContent = msg;
  t.className = `toast show ${type}`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { t.classList.remove('show'); }, duration);
  return t;
}
function showPersistentToast(msg) {
  const t = el('toast');
  t.textContent = msg;
  t.className = 'toast show';
  clearTimeout(_toastTimer);
  return t;
}
function hideToast(t) { if (t) { t.classList.remove('show'); } }

function scrollBottom() {
  const c = el('messages-container');
  if (c) c.scrollTop = c.scrollHeight;
}

function fmtTime(date) {
  if (!date) return '';
  const now  = new Date();
  const isToday = date.toDateString() === now.toDateString();
  if (isToday) return date.toLocaleTimeString('id-ID', { hour:'2-digit', minute:'2-digit' });
  const yesterday = new Date(now); yesterday.setDate(now.getDate()-1);
  if (date.toDateString() === yesterday.toDateString()) return 'Kemarin';
  return date.toLocaleDateString('id-ID', { day:'2-digit', month:'2-digit', year:'2-digit' });
}

function fmtTimeFull(date) {
  return date ? date.toLocaleTimeString('id-ID', { hour:'2-digit', minute:'2-digit' }) : '';
}

function fmtTimeRelative(date) {
  if (!date) return '';
  const diff = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diff < 60)   return 'baru saja';
  if (diff < 3600) return Math.floor(diff/60) + ' menit lalu';
  if (diff < 86400)return Math.floor(diff/3600) + ' jam lalu';
  return date.toLocaleDateString('id-ID', { day:'numeric', month:'short' });
}

function fmtDate(date) {
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return 'Hari Ini';
  const y = new Date(now); y.setDate(now.getDate()-1);
  if (date.toDateString() === y.toDateString()) return 'Kemarin';
  return date.toLocaleDateString('id-ID', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
}

function fmtSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
  return (b/1048576).toFixed(1) + ' MB';
}

function fileIcon(name) {
  if (!name) return '📎';
  const ext = name.split('.').pop().toLowerCase();
  const map = { pdf:'📕', doc:'📘', docx:'📘', xls:'📗', xlsx:'📗', ppt:'📙', pptx:'📙', zip:'🗜️', rar:'🗜️', txt:'📄', csv:'📊' };
  return map[ext] || '📎';
}

function authErrMsg(code) {
  const m = {
    'auth/user-not-found':       'Email tidak terdaftar.',
    'auth/wrong-password':       'Password salah.',
    'auth/invalid-credential':   'Email atau password salah.',
    'auth/email-already-in-use': 'Email sudah digunakan akun lain.',
    'auth/invalid-email':        'Format email tidak valid.',
    'auth/weak-password':        'Password terlalu lemah.',
    'auth/too-many-requests':    'Terlalu banyak percobaan. Coba beberapa saat lagi.',
    'auth/network-request-failed':'Masalah koneksi jaringan.',
    'auth/popup-closed-by-user': 'Login dibatalkan.'
  };
  return m[code] || `Terjadi kesalahan (${code}).`;
}


/* listenTyping dipanggil langsung dari dalam openChat di atas */

/* ════════════════════════════════════════
   QUICK REACTION BAR
   Shows 6 quick emoji on long-press (desktop: right-click)
════════════════════════════════════════ */
const QUICK_REACTIONS = ['❤️','😂','😮','😢','👍','👎'];

function showQuickReactions(msgId, anchorEl) {
  closeQuickReactions();
  const bar   = document.createElement('div');
  bar.id      = 'quick-reaction-bar';
  bar.className = 'quick-reaction-bar';

  QUICK_REACTIONS.forEach(emoji => {
    const btn = document.createElement('button');
    btn.className   = 'qr-btn';
    btn.textContent = emoji;
    btn.title       = emoji;
    btn.addEventListener('click', e => {
      e.stopPropagation();
      addReaction(msgId, emoji);
      closeQuickReactions();
    });
    bar.appendChild(btn);
  });

  document.body.appendChild(bar);

  // Position near element
  const rect = anchorEl.getBoundingClientRect();
  bar.style.left = Math.min(rect.left, window.innerWidth - 280) + 'px';
  bar.style.top  = (rect.top - 56) + 'px';
  bar.style.position = 'fixed';

  // Auto-dismiss
  setTimeout(closeQuickReactions, 4000);
}

function closeQuickReactions() {
  document.getElementById('quick-reaction-bar')?.remove();
}

document.addEventListener('click', closeQuickReactions);

/* ════════════════════════════════════════
   MEDIA PREVIEW BEFORE SEND
   Panggil showMediaPreview untuk foto/video
════════════════════════════════════════ */
// handleFileSelect sudah di-override di atas (baris ~601)
// Baris ini hanya memastikan showMediaPreview tersedia

function showMediaPreview(file, type) {
  // Remove existing
  document.getElementById('media-preview-modal')?.remove();

  const modal  = document.createElement('div');
  modal.id     = 'media-preview-modal';
  modal.className = 'media-preview-modal';

  const url    = URL.createObjectURL(file);
  const media  = type === 'image'
    ? `<img src="${url}" alt="preview" />`
    : `<video src="${url}" controls style="max-width:85vw;max-height:60vh;border-radius:12px"></video>`;

  modal.innerHTML = `
    <div style="color:white;font-size:0.9rem;opacity:0.8;align-self:flex-start">
      ${type === 'image' ? '🖼️ Pratinjau Foto' : '🎥 Pratinjau Video'}
      <span style="margin-left:8px;opacity:0.6">${fmtSize(file.size)}</span>
    </div>
    ${media}
    <input type="text" id="media-caption" class="caption-input"
      placeholder="Tambahkan keterangan… (opsional)"
      style="max-width:85vw" maxlength="300" />
    <div class="media-preview-actions">
      <button id="cancel-media-btn" class="btn-secondary" style="width:auto;padding:10px 22px;margin:0;border-color:rgba(255,255,255,0.3);color:white">
        Batal
      </button>
      <button id="send-media-btn" class="btn-primary" style="width:auto;padding:10px 22px;margin:0">
        ✈️ Kirim
      </button>
    </div>
  `;

  document.body.appendChild(modal);

  document.getElementById('cancel-media-btn').addEventListener('click', () => {
    URL.revokeObjectURL(url);
    modal.remove();
  });

  document.getElementById('send-media-btn').addEventListener('click', async () => {
    const caption = document.getElementById('media-caption')?.value.trim() || '';
    URL.revokeObjectURL(url);
    modal.remove();
    await uploadAndSend(file, type, caption);
  });
}

/* uploadAndSend sudah didefinisikan di atas dengan parameter caption */

/* ════════════════════════════════════════
   FORGOT PASSWORD
════════════════════════════════════════ */
window.forgotPassword = async function() {
  const email = prompt('Masukkan email akun kamu:');
  if (!email) return;
  try {
    const { sendPasswordResetEmail } = await import(
      "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js"
    );
    await sendPasswordResetEmail(auth, email.trim());
    showToast('Email reset password dikirim! Cek inbox kamu.', 'success');
  } catch (err) {
    showToast('Gagal kirim email: ' + authErrMsg(err.code), 'error');
  }
};

/* ════════════════════════════════════════
   SCROLL TO BOTTOM FAB
   Appears when user scrolls up
════════════════════════════════════════ */
(function setupScrollFab() {
  document.addEventListener('DOMContentLoaded', () => {
    const container = el('messages-container');
    if (!container) return;

    let fab = null;
    container.addEventListener('scroll', () => {
      const threshold = 200;
      const atBottom  = container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
      if (!atBottom && !fab) {
        fab = document.createElement('button');
        fab.className   = 'new-msg-fab';
        fab.innerHTML   = '↓ Pesan terbaru';
        fab.onclick     = () => { scrollBottom(); fab?.remove(); fab = null; };
        container.parentElement.style.position = 'relative';
        container.parentElement.appendChild(fab);
      } else if (atBottom && fab) {
        fab.remove();
        fab = null;
      }
    });
  });
})();

/* ════════════════════════════════════════
   KEYBOARD SHORTCUT
   Ctrl+K → focus search
   Escape → close modals / menus
════════════════════════════════════════ */
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    el('search-contacts')?.focus();
  }
  if (e.key === 'Escape') {
    closeContextMenu();
    closeQuickReactions();
    el('attach-menu')?.classList.add('hidden');
    el('emoji-picker')?.classList.add('hidden');
    el('chat-dropdown')?.classList.add('hidden');
    document.getElementById('media-preview-modal')?.remove();
    // Close open modals
    document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
    el('lightbox')?.classList.add('hidden');
  }
});
