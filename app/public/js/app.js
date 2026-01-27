// SVG Icons
const icons = {
    refresh: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>',
    stop: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>',
    play: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6,4 20,12 6,20"/></svg>',
    copy: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    eye: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
    users: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    power: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>',
    check: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    x: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    info: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
};

// State
let cameras = [];
let credentials = [];
let currentPreview = null;
let logs = [];
let logFilter = 'all';
let sourceFilter = '';
let textFilter = '';
let ws = null;
let loadingOperations = new Set();
let appSettings = { serviceIp: 'localhost', proxyPort: 8554, serverPort: 3000 };

// Loading state helpers
function setLoading(operationId, isLoading) {
    if (isLoading) {
        loadingOperations.add(operationId);
    } else {
        loadingOperations.delete(operationId);
    }
    document.querySelectorAll('[data-loading-id="' + operationId + '"]').forEach(btn => {
        btn.disabled = isLoading;
        if (isLoading) {
            btn.dataset.originalText = btn.innerHTML;
            btn.innerHTML = '<span class="spinner"></span>';
        } else if (btn.dataset.originalText) {
            btn.innerHTML = btn.dataset.originalText;
        }
    });
}

function isLoading(operationId) {
    return loadingOperations.has(operationId);
}

// API Helper
async function api(path, method = 'GET', body = null) {
    const options = {
        method,
        headers: { 'Content-Type': 'application/json' },
    };
    if (body) options.body = JSON.stringify(body);

    const res = await fetch('/api/trpc/' + path, options);
    const data = await res.json();

    if (data.error) {
        throw new Error(data.error.message || 'API Error');
    }
    return data.result?.data;
}

// Toast notifications
function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.innerHTML = message;
    document.getElementById('toastContainer').appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
}

// Navigation
function initNavigation() {
    document.querySelectorAll('.nav-item[data-page]').forEach(item => {
        item.addEventListener('click', () => {
            const page = item.dataset.page;

            document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
            item.classList.add('active');

            document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
            document.getElementById('page-' + page).classList.add('active');

            const titles = {
                cameras: 'Cameras & RTSP Servers',
                logs: 'Live Logs',
                settings: 'Settings',
                docs: 'API Documentation'
            };
            document.getElementById('pageTitle').textContent = titles[page] || page;

            const actions = document.getElementById('headerActions');
            if (page === 'cameras') {
                actions.innerHTML = '<button class="btn btn-primary" onclick="openAddCameraModal()">+ Add Camera</button>';
            } else {
                actions.innerHTML = '';
            }

            if (page === 'cameras') loadCameras();
            if (page === 'settings') loadSettingsUI();
        });
    });

    document.getElementById('headerActions').innerHTML =
        '<button class="btn btn-primary" onclick="openAddCameraModal()">+ Add Camera</button>';
}

// Modal helpers
function openModal(id) {
    document.getElementById(id).classList.add('active');
}

function closeModal(id) {
    document.getElementById(id).classList.remove('active');
}

