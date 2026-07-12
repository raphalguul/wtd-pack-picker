const state = {
  packs: [],
  originalStates: {},
  steamId: null,
  loaded: false
};

const $ = (sel) => document.querySelector(sel);

const loadingEl = $('#loading');
const appEl = $('#app');
const errorBanner = $('#error-banner');
const packGrid = $('#pack-grid');
const searchInput = $('#search');
const statusText = $('#status-text');
const saveIndicator = $('#save-indicator');
const profilePicker = $('#profile-picker');
const profileSelect = $('#profile-select');
const presetMenu = $('#preset-menu');
const presetList = presetMenu.querySelector('.preset-list');
const applyBtn = $('#btn-apply');
const revertBtn = $('#btn-revert');

const socket = io();

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function init() {
  try {
    const status = await api('/api/status');
    if (!status.gamePathValid) {
      showSettings(true);
    } else {
      await loadSaves(status);
    }
  } catch (e) {
    showError('Server connection failed');
  }
  loadingEl.classList.add('hidden');
}

async function loadSaves(status) {
  if (status.saves.length === 0) {
    packGrid.innerHTML = '<div class="placeholder-msg">No save files found. Launch the game at least once.</div>';
    profilePicker.classList.remove('hidden');
    appEl.classList.remove('hidden');
    return;
  }

  populateProfileSelect(status.saves);
  profilePicker.classList.remove('hidden');
  appEl.classList.remove('hidden');

  const lastId = localStorage.getItem('wtd-pack-picker-steamId');
  const selectedId = lastId || status.saves[0].steamId;
  const match = status.saves.find(s => s.steamId === selectedId);
  profileSelect.value = match ? selectedId : status.saves[0].steamId;

  await loadPacks(profileSelect.value);
}

function populateProfileSelect(saves) {
  profileSelect.innerHTML = '';
  for (const save of saves) {
    const option = document.createElement('option');
    option.value = save.steamId;
    option.textContent = `Steam ID: ${save.label}`;
    profileSelect.appendChild(option);
  }
}

async function loadPacks(steamId) {
  packGrid.innerHTML = '<div class="placeholder-msg">Loading packs...</div>';
  state.loaded = false;
  localStorage.setItem('wtd-pack-picker-steamId', steamId);

  try {
    const packs = await api(`/api/local-packs/${steamId}`);
    state.steamId = steamId;
    state.packs = packs;
    state.originalStates = {};
    for (const p of packs) {
      state.originalStates[p.id] = p.enabled;
    }

    state.loaded = true;
    renderCards();
    updateStatus();
    saveIndicator.classList.add('hidden');
  } catch (e) {
    showError('Failed to load packs: ' + e.message);
    packGrid.innerHTML = '<div class="placeholder-msg">Error loading packs. Check game path in settings.</div>';
  }
}

function togglePack(packId) {
  if (!state.loaded) return;
  const pack = state.packs.find(p => p.id === packId);
  if (!pack) return;
  pack.enabled = !pack.enabled;
  updateCardState(packId);
  updateStatus();
}

function setAll(enabled) {
  if (!state.loaded) return;
  for (const pack of state.packs) {
    pack.enabled = enabled;
  }
  renderCards();
  updateStatus();
}

function updateCardState(packId) {
  const card = packGrid.querySelector(`[data-pack-id="${CSS.escape(packId)}"]`);
  if (!card) return;
  const pack = state.packs.find(p => p.id === packId);
  card.classList.toggle('enabled', pack ? pack.enabled : false);
}

function createNoThumb() {
  const div = document.createElement('div');
  div.className = 'pack-thumb';
  div.innerHTML = '<span class="no-thumb-icon">🎬</span>';
  return div;
}

function renderCards() {
  packGrid.innerHTML = '';

  if (state.packs.length === 0) {
    packGrid.innerHTML = '<div class="placeholder-msg">No clip packs found.</div>';
    return;
  }

  const filterText = searchInput.value.toLowerCase().trim();

  for (const pack of state.packs) {
    if (filterText) {
      const nameMatch = (pack.name || pack.id).toLowerCase().includes(filterText);
      const idMatch = pack.id.toLowerCase().includes(filterText);
      if (!nameMatch && !idMatch) continue;
    }

    const card = document.createElement('div');
    card.className = 'pack-card';
    card.dataset.packId = pack.id;
    card.title = `${pack.name || pack.id}\nID: ${pack.id}`;

    if (pack.enabled) {
      card.classList.add('enabled');
    }

    if (pack.thumbnailPath) {
      const img = document.createElement('img');
      img.className = 'pack-thumb';
      img.src = `/thumbs/${pack.thumbnailPath}`;
      img.alt = '';
      img.loading = 'lazy';
      img.onerror = () => {
        img.remove();
        card.insertBefore(createNoThumb(), card.firstChild);
      };
      card.appendChild(img);
    } else {
      card.appendChild(createNoThumb());
    }

    const nameEl = document.createElement('div');
    nameEl.className = 'pack-name';
    nameEl.textContent = pack.name || pack.id;
    card.appendChild(nameEl);

    card.addEventListener('click', () => togglePack(pack.id));
    packGrid.appendChild(card);
  }
}

