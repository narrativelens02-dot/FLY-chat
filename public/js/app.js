/**
 * FLYchat — Frontend App (Neon Postgres + Vercel Serverless)
 * Real-time via polling — works on Vercel without Socket.io
 */
'use strict';

/* ════════════════════════════════════════
   CONFIG
════════════════════════════════════════ */
const API = window.__FLYCHAT_API__ || '';

/* ════════════════════════════════════════
   STATE
════════════════════════════════════════ */
let currentUser    = null;
let currentChatId  = null;
let currentPartner = null;
let currentGroupId = null;
let currentGroup   = null;
let replyingTo     = null;
let contextMsgId   = null;
let contextMsgData = null;
let typingTimer    = null;
let notifEnabled   = false;
let allChats       = [];
let allGroups      = [];

// Polling intervals (menggantikan Socket.io)
let pollMessages  = null;   // poll pesan baru setiap 2 detik
let pollChats     = null;   // poll daftar chat setiap 5 detik
let pollGroups    = null;   // poll daftar grup setiap 6 detik
let lastMsgTime   = null;   // timestamp pesan terakhir untuk incremental poll
let lastDeletedTime = null; // timestamp penghapusan terakhir
let isTyping      = false;
let lastTypingSent = 0;
let typingHideTimer = null;

/* ════════════════════════════════════════
   BOOT
════════════════════════════════════════ */
window.addEventListener('DOMContentLoaded', () => {
  buildEmojiPicker();
  loadTheme();
  setupFormListeners();   // ← pasang form listeners setelah DOM siap

  // Cek apakah halaman ini adalah halaman reset password
  handleResetPasswordPage();

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
    // Jangan redirect ke login jika sedang di reset-password
    if (!window.location.search.includes('token=')) {
      setTimeout(() => showScreen('login-screen'), 2000);
    }
  }
});

