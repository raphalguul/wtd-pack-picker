const state = {
  packs: [],
  originalStates: {},
  steamId: null,
  loaded: false,
  waitingOnSteam: new Set(),
  watchingForRemoval: new Set(),
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

socket.on('embed-start', () => document.body.classList.add('embed-mode'));
socket.on('embed-stop', () => document.body.classList.remove('embed-mode'));

let updateState = {
  state: 'idle',
  currentVersion: null,
  availableVersion: null,
  percent: 0,
  error: null,
};

function describeUpdate(update) {
  if (!update) return '';
  switch (update.state) {
    case 'checking':
      return 'Checking for updates...';
    case 'available':
      return `Update available: v${update.availableVersion}`;
    case 'downloading':
      return `Downloading update: ${update.percent || 0}%`;
    case 'downloaded':
      return 'Update downloaded. Restart to install.';
    case 'none':
      return 'You are running the latest version.';
    case 'unsupported':
      return update.error || 'Updates are unavailable in this build.';
    case 'error':
      return `Update check failed: ${update.error}`;
    case 'installing':
      return 'Installing update...';
    default:
      return '';
  }
}

function renderUpdateStatus() {
  const el = document.getElementById('settings-update-status');
  if (!el) return;
  el.textContent = describeUpdate(updateState);
  el.classList.toggle('hidden', !el.textContent);
}

socket.on('update:status', (update) => {
  updateState = update;
  renderUpdateStatus();
});

socket.on('update:progress', (percent) => {
  if (updateState.state !== 'downloading') return;
  updateState = { ...updateState, percent };
  renderUpdateStatus();
});

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
      startSteamPoll();
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

  let lastSection = null;

  for (const pack of state.packs) {
    if (filterText) {
      const nameMatch = (pack.name || pack.id).toLowerCase().includes(filterText);
      const idMatch = pack.id.toLowerCase().includes(filterText);
      const creatorMatch = pack.creator && pack.creator.toLowerCase().includes(filterText);
      if (!nameMatch && !idMatch && !creatorMatch) continue;
    }

    const isInstalled = pack.installed !== false;
    const currentSection = isInstalled ? 'installed' : 'uninstalled';
    
    if (lastSection && lastSection !== currentSection) {
      const separator = document.createElement('div');
      separator.className = 'pack-section-separator';
      separator.innerHTML = '<span>Available to download</span>';
      packGrid.appendChild(separator);
    }
    lastSection = currentSection;

    const card = document.createElement('div');
    card.className = 'pack-card';
    card.dataset.packId = pack.id;
    card.title = `${pack.name || pack.id}\nID: ${pack.id}${pack.creator ? `\nCreator: ${pack.creator}` : ''}`;

    if (pack.enabled) {
      card.classList.add('enabled');
    }

    if (isInstalled) {
      card.classList.add('installed');
    }

    if (state.waitingOnSteam.has(pack.id)) {
      card.classList.add('waiting');
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

    if (isInstalled) {
      card.addEventListener('click', () => togglePack(pack.id));
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        handleContextMenu(pack.id, e.pageX, e.pageY, true);
      });
    } else {
      card.addEventListener('click', () => downloadPack(pack.id));
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        handleContextMenu(pack.id, e.pageX, e.pageY, false);
      });
    }
    
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

function normalizeHotkeyKey(key) {
  const named = {
    Escape: 'Escape',
    Tab: 'Tab',
    Enter: 'Enter',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Insert: 'Insert',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ' ': 'Space',
  };
  if (named[key]) return named[key];
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return key;
  if (key.length === 1) {
    const c = key.toUpperCase();
    if (/[A-Z0-9]/.test(c)) return c;
  }
  return null;
}

function eventToAccelerator(e) {
  if (!e.ctrlKey && !e.altKey && !e.metaKey) return null;
  const keyName = normalizeHotkeyKey(e.key);
  if (!keyName) return null;
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  return mods.concat(keyName).join('+');
}