function updateStatus() {
  if (!state.loaded) return;
  const total = state.packs.length;
  const enabled = state.packs.filter(p => p.enabled).length;
  statusText.textContent = `${enabled} / ${total} packs enabled`;

  let changed = false;
  for (const pack of state.packs) {
    if (pack.enabled !== state.originalStates[pack.id]) {
      changed = true;
      break;
    }
  }
  saveIndicator.classList.toggle('hidden', !changed);
}

async function applyChanges() {
  if (!state.loaded || !state.steamId) return;

  try {
    const status = await api('/api/status');
    if (status.gameRunning) {
      showError('Game is running. Please close it before applying changes.');
      return;
    }
  } catch {}

  const disabledClipPacks = state.packs
    .filter(p => !p.enabled)
    .map(p => p.id);

  try {
    await api(`/api/write-save/${state.steamId}`, {
      method: 'POST',
      body: JSON.stringify({ disabledClipPacks })
    });
    state.originalStates = {};
    for (const pack of state.packs) {
      state.originalStates[pack.id] = pack.enabled;
    }
    saveIndicator.classList.add('hidden');
    statusText.textContent += ' — Saved!';
    setTimeout(() => updateStatus(), 2000);
  } catch (e) {
    showError('Failed to write save: ' + e.message);
  }
}

async function revertChanges() {
  if (!state.loaded) return;
  for (const pack of state.packs) {
    pack.enabled = state.originalStates[pack.id] || false;
  }
  renderCards();
  updateStatus();
}

function showError(msg) {
  errorBanner.textContent = msg;
  errorBanner.classList.remove('hidden');
  setTimeout(() => errorBanner.classList.add('hidden'), 5000);
}