function setupFormListeners() {
  /* ── Unduh dokumen (mendukung file besar per potongan) ── */
  document.addEventListener('click', e => {
    const link = e.target.closest && e.target.closest('.msg-file-dl');
    if (!link) return;
    e.preventDefault();
    downloadFileChunked(link.getAttribute('href'), link.getAttribute('download') || 'file');
  });

  /* ── Register ── */
  const regForm = el('register-form');
  if (regForm) regForm.addEventListener('submit', async e => {
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
  const loginForm = el('login-form');
  if (loginForm) loginForm.addEventListener('submit', async e => {
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
  try { initSocket(); }   catch(e) { console.warn('initSocket error:', e); }
  try { startPolling(); } catch(e) { console.warn('startPolling error:', e); }
  try { loadSidebarProfile(); } catch(e) { console.warn('loadSidebarProfile error:', e); }
  try { loadChats(); }    catch(e) { console.warn('loadChats error:', e); }
  try { loadGroups(); }   catch(e) { console.warn('loadGroups error:', e); }
  try { registerServiceWorker(); } catch(e) { console.warn('registerSW error:', e); }
  showScreen('home-screen');
  // Update nav avatar
  if (currentUser?.photo_url) {
    const navAv = el('nav-user-avatar');
    if (navAv) navAv.src = currentUser.photo_url;
  }
}

/* ════════════════════════════════════════
   SOCKET.IO & REAL-TIME WEB SOCKET
════════════════════════════════════════ */
let socket = null;

function initSocket() {
  const token = localStorage.getItem('fc_token');
  if (!token || typeof io === 'undefined') return;
  if (socket && socket.connected) return;

  try {
    const socketUrl = API || window.location.origin;
    socket = io(socketUrl, {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 10
    });

    socket.on('connect', () => {
      console.log('🔌 Socket.io connected:', socket.id);
      if (currentChatId) socket.emit('chat:join', currentChatId);
      if (currentGroupId) socket.emit('group:join', currentGroupId);
    });

    socket.on('call:incoming', (data) => {
      console.log('📞 Panggilan masuk via Socket:', data);
      handleIncomingCallSignal(data);
    });

    socket.on('call:signal', (data) => {
      Promise.resolve(handleRtcSignalEvent(data)).catch(() => {});
    });

    socket.on('call:rejected', (data) => {
      if (RTC.callId && (!data.callId || data.callId === RTC.callId)) {
        endCall(false);
        showToast('Panggilan ditolak oleh partner', 'error');
      }
    });

    socket.on('call:ended', (data) => {
      if (RTC.callId && (!data.callId || data.callId === RTC.callId)) {
        endCall(false);
        showToast('Panggilan diakhiri oleh partner', 'info');
      }
    });

    /* ── DM messages ── */
    socket.on('message:new', ({ chatId, message }) => {
      let sig;
      try { sig = JSON.parse(message.content); } catch {}
      if (sig?.__rtc__) {
        if (currentChatId === chatId) Promise.resolve(processRtcSignal(message)).catch(() => {});
        return;
      }
      if (currentChatId === chatId && !currentGroupId) {
        const already = message.id && document.querySelector(`[data-msg-id="${message.id}"]`);
        appendMessage(message, false);
        bumpLastMsgTime(message.created_at);
        if (!already && message.sender_id !== currentUser?.id) {
          handleIncomingUnread(chatId);
          if (document.visibilityState !== 'visible') sendPushNotif(message.content || `[${message.type}]`);
        }
      }
      loadChats(true);
    });

    socket.on('message:deleted', ({ chatId, msgId }) => {
      if (currentChatId === chatId && !currentGroupId) markMessageDeleted(msgId);
    });

    socket.on('message:reacted', ({ chatId, msgId, reactions }) => {
      if (currentChatId === chatId && !currentGroupId) applyReactions(msgId, reactions);
    });

    socket.on('chat:cleared', ({ chatId }) => {
      if (currentChatId === chatId && !currentGroupId) el('messages-list').innerHTML = '';
      loadChats(true);
    });

    socket.on('typing:start', ({ chatId, userId: typingId, userName }) => {
      if (currentChatId === chatId && !currentGroupId && typingId !== currentUser?.id)
        showTypingIndicator(userName);
    });

    socket.on('typing:stop', ({ chatId, userId: typingId }) => {
      if (currentChatId === chatId && !currentGroupId && typingId !== currentUser?.id)
        clearTypingIndicator();
    });

    /* ── Group messages ── */
    socket.on('group:message:new', ({ groupId, message }) => {
      if (currentGroupId === groupId) {
        const already = message.id && document.querySelector(`[data-msg-id="${message.id}"]`);
        appendMessage(message, false);
        bumpLastMsgTime(message.created_at);
        if (!already && message.sender_id !== currentUser?.id) {
          handleIncomingGroupUnread(groupId);
          if (document.visibilityState !== 'visible') sendPushNotif(message.content || `[${message.type}]`);
        }
      }
      loadGroups(true);
    });

    socket.on('group:message:deleted', ({ groupId, msgId }) => {
      if (currentGroupId === groupId) markMessageDeleted(msgId);
    });

    socket.on('group:message:reacted', ({ groupId, msgId, reactions }) => {
      if (currentGroupId === groupId) applyReactions(msgId, reactions);
    });

    socket.on('group:cleared', ({ groupId }) => {
      if (currentGroupId === groupId) el('messages-list').innerHTML = '';
      loadGroups(true);
    });

    socket.on('group:typing:start', ({ groupId, userId: typingId, userName }) => {
      if (currentGroupId === groupId && typingId !== currentUser?.id)
        showTypingIndicator(userName);
    });

    socket.on('group:typing:stop', ({ groupId, userId: typingId }) => {
      if (currentGroupId === groupId && typingId !== currentUser?.id)
        clearTypingIndicator();
    });

    socket.on('group:updated', () => loadGroups(true));

    socket.on('group:deleted', ({ groupId }) => {
      if (currentGroupId === groupId) resetGroupChat();
      loadGroups(true);
    });

    socket.on('user:online', ({ userId, online }) => {
      if (currentPartner && currentPartner.id === userId) {
        const dot = el('partner-online-dot');
        const st  = el('chat-partner-status');
        if (dot) dot.className = `online-dot ${online ? '' : 'offline'}`;
        if (st) st.textContent = online ? 'Online' : 'Offline';
      }
      loadChats(true);
    });
  } catch (err) {
    console.warn('Socket init error:', err);
  }
}

/* ════════════════════════════════════════
   RINGTONE SYNTHESIZER (Web Audio API)
════════════════════════════════════════ */
let ringtoneAudioCtx = null;
let ringtoneInterval = null;

function playRingtone() {
  try {
    stopRingtone();
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    ringtoneAudioCtx = new AudioCtx();

    function beep() {
      if (!ringtoneAudioCtx || ringtoneAudioCtx.state === 'closed') return;
      if (ringtoneAudioCtx.state === 'suspended') {
        ringtoneAudioCtx.resume().catch(() => {});
      }
      const now = ringtoneAudioCtx.currentTime;
      const osc1 = ringtoneAudioCtx.createOscillator();
      const osc2 = ringtoneAudioCtx.createOscillator();
      const gain = ringtoneAudioCtx.createGain();

      osc1.type = 'sine';
      osc2.type = 'sine';
      osc1.frequency.setValueAtTime(440, now);
      osc2.frequency.setValueAtTime(480, now);

      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 1.2);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ringtoneAudioCtx.destination);

      osc1.start(now);
      osc2.start(now);
      osc1.stop(now + 1.2);
      osc2.stop(now + 1.2);
    }

    beep();
    ringtoneInterval = setInterval(beep, 2800);
  } catch (e) {
    console.warn('Ringtone error:', e);
  }
}

function stopRingtone() {
  if (ringtoneInterval) {
    clearInterval(ringtoneInterval);
    ringtoneInterval = null;
  }
  if (ringtoneAudioCtx) {
    try { ringtoneAudioCtx.close(); } catch {}
    ringtoneAudioCtx = null;
  }
}

/* ════════════════════════════════════════
   POLLING & INCOMING CALL CHECK (Fallback)
════════════════════════════════════════ */
let pollIncomingCalls = null;

function startPolling() {
  stopPolling();
  pollChats  = setInterval(() => loadChats(true), 5000);
  pollGroups = setInterval(() => loadGroups(true), 6000);
  pollIncomingCalls = setInterval(checkIncomingCallsHttp, 2500);
}

function stopPolling() {
  clearInterval(pollChats);
  clearInterval(pollGroups);
  clearInterval(pollMessages);
  clearInterval(pollIncomingCalls);
  pollChats = pollGroups = pollMessages = pollIncomingCalls = null;
}

async function checkIncomingCallsHttp() {
  if (RTC.pc || RTC.pendingOffer || !currentUser) return;
  try {
    const data = await apiGet('/api/chats/rtc/incoming');
    if (data?.incoming?.signal && !RTC.pc && !RTC.pendingOffer) {
      const inc = data.incoming;
      handleIncomingCallSignal({
        chatId:       inc.chat_id,
        senderId:     inc.sender_id,
        callId:       inc.signal.callId,
        callType:     inc.signal.callType,
        sdp:          inc.signal.sdp,
        caller:       inc.signal.caller,
        targetUserId: currentUser.id
      });
    }
  } catch {}
}

/* ════════════════════════════════════════
   ACTIVE CHAT POLLING (DM + Group)
════════════════════════════════════════ */
function bumpLastMsgTime(createdAt) {
  if (!createdAt) return;
  if (!lastMsgTime || new Date(createdAt) > new Date(lastMsgTime)) lastMsgTime = createdAt;
}

function buildPollQuery() {
  const params = new URLSearchParams();
  if (lastMsgTime)     params.set('after', lastMsgTime);
  if (lastDeletedTime) params.set('deleted_after', lastDeletedTime);
  const s = params.toString();
  return s ? `?${s}` : '';
}

function startMessagePolling() {
  clearInterval(pollMessages);
  pollMessages = setInterval(pollActiveChat, 2000);
}

function stopMessagePolling() {
  clearInterval(pollMessages);
  pollMessages = null;
}

async function pollActiveChat() {
  try {
    if (currentGroupId) {
      const data = await apiGet(`/api/groups/${currentGroupId}/messages${buildPollQuery()}`);
      applyPollData(data, true);
      return;
    }
    if (!currentChatId) return;
    const data = await apiGet(`/api/chats/${currentChatId}/messages${buildPollQuery()}`);
    applyPollData(data, false);
  } catch {}
}

function applyPollData(data, isGroup) {
  const list = el('messages-list');
  if (!list) return;

  (data.messages || []).forEach(msg => {
    // Sinyal WebRTC jangan dirender sebagai bubble
    let sig;
    try { sig = JSON.parse(msg.content); } catch {}
    if (!isGroup && sig?.__rtc__) {
      bumpLastMsgTime(msg.created_at);
      Promise.resolve(processRtcSignal(msg)).catch(() => {});
      return;
    }

    bumpLastMsgTime(msg.created_at);

    if (msg.is_deleted) { appendMessage(msg, false); return; }

    const alreadyRendered = msg.id && document.querySelector(`[data-msg-id="${msg.id}"]`);
    if (alreadyRendered) return;

    appendMessage(msg, false);
    if (msg.sender_id !== currentUser?.id) {
      if (isGroup) handleIncomingGroupUnread(msg.group_id || currentGroupId);
      else         handleIncomingUnread(msg.chat_id || currentChatId);
      if (document.visibilityState !== 'visible') {
        sendPushNotif(msg.content || `[${msg.type}]`);
      }
    }
  });

  (data.deleted || []).forEach(d => {
    markMessageDeleted(d.id);
    if (d.deleted_at && (!lastDeletedTime || new Date(d.deleted_at) > new Date(lastDeletedTime))) {
      lastDeletedTime = d.deleted_at;
    }
  });

  if (Array.isArray(data.reactions)) applyReactionRows(data.reactions);

  updateTypingFromPoll(data.typing);
}

function applyReactionRows(rows) {
  const byMsg = {};
  rows.forEach(r => {
    if (!byMsg[r.message_id]) byMsg[r.message_id] = {};
    byMsg[r.message_id][r.user_id] = r.emoji;
  });
  // Sinkronkan semua pesan yang sedang tampil — termasuk yang reaksinya habis
  document.querySelectorAll('#messages-list [data-msg-id]').forEach(w => {
    const id = w.dataset.msgId;
    applyReactions(id, byMsg[id] || {});
  });
}

/* ════════════════════════════════════════
   TYPING INDICATOR
════════════════════════════════════════ */
function showTypingIndicator(name) {
  const area = el('typing-area');
  if (!area) return;
  area.innerHTML = `<div class="typing-indicator">
    <span class="t-dot"></span><span class="t-dot"></span><span class="t-dot"></span>
    <span class="typing-text" style="padding:0 0 0 6px">${esc(name || 'Seseorang')} sedang mengetik…</span>
  </div>`;
  clearTimeout(typingHideTimer);
  typingHideTimer = setTimeout(clearTypingIndicator, 4500);
}

function clearTypingIndicator() {
  clearTimeout(typingHideTimer);
  const area = el('typing-area');
  if (area) area.innerHTML = '';
}

function updateTypingFromPoll(typing) {
  if (!Array.isArray(typing) || !typing.length) { clearTypingIndicator(); return; }
  showTypingIndicator(typing[0].name);
}

/* ════════════════════════════════════════
   SCREENS
════════════════════════════════════════ */
window.showScreen = function(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = el(id);
  if (target) target.classList.add('active');
  if (id === 'profile-screen') populateProfileForm();
};

/* ════════════════════════════════════════
   AUTH — GOOGLE (via Google Identity Services)
════════════════════════════════════════ */
window.signInWithGoogle = function() {
  const clientId = window.__GOOGLE_CLIENT_ID__;
  if (!clientId || clientId.includes('YOUR_GOOGLE_CLIENT_ID')) {
    showToast('Google Client ID belum dikonfigurasi. Isi window.__GOOGLE_CLIENT_ID__ di config.js', 'error');
    return;
  }
  // Load Google Identity script once
  if (!window.google) {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onerror = () => showToast('Gagal memuat Google SDK. Cek koneksi internet.', 'error');
    s.onload  = initGoogleAuth;
    document.head.appendChild(s);
  } else {
    initGoogleAuth();
  }
};

function initGoogleAuth() {
  if (!window.google?.accounts) { showToast('Google SDK gagal dimuat', 'error'); return; }
  const clientId = window.__GOOGLE_CLIENT_ID__;
  google.accounts.id.initialize({
    client_id:   clientId,
    callback:    handleGoogleCredential,
    auto_select: false,
    cancel_on_tap_outside: true
  });
  google.accounts.id.prompt((notification) => {
    if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
      // Fallback: tampilkan popup jika one-tap tidak muncul
      google.accounts.id.renderButton(
        document.getElementById('google-btn-container') || document.body,
        { theme: 'outline', size: 'large', text: 'signin_with', locale: 'id' }
      );
    }
  });
}

async function handleGoogleCredential(response) {
  try {
    // Kirim raw credential (ID token) ke backend untuk diverifikasi
    const data = await apiPost('/api/auth/google', { credential: response.credential });
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
  stopRingtone();
  if (RTC.pc) endCall(false);
  if (socket) {
    try { socket.disconnect(); } catch {}
    socket = null;
  }
  apiPost('/api/auth/logout').catch(() => {});
  stopPolling();
  localStorage.removeItem('fc_token');
  currentUser = currentChatId = currentPartner = currentGroupId = currentGroup = null;
  allChats = [];
  allGroups = [];
  lastMsgTime = lastDeletedTime = null;
  showScreen('login-screen');
};

/* ════════════════════════════════════════
   AUTH — FORGOT PASSWORD
════════════════════════════════════════ */
window.forgotPassword = function() {
  const modalEl  = el('forgot-password-modal');
  const emailEl  = el('forgot-modal-email');
  const errorEl  = el('forgot-modal-error');
  const successEl = el('forgot-modal-success');
  const submitBtn = el('forgot-btn-submit');
  if (!modalEl) return;

  if (emailEl)  emailEl.value = el('login-email')?.value || '';
  if (errorEl)  errorEl.classList.add('hidden');
  if (successEl) successEl.classList.add('hidden');
  if (submitBtn) {
    submitBtn.disabled = false;
    const btnText = submitBtn.querySelector('.btn-text');
    if (btnText) btnText.textContent = 'Kirim Link Reset';
    submitBtn.querySelector('.spinner')?.classList.add('hidden');
  }
  modalEl.classList.remove('hidden');
  if (emailEl) emailEl.focus();
};

window.closeForgotModal = function() {
  el('forgot-password-modal').classList.add('hidden');
};

window.submitForgotPassword = async function() {
  const emailEl   = el('forgot-modal-email');
  const errorEl   = el('forgot-modal-error');
  const successEl = el('forgot-modal-success');
  const email     = emailEl?.value.trim() || '';

  if (errorEl)   errorEl.classList.add('hidden');
  if (successEl) successEl.classList.add('hidden');

  if (!email) {
    if (errorEl) { errorEl.textContent = 'Masukkan alamat email kamu.'; errorEl.classList.remove('hidden'); }
    return;
  }

  setLoad('forgot-btn-submit', true);
  try {
    await apiPost('/api/auth/forgot-password', { email });
    if (successEl) { successEl.classList.remove('hidden'); successEl.textContent = '✅ Jika email terdaftar, link reset password telah dikirim. Cek inbox (dan folder spam) kamu.'; }
    const submitBtn = el('forgot-btn-submit');
    if (submitBtn) submitBtn.disabled = true;
  } catch (err) {
    if (errorEl) { errorEl.textContent = err.message || 'Gagal mengirim email. Coba lagi.'; errorEl.classList.remove('hidden'); }
  } finally {
    setLoad('forgot-btn-submit', false);
  }
};

/* Reset Password — halaman /reset-password?token=... */
async function handleResetPasswordPage() {
  const params = new URLSearchParams(window.location.search);
  const token  = params.get('token');
  if (!window.location.pathname.includes('reset-password') || !token) return;

  // Verifikasi token
  try {
    await apiGet(`/api/auth/reset-password?token=${token}`);
    showResetPasswordForm(token);
  } catch (err) {
    showScreen('login-screen');
    showToast('Link reset password tidak valid atau sudah kedaluwarsa.', 'error');
  }
}

function showResetPasswordForm(token) {
  // Tampilkan screen reset password
  el('reset-token-hidden').value = token;
  el('reset-pw-error').classList.add('hidden');
  showScreen('reset-password-screen');
}

window.submitResetPassword = async function() {
  const token   = el('reset-token-hidden').value;
  const pw      = el('reset-new-password').value;
  const confirm = el('reset-confirm-password').value;
  const errEl   = el('reset-pw-error');

  errEl.classList.add('hidden');
  if (pw.length < 6) { errEl.textContent = 'Password minimal 6 karakter.'; errEl.classList.remove('hidden'); return; }
  if (pw !== confirm) { errEl.textContent = 'Password tidak cocok.'; errEl.classList.remove('hidden'); return; }

  setLoad('reset-pw-btn', true);
  try {
    await apiPost('/api/auth/reset-password', { token, password: pw });
    showToast('Password berhasil diubah! Silakan login.', 'success');
    setTimeout(() => showScreen('login-screen'), 1500);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  } finally {
    setLoad('reset-pw-btn', false);
  }
};

/* ════════════════════════════════════════
   SIDEBAR PROFILE
════════════════════════════════════════ */
function loadSidebarProfile() {
  if (!currentUser) return;
  const nameEl   = el('sidebar-name');
  const statusEl = el('sidebar-status');
  const avatarEl = el('sidebar-avatar');
  const dotEl    = el('my-online-dot');
  if (nameEl)   nameEl.textContent   = currentUser.name || 'User';
  if (statusEl) statusEl.textContent = currentUser.status || '';
  if (avatarEl && currentUser.photo_url) avatarEl.src = currentUser.photo_url;
  if (dotEl)    dotEl.className = 'online-dot';
  // Update nav avatar juga
  const navAv = el('nav-user-avatar');
  if (navAv && currentUser.photo_url) navAv.src = currentUser.photo_url;
}

/* ════════════════════════════════════════
   CHAT LIST
════════════════════════════════════════ */
async function loadChats(silent = false) {
  try {
    const data = await apiGet('/api/chats');
    allChats = data.chats || [];
    renderChatList(allChats);
    const q = el('search-contacts')?.value;
    if (q) handleUniversalSearch(q);
  } catch (err) {
    if (!silent) console.error('loadChats error:', err);
  }
}

function renderChatList(chats) {
  const list = el('chat-list');
  if (!list) return; // belum di home-screen
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
  const meta = item.querySelector('.chat-item-meta');
  if (!meta) return;
  let badge = item.querySelector('.unread-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'unread-badge';
    meta.appendChild(badge);
  }
  badge.textContent = (parseInt(badge.textContent) || 0) + 1;
}

function handleIncomingUnread(chatId) {
  if (!chatId) return;
  if (currentChatId === chatId && !currentGroupId && document.visibilityState === 'visible') {
    // Sedang membuka chat ini → langsung tandai terbaca
    apiPatch(`/api/chats/${chatId}/read`).catch(() => {});
    document.querySelector(`.chat-item[data-chat-id="${chatId}"] .unread-badge`)?.remove();
    return;
  }
  incrementUnread(chatId);
}

function incrementGroupUnread(groupId) {
  const item = document.querySelector(`.group-item[data-group-id="${groupId}"]`);
  if (!item) return;
  const meta = item.querySelector('.chat-item-meta');
  if (!meta) return;
  let badge = item.querySelector('.unread-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'unread-badge';
    meta.appendChild(badge);
  }
  badge.textContent = (parseInt(badge.textContent) || 0) + 1;
}

function handleIncomingGroupUnread(groupId) {
  if (!groupId) return;
  if (currentGroupId === groupId && document.visibilityState === 'visible') {
    apiPost(`/api/groups/${groupId}/read`).catch(() => {});
    document.querySelector(`.group-item[data-group-id="${groupId}"] .unread-badge`)?.remove();
    return;
  }
  incrementGroupUnread(groupId);
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
  stopMessagePolling();

  currentChatId  = chatId;
  currentPartner = partner;
  currentGroupId = null;
  currentGroup   = null;
  replyingTo     = null;
  lastMsgTime    = null;
  lastDeletedTime = null;
  clearTypingIndicator();
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

  // Header DM: tampilkan status + tombol panggilan
  const pNameEl   = el('chat-partner-name');
  const pAvatarEl = el('chat-partner-avatar');
  if (pNameEl)   pNameEl.textContent = partner.name || 'User';
  if (pAvatarEl) pAvatarEl.src       = partner.photo_url || 'assets/default-avatar.svg';
  const dotEl = el('partner-online-dot');
  if (dotEl) dotEl.style.display = '';
  const voiceBtn = el('voice-call-btn');
  const videoBtn = el('video-call-btn');
  if (voiceBtn) voiceBtn.style.display = '';
  if (videoBtn) videoBtn.style.display = '';
  updatePartnerStatus(partner);

  // Load messages
  await loadMessages(chatId);
  startMessagePolling();
  if (socket && socket.connected) {
    socket.emit('chat:join', chatId);
  }
}

function updatePartnerStatus(p) {
  const online = p.online && p.show_online !== false;
  const statusEl = el('chat-partner-status');
  const dotEl    = el('partner-online-dot');
  if (online) {
    if (statusEl) { statusEl.textContent = 'Online'; statusEl.className = 'status-text online'; }
    if (dotEl)    dotEl.className = 'online-dot';
  } else {
    const ls = p.last_seen ? fmtTimeRelative(new Date(p.last_seen)) : '';
    if (statusEl) { statusEl.textContent = ls ? `Terakhir ${ls}` : 'Offline'; statusEl.className = 'status-text'; }
    if (dotEl)    dotEl.className = 'online-dot offline';
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
  const isGroup = !!currentGroupId;
  try {
    const url = isGroup
      ? `/api/groups/${currentGroupId}/messages?limit=100`
      : `/api/chats/${chatId}/messages?limit=100`;
    const data = await apiGet(url);
    const msgs = data.messages || [];
    msgs.forEach(msg => {
      // Jangan tampilkan sinyal WebRTC sebagai chat bubble
      let sig; try { sig = JSON.parse(msg.content); } catch {}
      if (!isGroup && sig?.__rtc__) return;

      if (msg.created_at) ensureDateSeparator(new Date(msg.created_at));
      list.appendChild(buildMsgBubble(msg));
    });
    lastMsgTime     = msgs.length ? msgs[msgs.length - 1].created_at : null;
    lastDeletedTime = null;
    clearTypingIndicator();
    scrollBottom(true);
  } catch (err) {
    list.innerHTML = '<div class="empty-list-msg">Gagal memuat pesan</div>';
  }
}

function ensureDateSeparator(date) {
  const list = el('messages-list');
  if (!list || !date) return;
  const label = fmtDate(date);
  const seps  = list.querySelectorAll('.date-separator span');
  const last  = seps.length ? seps[seps.length - 1].textContent : null;
  if (last === label) return;
  const sep = document.createElement('div');
  sep.className = 'date-separator';
  sep.innerHTML = `<span>${label}</span>`;
  list.appendChild(sep);
}

function appendMessage(msg, forceScroll = false) {
  const list = el('messages-list');
  if (!list) return;

  // Cek apakah pesan sudah pernah dirender di UI
  if (msg?.id && document.querySelector(`[data-msg-id="${msg.id}"]`)) return;

  if (msg?.created_at) ensureDateSeparator(new Date(msg.created_at));
  list.appendChild(buildMsgBubble(msg));
  scrollBottom(forceScroll);
}

function buildMsgBubble(msg) {
  const isOut  = msg.sender_id === currentUser?.id;
  const isGroup = !!currentGroupId;
  const wrapper = document.createElement('div');
  wrapper.className = `msg-wrapper ${isOut ? 'outgoing' : 'incoming'}`;
  wrapper.dataset.msgId = msg.id;

  if (!isOut) {
    const av = document.createElement('img');
    av.src = msg.sender_photo || currentPartner?.photo_url || 'assets/default-avatar.svg';
    av.className = 'avatar-sm';
    wrapper.appendChild(av);
  }

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  // Nama pengirim (hanya untuk pesan masuk di grup)
  if (isGroup && !isOut) {
    const senderEl = document.createElement('div');
    senderEl.className = 'msg-sender-name';
    senderEl.textContent = msg.sender_name || 'Anggota';
    bubble.appendChild(senderEl);
  }

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

function applyReactions(msgId, reactions) {
  const wrapper = document.querySelector(`[data-msg-id="${msgId}"]`);
  if (!wrapper) return;
  const bubble = wrapper.querySelector('.msg-bubble');
  if (!bubble) return;

  bubble.querySelector('.msg-reactions')?.remove();
  if (reactions && Object.keys(reactions).length) {
    bubble.appendChild(buildReactionPills(msgId, reactions));
  }
}

function markMessageDeleted(msgId) {
  const wrapper = document.querySelector(`[data-msg-id="${msgId}"]`);
  if (!wrapper) return;
  const bubble = wrapper.querySelector('.msg-bubble');
  if (bubble) bubble.innerHTML = '<em class="msg-deleted">Pesan telah dihapus</em>';
}

/* Unduh file besar per potongan (server membatasi ukuran tiap respons) */
window.downloadFileChunked = async function(url, name) {
  const t = showPersistentToast('Mengunduh…');
  try {
    const head = await fetch(url, { method: 'HEAD' });
    if (!head.ok) throw new Error('HTTP ' + head.status);
    const total = Number(head.headers.get('X-File-Size')) || 0;

    // Bukan file database (Cloudinary/disk) → unduh langsung
    if (!total) {
      hideToast(t);
      window.open(url, '_blank', 'noopener');
      return;
    }

    const CH = 2 * 1024 * 1024;
    const parts = [];
    for (let start = 0; start < total; start += CH) {
      const end = Math.min(total - 1, start + CH - 1);
      const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
      if (!res.ok && res.status !== 206) throw new Error('HTTP ' + res.status);
      parts.push(await res.arrayBuffer());
      t.textContent = `Mengunduh ${Math.min(100, Math.round(((start + CH) / total) * 100))}%…`;
    }

    const blob = new Blob(parts);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name || 'file';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    hideToast(t);
    showToast('Unduhan dimulai', 'success');
  } catch (err) {
    hideToast(t);
    showToast('Gagal mengunduh: ' + err.message, 'error');
  }
};

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
/* Kirim pesan ke DM atau grup sesuai konteks aktif */
function currentChatTarget() {
  if (currentGroupId) return { groupId: currentGroupId };
  if (currentChatId)  return { chatId: currentChatId };
  return null;
}

async function postChatMessage(payload, previewText, target = currentChatTarget()) {
  if (!target) throw new Error('Pilih percakapan dulu');
  if (target.groupId) {
    const data = await apiPost(`/api/groups/${target.groupId}/messages`, payload);
    appendMessage(data.message, true);
    loadGroups(true);
    return data.message;
  }
  const data = await apiPost(`/api/chats/${target.chatId}/messages`, payload);
  appendMessage(data.message, true);
  refreshChatPreview(target.chatId, previewText ?? payload.content ?? '', data.message.created_at);
  return data.message;
}

window.sendMessage = async function() {
  const input = el('message-input');
  const text  = input.value.trim();
  if ((!currentChatId && !currentGroupId) || !text) return;

  input.value = '';
  const payload = { type: 'text', content: text };
  if (replyingTo) {
    payload.reply_to_id     = replyingTo.id;
    payload.reply_to_sender = replyingTo.senderName;
    payload.reply_to_text   = replyingTo.text;
  }
  cancelReply();

  try {
    await postChatMessage(payload, text);
  } catch (err) {
    showToast('Gagal kirim pesan: ' + err.message, 'error');
  }
};

/* ════════════════════════════════════════
   TYPING
════════════════════════════════════════ */
window.handleTyping = function() {
  if (!currentChatId && !currentGroupId) return;

  const isGroup = !!currentGroupId;
  const id      = isGroup ? currentGroupId : currentChatId;
  const now     = Date.now();

  if (now - lastTypingSent > 1800) {
    lastTypingSent = now;
    apiPost(isGroup ? `/api/groups/${id}/typing` : `/api/chats/${id}/typing`, { typing: true }).catch(() => {});
    if (socket?.connected) {
      socket.emit(isGroup ? 'group:typing:start' : 'typing:start',
        isGroup ? { groupId: id } : { chatId: id });
    }
  }

  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    lastTypingSent = 0;
    apiPost(isGroup ? `/api/groups/${id}/typing` : `/api/chats/${id}/typing`, { typing: false }).catch(() => {});
    if (socket?.connected) {
      socket.emit(isGroup ? 'group:typing:stop' : 'typing:stop',
        isGroup ? { groupId: id } : { chatId: id });
    }
  }, 2200);
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
  if (!currentChatId && !currentGroupId) { showToast('Pilih percakapan dulu', 'error'); return; }
  if (type === 'image' || type === 'video') showMediaPreview(file, type);
  else await uploadAndSend(file, type);
};

/* Batas sekali kirim; file lebih besar otomatis dipecah per 2 MB */
const UPLOAD_SINGLE_MAX = 2 * 1024 * 1024;
const UPLOAD_MAX_MB = 50;
let _uploadInfoPromise = null;

function getUploadInfo() {
  if (!_uploadInfoPromise) {
    _uploadInfoPromise = apiGet('/api/upload/info').catch(() => ({
      singleMax: UPLOAD_SINGLE_MAX,
      chunkSize: UPLOAD_SINGLE_MAX
    }));
  }
  return _uploadInfoPromise;
}

/* Kompres gambar di browser supaya cepat & hemat kuota */
async function compressImageForUpload(file, maxDim = 1600, targetBytes = 1.6 * 1024 * 1024) {
  if (!file.type || !file.type.startsWith('image/')) return file;
  if (file.type === 'image/gif' || file.type === 'image/svg+xml') return file;
  if (file.size <= Math.min(targetBytes, 640 * 1024)) return file;

  try {
    const bitmap = await createImageBitmap(file);
    let scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    let quality = 0.86;

    for (let i = 0; i < 8; i++) {
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bitmap, 0, 0, w, h);

      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (!blob) break;
      if (blob.size <= targetBytes || (w <= 320 && h <= 320)) {
        bitmap.close?.();
        const base = (file.name || 'foto').replace(/\.[^.]+$/, '');
        return new File([blob], base + '.jpg', { type: 'image/jpeg', lastModified: Date.now() });
      }
      if (i < 4) quality = Math.max(0.45, quality - 0.12);
      else scale *= 0.75;
    }
    bitmap.close?.();
  } catch { /* biarkan file asli bila browser tidak mendukung */ }
  return file;
}

/* XHR agar progres unggah tetap terlihat */
function xhrUpload(path, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = e => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `Upload gagal (HTTP ${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Koneksi terputus saat mengunggah'));
    xhr.ontimeout = () => reject(new Error('Upload timeout, coba lagi'));
    xhr.timeout = 120000;
    xhr.open('POST', `${API}${path}`);
    xhr.setRequestHeader('Authorization', `Bearer ${localStorage.getItem('fc_token')}`);
    xhr.send(formData);
  });
}

/* Unggah file: sekali kirim bila di bawah batas, chunked bila besar (video/dokumen) */
async function uploadChatFile(file, onProgress) {
  const info = await getUploadInfo();
  const singleMax = info?.singleMax || UPLOAD_SINGLE_MAX;

  if (file.size <= singleMax) {
    const fd = new FormData();
    fd.append('file', file);
    return xhrUpload('/api/upload/file', fd, onProgress);
  }

  const init = await apiPost('/api/upload/init', {
    file_name: file.name || 'file',
    mime_type: file.type || 'application/octet-stream',
    file_size: file.size,
    kind: 'chat'
  });

  const chunkSize = init.chunk_size || UPLOAD_SINGLE_MAX;
  const total = init.chunk_count || Math.ceil(file.size / chunkSize);

  for (let i = 0; i < total; i++) {
    const part = file.slice(i * chunkSize, Math.min(file.size, (i + 1) * chunkSize));
    const fd = new FormData();
    fd.append('upload_id', init.upload_id);
    fd.append('index', String(i));
    fd.append('chunk', part, 'chunk');
    await xhrUpload('/api/upload/chunk', fd, null);
    if (onProgress) onProgress((i + 1) / total);
  }

  return apiPost('/api/upload/complete', { upload_id: init.upload_id });
}

async function uploadAndSend(file, type, caption = '') {
  const target = currentChatTarget();
  if (!target) { showToast('Pilih percakapan dulu', 'error'); return; }
  if (file.size > UPLOAD_MAX_MB * 1024 * 1024) {
    showToast(`File terlalu besar (maks ${UPLOAD_MAX_MB}MB)`, 'error');
    return;
  }

  const toastEl = showPersistentToast('Menyiapkan file…');
  try {
    const prepared = type === 'image' ? await compressImageForUpload(file) : file;

    toastEl.textContent = 'Mengunggah 0%…';
    const uploadResult = await uploadChatFile(prepared, pct => {
      toastEl.textContent = `Mengunggah ${Math.min(100, Math.round(pct * 100))}%…`;
    });

    const msgPayload = {
      type,
      content:   caption || `[${type === 'image' ? '📷 Foto' : type === 'video' ? '🎥 Video' : '📄 ' + (prepared.name || file.name)}]`,
      file_url:  uploadResult.fileURL,
      file_name: uploadResult.fileName || prepared.name || file.name,
      file_size: uploadResult.fileSize,
      caption
    };
    if (replyingTo) {
      msgPayload.reply_to_id     = replyingTo.id;
      msgPayload.reply_to_sender = replyingTo.senderName;
      msgPayload.reply_to_text   = replyingTo.text;
    }
    cancelReply();

    await postChatMessage(msgPayload, msgPayload.content, target);
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
function getCurrentPositionWithFallback() {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      resolve,
      err => {
        // Jika ditolak user (code 1), jangan retry
        if (err.code === 1) return reject(err);
        // Fallback ke akurasi standar (Wi-Fi / seluler) jika GPS lambat/tidak tersedia
        navigator.geolocation.getCurrentPosition(
          resolve,
          reject,
          { timeout: 15000, enableHighAccuracy: false, maximumAge: 300000 }
        );
      },
      { timeout: 10000, enableHighAccuracy: true, maximumAge: 60000 }
    );
  });
}

window.shareLocation = async function() {
  el('attach-menu')?.classList.add('hidden');
  if (!currentChatId && !currentGroupId) { showToast('Pilih percakapan dulu', 'error'); return; }
  if (!navigator.geolocation) { showToast('Perangkat ini tidak mendukung geolokasi', 'error'); return; }
  if (!window.isSecureContext) {
    showToast('Lokasi hanya bisa dibagikan lewat HTTPS (bukan http://IP-lokal)', 'error');
    return;
  }

  const target = currentChatTarget();
  const t = showPersistentToast('📍 Mendapatkan lokasi...');

  try {
    const pos = await getCurrentPositionWithFallback();
    const { latitude: lat, longitude: lng } = pos.coords;
    let locationName = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

    // Reverse geocoding boleh gagal — lokasi tetap dikirim dengan koordinat
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=id`,
        { signal: ctrl.signal }
      );
      clearTimeout(timer);
      const data = await res.json();
      if (data.display_name) locationName = data.display_name.split(',').slice(0, 3).join(', ');
    } catch { /* pakai koordinat saja */ }

    if (t) t.textContent = '📍 Mengirim lokasi...';
    const payload = {
      type: 'location',
      content: `📍 ${locationName}`,
      lat, lng,
      location_name: locationName
    };
    if (replyingTo) {
      payload.reply_to_id = replyingTo.id;
      payload.reply_to_sender = replyingTo.senderName;
      payload.reply_to_text = replyingTo.text;
    }
    cancelReply();

    await postChatMessage(payload, `📍 ${locationName}`, target);
    hideToast(t);
    showToast('Lokasi dibagikan!', 'success');
  } catch (err) {
    hideToast(t);
    let msg;
    if (err.code === 1)      msg = 'Izin lokasi ditolak. Aktifkan izin lokasi untuk situs ini di pengaturan browser.';
    else if (err.code === 2) msg = 'Lokasi tidak tersedia. Pastikan GPS/lokasi perangkat aktif.';
    else if (err.code === 3) msg = 'Gagal mendapatkan lokasi (timeout). Coba lagi.';
    else                     msg = 'Gagal mengirim lokasi: ' + (err.message || 'Unknown error');
    showToast(msg, 'error');
  }
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
    : (msg.sender_name || currentPartner?.name || 'Pengguna');
  const text = msg.content || (msg.type !== 'text' ? `[${msg.type}]` : '');
  replyingTo = { id: msg.id, senderName, text };
  const rpName = el('reply-preview-name');
  const rpText = el('reply-preview-text');
  const rpEl   = el('reply-preview');
  if (rpName) rpName.textContent = senderName;
  if (rpText) rpText.textContent = truncate(text, 80);
  if (rpEl)   rpEl.classList.remove('hidden');
  el('message-input')?.focus();
};
window.cancelReply = function() { replyingTo = null; el('reply-preview').classList.add('hidden'); };