// Helper: sanitize name for preview
function sanitizeName(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// Helper: get proxy URL for a stream
function getProxyUrl(cameraName, profile) {
    const sanitizedName = sanitizeName(cameraName);
    return `rtsp://${appSettings.serviceIp}:${appSettings.proxyPort}/${sanitizedName}/${profile}`;
}

// Cameras
async function loadCameras() {
    try {
        cameras = await api('cameras.list');
        renderCameras();

        for (const cam of cameras) {
            if (cam.status === 'connected' && !cam.availableStreams) {
                loadCameraStreams(cam.id);
            }
        }
    } catch (err) {
        showToast('Failed to load cameras: ' + err.message, 'error');
    }
}

async function loadCameraStreams(cameraId) {
    try {
        const cam = cameras.find(c => c.id === cameraId);
        if (!cam) return;
        const channel = parseInt(cam.rtspChannel) || 0;
        const result = await api('cameras.getAvailableStreams?input=' + encodeURIComponent(JSON.stringify({ id: cameraId, channel })));
        const camIndex = cameras.findIndex(c => c.id === cameraId);
        if (camIndex >= 0) {
            cameras[camIndex].availableStreams = result.nativeStreams;
            renderCameras();
        }
    } catch (err) {
        console.log('Failed to load streams for camera:', cameraId, err);
    }
}

function renderCameras() {
    const grid = document.getElementById('cameraGrid');
    const empty = document.getElementById('camerasEmpty');

    if (!cameras || cameras.length === 0) {
        grid.innerHTML = '';
        empty.style.display = 'block';
        return;
    }

    empty.style.display = 'none';
    grid.innerHTML = cameras.map(cam => {
        const rtspServers = cam.rtspServers || [];
        const availableStreams = cam.availableStreams || [];
        const channel = parseInt(cam.rtspChannel) || 0;

        const runningProfiles = new Set(rtspServers.map(s => s.profile));

        // For NVR/Hub: show channel camera name if available
        const displayName = cam.deviceInfo?.channelName || cam.name;
        const isNvr = cam.deviceInfo?.isNvr;

        // Merge available streams with running servers info
        const allStreams = [
            ...rtspServers.map(s => {
                const available = availableStreams.find(a => a.profile === s.profile);
                return { ...s, codec: available?.codec || s.codec, resolution: available?.resolution || s.resolution };
            }),
            ...availableStreams
                .filter(s => !runningProfiles.has(s.profile))
                .map(s => ({ ...s, status: 'available' }))
        ];

        return `
    <div class="camera-card" data-camera-id="${cam.id}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div>
          <div class="camera-status ${cam.status}"></div>
          <div class="camera-name">${displayName}</div>
          ${isNvr && cam.deviceInfo?.channelName ? `<div class="camera-info" style="font-size:10px;opacity:0.7;">via ${cam.deviceInfo.hubModel || 'Hub'} (ch${channel})</div>` : ''}
          <div class="camera-info">${cam.host}:${cam.port}</div>
        </div>
        <div style="display:flex;gap:4px;">
          <button class="btn btn-secondary icon-btn" onclick="showDeviceInfo('${cam.id}')" title="Device info">${icons.info}</button>
          <button class="btn btn-secondary icon-btn" data-loading-id="refresh-${cam.id}" onclick="refreshCamera('${cam.id}')" title="Refresh camera data">${icons.refresh}</button>
        </div>
      </div>
      
      <div class="streams-section">
        <div style="margin-bottom:8px;">
          <span class="streams-section-title">RTSP Streams (On-Demand)</span>
        </div>
        <div id="streams-${cam.id}" class="streams-grid">
          ${allStreams.length > 0 ? allStreams.map(stream => {
            const streamChannel = stream.channel ?? channel;
            const proxyUrl = getProxyUrl(cam.name, stream.profile);
            const isRunning = stream.status === 'running';
            const hasViewers = isRunning && (stream.connections || 0) > 0;
            const codecInfo = stream.codec || '—';
            const resInfo = stream.resolution || '—';
            return `
            <div class="stream-item ${hasViewers ? 'active' : ''}">
              <div class="stream-header">
                <span class="stream-profile">${stream.profile.toUpperCase()}</span>
                ${hasViewers ? `<span class="stream-status-dot running" title="Active (${stream.connections} viewer${stream.connections > 1 ? 's' : ''})"></span>` : `<span class="stream-status-dot" title="Ready (on-demand)"></span>`}
              </div>
              <div class="stream-details">
                <div class="stream-detail-row">
                  <span class="detail-label">Codec</span>
                  <span class="detail-value">${codecInfo}</span>
                </div>
                <div class="stream-detail-row">
                  <span class="detail-label">Resolution</span>
                  <span class="detail-value">${resInfo}</span>
                </div>
                <div class="stream-detail-row">
                  <span class="detail-label">${icons.users} Viewers</span>
                  <span class="detail-value ${hasViewers ? 'viewers-active' : ''}">${isRunning ? (stream.connections || 0) : '—'}</span>
                </div>
              </div>
              <div class="stream-actions">
                <button class="btn btn-secondary btn-sm" onclick="showStreamUrls('${cam.name}', '${stream.profile}', '${proxyUrl}')">📋 URLs</button>
                <button class="btn btn-secondary icon-btn-sm" onclick="openPreview('${cam.id}', '${stream.profile}')" title="Preview">${icons.eye}</button>
              </div>
            </div>
          `}).join('') : `
            <div style="color:var(--text-secondary);font-size:12px;grid-column:1/-1;">
              ${cam.status === 'connected' ?
                'No streams detected yet. Click refresh to detect.' :
                'Connect to camera to see available streams'}
            </div>
          `}
        </div>
      </div>
      
      <div class="camera-actions">
        ${cam.status !== 'connected' ?
                `<button class="btn btn-success" data-loading-id="connect-${cam.id}" onclick="connectCamera('${cam.id}')">Connect</button>` :
                `<button class="btn btn-secondary" data-loading-id="disconnect-${cam.id}" onclick="disconnectCamera('${cam.id}')">Disconnect</button>`
            }
        <button class="btn btn-secondary" onclick="editCamera('${cam.id}')">Edit</button>
        <button class="btn btn-danger" data-loading-id="delete-${cam.id}" onclick="deleteCamera('${cam.id}')">Delete</button>
      </div>
    </div>
  `}).join('');
}

function openAddCameraModal() {
    document.getElementById('cameraModalTitle').textContent = 'Add Camera';
    document.getElementById('cameraForm').reset();
    document.getElementById('cameraId').value = '';
    document.getElementById('cameraNamePreview').textContent = '';
    document.getElementById('cameraDebugLogs').checked = false;
    openModal('addCameraModal');
}

async function editCamera(id) {
    const cam = cameras.find(c => c.id === id);
    if (!cam) return;

    document.getElementById('cameraModalTitle').textContent = 'Edit Camera';
    document.getElementById('cameraId').value = id;
    document.getElementById('cameraName').value = cam.name;
    document.getElementById('cameraHost').value = cam.host;
    document.getElementById('cameraPort').value = cam.port;
    document.getElementById('cameraNamePreview').textContent = '';

    const rtspChannel = cam.rtspChannel ?? 0;
    document.getElementById('cameraChannel').value = rtspChannel;
    document.getElementById('cameraDebugLogs').checked = cam.debugLogs || false;

    openModal('addCameraModal');
}

function initCameraForm() {
    document.getElementById('cameraForm').addEventListener('submit', async (e) => {
        e.preventDefault();

        const id = document.getElementById('cameraId').value;
        const channel = parseInt(document.getElementById('cameraChannel').value) || 0;
        const nameValue = document.getElementById('cameraName').value.trim();

        const data = {
            name: nameValue || undefined, // Send undefined to trigger auto-detect
            host: document.getElementById('cameraHost').value,
            port: parseInt(document.getElementById('cameraPort').value) || 9000,
            username: document.getElementById('cameraUsername').value,
            password: document.getElementById('cameraPassword').value,
            rtspChannel: channel,
            debugLogs: document.getElementById('cameraDebugLogs').checked,
        };

        try {
            if (id) {
                // For updates, always send the name (even if empty means keep current)
                data.name = nameValue || undefined;
                await api('cameras.update', 'POST', { id, ...data });
                showToast('Camera updated');
            } else {
                await api('cameras.add', 'POST', data);
                showToast('Camera added');
            }
            closeModal('addCameraModal');
            loadCameras();
        } catch (err) {
            showToast('Failed to save camera: ' + err.message, 'error');
        }
    });
}

async function testCameraConnection() {
    const channel = parseInt(document.getElementById('cameraChannel').value);
    const data = {
        host: document.getElementById('cameraHost').value,
        port: parseInt(document.getElementById('cameraPort').value) || 9000,
        username: document.getElementById('cameraUsername').value,
        password: document.getElementById('cameraPassword').value,
        channel: isNaN(channel) ? undefined : channel, // For Hub/NVR: pass channel to get correct camera info
    };

    try {
        showToast('Testing connection...', 'warning');
        const result = await api('cameras.testConnection', 'POST', data);
        if (result.success) {
            showToast('Connection successful! Model: ' + (result.info?.model || 'Unknown'));
        } else {
            showToast('Connection failed: ' + result.error, 'error');
        }
    } catch (err) {
        showToast('Connection failed: ' + err.message, 'error');
    }
}

async function connectCamera(id) {
    const loadingId = 'connect-' + id;
    setLoading(loadingId, true);
    try {
        await api('cameras.connect', 'POST', { id });
        showToast('Connected to camera');
        await loadCameras();
        await refreshCamera(id);
    } catch (err) {
        showToast('Failed to connect: ' + err.message, 'error');
    } finally {
        setLoading(loadingId, false);
    }
}

async function disconnectCamera(id) {
    const loadingId = 'disconnect-' + id;
    setLoading(loadingId, true);
    try {
        await api('cameras.disconnect', 'POST', { id });
        showToast('Disconnected from camera');
        await loadCameras();
    } catch (err) {
        showToast('Failed to disconnect: ' + err.message, 'error');
    } finally {
        setLoading(loadingId, false);
    }
}

async function deleteCamera(id) {
    if (!confirm('Are you sure you want to delete this camera?')) return;

    const loadingId = 'delete-' + id;
    setLoading(loadingId, true);
    try {
        await api('cameras.delete', 'POST', { id });
        showToast('Camera deleted');
        await loadCameras();
    } catch (err) {
        showToast('Failed to delete camera: ' + err.message, 'error');
    } finally {
        setLoading(loadingId, false);
    }
}

// RTSP Stream Controls
async function startStreamWithPort(cameraId, profile, channel = 0) {
    const portInput = document.getElementById('port-' + cameraId + '-' + profile);
    const port = portInput && portInput.value ? parseInt(portInput.value) : undefined;

    const loadingId = 'start-' + cameraId + '-' + profile;
    setLoading(loadingId, true);
    try {
        const params = { cameraId, profile, channel };
        if (port) params.port = port;
        await api('rtsp.start', 'POST', params);
        showToast('Stream ' + profile + ' started' + (port ? ' on port ' + port : ''));
        await loadCameras();
    } catch (err) {
        showToast('Failed to start stream: ' + err.message, 'error');
    } finally {
        setLoading(loadingId, false);
    }
}

async function startStream(cameraId, profile, channel = 0) {
    const loadingId = 'start-' + cameraId + '-' + profile;
    setLoading(loadingId, true);
    try {
        await api('rtsp.start', 'POST', { cameraId, profile, channel });
        showToast('Stream ' + profile + ' started');
        await loadCameras();
    } catch (err) {
        showToast('Failed to start stream: ' + err.message, 'error');
    } finally {
        setLoading(loadingId, false);
    }
}

async function stopStream(cameraId, profile, channel = 0) {
    const loadingId = 'stop-' + cameraId + '-' + profile;
    setLoading(loadingId, true);
    try {
        await api('rtsp.stop', 'POST', { cameraId, profile, channel });
        showToast('Stream ' + profile + ' stopped');
        await loadCameras();
    } catch (err) {
        showToast('Failed to stop stream: ' + err.message, 'error');
    } finally {
        setLoading(loadingId, false);
    }
}

async function refreshCamera(cameraId) {
    const loadingId = 'refresh-' + cameraId;
    setLoading(loadingId, true);
    try {
        const cam = cameras.find(c => c.id === cameraId);
        const channel = parseInt(cam?.rtspChannel) || 0;

        const result = await api('cameras.getAvailableStreams?input=' + encodeURIComponent(JSON.stringify({ id: cameraId, channel })));

        const camIndex = cameras.findIndex(c => c.id === cameraId);
        if (camIndex >= 0) {
            cameras[camIndex].availableStreams = result.nativeStreams;
        }
        renderCameras();
        showToast('Camera refreshed - ' + result.nativeStreams.length + ' stream(s) available');
    } catch (err) {
        showToast('Failed to refresh: ' + err.message, 'error');
    } finally {
        setLoading(loadingId, false);
    }
}

async function startCameraStreams(cameraId) {
    const loadingId = 'startall-' + cameraId;
    setLoading(loadingId, true);
    try {
        const cam = cameras.find(c => c.id === cameraId);
        let availableStreams = cam?.availableStreams || [];
        const channel = parseInt(cam?.rtspChannel) || 0;

        if (availableStreams.length === 0 && cam?.status === 'connected') {
            const result = await api('cameras.getAvailableStreams?input=' + encodeURIComponent(JSON.stringify({ id: cameraId, channel })));
            availableStreams = result.nativeStreams || [];
            const camIndex = cameras.findIndex(c => c.id === cameraId);
            if (camIndex >= 0) cameras[camIndex].availableStreams = availableStreams;
        }

        if (availableStreams.length === 0) {
            showToast('No streams available to start', 'warning');
            return;
        }

        for (const stream of availableStreams) {
            await api('rtsp.start', 'POST', { cameraId, profile: stream.profile, channel });
        }
        showToast('All streams started');
        await loadCameras();
    } catch (err) {
        showToast('Failed to start streams: ' + err.message, 'error');
    } finally {
        setLoading(loadingId, false);
    }
}

async function stopCameraStreams(cameraId) {
    const loadingId = 'stopall-' + cameraId;
    setLoading(loadingId, true);
    try {
        await api('cameras.stopAllStreams', 'POST', { id: cameraId });
        showToast('All streams stopped');
        await loadCameras();
    } catch (err) {
        showToast('Failed to stop streams: ' + err.message, 'error');
    } finally {
        setLoading(loadingId, false);
    }
}

async function startAllRtsp() {
    try {
        await api('rtsp.startAll', 'POST', {});
        showToast('All RTSP servers started');
        loadCameras();
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    }
}

async function stopAllRtsp() {
    try {
        await api('rtsp.stopAll', 'POST', {});
        showToast('All RTSP servers stopped');
        loadCameras();
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    }
}

// Toggle autoStart for a stream
async function toggleAutoStart(cameraId, profile, channel, autoStart) {
    try {
        await api('rtsp.setAutoStart', 'POST', { cameraId, profile, channel, autoStart });
        showToast(autoStart ? 'Auto-start enabled' : 'Auto-start disabled');
        await loadCameras();
    } catch (err) {
        showToast('Failed to update auto-start: ' + err.message, 'error');
    }
}

// Clipboard helper
function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        showToast('Copied to clipboard');
    }).catch(() => {
        showToast('Failed to copy', 'error');
    });
}

