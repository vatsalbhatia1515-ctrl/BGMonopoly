const api = {
  async call(path, method = 'GET', body) {
    const res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }
};

const state = {
  deviceId: localStorage.getItem('bgm_device_id') || crypto.randomUUID(),
  user: null,
  room: null,
  disbandNotice: null,
  image: null,
  cropZoom: 1
};
localStorage.setItem('bgm_device_id', state.deviceId);

const el = {
  me: document.getElementById('me'),
  entryCard: document.getElementById('entry-card'),
  guestBtn: document.getElementById('guest-login-btn'),
  lobbyActions: document.getElementById('lobby-actions'),
  createRoomBtn: document.getElementById('create-room-btn'),
  joinRoomBtn: document.getElementById('join-room-btn'),
  joinCodeInput: document.getElementById('join-code-input'),
  roomCard: document.getElementById('room-card'),
  roomCode: document.getElementById('room-code'),
  roomStatus: document.getElementById('room-status'),
  playerList: document.getElementById('player-list'),
  eventList: document.getElementById('event-list'),
  tradeList: document.getElementById('trade-list'),
  tradeTarget: document.getElementById('trade-target'),
  tradeOffer: document.getElementById('trade-offer'),
  sendTradeBtn: document.getElementById('send-trade-btn'),
  bankruptBtn: document.getElementById('bankrupt-btn'),
  saveSettingsBtn: document.getElementById('save-settings-btn'),
  startGameBtn: document.getElementById('start-game-btn'),
  leaveRoomBtn: document.getElementById('leave-room-btn'),
  usernameModal: document.getElementById('username-modal'),
  usernameInput: document.getElementById('username-input'),
  usernameNextBtn: document.getElementById('username-next-btn'),
  avatarModal: document.getElementById('avatar-modal'),
  avatarFile: document.getElementById('avatar-file'),
  avatarZoom: document.getElementById('avatar-zoom'),
  avatarCanvas: document.getElementById('avatar-canvas'),
  avatarNextBtn: document.getElementById('avatar-next-btn')
};

const settingsIds = ['maximumPlayers', 'startingCash', 'evenBuild', 'mortgage', 'noRentInPrison', 'auction', 'vacationCash', 'doubleRentOnSet'];

function getSettingsFromUi() {
  return {
    maximumPlayers: Number(document.getElementById('maximumPlayers').value),
    startingCash: Number(document.getElementById('startingCash').value),
    evenBuild: document.getElementById('evenBuild').checked,
    mortgage: document.getElementById('mortgage').checked,
    noRentInPrison: document.getElementById('noRentInPrison').checked,
    auction: document.getElementById('auction').checked,
    vacationCash: document.getElementById('vacationCash').checked,
    doubleRentOnSet: document.getElementById('doubleRentOnSet').checked
  };
}

function applySettingsToUi(settings = {}) {
  settingsIds.forEach((id) => {
    const node = document.getElementById(id);
    if (!node || !(id in settings)) return;
    if (node.type === 'checkbox') node.checked = !!settings[id];
    else node.value = String(settings[id]);
  });
}

function toast(msg) {
  alert(msg);
}

function render() {
  el.me.textContent = state.user?.username ? `Logged in: ${state.user.username}` : 'Not logged in';

  el.entryCard.classList.toggle('hidden', !!state.user);
  el.lobbyActions.classList.toggle('hidden', !state.user || !!state.room);
  el.roomCard.classList.toggle('hidden', !state.room);

  if (state.disbandNotice) {
    toast(`Room ${state.disbandNotice.roomCode} ended. Winner: ${state.disbandNotice.winnerName}.`);
    state.disbandNotice = null;
  }

  if (!state.room) return;

  const me = state.user;
  const room = state.room;
  const isHost = room.hostDeviceId === me.deviceId;
  el.roomCode.textContent = room.code;
  el.roomStatus.textContent = room.started ? 'Game in progress' : 'Waiting in pre-game lobby';

  applySettingsToUi(room.settings);
  settingsIds.forEach((id) => {
    document.getElementById(id).disabled = !isHost || room.started;
  });
  el.saveSettingsBtn.disabled = !isHost || room.started;
  el.startGameBtn.disabled = !isHost || room.started;
  el.bankruptBtn.disabled = !room.started;

  el.playerList.innerHTML = '';
  room.players.forEach((p) => {
    const li = document.createElement('li');
    const hostMark = p.isHost ? '👑 ' : '';
    const bankruptMark = p.isBankrupt ? '💀 BANKRUPT' : '';
    li.innerHTML = `${p.avatarDataUrl ? `<img src="${p.avatarDataUrl}" alt="${p.username}"/>` : ''}${hostMark}${p.username} ${bankruptMark}`;

    if (isHost && !room.started && !p.isHost) {
      const btn = document.createElement('button');
      btn.textContent = 'Kick';
      btn.onclick = () => kickPlayer(p.deviceId);
      li.appendChild(btn);
    }

    el.playerList.appendChild(li);
  });

  const others = room.players.filter((p) => p.deviceId !== me.deviceId);
  el.tradeTarget.innerHTML = others.map((p) => `<option value="${p.deviceId}">${p.username}</option>`).join('');

  el.tradeList.innerHTML = '';
  room.tradeRequests.forEach((t) => {
    const fromName = room.players.find((p) => p.deviceId === t.fromDeviceId)?.username || 'Unknown';
    const toName = room.players.find((p) => p.deviceId === t.toDeviceId)?.username || 'Unknown';
    const li = document.createElement('li');
    li.textContent = `${fromName} → ${toName}: ${t.offerText} [${t.status}]`;

    if (t.toDeviceId === me.deviceId && t.status === 'pending') {
      const accept = document.createElement('button');
      accept.textContent = 'Accept';
      accept.onclick = () => respondTrade(t.id, 'accept');
      const decline = document.createElement('button');
      decline.textContent = 'Decline';
      decline.onclick = () => respondTrade(t.id, 'decline');
      li.append(accept, decline);
    }

    el.tradeList.appendChild(li);
  });

  el.eventList.innerHTML = '';
  room.events.slice().reverse().forEach((evt) => {
    const li = document.createElement('li');
    li.textContent = `${new Date(evt.at).toLocaleTimeString()} - ${evt.message}`;
    el.eventList.appendChild(li);
  });
}