window.copyMsg = function() {
  closeContextMenu();
  navigator.clipboard?.writeText(contextMsgData?.content || '').then(() => showToast('Pesan disalin!'));
};

window.deleteMsg = async function() {
  closeContextMenu();
  const msg = contextMsgData;
  if (!msg) return;
  const isGroup = !!currentGroupId;
  if (!isGroup && !currentChatId) return;

  const isOwn   = msg.sender_id === currentUser.id;
  const isAdmin = isGroup && currentGroup?.my_role === 'admin';
  if (!isOwn && !isAdmin) { showToast('Hanya bisa hapus pesan sendiri', 'error'); return; }
  if (!confirm('Hapus pesan ini?')) return;

  try {
    const url = isGroup
      ? `/api/groups/${currentGroupId}/messages/${msg.id}`
      : `/api/chats/${currentChatId}/messages/${msg.id}`;
    await apiDelete(url);
    markMessageDeleted(msg.id);
    showToast('Pesan dihapus');
  } catch (err) {
    showToast('Gagal hapus: ' + err.message, 'error');
  }
};

async function addReaction(msgId, emoji) {
  try {
    let data;
    if (currentGroupId) {
      data = await apiPatch(`/api/groups/${currentGroupId}/messages/${msgId}/reactions`, { emoji });
    } else if (currentChatId) {
      data = await apiPatch(`/api/chats/${currentChatId}/messages/${msgId}/reactions`, { emoji });
    } else {
      return;
    }
    if (data?.reactions) applyReactions(msgId, data.reactions);
  } catch (err) {
    showToast('Gagal memberi reaksi: ' + err.message, 'error');
  }
}