// Show Stream URLs popover
function showStreamUrls(cameraName, profile, rtspUrl) {
    const sanitizedName = sanitizeName(cameraName);
    const mjpegUrl = `http://${appSettings.serviceIp}:${appSettings.serverPort}/api/stream/${sanitizedName}/${profile}`;

    // Remove any existing popover
    const existingPopover = document.getElementById('streamUrlsPopover');
    if (existingPopover) {
        existingPopover.remove();
    }

    // Create popover
    const popover = document.createElement('div');
    popover.id = 'streamUrlsPopover';
    popover.className = 'stream-urls-popover';
    popover.innerHTML = `
        <div class="popover-header">
            <span>Stream URLs</span>
            <button class="popover-close" onclick="closeStreamUrlsPopover()">&times;</button>
        </div>
        <div class="popover-content">
            <div class="url-row">
                <span class="url-label">RTSP</span>
                <code class="url-value">${rtspUrl}</code>
                <button class="btn btn-secondary icon-btn-sm" onclick="copyToClipboard('${rtspUrl}')" title="Copy">${icons.copy}</button>
            </div>
            <div class="url-row">
                <span class="url-label">MJPEG</span>
                <code class="url-value">${mjpegUrl}</code>
                <button class="btn btn-secondary icon-btn-sm" onclick="copyToClipboard('${mjpegUrl}')" title="Copy">${icons.copy}</button>
            </div>
        </div>
    `;

    document.body.appendChild(popover);

    // Position popover near mouse/center of screen
    popover.style.position = 'fixed';
    popover.style.top = '50%';
    popover.style.left = '50%';
    popover.style.transform = 'translate(-50%, -50%)';

    // Close on click outside
    setTimeout(() => {
        document.addEventListener('click', closeStreamUrlsPopoverOnOutsideClick);
    }, 100);
}