function showSettings(force = false) {
  const existing = document.getElementById('settings-overlay');
  if (existing) existing.remove();

  api('/api/status').then(status => {
    const overlay = document.createElement('div');
    overlay.id = 'settings-overlay';
    overlay.className = 'overlay';

    const offlineChecked = status.offlineMode ? 'checked' : '';

    overlay.innerHTML = `
      <div class="settings-panel">
        <h2>Settings</h2>
        <div class="settings-field">
          <label>Game Installation Path (needed to read save file)</label>
          <input type="text" id="settings-game-path" placeholder="Auto-detect or browse..." value="${status.gamePath || ''}">
          <span class="settings-hint">Auto-detect: ${status.gamePathDetected || 'not found (no Steam manifest)'}</span>
        </div>
        <div class="settings-field">
          <label>Workshop Content Path (clip pack folders)</label>
          <input type="text" id="settings-workshop-path" placeholder="Auto-detected: ${status.workshopDir || 'none'}" value="${status.workshopPath || ''}">
          <span class="settings-hint">Leave empty to auto-detect</span>
        </div>
        <div class="settings-field">
          <label>
            <input type="checkbox" id="settings-offline-mode" ${offlineChecked}>
            Offline Mode (no Steam API calls)
          </label>
        </div>
        <div class="settings-actions">
          <button id="settings-cancel">Cancel</button>
          <button id="settings-save">Save</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    $('#settings-cancel').addEventListener('click', () => {
      overlay.remove();
      if (force) {
        packGrid.innerHTML = '<div class="placeholder-msg">Game path not configured. Open settings (⚙) to set it up.</div>';
      }
    });

    $('#settings-save').addEventListener('click', async () => {
      const newPath = $('#settings-game-path').value.trim();
      const workshopPath = $('#settings-workshop-path').value.trim();
      const offlineMode = $('#settings-offline-mode').checked;

      await api('/api/settings', {
        method: 'POST',
        body: JSON.stringify({
          gamePath: newPath,
          offlineMode,
          workshopPath: workshopPath || null,
        })
      });
      overlay.remove();
      if (force) {
        window.location.reload();
      } else {
        const status = await api('/api/status');
        await loadSaves(status);
      }
    });
  });
}

// Events
searchInput.addEventListener('input', renderCards);

$('#btn-enable-all').addEventListener('click', () => setAll(true));
$('#btn-disable-all').addEventListener('click', () => setAll(false));
$('#btn-apply').addEventListener('click', applyChanges);
$('#btn-revert').addEventListener('click', revertChanges);

$('#btn-start-game').addEventListener('click', async () => {
  try {
    await applyChanges();
    await api('/api/start-game', { method: 'POST' });
  } catch (e) {
    showError('Failed: ' + e.message);
  }
});

$('#btn-load-profile').addEventListener('click', async () => {
  const steamId = profileSelect.value;
  if (steamId) await loadPacks(steamId);
});

$('#btn-settings').addEventListener('click', () => showSettings());

$('#btn-presets').addEventListener('click', () => {
  presetMenu.classList.toggle('hidden');
  if (!presetMenu.classList.contains('hidden')) renderPresetList();
});

document.addEventListener('click', (e) => {
  if (!presetMenu.contains(e.target) && e.target !== $('#btn-presets')) {
    presetMenu.classList.add('hidden');
  }
});

$('#btn-save-preset').addEventListener('click', async () => {
  const name = $('#preset-name').value.trim();
  if (!name) return;
  const disabledClipPacks = state.packs.filter(p => !p.enabled).map(p => p.id);
  await api('/api/presets', { method: 'POST', body: JSON.stringify({ name, disabledClipPacks }) });
  await renderPresetList();
  $('#preset-name').value = '';
});

async function renderPresetList() {
  const presets = await api('/api/presets');
  presetList.innerHTML = '';

  if (presets.length === 0) {
    presetList.innerHTML = '<div class="preset-item" style="color:var(--text-muted)">No saved presets</div>';
    return;
  }

  for (const preset of presets) {
    const item = document.createElement('div');
    item.className = 'preset-item';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'preset-item-name';
    nameSpan.textContent = preset.name;
    nameSpan.addEventListener('click', () => {
      const disabledSet = new Set(preset.disabledClipPacks);
      for (const pack of state.packs) {
        pack.enabled = !disabledSet.has(pack.id);
      }
      renderCards();
      updateStatus();
      presetMenu.classList.add('hidden');
    });

    const deleteSpan = document.createElement('span');
    deleteSpan.className = 'preset-item-delete';
    deleteSpan.textContent = '\u2715';
    deleteSpan.title = 'Delete preset';
    deleteSpan.addEventListener('click', async (e) => {
      e.stopPropagation();
      await api(`/api/presets/${encodeURIComponent(preset.name)}`, { method: 'DELETE' });
      await renderPresetList();
    });

    item.appendChild(nameSpan);
    item.appendChild(deleteSpan);
    presetList.appendChild(item);
  }
}

// Live name updates
socket.on('name-resolved', ({ id, name }) => {
  if (!state.loaded) return;
  const pack = state.packs.find(p => p.id === id);
  if (pack) {
    pack.name = name;
    const card = packGrid.querySelector(`[data-pack-id="${CSS.escape(id)}"]`);
    if (card) {
      const nameEl = card.querySelector('.pack-name');
      if (nameEl) nameEl.textContent = name;
    }
  }
});

// Music management
const musicOverlay = document.getElementById('music-overlay');
const musicClipsList = document.getElementById('music-clips-list');
let musicClipNames = [];
let musicBusy = false;

const musicNameMap = {
  'WTD_CREDITS_STEREO MIX#01_200122': 'Opening Music',
  'WTD_CODE ROOM_STEREO MIX#04_200125': 'Waiting for Players',
  'WTD_ENTER DUB_STEREO MIX#01_200122': 'Waiting for Dubs / Pause',
  'WTD_END CREDITS_FULL_STEREO MIX#10_200211': 'End Credits',
  'WTD_END CREDITS_LOOP_STEREO MIX#11_200211': 'Fallback after Opening / Credits',
  'WTD_CODE ROOM_BASS AND PERC_200127': 'Tutorial',
  'WTD_CODE ROOM_BASS AND DRUMS_200127': 'Round Transition',
};

const musicClipOrder = [
  'WTD_CREDITS_STEREO MIX#01_200122',
  'WTD_CODE ROOM_STEREO MIX#04_200125',
  'WTD_ENTER DUB_STEREO MIX#01_200122',
  'WTD_END CREDITS_FULL_STEREO MIX#10_200211',
  'WTD_END CREDITS_LOOP_STEREO MIX#11_200211',
  'WTD_CODE ROOM_BASS AND PERC_200127',
  'WTD_CODE ROOM_BASS AND DRUMS_200127',
];

let musicFfmpegOk = false;

function musicDisplayName(clip) {
  return musicNameMap[clip.name] || clip.name;
}

async function loadMusicClips() {
  musicClipsList.innerHTML = '<div class="placeholder-msg">Loading clips...</div>';

  try {
    const status = await api('/api/status');
    if (!status.gamePathValid) {
      musicClipsList.innerHTML = '<div class="music-error">Game path not configured. Open settings first.</div>';
      setMusicFfmpegGate(false);
      return;
    }

    const ffmpeg = await api('/api/music/status');
    musicFfmpegOk = ffmpeg.ffmpegAvailable;

    if (!musicFfmpegOk) {
      musicClipsList.innerHTML = `
        <div class="music-ffmpeg-warning">
          <strong>FFmpeg is required for audio replacement.</strong>
          <p>FFmpeg was not found on your system. It is needed for
          audio conversion and loudness normalization.</p>
          <p>Download from <a href="https://ffmpeg.org/download.html" target="_blank">ffmpeg.org/download.html</a>,
          add it to your PATH, then restart the app.</p>
        </div>`;
      setMusicFfmpegGate(false);
      return;
    }

    const clips = await api('/api/music/clips');
    renderMusicClips(clips);
  } catch (e) {
    musicClipsList.innerHTML = `<div class="music-error">Failed to load clips: ${e.message}</div>`;
    setMusicFfmpegGate(false);
  }
}

function setMusicFfmpegGate(ok) {
  const allBtn = document.getElementById('music-replace-all-btn');
  const restoreBtn = document.getElementById('music-restore-all');
  if (allBtn) allBtn.disabled = !ok;
  if (restoreBtn) restoreBtn.disabled = !ok;
  if (!ok) {
    musicClipsList.innerHTML = musicClipsList.innerHTML ||
      '<div class="music-error">FFmpeg not available &#8212; audio replacement disabled</div>';
  }
}

function renderMusicClips(clips) {
  musicClipsList.innerHTML = '';

  const musicClips = clips.filter(c =>
    (c.name.includes('STEREO MIX') || c.name.includes('BASS AND')) &&
    !c.name.includes('STING') &&
    !c.name.includes('Applause')
  );

  musicClips.sort((a, b) => {
    const ai = musicClipOrder.indexOf(a.name);
    const bi = musicClipOrder.indexOf(b.name);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  musicClipNames = musicClips.map(c => c.name);

  if (musicClips.length === 0) {
    musicClipsList.innerHTML = '<div class="music-error">No music clips found</div>';
    return;
  }

  for (const clip of musicClips) {
    const item = document.createElement('div');
    item.className = 'music-clip-item';

    const name = document.createElement('div');
    name.className = 'music-clip-name';
    name.textContent = musicDisplayName(clip);
    name.title = clip.name;

    const duration = document.createElement('div');
    duration.className = 'music-clip-duration';
    duration.textContent = `${clip.duration}s`;

    const fadeLabel = document.createElement('label');
    fadeLabel.className = 'music-fade-label';
    const fadeCb = document.createElement('input');
    fadeCb.type = 'checkbox';
    fadeCb.className = 'fade-toggle';
    fadeCb.checked = true;
    fadeCb.dataset.clipName = clip.name;
    fadeLabel.appendChild(fadeCb);
    fadeLabel.appendChild(document.createTextNode('Fade'));

    const replaceBtn = document.createElement('button');
    replaceBtn.className = 'music-clip-replace';
    replaceBtn.textContent = 'Replace';
    replaceBtn.addEventListener('click', () => replaceMusicClip(clip.name, item));

    item.appendChild(name);
    item.appendChild(duration);
    item.appendChild(fadeLabel);
    item.appendChild(replaceBtn);
    musicClipsList.appendChild(item);
  }
}

async function replaceMusicClip(clipName, itemEl) {
  if (musicBusy || !musicFfmpegOk) return;

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'audio/*';
  input.style.display = 'none';
  document.body.appendChild(input);

  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) {
      input.remove();
      return;
    }

    setMusicBusy(true);

    const statusEl = document.createElement('div');
    statusEl.className = 'music-clip-status';
    statusEl.textContent = 'Replacing...';

    const existingStatus = itemEl.querySelector('.music-clip-status');
    if (existingStatus) existingStatus.remove();

    const replaceBtn = itemEl.querySelector('.music-clip-replace');
    replaceBtn.disabled = true;
    itemEl.appendChild(statusEl);

    const fadeCb = itemEl.querySelector('.fade-toggle');
    const fade = fadeCb ? fadeCb.checked : true;

    try {
      const formData = new FormData();
      formData.append('clipName', clipName);
      formData.append('audioFile', file);
      formData.append('fade', fade ? 'true' : 'false');

      const res = await fetch('/api/music/replace', {
        method: 'POST',
        body: formData
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      await res.json();
      statusEl.textContent = 'Done!';
      statusEl.style.color = 'var(--success)';
    } catch (e) {
      statusEl.textContent = 'Failed: ' + e.message;
      statusEl.style.color = 'var(--danger)';
    }

    replaceBtn.disabled = false;
    input.remove();
    setMusicBusy(false);
  });

  input.click();
}

async function restoreAllMusic() {
  if (musicBusy || !musicFfmpegOk) return;
  setMusicBusy(true);

  try {
    const status = await api('/api/status');
    if (status.gameRunning) {
      showError('Game is running. Close it first.');
      return;
    }

    await api('/api/music/restore', { method: 'POST' });
    showError('Original audio restored!');
    errorBanner.style.background = 'var(--success)';
    setTimeout(() => { errorBanner.style.background = ''; }, 2000);
  } catch (e) {
    showError('Failed to restore: ' + e.message);
  } finally {
    setMusicBusy(false);
  }
}

async function replaceAllMusic() {
  if (musicBusy || !musicFfmpegOk) return;
  if (musicClipNames.length === 0) {
    showError('No music clips loaded');
    return;
  }

  const status = await api('/api/status');
  if (status.gameRunning) {
    showError('Game is running. Close it first.');
    return;
  }

  const fileInput = document.getElementById('music-replace-all-file');
  const statusEl = document.getElementById('music-batch-status');
  const btn = document.getElementById('music-replace-all-btn');

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;

    setMusicBusy(true);
    btn.disabled = true;
    statusEl.textContent = 'Normalizing and replacing...';
    statusEl.style.color = '';

    try {
      const toggles = document.querySelectorAll('.fade-toggle');
      const fades = {};
      toggles.forEach(cb => {
        fades[cb.dataset.clipName] = cb.checked;
      });

      const formData = new FormData();
      formData.append('clipNames', JSON.stringify(musicClipNames));
      formData.append('audioFile', file);
      formData.append('fades', JSON.stringify(fades));

      const res = await fetch('/api/music/replace-batch', {
        method: 'POST',
        body: formData
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      await res.json();
      statusEl.textContent = 'Done! All music replaced.';
      statusEl.style.color = 'var(--success)';
    } catch (e) {
      statusEl.textContent = 'Failed: ' + e.message;
      statusEl.style.color = 'var(--danger)';
    }

    btn.disabled = false;
    setMusicBusy(false);
  }, { once: true });

  fileInput.click();
}

function setMusicBusy(busy) {
  musicBusy = busy;
  const panel = document.querySelector('.music-panel');
  const closeBtn = document.getElementById('music-close');
  const allBtns = document.querySelectorAll('.music-clip-replace, #music-replace-all-btn, #music-restore-all');

  if (busy) {
    panel.classList.add('music-busy');
    closeBtn.disabled = true;
    allBtns.forEach(b => { b.disabled = true; });
  } else {
    panel.classList.remove('music-busy');
    closeBtn.disabled = false;
    allBtns.forEach(b => { b.disabled = false; });
  }
}

document.getElementById('btn-music').addEventListener('click', () => {
  musicOverlay.classList.remove('hidden');
  loadMusicClips();
});

document.getElementById('music-close').addEventListener('click', () => {
  if (musicBusy) return;
  musicOverlay.classList.add('hidden');
});

document.getElementById('music-replace-all-btn').addEventListener('click', replaceAllMusic);
document.getElementById('music-restore-all').addEventListener('click', restoreAllMusic);

musicOverlay.addEventListener('click', (e) => {
  if (musicBusy) return;
  if (e.target === musicOverlay) {
    musicOverlay.classList.add('hidden');
  }
});

// Keyboard
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    applyChanges();
  }
  if (e.key === 'Escape') {
    if (!presetMenu.classList.contains('hidden')) presetMenu.classList.add('hidden');
    if (!musicOverlay.classList.contains('hidden') && !musicBusy) musicOverlay.classList.add('hidden');
  }
});

init();