window.reactToMsg = async function(emoji) {
  if (!contextMsgData) return;
  const msgId = contextMsgData.id;
  closeContextMenu();
  await addReaction(msgId, emoji);
};

/* ════════════════════════════════════════
   CONTEXT MENU
════════════════════════════════════════ */
function showContextMenu(e, msg, refEl) {
  contextMsgId = msg.id; contextMsgData = msg;
  const menu = el('msg-context-menu');
  menu.classList.remove('hidden');
  const canDelete = msg.sender_id === currentUser.id ||
    (!!currentGroupId && currentGroup?.my_role === 'admin');
  el('ctx-delete').style.display = canDelete ? '' : 'none';
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

  if (currentGroupId) {
    if (currentGroup?.my_role !== 'admin') { showToast('Hanya admin yang bisa menghapus riwayat grup', 'error'); return; }
    if (!confirm('Hapus semua riwayat pesan grup ini?')) return;
    await apiDelete(`/api/groups/${currentGroupId}/messages`);
    el('messages-list').innerHTML = '';
    showToast('Riwayat grup dihapus');
    return;
  }

  if (!currentChatId || !confirm('Hapus semua riwayat pesan?')) return;
  await apiDelete(`/api/chats/${currentChatId}/messages`);
  el('messages-list').innerHTML = '';
  showToast('Riwayat chat dihapus');
};

window.showPartnerProfile = async function() {
  el('chat-dropdown').classList.add('hidden');
  if (currentGroupId) { await openGroupDetail(currentGroupId); return; }
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
    if (el('profile-name'))   el('profile-name').value   = u.name   || '';
    if (el('profile-status')) el('profile-status').value = u.status || '';
    if (el('profile-about'))  el('profile-about').value  = u.about  || '';
    if (el('profile-phone'))  el('profile-phone').value  = u.phone  || '';
    if (el('profile-email'))  el('profile-email').value  = u.email  || '';
    if (u.photo_url && el('profile-avatar-img')) el('profile-avatar-img').src = u.photo_url;
    const sc = el('status-count');
    if (sc) sc.textContent = `${(u.status||'').length}/100`;
    const tog = el('toggle-online-status');
    if (tog) tog.checked = u.show_online !== false;
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
    const snEl = el('sidebar-name');
    const ssEl = el('sidebar-status');
    if (snEl) snEl.textContent = currentUser.name;
    if (ssEl) ssEl.textContent = data.user.status || '';
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
  input.value = '';
  if (!file || !file.type.startsWith('image/')) { showToast('Pilih file gambar', 'error'); return; }
  if (file.size > 15 * 1024 * 1024) { showToast('Gambar terlalu besar (maks 15MB)', 'error'); return; }

  const progress = el('profile-upload-progress');
  const bar      = el('avatar-progress-bar');
  progress.classList.remove('hidden');
  bar.style.width = '10%';

  try {
    // Perkecil foto profil agar cepat & selalu di bawah batas server
    const prepared = await compressImageForUpload(file, 512, 900 * 1024);
    bar.style.width = '35%';

    const formData = new FormData();
    formData.append('avatar', prepared);
    const result = await xhrUpload('/api/upload/avatar', formData, pct => {
      bar.style.width = Math.round(35 + pct * 65) + '%';
    });
    await apiPatch('/api/users/me', { photo_url: result.photoURL });
    const paEl = el('profile-avatar-img');
    const saEl = el('sidebar-avatar');
    const naEl = el('nav-user-avatar');
    if (paEl) paEl.src = result.photoURL;
    if (saEl) saEl.src = result.photoURL;
    if (naEl) naEl.src = result.photoURL;
    currentUser.photo_url = result.photoURL;
    showToast('Foto profil diperbarui! ✓', 'success');
  } catch (err) {
    showToast('Gagal: ' + err.message, 'error');
  } finally {
    setTimeout(() => { progress.classList.add('hidden'); bar.style.width = '0%'; }, 1000);
  }
};