function closeStreamUrlsPopover() {
    const popover = document.getElementById('streamUrlsPopover');
    if (popover) {
        popover.remove();
    }
    document.removeEventListener('click', closeStreamUrlsPopoverOnOutsideClick);
}

function closeStreamUrlsPopoverOnOutsideClick(e) {
    const popover = document.getElementById('streamUrlsPopover');
    if (popover && !popover.contains(e.target) && !e.target.closest('[onclick*="showStreamUrls"]')) {
        closeStreamUrlsPopover();
    }
}

// Device Info Modal
async function showDeviceInfo(cameraId) {
    const cam = cameras.find(c => c.id === cameraId);
    if (!cam) return;

    const deviceInfo = cam.deviceInfo || {};
    const channel = parseInt(cam.rtspChannel) || 0;
    const availableStreams = cam.availableStreams || [];

    let content = `
        <div class="device-info-grid">
            <div class="device-info-section">
                <h4>Connection</h4>
                <div class="info-row"><span class="info-label">Name</span><span class="info-value">${cam.name}</span></div>
                <div class="info-row"><span class="info-label">Host</span><span class="info-value">${cam.host}:${cam.port}</span></div>
                <div class="info-row"><span class="info-label">Status</span><span class="info-value status-${cam.status}">${cam.status}</span></div>
                <div class="info-row"><span class="info-label">Channel</span><span class="info-value">${channel}</span></div>
            </div>
            <div class="device-info-section">
                <h4>Device</h4>
                <div class="info-row"><span class="info-label">Model</span><span class="info-value">${deviceInfo.model || '—'}</span></div>
                <div class="info-row"><span class="info-label">Firmware</span><span class="info-value">${deviceInfo.firmwareVersion || '—'}</span></div>
                <div class="info-row"><span class="info-label">Serial</span><span class="info-value">${deviceInfo.serialNumber || '—'}</span></div>
                <div class="info-row"><span class="info-label">Channels</span><span class="info-value">${deviceInfo.channelCount || 1}</span></div>
            </div>
        </div>
        <div class="device-info-section" style="margin-top:15px;">
            <h4>Available Streams</h4>
            <table class="streams-table">
                <thead>
                    <tr><th>Profile</th><th>Codec</th><th>Resolution</th><th>FPS</th><th>Bitrate</th></tr>
                </thead>
                <tbody>
                    ${availableStreams.length > 0 ? availableStreams.map(s => `
                        <tr>
                            <td>${s.profile.toUpperCase()}</td>
                            <td>${s.codec || '—'}</td>
                            <td>${s.resolution || '—'}</td>
                            <td>${s.fps ? s.fps + ' fps' : '—'}</td>
                            <td>${s.bitrate ? (s.bitrate / 1000).toFixed(0) + ' kbps' : '—'}</td>
                        </tr>
                    `).join('') : '<tr><td colspan="5" style="text-align:center;color:var(--text-secondary);">No stream info available. Try refreshing.</td></tr>'}
                </tbody>
            </table>
        </div>
    `;

    document.getElementById('deviceInfoContent').innerHTML = content;
    document.getElementById('deviceInfoTitle').textContent = cam.name + ' - Device Info';
    openModal('deviceInfoModal');
}