function showSettings(force = false) {
  const existing = document.getElementById('settings-overlay');
  if (existing) existing.remove();

  api('/api/status').then(status => {
    const overlay = document.createElement('div');
    overlay.id = 'settings-overlay';
    overlay.className = 'overlay';

    const offlineChecked = status.offlineMode ? 'checked' : '';
    const fullscreenChecked = status.fullscreen !== false ? 'checked' : '';
    const embedChecked = status.embedGame !== false ? 'checked' : '';
    const killHotkey = status.killHotkey || '';

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
        <div class="settings-field">
          <label>
            <input type="checkbox" id="settings-fullscreen" ${fullscreenChecked}>
            Start Fullscreen (recommended for streaming)
          </label>
          <span class="settings-hint">Keeps the picker fullscreen so Discord streams one window.</span>
        </div>
        <div class="settings-field">
          <label>
            <input type="checkbox" id="settings-embed-game" ${embedChecked}>
            Embed game inside picker window
          </label>
          <span class="settings-hint">Launches the game as a child of this window so it appears in the same stream.</span>
        </div>
        <div class="settings-field">
          <label>Kill Game Hotkey (active while the game is embedded)</label>
          <div class="hotkey-row">
            <input type="text" id="settings-kill-hotkey" class="hotkey-input" readonly placeholder="Click to record..." value="${killHotkey}">
            <button id="settings-kill-hotkey-clear">Clear</button>
          </div>
          <span class="settings-hint">Click the box and press a combo (e.g. Alt+X). Leave empty to disable.</span>
        </div>
        <div class="settings-section">
          <div class="settings-section-title">Updates</div>
          <div class="settings-field">
            <label>Version</label>
            <div class="settings-version-row">
              <span id="settings-version">v${status.version || 'Unknown'}</span>
              <button id="settings-check-update">Check for Updates</button>
            </div>
            <span class="settings-hint hidden" id="settings-update-status"></span>
          </div>
        </div>
        <div class="settings-actions">
          <button id="settings-cancel">Cancel</button>
          <button id="settings-save">Save</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    if (status.update) updateState = status.update;
    renderUpdateStatus();

    // Hotkey recorder
    const hotkeyInput = $('#settings-kill-hotkey');
    hotkeyInput.dataset.acc = killHotkey;
    hotkeyInput.addEventListener('focus', () => {
      hotkeyInput.dataset.recording = '1';
      hotkeyInput.value = 'Press keys...';
    });
    hotkeyInput.addEventListener('keydown', (e) => {
      if (!hotkeyInput.dataset.recording) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        hotkeyInput.value = hotkeyInput.dataset.acc || '';
        hotkeyInput.blur();
        return;
      }
      const acc = eventToAccelerator(e);
      if (!acc) {
        hotkeyInput.value = 'Include Ctrl/Alt/Win...';
        return;
      }
      hotkeyInput.value = acc;
      hotkeyInput.dataset.acc = acc;
      hotkeyInput.blur();
    });
    hotkeyInput.addEventListener('blur', () => {
      delete hotkeyInput.dataset.recording;
      if (hotkeyInput.value === 'Press keys...' || hotkeyInput.value === 'Include Ctrl/Alt/Win...') {
        hotkeyInput.value = hotkeyInput.dataset.acc || '';
      }
    });
    $('#settings-kill-hotkey-clear').addEventListener('click', () => {
      hotkeyInput.dataset.acc = '';
      hotkeyInput.value = '';
    });

    $('#settings-check-update').addEventListener('click', async () => {
      const btn = $('#settings-check-update');
      btn.disabled = true;
      try {
        const result = await api('/api/update/check', { method: 'POST' });
        if (result) updateState = result;
        renderUpdateStatus();
      } catch (e) {
        showError(e.message);
      } finally {
        btn.disabled = false;
      }
    });

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
      const fullscreen = $('#settings-fullscreen').checked;
      const embedGame = $('#settings-embed-game').checked;
      const killHotkey = hotkeyInput.dataset.acc || '';

      await api('/api/settings', {
        method: 'POST',
        body: JSON.stringify({
          gamePath: newPath,
          offlineMode,
          workshopPath: workshopPath || null,
          fullscreen,
          embedGame,
          killHotkey,
        })
      });
      overlay.remove();
      if (force) {
        window.location.reload();
      } else {
        const status2 = await api('/api/status');
        await loadSaves(status2);
      }
    });
  });
}

searchInput.addEventListener('input', renderCards);

$('#btn-enable-all').addEventListener('click', () => setAll(true));
$('#btn-disable-all').addEventListener('click', () => setAll(false));
$('#btn-apply').addEventListener('click', applyChanges);
$('#btn-revert').addEventListener('click', revertChanges);

$('#btn-start-game').addEventListener('click', async () => {
  try {
    await applyChanges();
    const r = await api('/api/start-game', { method: 'POST' });
    if (r && r.error) showError(r.error);
  } catch (e) {
    showError('Failed: ' + e.message);
  }
});

function quitApp() {
  if (!confirm('Quit WTD Pack Picker?')) return;
  api('/api/quit', { method: 'POST' }).catch(() => {});
}