/* ════════════════════════════════════════
   GOOGLE NOTO EMOJI PICKER
════════════════════════════════════════ */
const GOOGLE_EMOJI_CATEGORIES = [
  { id: 'wajah', icon: '😊', name: 'Wajah & Emosi', emojis: [
    '😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','😚','😙',
    '😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','🤨','😐','😑','😶','😏','😒','🙄','😬','🤥',
    '😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🤧','🥵','🥶','🥴','😵','🤯','🤠','🥳','🥸','😎',
    '🤓','🧐','😕','😟','🙁','😮','😯','😲','😳','🥺','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣',
    '😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','👿','💀','☠️','💩','🤡','👻','👽','🤖'
  ]},
  { id: 'tangan', icon: '🖐️', name: 'Gestur & Orang', emojis: [
    '👋','🤚','🖐️','✋','🖖','🫱','🫲','🫳','🫴','👌','🤌','🤏','✌️','🤞','🫰','🤟','🤘','🤙','👈','👉',
    '👆','🖕','👇','☝️','🫵','👍','👎','✊','👊','🤛','🤜','👏','🙌','🫶','👐','🤲','🤝','🙏','✍️','💅',
    '🤳','💪','🦾','🦿','🦵','🦶','👂','🦻','👃','🧠','🫀','🫁','🦷','🦴','👀','👁️','👅','👄','🫦','👶',
    '🧒','👦','👧','🧑','👱','👨','🧔','👩','🧓','👴','👵'
  ]},
  { id: 'hati', icon: '❤️', name: 'Hati & Simbol', emojis: [
    '❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','☮️',
    '✝️','☪️','🕉️','☸️','✡️','🔯','🕎','☯️','☦️','🛐','⛎','♈','♉','♊','♋','♌','♍','♎','♏','♐',
    '♑','♒','♓','🆔','⚛️','🉑','☢️','☣️','📴','📳','🈶','🈚','🈸','🈺','🈯','🉐','🈹','🈵','🈴','🈲',
    '🅰️','🅱️','🆎','🆑','🅾️','🆘','❌','⭕','🛑','⛔','📛','🚫','💯','💢','♨️','🚷','🚯','🚳','🚱','🔞',
    '📵','🚭','❗','❕','❓','❔','‼️','⁉️','🔅','🔆','〽️','⚠️','🚸','🔱','⚜️','🔰','♻️','✅','💹','❇️',
    '✳️','❎','🌐','💠','Ⓜ️','🌀','💤','🏧','🚾','♿','🅿️','🈳','🈂️','🛂','🛃','🛄','🛅','🚹','🚺','🚼'
  ]},
  { id: 'alam', icon: '🐶', name: 'Hewan & Alam', emojis: [
    '🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐻‍❄️','🐨','🐯','🦁','🐮','🐷','🐽','🐸','🐵','🙈','🙉','🙊',
    '🐒','🐔','🐧','🐦','🐤','🐣','🐥','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🪱','🐛','🦋','🐌',
    '🐞','🐜','🪰','🪲','🪳','🦟','🦗','🕷️','🕸️','🦂','🐢','🐍','🦎','🦖','🦕','🐙','🦑','🦐','🦞','🦀',
    '🐡','🐠','🐟','🐬','🐳','🐋','🦈','🦭','🐊','🐅','🐆','🦓','🦍','🦧','🦣','🐘','🦛','🦏','🐪','🐫',
    '🦒','🦘','🦬','🐃','🐂','🐄','🐎','🐖','🐏','🐑','🦙','🐐','🦌','🐕','🐩','🦮','🐕‍🦺','🐈','🐈‍⬛','🪶',
    '🌸','🌺','🌹','🌷','🌼','🌻','💐','🌾','🌿','☘️','🍀','🍁','🍂','🍃','🍄','🌱','🌴','🌲','🌳','🪵',
    '☀️','🌤️','⛅','🌥️','☁️','🌦️','🌧️','⛈️','🌩️','🌨️','❄️','☃️','⛄','🌈','⚡','🔥','💧','🌊'
  ]},
  { id: 'makanan', icon: '🍕', name: 'Makanan & Minuman', emojis: [
    '🍏','🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🍆','🥑',
    '🥦','🥬','🥒','🌶️','🫑','🌽','🥕','🫒','🧄','🧅','🥔','🍠','🥐','🥯','🍞','🥖','🥨','🧀','🥚','🍳',
    '🧈','🥞','🧇','🥓','🥩','🍗','🍖','🦴','🌭','🍔','🍟','🍕','🫓','🥪','🥙','🧆','🌮','🌯','🫔','🥗',
    '🥘','🫕','🥫','🍝','🍜','🍲','🍛','🍣','🍱','🥟','🦪','🍤','🍙','🍚','🍘','🍥','🥠','🥮','🍢','🍡',
    '🍧','🍨','🍦','🥧','🧁','🍰','🎂','🍮','🍭','🍬','🍫','🍿','🍩','🍪','🌰','🥜','🍯','🥛','🍼','🫖',
    '☕','🍵','🧃','🥤','🧋','🍶','🍺','🍻','🥂','🍷','🥃','🍸','🍹','🧉','🍾','🧊'
  ]},
  { id: 'olahraga', icon: '⚽', name: 'Aktivitas & Olahraga', emojis: [
    '⚽','🏀','🏈','⚾','🥎','🎾','🏐','🏉','🥏','🎱','🪀','🏓','🏸','🏒','🏑','🥍','🏏','🪃','🥅','⛳',
    '🪁','🏹','🎣','🤿','🥊','🥋','🎽','🛹','🛼','🛷','⛸️','🥌','🎿','⛷️','🏂','🪂','🏋️','🤼','🤸','⛹️',
    '🤺','🤾','🏌️','🏇','🧘','🏄','🏊','🤽','🚣','🧗','🚵','🚴','🏆','🥇','🥈','🥉','🏅','🎖️','🎫','🎟️',
    '🎪','🤹','🎭','🩰','🎨','🎬','🎤','🎧','🎼','🎹','🥁','🪘','🎷','🎺','🪗','🎸','🪕','🎻','🎲','♟️',
    '🎯','🎳','🎮','🎰','🧩'
  ]},
  { id: 'wisata', icon: '✈️', name: 'Wisata & Tempat', emojis: [
    '🚗','🚕','🚙','🚌','🚎','🏎️','🚓','🚑','🚒','🚐','🛻','🚚','🚛','🚜','🛴','🚲','🛵','🏍️','🛺','🚨',
    '🚔','🚍','🚘','🚖','🚡','🚠','🚟','🚃','🚋','🚞','🚝','🚄','🚅','🚈','🚂','🚆','🚇','🚊','🚉','✈️',
    '🛫','🛬','🛩️','💺','🛰️','🚀','🛸','🚁','🛶','⛵','🚤','🛥️','🛳️','⛴️','🚢','⚓','🛟','🚧','⛽','🚏',
    '🚦','🚥','🗺️','🗿','🗽','🗼','🏰','🏯','🏟️','🎡','🎢','🎠','⛲','🏖️','🏝️','🏜️','🌋','⛰️','🏔️','🗻',
    '🏕️','⛺','🛖','🏠','🏡','🏘️','🏚️','🏗️','🏭','🏢','🏬','🏣','🏤','🏥','🏦','🏨','🏪','🏫','🏩','💒',
    '🏛️','⛪','🕌','🛕','🕍','⛩️','🕋'
  ]},
  { id: 'objek', icon: '💡', name: 'Objek & Teknologi', emojis: [
    '📱','📲','☎️','📞','📟','📠','🔋','🪫','🔌','💻','🖥️','🖨️','⌨️','🖱️','💾','💿','📀','🧮','🎥','🎞️',
    '📽️','📺','📷','📸','📹','📼','🔍','🔎','🕯️','💡','🔦','🏮','🪔','📔','📕','📖','📗','📘','📙','📚',
    '📓','📒','📃','📜','📄','📰','🗞️','📑','🔖','🏷️','💰','🪙','💴','💵','💶','💷','💸','💳','🧾','✉️',
    '📧','📨','📩','📤','📥','📦','📫','📪','📬','📭','📮','🗳️','✏️','✒️','🖋️','🖊️','🖌️','🖍️','📝','💼',
    '📁','📂','🗂️','📅','📆','🗒️','🗓️','📇','📈','📉','📊','📋','📌','📍','📎','🖇️','📏','📐','✂️','🗃️',
    '🗄️','🗑️','🔒','🔓','🔏','🔐','🔑','🗝️','🔨','🪓','⛏️','⚒️','🛠️','🗡️','⚔️','💣','🛡️','🪚','🔧','🪛',
    '🔩','⚙️','🗜️','⚖️','🦯','🔗','⛓️','🧰','🧲','🪜','⚗️','🧪','🧫','🧬','🔬','🔭','📡','💉','🩸','💊',
    '🩹','🩺','🚪','🪞','🪟','🛏️','🛋️','🪑','🚿','🛁','🧼','🫧','🪥','🧽','🛒','🎁','🎈','🎉','🎊','🪩'
  ]},
  { id: 'bendera', icon: '🚩', name: 'Bendera', emojis: [
    '🇮🇩','🇲🇾','🇸🇬','🇧🇳','🇵🇭','🇹🇭','🇻🇳','🇲🇲','🇰🇭','🇱🇦','🇯🇵','🇰🇷','🇨🇳','🇮🇳','🇸🇦','🇵🇸','🇹🇷','🇦🇪','🇺🇸','🇬🇧',
    '🇦🇺','🇨🇦','🇩🇪','🇫🇷','🇮🇹','🇪🇸','🇧🇷','🇦🇷','🏁','🚩','🎌','🏴','🏳️','🏳️‍🌈','🏳️‍⚧️','🏴‍☠️'
  ]}
];

function buildEmojiPicker() {
  const picker = el('emoji-picker');
  if (!picker) return;
  picker.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'emoji-picker-header';
  header.innerHTML = `
    <div class="emoji-picker-title">
      <span>✨ Google Noto Emojis</span>
    </div>
  `;
  picker.appendChild(header);

  const searchBox = document.createElement('div');
  searchBox.className = 'emoji-search-box';
  const searchInp = document.createElement('input');
  searchInp.type = 'text';
  searchInp.className = 'emoji-search-input';
  searchInp.placeholder = 'Cari emoji Google...';
  searchBox.appendChild(searchInp);
  picker.appendChild(searchBox);

  const tabs = document.createElement('div');
  tabs.className = 'emoji-tabs';
  GOOGLE_EMOJI_CATEGORIES.forEach((cat, idx) => {
    const tabBtn = document.createElement('button');
    tabBtn.type = 'button';
    tabBtn.className = `emoji-tab-btn ${idx === 0 ? 'active' : ''}`;
    tabBtn.title = cat.name;
    tabBtn.textContent = cat.icon;
    tabBtn.dataset.catId = cat.id;
    tabBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      tabs.querySelectorAll('.emoji-tab-btn').forEach(b => b.classList.remove('active'));
      tabBtn.classList.add('active');
      const targetSec = scrollArea.querySelector(`[data-section="${cat.id}"]`);
      if (targetSec) {
        targetSec.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
    tabs.appendChild(tabBtn);
  });
  picker.appendChild(tabs);

  const scrollArea = document.createElement('div');
  scrollArea.className = 'emoji-scroll-area';

  function renderCategorySections(filter = '') {
    scrollArea.innerHTML = '';
    const q = filter.trim().toLowerCase();
    let hasResults = false;

    GOOGLE_EMOJI_CATEGORIES.forEach(cat => {
      let filteredEmojis = cat.emojis;
      if (q) {
        if (cat.name.toLowerCase().includes(q)) {
          filteredEmojis = cat.emojis;
        } else {
          filteredEmojis = cat.emojis.filter(e => e.includes(q));
        }
      }
      if (filteredEmojis.length === 0) return;
      hasResults = true;

      const sec = document.createElement('div');
      sec.dataset.section = cat.id;
      const title = document.createElement('div');
      title.className = 'emoji-cat-title';
      title.textContent = `${cat.icon} ${cat.name}`;
      sec.appendChild(title);

      const grid = document.createElement('div');
      grid.className = 'emoji-grid';
      filteredEmojis.forEach(emoji => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'emoji-btn-item';
        btn.textContent = emoji;
        btn.title = emoji;
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          insertEmojiToInput(emoji);
        });
        grid.appendChild(btn);
      });
      sec.appendChild(grid);
      scrollArea.appendChild(sec);
    });

    if (!hasResults) {
      scrollArea.innerHTML = '<div style="text-align:center;padding:24px 0;font-size:0.85rem;color:var(--text-m)">Emoji tidak ditemukan</div>';
    }
  }

  searchInp.addEventListener('input', () => {
    renderCategorySections(searchInp.value);
  });

  renderCategorySections();
  picker.appendChild(scrollArea);
}

function insertEmojiToInput(emoji) {
  const inp = el('message-input');
  if (!inp) return;
  const pos = inp.selectionStart ?? inp.value.length;
  inp.value = inp.value.slice(0, pos) + emoji + inp.value.slice(pos);
  inp.focus();
  const nextPos = pos + emoji.length;
  inp.setSelectionRange(nextPos, nextPos);
}

window.toggleEmojiPicker = function() {
  const p = el('emoji-picker');
  p.classList.toggle('hidden');
  el('attach-menu').classList.add('hidden');
  if (!p.classList.contains('hidden')) {
    const searchInp = p.querySelector('.emoji-search-input');
    if (searchInp) searchInp.focus();
  }
};

/* ════════════════════════════════════════
   DARK MODE
════════════════════════════════════════ */
window.toggleTheme = function() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  document.documentElement.setAttribute('data-theme', isDark ? 'light' : 'dark');
  const btn = el('theme-btn');
  if (btn) btn.textContent = isDark ? '🌙' : '☀️';
  localStorage.setItem('fc-theme', isDark ? 'light' : 'dark');
};
function loadTheme() {
  const t = localStorage.getItem('fc-theme');
  if (t) document.documentElement.setAttribute('data-theme', t);
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
  const title = currentGroup
    ? `FLYchat — ${currentGroup.name}`
    : `FLYchat — ${currentPartner?.name || 'Pesan baru'}`;
  new Notification(title, {
    body: text.substring(0,100), icon: 'assets/icon.svg'
  });
}

/* ════════════════════════════════════════
   MOBILE / MISC
════════════════════════════════════════ */
window.closeChatMobile = function() { el('chat-area').classList.remove('active'); };

/* ════════════════════════════════════════
   VOICE / VIDEO CALL — WebRTC P2P
   Kompatibel dengan WebSocket (Socket.io)
   dan REST polling fallback (Vercel).
════════════════════════════════════════ */
const RTC = {
  pc:                 null,   // RTCPeerConnection
  localStream:        null,   // MediaStream lokal
  callType:           null,   // 'voice' | 'video'
  isInitiator:        false,
  partnerId:          null,
  caller:             null,
  partner:            null,
  chatId:             null,
  pollTimer:          null,
  callId:             null,
  seenCallIds:        new Set(),
  pendingOffer:       null,
  iceCandidatesQueue: [],
  _callTimer:         null
};

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    {
      urls:       'turn:openrelay.metered.ca:80',
      username:   'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls:       'turn:openrelay.metered.ca:443',
      username:   'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls:       'turn:openrelay.metered.ca:443?transport=tcp',
      username:   'openrelayproject',
      credential: 'openrelayproject'
    }
  ]
};

window.startVoiceCall = async function() { await initiateCall('voice'); };
window.startVideoCall = async function() { await initiateCall('video'); };