// Preview
function openPreview(cameraId, profile) {
    const cam = cameras.find(c => c.id === cameraId);
    if (!cam) {
        showToast('Camera not found', 'error');
        return;
    }

    currentPreview = { cameraId, profile };

    const displayName = cam.deviceInfo?.channelName || cam.name;

    document.getElementById('previewModalTitle').textContent = displayName + ' - ' + profile;

    document.getElementById('previewLoading').style.display = 'flex';
    document.getElementById('previewStream').style.display = 'none';
    document.getElementById('previewError').style.display = 'none';

    openModal('previewModal');

    const img = document.getElementById('previewStream');
    const streamUrl = '/api/stream/' + encodeURIComponent(cameraId) + '/' + encodeURIComponent(profile) + '?t=' + Date.now();

    img.onload = function () {
        document.getElementById('previewLoading').style.display = 'none';
        document.getElementById('previewStream').style.display = 'block';
    };

    img.onerror = function () {
        document.getElementById('previewLoading').style.display = 'none';
        document.getElementById('previewError').style.display = 'block';
        document.getElementById('previewErrorMsg').textContent = 'Failed to load preview. Make sure ffmpeg is installed.';
    };

    img.src = streamUrl;
}

function closePreview() {
    if (currentPreview) {
        const { cameraId, profile } = currentPreview;
        fetch('/api/stream/' + encodeURIComponent(cameraId) + '/' + encodeURIComponent(profile), {
            method: 'DELETE'
        }).catch(() => { });
        currentPreview = null;
    }

    document.getElementById('previewStream').src = '';
    closeModal('previewModal');
}