$('#btn-quit').addEventListener('click', quitApp);

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'q') {
    e.preventDefault();
    quitApp();
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

function openSteamWorkshop(workshopId) {
  const a = document.createElement('a');
  a.href = 'steam://url/CommunityFilePage/' + workshopId;
  a.click();
  state.waitingOnSteam.add(workshopId);
  updatePackCardState(workshopId, 'waiting');
  showError('Waiting for Steam to download...');
}

function downloadPack(workshopId) {
  openSteamWorkshop(workshopId);
}

function updatePackCardState(packId, st) {
  const card = packGrid.querySelector(`[data-pack-id="${CSS.escape(packId)}"]`);
  if (!card) return;
  
  card.classList.remove('downloading', 'downloaded', 'error', 'waiting');
  if (st) {
    card.classList.add(st);
  }
}

let _steamPollTimer = null;

function startSteamPoll() {
  if (_steamPollTimer) return;
  _steamPollTimer = setInterval(async () => {
    let changed = false;

    for (const id of state.waitingOnSteam) {
      try {
        const res = await api('/api/pack-installed/' + id);
        if (res.installed) {
          state.waitingOnSteam.delete(id);
          state._autoEnable = state._autoEnable || new Set();
          state._autoEnable.add(id);
          changed = true;
        }
      } catch {}
    }

    for (const id of state.watchingForRemoval) {
      try {
        const res = await api('/api/pack-installed/' + id);
        if (!res.installed) {
          state.watchingForRemoval.delete(id);
          changed = true;
        }
      } catch {}
    }

    if (changed) {
      await loadPacks(state.steamId);
      if (state._autoEnable && state._autoEnable.size > 0) {
        for (const pack of state.packs) {
          if (state._autoEnable.has(pack.id)) pack.enabled = true;
        }
        state._autoEnable = null;
        await applyChanges();
      }
    }
  }, 5000);
}

function stopSteamPoll() {
  if (_steamPollTimer) {
    clearInterval(_steamPollTimer);
    _steamPollTimer = null;
  }
}

const contextMenu = document.getElementById('context-menu');
let _ctxPackId = null;

function handleContextMenu(packId, x, y, installed) {
  _ctxPackId = packId;
  document.getElementById('ctx-add-pack').classList.toggle('hidden', installed);
  document.getElementById('ctx-remove-pack').classList.toggle('hidden', !installed);
  contextMenu.classList.remove('hidden');
  contextMenu.style.left = x + 'px';
  contextMenu.style.top = y + 'px';
}

document.addEventListener('click', () => {
  contextMenu.classList.add('hidden');
});

document.getElementById('ctx-remove-pack').addEventListener('click', async () => {
  contextMenu.classList.add('hidden');
  if (!_ctxPackId) return;
  const packId = _ctxPackId;
  _ctxPackId = null;

  const pack = state.packs.find(p => p.id === packId);
  if (!pack || !pack.installed) return;

  pack.enabled = false;
  updateCardState(packId);
  updateStatus();

  const disabledClipPacks = state.packs
    .filter(p => !p.enabled)
    .map(p => p.id);

  try {
    await api(`/api/write-save/${state.steamId}`, {
      method: 'POST',
      body: JSON.stringify({ disabledClipPacks })
    });
    state.originalStates = {};
    for (const p of state.packs) {
      state.originalStates[p.id] = p.enabled;
    }
  } catch (e) {
    showError('Failed to update save: ' + e.message);
  }

  const a = document.createElement('a');
  a.href = 'steam://url/CommunityFilePage/' + packId;
  a.click();

  state.watchingForRemoval.add(packId);
  showError('Pack disabled. Unsubscribe on Steam to complete removal.');
});

document.getElementById('ctx-add-pack').addEventListener('click', () => {
  contextMenu.classList.add('hidden');
  if (!_ctxPackId) return;
  const packId = _ctxPackId;
  _ctxPackId = null;
  openSteamWorkshop(packId);
});

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

document.getElementById('btn-refresh-catalog').addEventListener('click', async () => {
  const apiKey = prompt('Enter your Steam API key to refresh the pack catalog:');
  if (!apiKey) return;

  try {
    await api('/api/catalog/refresh', {
      method: 'POST',
      body: JSON.stringify({ apiKey })
    });
    showError('Catalog refresh started...');
    errorBanner.style.background = 'var(--accent)';
    setTimeout(() => { errorBanner.style.background = ''; }, 2000);
  } catch (e) {
    showError('Failed to start catalog refresh: ' + e.message);
  }
});

init();