async function initiateCall(type) {
  if (currentGroupId) {
    showToast('Panggilan grup belum didukung', 'info');
    return;
  }
  if (!currentPartner || !currentChatId) {
    showToast('Pilih kontak atau buka chat terlebih dahulu', 'error');
    return;
  }
  if (RTC.pc) { showToast('Sudah ada panggilan aktif', 'error'); return; }

  RTC.callType           = type;
  RTC.isInitiator        = true;
  RTC.partnerId          = currentPartner.id;
  RTC.partner            = currentPartner;
  RTC.caller             = currentUser;
  RTC.chatId             = currentChatId;
  RTC.callId             = `${currentUser.id}_${Date.now()}`;
  RTC.iceCandidatesQueue = [];

  try {
    const constraints = {
      audio: true,
      video: type === 'video' ? { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' } : false
    };
    RTC.localStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    showToast(`Gagal akses ${type === 'video' ? 'kamera/mikrofon' : 'mikrofon'}: ${err.message}`, 'error');
    return;
  }

  showCallUI(type, 'outgoing');
  setupPeerConnection();

  try {
    const offer = await RTC.pc.createOffer();
    await RTC.pc.setLocalDescription(offer);

    const callPayload = {
      __rtc__:      true,
      action:       'offer',
      callId:       RTC.callId,
      callType:     type,
      sdp:          offer.sdp,
      targetUserId: currentPartner.id,
      chatId:       currentChatId,
      caller: {
        id:        currentUser.id,
        name:      currentUser.name,
        photo_url: currentUser.photo_url
      }
    };

    // Kirim langsung via Socket jika terhubung
    if (socket && socket.connected) {
      socket.emit('call:invite', callPayload);
    }

    // Kirim via REST signaling channel
    await apiPost(`/api/chats/${currentChatId}/messages`, {
      type:    'text',
      content: JSON.stringify(callPayload)
    });

    startSignalingPoll();
  } catch (err) {
    showToast('Gagal memulai panggilan: ' + err.message, 'error');
    endCall();
  }
}

function setupPeerConnection() {
  RTC.pc = new RTCPeerConnection(ICE_SERVERS);
  RTC.iceCandidatesQueue = [];

  // Tambahkan track lokal
  if (RTC.localStream) {
    RTC.localStream.getTracks().forEach(track => RTC.pc.addTrack(track, RTC.localStream));
  }

  // Tampilkan video lokal
  const localVideo = el('call-local-video');
  if (localVideo && RTC.localStream) {
    localVideo.srcObject = RTC.localStream;
    localVideo.play().catch(() => {});
  }

  // Terima track remote
  RTC.pc.ontrack = (event) => {
    console.log('WebRTC ontrack event:', event.streams);
    const remoteVideo = el('call-remote-video');
    const remoteAudio = el('call-remote-audio');
    const stream = event.streams[0];
    if (stream) {
      if (remoteVideo) {
        remoteVideo.srcObject = stream;
        remoteVideo.play().catch(() => {});
      }
      if (remoteAudio) {
        remoteAudio.srcObject = stream;
        remoteAudio.play().catch(() => {});
      }
    }
  };

  // Kirim ICE candidate
  RTC.pc.onicecandidate = async (event) => {
    if (!event.candidate) return;
    const cid = RTC.chatId || currentChatId;
    const tid = RTC.partnerId || currentPartner?.id;
    if (!cid) return;

    const icePayload = {
      __rtc__:      true,
      action:       'ice',
      callId:       RTC.callId,
      candidate:    event.candidate,
      targetUserId: tid,
      chatId:       cid
    };

    if (socket && socket.connected && tid) {
      socket.emit('call:signal', { targetUserId: tid, chatId: cid, callId: RTC.callId, signal: icePayload });
    }

    apiPost(`/api/chats/${cid}/messages`, {
      type:    'text',
      content: JSON.stringify(icePayload)
    }).catch(() => {});
  };

  RTC.pc.onconnectionstatechange = () => {
    const state = RTC.pc?.connectionState;
    console.log('WebRTC connection state:', state);
    if (state === 'connected') {
      const statusEl = el('call-status');
      if (statusEl) statusEl.textContent = 'Tersambung';
      startCallTimer();
    }
    if (state === 'disconnected' || state === 'failed' || state === 'closed') {
      endCall(false);
    }
  };
}

async function addOrQueueIceCandidate(candidate) {
  if (!RTC.pc || !candidate) return;
  if (RTC.pc.remoteDescription && RTC.pc.remoteDescription.type) {
    await RTC.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
  } else {
    RTC.iceCandidatesQueue.push(candidate);
  }
}

async function flushIceCandidateQueue() {
  while (RTC.iceCandidatesQueue && RTC.iceCandidatesQueue.length > 0) {
    const cand = RTC.iceCandidatesQueue.shift();
    await RTC.pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
  }
}

function handleIncomingCallSignal(data) {
  if (RTC.pc || RTC.pendingOffer) return; // sedang ada panggilan
  // Jangan dering ulang untuk tawaran yang sudah pernah diproses
  if (data.callId && RTC.seenCallIds.has(data.callId)) return;
  if (data.callId) {
    if (RTC.seenCallIds.size > 100) RTC.seenCallIds.clear();
    RTC.seenCallIds.add(data.callId);
  }
  RTC.pendingOffer = data;
  RTC.callId       = data.callId;
  RTC.callType     = data.callType || 'voice';
  RTC.chatId       = data.chatId;
  RTC.partnerId    = data.caller?.id || data.senderId;
  RTC.partner      = data.caller || currentPartner;

  playRingtone();
  showIncomingCallUI(data);
}

function showIncomingCallUI(data) {
  const modal = el('incoming-call-modal');
  if (!modal) return;
  modal.classList.remove('hidden');

  const callerName  = data.caller?.name || currentPartner?.name || 'Seseorang';
  const callerPhoto = data.caller?.photo_url || currentPartner?.photo_url || 'assets/default-avatar.svg';

  el('incoming-caller-name') && (el('incoming-caller-name').textContent = callerName);
  el('incoming-call-type')   && (el('incoming-call-type').textContent   = data.callType === 'video' ? '📹 Video Call' : '📞 Voice Call');
  el('incoming-caller-avatar') && (el('incoming-caller-avatar').src     = callerPhoto);
}

window.acceptCall = async function() {
  stopRingtone();
  if (!RTC.pendingOffer) return;
  const sig      = RTC.pendingOffer;
  const chatId   = sig.chatId || currentChatId;
  const targetId = sig.caller?.id || sig.senderId;

  try {
    const constraints = {
      audio: true,
      video: sig.callType === 'video' ? { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' } : false
    };
    RTC.localStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    showToast('Gagal akses kamera/mikrofon: ' + err.message, 'error');
    rejectCall();
    return;
  }

  el('incoming-call-modal')?.classList.add('hidden');
  showCallUI(sig.callType, 'incoming');
  setupPeerConnection();

  try {
    const offerSdp = sig.sdp || sig.signal?.sdp;
    await RTC.pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: offerSdp }));
    await flushIceCandidateQueue();

    const answer = await RTC.pc.createAnswer();
    await RTC.pc.setLocalDescription(answer);

    const answerPayload = {
      __rtc__:      true,
      action:       'answer',
      callId:       RTC.callId,
      sdp:          answer.sdp,
      targetUserId: targetId,
      chatId
    };

    if (socket && socket.connected && targetId) {
      socket.emit('call:signal', { targetUserId: targetId, chatId, callId: RTC.callId, signal: answerPayload });
    }

    await apiPost(`/api/chats/${chatId}/messages`, {
      type:    'text',
      content: JSON.stringify(answerPayload)
    });

    startSignalingPoll();
  } catch (err) {
    showToast('Gagal menyambungkan panggilan: ' + err.message, 'error');
    endCall();
  }
};

window.rejectCall = function() {
  stopRingtone();
  if (RTC.callId) RTC.seenCallIds.add(RTC.callId);
  const sig = RTC.pendingOffer;
  const cid = sig?.chatId || RTC.chatId || currentChatId;
  const tid = sig?.caller?.id || sig?.senderId || RTC.partnerId;

  if (cid) {
    const rejectPayload = { __rtc__: true, action: 'reject', callId: RTC.callId, targetUserId: tid, chatId: cid };
    if (socket && socket.connected && tid) {
      socket.emit('call:reject', { targetUserId: tid, chatId: cid, callId: RTC.callId });
    }
    apiPost(`/api/chats/${cid}/messages`, {
      type: 'text', content: JSON.stringify(rejectPayload)
    }).catch(() => {});
  }

  el('incoming-call-modal')?.classList.add('hidden');
  RTC.pendingOffer = null;
  RTC.callId = RTC.callType = RTC.partnerId = null;
};

window.endCall = function(notify = true) {
  stopRingtone();
  if (RTC.callId) RTC.seenCallIds.add(RTC.callId);
  clearInterval(RTC.pollTimer);
  clearInterval(RTC._callTimer);
  RTC.pollTimer = RTC._callTimer = null;

  const cid = RTC.chatId || currentChatId;
  const tid = RTC.partnerId || currentPartner?.id;

  if (notify && cid) {
    const endPayload = { __rtc__: true, action: 'end', callId: RTC.callId, targetUserId: tid, chatId: cid };
    if (socket && socket.connected && tid) {
      socket.emit('call:end', { targetUserId: tid, chatId: cid, callId: RTC.callId });
    }
    apiPost(`/api/chats/${cid}/messages`, {
      type: 'text', content: JSON.stringify(endPayload)
    }).catch(() => {});
  }

  if (RTC.localStream) {
    RTC.localStream.getTracks().forEach(t => t.stop());
    RTC.localStream = null;
  }
  if (RTC.pc) {
    RTC.pc.close();
    RTC.pc = null;
  }

  el('call-modal')?.classList.add('hidden');
  el('incoming-call-modal')?.classList.add('hidden');

  RTC.callId = RTC.callType = RTC.partnerId = RTC.caller = RTC.chatId = RTC.pendingOffer = null;
  RTC.isInitiator = false;
  RTC.iceCandidatesQueue = [];
};

window.toggleMic = function() {
  if (!RTC.localStream) return;
  const track = RTC.localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  el('btn-toggle-mic').textContent = track.enabled ? '🎤' : '🔇';
};

window.toggleCamera = function() {
  if (!RTC.localStream) return;
  const track = RTC.localStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  el('btn-toggle-cam').textContent = track.enabled ? '📷' : '📷🚫';
};

function showCallUI(type, direction) {
  const modal = el('call-modal');
  if (!modal) return;
  modal.classList.remove('hidden');

  const box = modal.querySelector('.call-modal-box');
  const isVideo = type === 'video';
  if (box) {
    box.classList.toggle('video-mode', isVideo);
  }

  const partnerName  = RTC.partner?.name || currentPartner?.name || 'Partner';
  const partnerPhoto = RTC.partner?.photo_url || currentPartner?.photo_url || 'assets/default-avatar.svg';

  el('call-modal-title').textContent = isVideo ? '📹 Video Call' : '📞 Voice Call';
  el('call-partner-name').textContent  = partnerName;
  el('call-status').textContent        = direction === 'outgoing' ? 'Menghubungi…' : 'Menerima…';
  el('call-timer').textContent         = '00:00';
  el('call-partner-avatar').src        = partnerPhoto;

  el('call-local-video').style.display     = isVideo ? 'block' : 'none';
  el('call-remote-video').style.display    = isVideo ? 'block' : 'none';
  el('btn-toggle-cam').style.display       = isVideo ? 'flex' : 'none';
  el('call-partner-display').style.display = isVideo ? 'none' : 'block';
}

async function handleRtcSignalEvent(data) {
  const sig = data.signal || data;
  if (!sig?.__rtc__) return false;
  if (sig.callId && RTC.callId && sig.callId !== RTC.callId) return false;

  if (sig.action === 'answer' && RTC.isInitiator && RTC.pc) {
    if (RTC.pc.signalingState !== 'have-local-offer') return true; // sudah diproses
    await RTC.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: sig.sdp }));
    await flushIceCandidateQueue();
    return true;
  }

  if (sig.action === 'ice' && RTC.pc) {
    await addOrQueueIceCandidate(sig.candidate);
    return true;
  }

  if (sig.action === 'end') {
    endCall(false);
    showToast('Partner mengakhiri panggilan', 'info');
    return true;
  }

  if (sig.action === 'reject') {
    endCall(false);
    showToast('Panggilan ditolak oleh partner', 'error');
    return true;
  }

  return false;
}

