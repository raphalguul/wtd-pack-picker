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
  const existing = document.querySelector('.settings-overlay');
  if (existing) existing.remove();

  api('/api/status').then(status => {
    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay';

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

// Keyboard
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    applyChanges();
  }
  if (e.key === 'Escape') {
    if (!presetMenu.classList.contains('hidden')) presetMenu.classList.add('hidden');
  }
});

init();