// Logs
let logsLoading = false;
let hasMoreLogs = true;

function loadRecentLogs() {
    // Logs will be loaded via WebSocket on connect
}

function initWebSocket() {
    ws = new WebSocket('ws://' + location.host + '/ws/logs');

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.type === 'history') {
            // Historical logs from server
            if (data.append) {
                // Append older logs at the end
                logs = [...logs, ...(data.logs || []).reverse()];
            } else {
                // Initial load - logs come in chronological order, we need reverse
                logs = (data.logs || []).reverse();
            }
            hasMoreLogs = (data.logs || []).length > 0;
            logsLoading = false;
            renderLogs();
            updateSourceFilter();
        } else if (data.type === 'log') {
            // New real-time log
            const { type, ...log } = data;
            logs.unshift(log); // Add new logs at the beginning
            if (logs.length > 2000) logs.pop(); // Remove oldest from the end
            renderLogs();
            updateSourceFilter();
        }
    };

    ws.onclose = () => {
        setTimeout(initWebSocket, 3000);
    };
}

function loadMoreLogs() {
    if (logsLoading || !hasMoreLogs || !ws || ws.readyState !== WebSocket.OPEN) return;

    logsLoading = true;
    // Send request for older logs - use the index of the oldest log we have
    ws.send(JSON.stringify({ type: 'loadMore', before: logs.length }));
}

function renderLogs() {
    const container = document.getElementById('logsContainer');

    let filtered = logs;
    if (logFilter !== 'all') {
        filtered = logs.filter(l => l.level === logFilter);
    }
    if (sourceFilter) {
        filtered = filtered.filter(l => l.source === sourceFilter);
    }
    if (textFilter) {
        const search = textFilter.toLowerCase();
        filtered = filtered.filter(l =>
            l.message.toLowerCase().includes(search) ||
            (l.source && l.source.toLowerCase().includes(search))
        );
    }

    // Logs are already in reverse order (newest first)
    container.innerHTML = filtered.map(log => `
    <div class="log-entry">
      <span class="log-time">${new Date(log.timestamp).toLocaleTimeString()}</span>
      <span class="log-level ${log.level}">${log.level.toUpperCase()}</span>
      ${log.source ? `<span class="log-source">[${log.source}]</span>` : ''}
      <span class="log-message">${escapeHtml(log.message)}</span>
    </div>
  `).join('') + (hasMoreLogs && filtered.length >= 20 ? '<div class="log-load-more" id="logLoadMore">Loading more...</div>' : '');

    if (document.getElementById('autoScroll').checked) {
        container.scrollTop = 0; // Scroll to top (newest)
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function getFilteredLogs() {
    let filtered = logs;
    if (logFilter !== 'all') {
        filtered = logs.filter(l => l.level === logFilter);
    }
    if (sourceFilter) {
        filtered = filtered.filter(l => l.source === sourceFilter);
    }
    if (textFilter) {
        const search = textFilter.toLowerCase();
        filtered = filtered.filter(l =>
            l.message.toLowerCase().includes(search) ||
            (l.source && l.source.toLowerCase().includes(search))
        );
    }
    return filtered;
}

function copyLogs() {
    const filtered = getFilteredLogs();
    const text = filtered.map(log =>
        `[${new Date(log.timestamp).toLocaleTimeString()}] [${log.level.toUpperCase()}]${log.source ? ` [${log.source}]` : ''} ${log.message}`
    ).join('\n');

    navigator.clipboard.writeText(text).then(() => {
        showToast(`Copied ${filtered.length} log entries`);
    }).catch(() => {
        showToast('Failed to copy logs', 'error');
    });
}

function updateSourceFilter() {
    const sources = [...new Set(logs.filter(l => l.source).map(l => l.source))];
    const select = document.getElementById('sourceFilter');
    const current = select.value;

    select.innerHTML = '<option value="">All Sources</option>' +
        sources.map(s => `<option value="${s}" ${s === current ? 'selected' : ''}>${s}</option>`).join('');
}

function clearLogs() {
    logs = [];
    renderLogs();
}

function initLogFilters() {
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            logFilter = btn.dataset.level;
            renderLogs();
        });
    });

    document.getElementById('sourceFilter').addEventListener('change', (e) => {
        sourceFilter = e.target.value;
        renderLogs();
    });

    document.getElementById('textFilter').addEventListener('input', (e) => {
        textFilter = e.target.value;
        renderLogs();
    });

    // Infinite scroll for logs
    const logsContainer = document.getElementById('logsContainer');
    logsContainer.addEventListener('scroll', () => {
        const { scrollTop, scrollHeight, clientHeight } = logsContainer;
        // Load more when scrolled near the bottom (older logs)
        if (scrollHeight - scrollTop - clientHeight < 100) {
            loadMoreLogs();
        }
    });
}