async function processRtcSignal(msg) {
  let sig;
  try { sig = JSON.parse(msg.content); } catch { return false; }
  if (!sig?.__rtc__) return false;
  if (sig.callId && RTC.callId && sig.callId !== RTC.callId) return true;

  if (sig.action === 'offer' && !RTC.isInitiator && !RTC.pc) {
    handleIncomingCallSignal({
      chatId:       msg.chat_id || currentChatId,
      senderId:     msg.sender_id,
      callId:       sig.callId,
      callType:     sig.callType,
      sdp:          sig.sdp,
      caller:       sig.caller,
      targetUserId: sig.targetUserId
    });
    return true;
  }

  return await handleRtcSignalEvent(sig);
}

function startSignalingPoll() {
  clearInterval(RTC.pollTimer);
  const cid = RTC.chatId || currentChatId;
  let lastSignalTime = new Date(Date.now() - 3000).toISOString();
  RTC.pollTimer = setInterval(async () => {
    if (!cid || !RTC.pc) { clearInterval(RTC.pollTimer); return; }
    try {
      const data = await apiGet(`/api/chats/${cid}/rtc?since=${encodeURIComponent(lastSignalTime)}`);
      for (const sigItem of (data.signals || [])) {
        if (new Date(sigItem.created_at) > new Date(lastSignalTime)) {
          lastSignalTime = sigItem.created_at;
        }
        let sig;
        try { sig = JSON.parse(sigItem.content); } catch {}
        if (sig?.__rtc__) {
          await handleRtcSignalEvent(sig);
        }
      }
    } catch {
      try {
        const qs   = `?after=${encodeURIComponent(lastSignalTime)}`;
        const data = await apiGet(`/api/chats/${cid}/messages${qs}`);
        for (const msg of (data.messages || [])) {
          if (new Date(msg.created_at) > new Date(lastSignalTime))
            lastSignalTime = msg.created_at;
          if (msg.sender_id !== currentUser.id) {
            await processRtcSignal(msg);
          }
        }
      } catch {}
    }
  }, 1000);
}