async function loginGuest() {
  const data = await api.call('/api/auth/session', 'POST', { deviceId: state.deviceId });
  state.user = data.user;
  state.disbandNotice = data.disbandNotice;
  if (!state.user.username) {
    el.usernameModal.showModal();
  } else {
    await syncState();
  }
  render();
}

el.guestBtn.onclick = () => loginGuest().catch((e) => toast(e.message));

el.usernameNextBtn.onclick = async () => {
  const value = el.usernameInput.value.trim();
  if (value.length < 3 || value.length > 20) return toast('Username must be 3-20 chars');
  state.pendingUsername = value;
  el.usernameModal.close();
  el.avatarModal.showModal();
};

el.avatarFile.onchange = () => {
  const file = el.avatarFile.files[0];
  if (!file) return;
  const fr = new FileReader();
  fr.onload = () => {
    const img = new Image();
    img.onload = () => {
      state.image = img;
      drawAvatarPreview();
    };
    img.src = fr.result;
  };
  fr.readAsDataURL(file);
};

el.avatarZoom.oninput = () => {
  state.cropZoom = Number(el.avatarZoom.value);
  drawAvatarPreview();
};

function drawAvatarPreview() {
  const canvas = el.avatarCanvas;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.beginPath();
  ctx.arc(canvas.width / 2, canvas.height / 2, canvas.width / 2, 0, Math.PI * 2);
  ctx.clip();

  if (state.image) {
    const img = state.image;
    const short = Math.min(img.width, img.height);
    const srcSize = short / state.cropZoom;
    const sx = (img.width - srcSize) / 2;
    const sy = (img.height - srcSize) / 2;
    ctx.drawImage(img, sx, sy, srcSize, srcSize, 0, 0, canvas.width, canvas.height);
  } else {
    ctx.fillStyle = '#1f2535';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.restore();
}

drawAvatarPreview();

el.avatarNextBtn.onclick = async () => {
  try {
    const avatarDataUrl = el.avatarCanvas.toDataURL('image/png');
    const data = await api.call('/api/profile', 'POST', {
      deviceId: state.deviceId,
      username: state.pendingUsername,
      avatarDataUrl
    });

    state.user = data.user;
    el.avatarModal.close();
    await syncState();
    render();
  } catch (error) {
    toast(error.message);
    el.usernameModal.showModal();
  }
};

el.createRoomBtn.onclick = async () => {
  const data = await api.call('/api/rooms/create', 'POST', { deviceId: state.deviceId });
  state.room = data.room;
  render();
};

el.joinRoomBtn.onclick = async () => {
  const roomCode = el.joinCodeInput.value.trim();
  const data = await api.call('/api/rooms/join', 'POST', { deviceId: state.deviceId, roomCode });
  state.room = data.room;
  render();
};

el.leaveRoomBtn.onclick = async () => {
  await api.call('/api/rooms/leave', 'POST', { deviceId: state.deviceId });
  state.room = null;
  render();
};

el.saveSettingsBtn.onclick = async () => {
  const data = await api.call('/api/rooms/settings', 'POST', {
    deviceId: state.deviceId,
    settings: getSettingsFromUi()
  });
  state.room = data.room;
  render();
};

el.startGameBtn.onclick = async () => {
  const data = await api.call('/api/rooms/start', 'POST', { deviceId: state.deviceId });
  state.room = data.room;
  render();
};

async function kickPlayer(targetDeviceId) {
  const data = await api.call('/api/rooms/kick', 'POST', { deviceId: state.deviceId, targetDeviceId });
  state.room = data.room;
  render();
}

el.bankruptBtn.onclick = async () => {
  const data = await api.call('/api/rooms/bankrupt', 'POST', { deviceId: state.deviceId });
  state.room = data.room;
  await syncState();
  render();
};

el.sendTradeBtn.onclick = async () => {
  if (!el.tradeTarget.value) return toast('No target player selected');
  const data = await api.call('/api/rooms/trade', 'POST', {
    deviceId: state.deviceId,
    targetDeviceId: el.tradeTarget.value,
    offerText: el.tradeOffer.value
  });
  state.room = data.room;
  el.tradeOffer.value = '';
  render();
};

async function respondTrade(tradeId, action) {
  const data = await api.call('/api/rooms/trade/respond', 'POST', {
    deviceId: state.deviceId,
    tradeId,
    action
  });
  state.room = data.room;
  render();
}

async function syncState() {
  if (!state.user) return;
  try {
    const data = await api.call(`/api/state?deviceId=${encodeURIComponent(state.deviceId)}`);
    state.user = data.user;
    state.room = data.room;
    state.disbandNotice = data.disbandNotice || state.disbandNotice;
  } catch (error) {
    console.error(error);
  }
}

setInterval(async () => {
  if (!state.user) return;
  await syncState();
  render();
}, 1500);

render();