// Settings
async function loadSettingsUI() {
    try {
        const settings = await api('settings.get');
        const defaultIp = getBestEffortServerIp();
        document.getElementById('settingsConfigPath').value = settings.configPath || '';
        document.getElementById('settingsLogsPath').value = settings.logsPath || '';
        document.getElementById('settingsServerPort').value = settings.serverPort || 3000;
        document.getElementById('settingsServiceIp').value = settings.serviceIp || defaultIp;
        document.getElementById('settingsLogLevel').value = settings.logLevel || 'info';
        document.getElementById('settingsProxyPort').value = settings.rtspProxyPort || 8554;
        document.getElementById('settingsRtspRequireAuth').checked = settings.rtspRequireAuth || false;

        await loadCredentials();
    } catch (err) {
        showToast('Failed to load settings: ' + err.message, 'error');
    }
}

async function saveSettings() {
    const data = {
        configPath: document.getElementById('settingsConfigPath').value || undefined,
        logsPath: document.getElementById('settingsLogsPath').value || undefined,
        serverPort: parseInt(document.getElementById('settingsServerPort').value) || undefined,
        serviceIp: document.getElementById('settingsServiceIp').value || undefined,
        logLevel: document.getElementById('settingsLogLevel').value || undefined,
        rtspRequireAuth: document.getElementById('settingsRtspRequireAuth').checked,
        rtspProxyPort: parseInt(document.getElementById('settingsProxyPort').value) || undefined,
    };

    try {
        await api('settings.update', 'POST', data);
        showToast('Settings saved');
    } catch (err) {
        showToast('Failed to save settings: ' + err.message, 'error');
    }
}

// Credentials Management
async function loadCredentials() {
    try {
        credentials = await api('settings.listCredentials');
        renderCredentials();
    } catch (err) {
        console.error('Failed to load credentials:', err);
    }
}

function renderCredentials() {
    const container = document.getElementById('credentialsList');
    if (!credentials || credentials.length === 0) {
        container.innerHTML = '<div style="color:var(--text-secondary);font-size:13px;">No credentials configured.</div>';
        return;
    }

    container.innerHTML = credentials.map(cred => `
    <div style="display:flex;align-items:center;gap:10px;padding:10px;background:var(--bg-card);border-radius:8px;margin-bottom:10px;">
      <div style="flex:1;">
        <div style="font-weight:500;">${cred.username}</div>
        <div style="font-size:12px;color:var(--text-secondary);">${cred.description || 'No description'}</div>
      </div>
      <button class="btn btn-secondary" style="padding:4px 10px;" onclick="editCredential('${cred.id}')">Edit</button>
      <button class="btn btn-danger" style="padding:4px 10px;" onclick="deleteCredential('${cred.id}')">Delete</button>
    </div>
  `).join('');
}

function openAddCredentialModal() {
    document.getElementById('credentialModalTitle').textContent = 'Add Credential';
    document.getElementById('credentialForm').reset();
    document.getElementById('credentialId').value = '';
    openModal('addCredentialModal');
}

async function editCredential(id) {
    try {
        const cred = await api('settings.getCredential?input=' + encodeURIComponent(JSON.stringify({ id })));
        if (!cred) return;

        document.getElementById('credentialModalTitle').textContent = 'Edit Credential';
        document.getElementById('credentialId').value = id;
        document.getElementById('credentialUsername').value = cred.username;
        document.getElementById('credentialPassword').value = cred.password;
        document.getElementById('credentialDescription').value = cred.description || '';
        openModal('addCredentialModal');
    } catch (err) {
        showToast('Failed to load credential: ' + err.message, 'error');
    }
}

async function deleteCredential(id) {
    if (!confirm('Are you sure you want to delete this credential?')) return;

    try {
        await api('settings.deleteCredential', 'POST', { id });
        showToast('Credential deleted');
        loadCredentials();
    } catch (err) {
        showToast('Failed to delete credential: ' + err.message, 'error');
    }
}