let _callSeconds = 0;
function startCallTimer() {
  _callSeconds = 0;
  clearInterval(RTC._callTimer);
  RTC._callTimer = setInterval(() => {
    _callSeconds++;
    const m = String(Math.floor(_callSeconds/60)).padStart(2,'0');
    const s = String(_callSeconds%60).padStart(2,'0');
    const el2 = el('call-timer');
    if (el2) el2.textContent = `${m}:${s}`;
  }, 1000);
}

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
window.addEventListener('pagehide', () => {
  if (!currentUser) return;
  // keepalive fetch agar header Authorization tetap terkirim (sendBeacon tidak bisa set header)
  fetch(`${API}/api/users/me/presence`, {
    method: 'PATCH',
    keepalive: true,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${getToken()}`
    },
    body: JSON.stringify({ online: false })
  }).catch(() => {});
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
function scrollBottom(force = false) {
  const c = el('messages-container');
  if (!c) return;
  const isNearBottom = (c.scrollHeight - c.scrollTop - c.clientHeight) <= 140;
  if (force || isNearBottom) {
    c.scrollTop = c.scrollHeight;
  }
}

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
  if (!t) { console.warn('Toast:', msg); return null; }
  t.textContent = msg;
  t.className = `toast show ${type}`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), duration);
  return t;
}
function showPersistentToast(msg) {
  const t = el('toast');
  if (!t) { console.warn('Toast:', msg); return null; }
  t.textContent = msg;
  t.className = 'toast show';
  clearTimeout(_toastTimer);
  return t;
}
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

/* ════════════════════════════════════════
   NAVIGATION — Bottom Taskbar
════════════════════════════════════════ */
window.switchNavSection = function(section, btn) {
  // Update active button
  document.querySelectorAll('.taskbar-item').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');

  // Hide all sections
  ['section-chats', 'section-calls', 'section-groups'].forEach(id => {
    el(id)?.classList.add('hidden');
  });

  // Show target section
  if (section === 'home')   { el('section-chats')?.classList.remove('hidden'); }
  if (section === 'calls')  { el('section-calls')?.classList.remove('hidden'); loadCallLogs(); }
  if (section === 'groups') { el('section-groups')?.classList.remove('hidden'); loadGroups(); }

  // Update nav avatar
  if (currentUser?.photo_url) {
    const navAv = el('nav-user-avatar');
    if (navAv) navAv.src = currentUser.photo_url;
  }
};

window.triggerNavAddContact = function() {
  showAddContact();
};

window.triggerNavProfile = function() {
  showScreen('profile-screen');
};

/* ════════════════════════════════════════
   UNIVERSAL SEARCH
════════════════════════════════════════ */
window.handleUniversalSearch = function(q) {
  const query = q.toLowerCase().trim();
  // Cari di chat list (nama partner atau preview pesan)
  document.querySelectorAll('.chat-item').forEach(item => {
    const name    = item.querySelector('.chat-item-name')?.textContent?.toLowerCase() || '';
    const preview = item.querySelector('.chat-item-preview')?.textContent?.toLowerCase() || '';
    item.style.display = (!query || name.includes(query) || preview.includes(query)) ? '' : 'none';
  });
};

/* ════════════════════════════════════════
   CALL LOGS — Riwayat Panggilan
   Disimpan di localStorage (tidak perlu DB)
════════════════════════════════════════ */
const CALL_LOGS_KEY = 'fc_call_logs';

function saveCallLog(entry) {
  const logs = getCallLogs();
  logs.unshift(entry); // terbaru di atas
  if (logs.length > 100) logs.splice(100); // max 100 entri
  try { localStorage.setItem(CALL_LOGS_KEY, JSON.stringify(logs)); } catch {}
}

function getCallLogs() {
  try { return JSON.parse(localStorage.getItem(CALL_LOGS_KEY) || '[]'); } catch { return []; }
}

function loadCallLogs() {
  const list = el('calls-list');
  if (!list) return;
  const logs = getCallLogs();

  if (!logs.length) {
    list.innerHTML = '<div class="empty-list-msg">Belum ada riwayat panggilan</div>';
    return;
  }

  list.innerHTML = '';
  logs.forEach(log => {
    const div = document.createElement('div');
    div.className = 'chat-item call-log-item';

    const isOut     = log.direction === 'outgoing';
    const isMissed  = log.status === 'missed';
    const icon      = log.type === 'video' ? '📹' : '📞';
    const dirIcon   = isMissed ? '📵' : (isOut ? '↗' : '↙');
    const dirColor  = isMissed ? '#ef4444' : (isOut ? '#7d2535' : '#22c55e');
    const timeStr   = log.time ? fmtTime(new Date(log.time)) : '';
    const durationStr = log.duration ? fmtCallDuration(log.duration) : (isMissed ? 'Tidak terjawab' : '');

    div.innerHTML = `
      <div class="avatar-container">
        <img src="${esc(log.photo_url || 'assets/default-avatar.svg')}" alt="" class="avatar-sm"/>
      </div>
      <div class="chat-item-info">
        <div class="chat-item-name">${esc(log.name || 'Pengguna')}</div>
        <div class="chat-item-preview" style="color:${dirColor}">
          ${dirIcon} ${icon} ${durationStr}
        </div>
      </div>
      <div class="chat-item-meta">
        <span class="chat-item-time">${timeStr}</span>
      </div>
    `;

    // Klik untuk call ulang
    div.addEventListener('click', async () => {
      if (!log.partner_id) return;
      try {
        const data = await apiGet(`/api/users/${log.partner_id}`);
        const partner = data.user;
        const chatData = await apiPost('/api/chats', { partner_id: partner.id });
        await openChat(chatData.chat_id, partner);
        if (log.type === 'video') startVideoCall();
        else startVoiceCall();
      } catch (err) {
        showToast('Gagal menghubungi: ' + err.message, 'error');
      }
    });

    list.appendChild(div);
  });
}

function fmtCallDuration(seconds) {
  if (!seconds || seconds < 1) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

window.clearCallLogs = function() {
  if (!confirm('Hapus semua riwayat panggilan?')) return;
  localStorage.removeItem(CALL_LOGS_KEY);
  loadCallLogs();
  showToast('Riwayat panggilan dihapus');
};

// Hook ke endCall untuk menyimpan log
const _origEndCall = window.endCall;
window.endCall = function(notify = true) {
  // Simpan log sebelum state di-reset
  if (RTC.callId && (RTC.partnerId || RTC.partner)) {
    const duration = typeof _callSeconds !== 'undefined' ? _callSeconds : 0;
    const isConnected = RTC.pc?.connectionState === 'connected';
    saveCallLog({
      call_id:    RTC.callId,
      partner_id: RTC.partnerId || RTC.partner?.id,
      name:       RTC.partner?.name || currentPartner?.name || 'Pengguna',
      photo_url:  RTC.partner?.photo_url || currentPartner?.photo_url || '',
      type:       RTC.callType || 'voice',
      direction:  RTC.isInitiator ? 'outgoing' : 'incoming',
      status:     isConnected ? 'answered' : (RTC.isInitiator ? 'no-answer' : 'missed'),
      duration:   isConnected ? duration : 0,
      time:       new Date().toISOString()
    });
  }
  _origEndCall(notify);
};

/* ════════════════════════════════════════
   GRUP / KELOMPOK — API + Database
   Endpoint: /api/groups (server/routes/groups.js)
════════════════════════════════════════ */
function groupInitials(name) {
  return (name || 'G').trim().split(/\s+/).filter(Boolean)
    .map(w => w[0]).join('').slice(0, 2).toUpperCase() || 'G';
}

/* ── Daftar grup ── */
async function loadGroups(silent = false) {
  if (!currentUser) return;
  const list = el('groups-list');
  try {
    const data = await apiGet('/api/groups');
    allGroups = data.groups || [];
    renderGroupList(allGroups);
  } catch (err) {
    if (!silent && list) {
      list.innerHTML = '<div class="empty-list-msg">Gagal memuat grup</div>';
    }
  }
}

function renderGroupList(groups) {
  const list = el('groups-list');
  if (!list) return;
  const q = el('search-contacts')?.value?.toLowerCase().trim();
  const items = q ? groups.filter(g => (g.name || '').toLowerCase().includes(q)) : groups;

  if (!items.length) {
    list.innerHTML = `<div class="empty-list-msg">${q ? 'Grup tidak ditemukan' : 'Belum ada grup. Klik <strong>+ Buat Grup</strong> untuk memulai.'}</div>`;
    return;
  }
  list.innerHTML = '';
  items.forEach(g => list.appendChild(buildGroupItem(g)));
}

function buildGroupItem(group) {
  const div = document.createElement('div');
  div.className = 'chat-item group-item' + (group.id === currentGroupId ? ' active' : '');
  div.dataset.groupId = group.id;
  div.title = group.name || 'Grup';

  const av = document.createElement('div');
  av.className = 'avatar-container';
  if (group.photo_url) {
    av.innerHTML = `<img src="${esc(group.photo_url)}" class="avatar-md" alt=""/>`;
  } else {
    av.innerHTML = `<div class="group-avatar-circle">${esc(groupInitials(group.name))}</div>`;
  }
  div.appendChild(av);

  const info = document.createElement('div');
  info.className = 'chat-item-info';
  const preview = group.last_message
    ? truncate(group.last_message, 42)
    : `${group.member_count || (group.members || []).length} anggota`;
  info.innerHTML = `
    <div class="chat-item-name">${esc(group.name || 'Grup')}</div>
    <div class="chat-item-preview">${esc(preview)}</div>`;
  div.appendChild(info);

  const meta = document.createElement('div');
  meta.className = 'chat-item-meta';
  const time = group.last_message_at ? fmtTimeRelative(new Date(group.last_message_at)) : '';
  const timeEl = document.createElement('span');
  timeEl.className = 'chat-item-time';
  timeEl.textContent = time;
  meta.appendChild(timeEl);

  if (group.unread > 0) {
    const badge = document.createElement('span');
    badge.className = 'unread-badge';
    badge.textContent = group.unread;
    meta.appendChild(badge);
  }
  div.appendChild(meta);

  div.addEventListener('click', () => openGroupChat(group.id, group));
  return div;
}

/* ── Buka chat grup ── */
async function openGroupChat(groupId, groupData = null) {
  stopMessagePolling();

  currentChatId   = null;
  currentPartner  = null;
  currentGroupId  = groupId;
  currentGroup    = groupData || allGroups.find(g => g.id === groupId) || { id: groupId, name: 'Grup' };
  replyingTo      = null;
  lastMsgTime     = null;
  lastDeletedTime = null;

  clearTypingIndicator();
  el('reply-preview').classList.add('hidden');
  el('typing-area').innerHTML = '';

  // Tandai sudah dibaca
  apiPost(`/api/groups/${groupId}/read`).catch(() => {});
  document.querySelector(`.group-item[data-group-id="${groupId}"] .unread-badge`)?.remove();

  // Highlight sidebar
  document.querySelectorAll('.chat-item').forEach(i =>
    i.classList.toggle('active', i.dataset.groupId === groupId)
  );

  // Tampilkan panel chat
  el('empty-chat').classList.add('hidden');
  el('active-chat').classList.remove('hidden');
  el('chat-area').classList.add('active');

  // Header grup: sembunyikan status online + tombol panggilan
  const pNameEl   = el('chat-partner-name');
  const pAvatarEl = el('chat-partner-avatar');
  const statusEl  = el('chat-partner-status');
  if (pNameEl)   pNameEl.textContent = currentGroup.name || 'Grup';
  if (pAvatarEl) pAvatarEl.src = currentGroup.photo_url || 'assets/default-avatar.svg';
  if (statusEl)  statusEl.textContent = `${currentGroup.member_count || (currentGroup.members || []).length || 0} anggota`;
  const dotEl = el('partner-online-dot');
  if (dotEl) dotEl.style.display = 'none';
  const voiceBtn = el('voice-call-btn');
  const videoBtn = el('video-call-btn');
  if (voiceBtn) voiceBtn.style.display = 'none';
  if (videoBtn) videoBtn.style.display = 'none';

  await loadMessages(null);
  startMessagePolling();

  if (socket && socket.connected) socket.emit('group:join', groupId);
  loadGroups(true);
}
window.openGroupChat = openGroupChat;

/* ── Reset tampilan grup (mis. grup dihapus / dikeluarkan) ── */
function resetGroupChat() {
  if (!currentGroupId) return;
  stopMessagePolling();
  currentGroupId = null;
  currentGroup   = null;
  lastMsgTime    = null;
  lastDeletedTime = null;

  const list = el('messages-list');
  if (list) list.innerHTML = '';
  clearTypingIndicator();
  el('reply-preview').classList.add('hidden');

  el('empty-chat').classList.remove('hidden');
  el('active-chat').classList.add('hidden');
  el('chat-area').classList.remove('active');

  const nameEl   = el('chat-partner-name');
  const statusEl = el('chat-partner-status');
  const dotEl    = el('partner-online-dot');
  const voiceBtn = el('voice-call-btn');
  const videoBtn = el('video-call-btn');
  if (nameEl)   nameEl.textContent = '-';
  if (statusEl) statusEl.textContent = 'offline';
  if (dotEl)    dotEl.style.display = '';
  if (voiceBtn) voiceBtn.style.display = '';
  if (videoBtn) videoBtn.style.display = '';

  document.querySelectorAll('.chat-item').forEach(i => i.classList.remove('active'));
}

/* ── Buat grup ── */
window.openCreateGroupModal = function() {
  el('group-name-input').value = '';
  el('group-desc-input').value = '';

  const picker = el('group-contacts-picker');
  picker.innerHTML = '<div style="font-size:.82rem;color:var(--text-m);padding:4px">Memuat kontak...</div>';

  apiGet('/api/users/me/contacts').then(data => {
    const contacts = data.contacts || [];
    if (!contacts.length) {
      picker.innerHTML = '<div style="font-size:.82rem;color:var(--text-m);padding:4px">Belum ada kontak. Tambah kontak terlebih dahulu.</div>';
      return;
    }
    picker.innerHTML = '';
    contacts.forEach(u => {
      const label = document.createElement('label');
      label.className = 'group-member-pick';
      label.innerHTML = `
        <input type="checkbox" value="${esc(u.id)}" data-name="${esc(u.name)}" />
        <img src="${esc(u.photo_url || 'assets/default-avatar.svg')}" class="avatar-sm" alt="" />
        <span>${esc(u.name)}</span>
      `;
      picker.appendChild(label);
    });
  }).catch(() => {
    picker.innerHTML = '<div style="font-size:.82rem;color:var(--text-m);padding:4px">Gagal memuat kontak</div>';
  });

  el('create-group-modal').classList.remove('hidden');
  el('group-name-input').focus();
};

window.submitCreateGroup = async function() {
  const name = el('group-name-input').value.trim();
  if (!name) { showToast('Nama grup wajib diisi', 'error'); return; }

  const checkedBoxes = el('group-contacts-picker').querySelectorAll('input[type=checkbox]:checked');
  const memberIds = Array.from(checkedBoxes).map(cb => cb.value);
  if (memberIds.length < 1) { showToast('Pilih minimal 1 anggota', 'error'); return; }

  const btn = document.querySelector('#create-group-modal .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'Membuat...'; }

  try {
    const data = await apiPost('/api/groups', {
      name,
      description: el('group-desc-input').value.trim(),
      member_ids: memberIds
    });

    closeModal('create-group-modal');
    showToast(`Grup "${name}" berhasil dibuat! 🎉`, 'success');
    await loadGroups(true);

    const groupsBtn = el('nav-item-groups');
    if (groupsBtn) switchNavSection('groups', groupsBtn);

    if (data?.group?.id) openGroupChat(data.group.id, data.group);
  } catch (err) {
    showToast('Gagal membuat grup: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '✨ Buat Grup Sekarang'; }
  }
};

/* ── Detail & pengelolaan grup ── */
let groupDetailId = null;

window.openGroupDetail = async function(groupId) {
  let group = allGroups.find(g => g.id === groupId) || null;
  try {
    const data = await apiGet(`/api/groups/${groupId}`);
    group = data.group;
  } catch (err) {
    if (!group) { showToast('Gagal memuat detail grup', 'error'); return; }
  }

  groupDetailId = group.id;
  el('chat-dropdown').classList.add('hidden');
  const isAdmin = group.my_role === 'admin';
  const members = group.members || [];

  const memberList = members.map(m => {
    const isMe = m.id === currentUser?.id;
    const canRemove = isAdmin && !isMe;
    return `
      <div class="group-member-row">
        <img src="${esc(m.photo_url || 'assets/default-avatar.svg')}" class="avatar-sm" alt=""/>
        <span class="group-member-name">${esc(m.name)}${isMe ? ' (Kamu)' : ''}</span>
        <span class="group-role-badge">${m.role === 'admin' ? '👑 Admin' : 'Anggota'}</span>
        ${canRemove ? `<button class="group-remove-btn" title="Keluarkan" onclick="removeGroupMember('${esc(m.id)}','${esc(m.name)}')">✕</button>` : ''}
      </div>`;
  }).join('');

  let addSection = '';
  if (isAdmin) {
    addSection = `
      <div class="group-add-section">
        <div class="group-add-title">Tambah anggota</div>
        <div id="group-add-picker" class="group-contacts-picker">
          <div style="font-size:.8rem;color:var(--text-m);padding:4px">Memuat kontak...</div>
        </div>
        <button class="btn-primary" style="width:100%;padding:8px;margin-top:8px" onclick="addGroupMembers()">+ Tambahkan</button>
      </div>`;
  }

  const content = el('partner-profile-content');
  content.innerHTML = `
    <div style="text-align:center;padding:4px 0 14px">
      <div class="group-avatar-circle" style="width:72px;height:72px;font-size:1.6rem;margin:0 auto 10px">${esc(groupInitials(group.name))}</div>
      <div style="font-size:1.1rem;font-weight:700">${esc(group.name)}</div>
      ${group.description ? `<div style="font-size:.85rem;color:var(--text-m);margin-top:4px">${esc(group.description)}</div>` : ''}
      <div style="font-size:.8rem;color:var(--text-light);margin-top:4px">${members.length || group.member_count || 0} anggota · Dibuat ${fmtDate(new Date(group.created_at))}</div>
      ${isAdmin ? `<button class="group-edit-btn" onclick="renameGroup('${esc(group.id)}')">✏️ Ganti nama grup</button>` : ''}
    </div>
    <div class="group-member-list">${memberList}</div>
    ${addSection}
    ${isAdmin
      ? `<button class="btn-danger" style="width:100%;margin-top:12px;padding:9px" onclick="deleteGroup('${esc(group.id)}')">🗑 Hapus Grup</button>`
      : `<button class="btn-danger" style="width:100%;margin-top:12px;padding:9px" onclick="leaveGroup('${esc(group.id)}')">🚪 Keluar dari Grup</button>`}
    <button class="btn-primary" style="width:auto;padding:9px 24px;margin-top:8px" onclick="closeModal('partner-profile-modal')">Tutup</button>
  `;
  el('partner-profile-modal').classList.remove('hidden');

  // Isi picker kontak yang belum jadi anggota
  if (isAdmin) {
    const picker = el('group-add-picker');
    apiGet('/api/users/me/contacts').then(data => {
      const allContacts = data.contacts || [];
      if (!picker) return;
      if (!allContacts.length) {
        picker.innerHTML = '<div style="font-size:.8rem;color:var(--text-m);padding:4px">Belum ada kontak. Tambah kontak dulu untuk mengundang anggota.</div>';
        return;
      }
      const memberIds = new Set(members.map(m => m.id));
      const contacts = allContacts.filter(c => !memberIds.has(c.id));
      if (!contacts.length) {
        picker.innerHTML = '<div style="font-size:.8rem;color:var(--text-m);padding:4px">Semua kontak sudah menjadi anggota.</div>';
        return;
      }
      picker.innerHTML = '';
      contacts.forEach(u => {
        const label = document.createElement('label');
        label.className = 'group-member-pick';
        label.innerHTML = `
          <input type="checkbox" value="${esc(u.id)}" />
          <img src="${esc(u.photo_url || 'assets/default-avatar.svg')}" class="avatar-sm" alt="" />
          <span>${esc(u.name)}</span>
        `;
        picker.appendChild(label);
      });
    }).catch(() => {
      if (picker) picker.innerHTML = '<div style="font-size:.8rem;color:var(--text-m);padding:4px">Gagal memuat kontak</div>';
    });
  }
};

window.addGroupMembers = async function() {
  const gid = groupDetailId || currentGroupId;
  if (!gid) return;
  const picker = el('group-add-picker');
  if (!picker) return;
  const ids = Array.from(picker.querySelectorAll('input[type=checkbox]:checked')).map(cb => cb.value);
  if (!ids.length) { showToast('Pilih minimal 1 kontak', 'error'); return; }

  try {
    await apiPost(`/api/groups/${gid}/members`, { user_ids: ids });
    showToast('Anggota ditambahkan', 'success');
    await loadGroups(true);
    await openGroupDetail(gid);
  } catch (err) {
    showToast('Gagal menambah anggota: ' + err.message, 'error');
  }
};

window.removeGroupMember = async function(userId, name) {
  const gid = groupDetailId || currentGroupId;
  if (!gid) return;
  if (!confirm(`Keluarkan ${name} dari grup?`)) return;
  try {
    await apiDelete(`/api/groups/${gid}/members/${userId}`);
    showToast(`${name} dikeluarkan`, 'success');
    await loadGroups(true);
    await openGroupDetail(gid);
  } catch (err) {
    showToast('Gagal mengeluarkan anggota: ' + err.message, 'error');
  }
};

window.renameGroup = async function(groupId) {
  const current = allGroups.find(g => g.id === groupId);
  const name = prompt('Nama grup baru:', current?.name || '');
  if (!name || !name.trim()) return;
  try {
    await apiPatch(`/api/groups/${groupId}`, { name: name.trim() });
    showToast('Nama grup diperbarui', 'success');
    await loadGroups(true);
    if (currentGroupId === groupId) {
      currentGroup.name = name.trim();
      const nameEl = el('chat-partner-name');
      if (nameEl) nameEl.textContent = name.trim();
    }
    await openGroupDetail(groupId);
  } catch (err) {
    showToast('Gagal mengubah nama: ' + err.message, 'error');
  }
};

window.leaveGroup = async function(groupId) {
  if (!confirm('Keluar dari grup ini?')) return;
  try {
    await apiDelete(`/api/groups/${groupId}/members/${currentUser.id}`);
    closeModal('partner-profile-modal');
    groupDetailId = null;
    if (currentGroupId === groupId) resetGroupChat();
    showToast('Kamu keluar dari grup');
    await loadGroups(true);
  } catch (err) {
    showToast('Gagal keluar grup: ' + err.message, 'error');
  }
};

window.deleteGroup = async function(groupId) {
  if (!confirm('Hapus grup ini untuk semua anggota?')) return;
  try {
    await apiDelete(`/api/groups/${groupId}`);
    closeModal('partner-profile-modal');
    groupDetailId = null;
    if (currentGroupId === groupId) resetGroupChat();
    showToast('Grup dihapus');
    await loadGroups(true);
  } catch (err) {
    showToast('Gagal menghapus grup: ' + err.message, 'error');
  }
};