function initCredentialForm() {
    document.getElementById('credentialForm').addEventListener('submit', async (e) => {
        e.preventDefault();

        const id = document.getElementById('credentialId').value;
        const data = {
            username: document.getElementById('credentialUsername').value,
            password: document.getElementById('credentialPassword').value,
            description: document.getElementById('credentialDescription').value || undefined,
        };

        try {
            if (id) {
                await api('settings.updateCredential', 'POST', { id, ...data });
                showToast('Credential updated');
            } else {
                await api('settings.addCredential', 'POST', data);
                showToast('Credential added');
            }
            closeModal('addCredentialModal');
            loadCredentials();
        } catch (err) {
            showToast('Failed to save credential: ' + err.message, 'error');
        }
    });
}

// RTSP Proxy Management
async function loadProxyStatus() {
    try {
        const status = await api('rtspProxy.getStatus');
        updateProxyUI(status);
    } catch (err) {
        console.error('Failed to load proxy status:', err);
    }
}

function updateProxyUI(status) {
    const statusDot = document.getElementById('proxyStatusDot');
    const statusText = document.getElementById('proxyStatusText');
    const startBtn = document.getElementById('proxyStartBtn');
    const stopBtn = document.getElementById('proxyStopBtn');
    const streamsList = document.getElementById('proxyStreamsList');
    const streamsContent = document.getElementById('proxyStreamsContent');

    if (status.running) {
        statusDot.className = 'status-dot running';
        statusText.textContent = `Proxy Running on port ${status.port}`;
        startBtn.style.display = 'none';
        stopBtn.style.display = 'inline-flex';

        // Show available streams
        if (status.streams && status.streams.length > 0) {
            streamsList.style.display = 'block';
            const serviceIp = document.getElementById('settingsServiceIp').value || 'localhost';
            streamsContent.innerHTML = status.streams.map(s => `
                <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 10px;background:var(--bg-card);border-radius:4px;margin-bottom:4px;font-size:12px;">
                    <span style="font-family:monospace;">rtsp://${serviceIp}:${status.port}/${s.path}</span>
                    <button class="btn btn-secondary" style="padding:2px 8px;font-size:11px;" onclick="copyProxyUrl('${s.path}', ${status.port})">📋</button>
                </div>
            `).join('');
        } else {
            streamsList.style.display = 'none';
        }
    } else {
        statusDot.className = 'status-dot stopped';
        statusText.textContent = 'Proxy Stopped';
        startBtn.style.display = 'inline-flex';
        stopBtn.style.display = 'none';
        streamsList.style.display = 'none';
    }
}

async function startRtspProxy() {
    try {
        const result = await api('rtspProxy.start', 'POST', {});
        if (result.success) {
            showToast('RTSP Proxy started');
            await loadProxyStatus();
        } else {
            showToast('Failed to start proxy: ' + (result.error || 'Unknown error'), 'error');
        }
    } catch (err) {
        showToast('Failed to start proxy: ' + err.message, 'error');
    }
}

async function stopRtspProxy() {
    try {
        const result = await api('rtspProxy.stop', 'POST', {});
        if (result.success) {
            showToast('RTSP Proxy stopped');
            await loadProxyStatus();
        } else {
            showToast('Failed to stop proxy: ' + (result.error || 'Unknown error'), 'error');
        }
    } catch (err) {
        showToast('Failed to stop proxy: ' + err.message, 'error');
    }
}

function copyProxyUrl(path, port) {
    const serviceIp = document.getElementById('settingsServiceIp').value || 'localhost';
    const url = `rtsp://${serviceIp}:${port}/${path}`;
    navigator.clipboard.writeText(url);
    showToast('URL copied to clipboard');
}

// Initialize everything on DOM ready
document.addEventListener('DOMContentLoaded', async () => {
    initNavigation();
    initCameraForm();
    initCredentialForm();
    initLogFilters();

    // Load settings first (for proxy URLs)
    await loadAppSettings();

    // Load initial data
    loadCameras();
    loadRecentLogs();
    initWebSocket();
});

// Load app settings for proxy URLs
async function loadAppSettings() {
    try {
        const settings = await api('settings.get');
        // Use saved serviceIp, or fallback to current hostname (best effort)
        const defaultIp = getBestEffortServerIp();
        appSettings.serviceIp = settings.serviceIp || defaultIp;
        appSettings.proxyPort = settings.rtspProxyPort || 8554;
        appSettings.serverPort = settings.serverPort || window.location.port || 3000;
    } catch (err) {
        console.error('Failed to load app settings:', err);
        appSettings.serviceIp = getBestEffortServerIp();
        appSettings.serverPort = window.location.port || 3000;
    }
}

// Get best effort server IP from current browser URL
function getBestEffortServerIp() {
    const hostname = window.location.hostname;
    // If accessing via IP address, use that
    if (hostname && hostname !== 'localhost' && hostname !== '127.0.0.1') {
        return hostname;
    }
    // Fallback to localhost
    return 'localhost';
}
