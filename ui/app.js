// local-expo-build UI Application Client
(function () {
  'use strict';

  // DOM Elements
  const statusPill = document.getElementById('status-pill');
  const statusText = document.getElementById('status-text');
  const dryRunBadge = document.getElementById('dry-run-badge');
  const hostInfo = document.getElementById('host-info');

  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabPanels = document.querySelectorAll('.tab-panel');

  const pillOpts = document.querySelectorAll('.pill-opt');
  const buildForm = document.getElementById('build-form');
  const btnStartBuild = document.getElementById('btn-start-build');
  const buildErrorBanner = document.getElementById('build-error-banner');
  const logConsole = document.getElementById('log-console');
  const btnClearLog = document.getElementById('btn-clear-log');
  const artifactResult = document.getElementById('artifact-result');
  const artifactPath = document.getElementById('artifact-path');

  const doctorGrid = document.getElementById('doctor-grid');
  const doctorSummaryBanner = document.getElementById('doctor-summary-banner');
  const btnRefreshDoctor = document.getElementById('btn-refresh-doctor');
  const doctorActionsBar = document.getElementById('doctor-actions-bar');
  const btnFixPkg = document.getElementById('btn-fix-pkg');
  const btnEasInit = document.getElementById('btn-eas-init');
  const btnEasConfigure = document.getElementById('btn-eas-configure');
  const btnDoctorRehydrate = document.getElementById('btn-doctor-rehydrate');

  const keystoreStatusContent = document.getElementById('keystore-status-content');
  const subtabBtns = document.querySelectorAll('.subtab-btn');
  const subpanels = document.querySelectorAll('.subpanel');

  const jksDropZone = document.getElementById('jks-drop-zone');
  const inputJksFile = document.getElementById('input-jks-file');
  const selectedFileName = document.getElementById('selected-file-name');
  const formKsUpload = document.getElementById('form-ks-upload');

  const formKsImport = document.getElementById('form-ks-import');
  const formKsGenerate = document.getElementById('form-ks-generate');
  const btnTriggerRehydrate = document.getElementById('btn-trigger-rehydrate');
  const btnTriggerEasFetch = document.getElementById('btn-trigger-eas-fetch');

  const terminalDock = document.getElementById('terminal-dock');
  const btnDockToggle = document.getElementById('btn-dock-toggle');
  const btnDockClear = document.getElementById('btn-dock-clear');
  const ptyStatusText = document.getElementById('pty-status-text');

  // Custom Modal Elements
  const modalOverlay = document.getElementById('custom-modal-overlay');
  const modalTitle = document.getElementById('modal-title');
  const modalMessage = document.getElementById('modal-message');
  const modalIconBadge = document.getElementById('modal-icon-badge');
  const modalInputContainer = document.getElementById('modal-input-container');
  const modalInputField = document.getElementById('modal-input-field');
  const modalInputError = document.getElementById('modal-input-error');
  const modalBtnCancel = document.getElementById('modal-btn-cancel');
  const modalBtnConfirm = document.getElementById('modal-btn-confirm');

  // Application State
  let selectedKind = 'aab';
  let isBuilding = false;
  let eventSource = null;
  let term = null;
  let fitAddon = null;
  let ptyWs = null;
  let ptyConnected = false;

  // ── Custom Modal Dialog Manager ──
  function showModal({
    title = 'Notice',
    message = '',
    type = 'info', // 'info' | 'success' | 'error'
    showInput = false,
    inputDefault = '',
    inputPlaceholder = '',
    confirmText = 'OK',
    cancelText = 'Cancel',
    showCancel = false,
    validate = null,
  }) {
    return new Promise((resolve) => {
      modalTitle.textContent = title;
      modalMessage.textContent = message;

      // Icon badge
      modalIconBadge.className = `modal-icon-badge ${type}`;
      modalIconBadge.textContent = type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ';

      // Buttons
      modalBtnConfirm.textContent = confirmText;
      modalBtnCancel.textContent = cancelText;
      modalBtnCancel.style.display = showCancel ? 'inline-flex' : 'none';

      // Input field
      if (showInput) {
        modalInputContainer.style.display = 'block';
        modalInputField.value = inputDefault;
        modalInputField.placeholder = inputPlaceholder;
        modalInputError.style.display = 'none';
        setTimeout(() => { modalInputField.focus(); modalInputField.select(); }, 50);
      } else {
        modalInputContainer.style.display = 'none';
      }

      modalOverlay.style.display = 'flex';

      function cleanup() {
        modalOverlay.style.display = 'none';
        modalBtnConfirm.onclick = null;
        modalBtnCancel.onclick = null;
      }

      modalBtnCancel.onclick = () => {
        cleanup();
        resolve(null);
      };

      modalBtnConfirm.onclick = () => {
        if (showInput) {
          const val = modalInputField.value.trim();
          if (validate) {
            const err = validate(val);
            if (err) {
              modalInputError.textContent = err;
              modalInputError.style.display = 'block';
              return;
            }
          }
          cleanup();
          resolve(val);
        } else {
          cleanup();
          resolve(true);
        }
      };
    });
  }

  function showAlert(title, message, type = 'info') {
    return showModal({ title, message, type, confirmText: 'OK', showCancel: false });
  }

  function showPrompt(title, message, defaultValue = '', placeholder = '', validate = null) {
    return showModal({
      title,
      message,
      type: 'info',
      showInput: true,
      inputDefault: defaultValue,
      inputPlaceholder: placeholder,
      confirmText: 'Submit',
      cancelText: 'Cancel',
      showCancel: true,
      validate,
    });
  }

  // ── Initialization ──
  function init() {
    setupTabNavigation();
    setupPillSelector();
    setupBuildForm();
    setupDoctorTab();
    setupKeystoreTab();
    setupTerminalDock();
    initSse();
    fetchStatus();
    fetchDoctor();
    fetchKeystoreStatus();
  }

  // ── Tab Navigation ──
  function setupTabNavigation() {
    tabBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetTab = btn.getAttribute('data-tab');
        tabBtns.forEach((b) => b.classList.remove('active'));
        tabPanels.forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(`panel-${targetTab}`).classList.add('active');

        if (targetTab === 'doctor') fetchDoctor();
        if (targetTab === 'keystore') fetchKeystoreStatus();
      });
    });

    subtabBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetSub = btn.getAttribute('data-subtab');
        subtabBtns.forEach((b) => b.classList.remove('active'));
        subpanels.forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(`subpanel-${targetSub}`).classList.add('active');
      });
    });
  }

  // ── Format Selector ──
  function setupPillSelector() {
    pillOpts.forEach((btn) => {
      btn.addEventListener('click', () => {
        pillOpts.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        selectedKind = btn.getAttribute('data-val');
      });
    });
  }

  // ── Status Poll ──
  async function fetchStatus() {
    try {
      const res = await fetch('/api/status');
      if (!res.ok) return;
      const data = await res.json();
      hostInfo.textContent = `127.0.0.1:${data.port}`;

      if (data.dryRun) {
        dryRunBadge.style.display = 'inline-block';
      } else {
        dryRunBadge.style.display = 'none';
      }

      if (data.buildStatus === 'building') {
        setBuildingState(true);
      } else if (!isBuilding) {
        setBuildingState(false);
      }
    } catch {
      // Ignore poll error
    }
  }

  function setBuildingState(building) {
    isBuilding = building;
    if (building) {
      statusPill.className = 'status-pill building';
      statusText.textContent = 'Building...';
      btnStartBuild.disabled = true;
      btnStartBuild.querySelector('.btn-text').textContent = 'Build in Progress...';
      btnStartBuild.querySelector('.btn-spinner').style.display = 'inline-block';
    } else {
      statusPill.className = 'status-pill idle';
      statusText.textContent = 'Idle';
      btnStartBuild.disabled = false;
      btnStartBuild.querySelector('.btn-text').textContent = 'Start Local Build';
      btnStartBuild.querySelector('.btn-spinner').style.display = 'none';
    }
  }

  // ── SSE Realtime Stream ──
  function initSse() {
    if (eventSource) eventSource.close();
    eventSource = new EventSource('/api/events');

    eventSource.onmessage = () => {};

    eventSource.addEventListener('connected', () => {});

    eventSource.addEventListener('log', (e) => {
      const data = JSON.parse(e.data);
      appendLog(data.line);
    });

    eventSource.addEventListener('step', (e) => {
      const data = JSON.parse(e.data);
      appendLog(`▶ ${data.message}`, 'step');
    });

    eventSource.addEventListener('build-start', () => {
      setBuildingState(true);
      logConsole.innerHTML = '';
      artifactResult.style.display = 'none';
      buildErrorBanner.style.display = 'none';
      appendLog('=== Starting Local Android Build ===', 'step');
    });

    eventSource.addEventListener('build-complete', (e) => {
      const data = JSON.parse(e.data);
      setBuildingState(false);
      if (data.success) {
        appendLog(`✓ Build Succeeded (${data.kind})`, 'ok');
        if (data.artifact) {
          artifactPath.textContent = data.artifact;
          artifactResult.style.display = 'block';
        }
      } else {
        appendLog(`✗ Build Failed: ${data.error}`, 'err');
        showBuildError(data.error || 'Build failed.');
      }
    });

    eventSource.addEventListener('doctor-updated', () => {
      fetchDoctor();
    });

    eventSource.addEventListener('keystore-updated', () => {
      fetchKeystoreStatus();
      fetchDoctor();
    });

    eventSource.addEventListener('pty-exit', (e) => {
      const data = JSON.parse(e.data);
      appendLog(`[PTY] Command "${data.commandId}" exited with code ${data.exitCode}`, 'dim');
      fetchDoctor();
      fetchKeystoreStatus();
    });

    eventSource.onerror = () => {
      setTimeout(initSse, 3000);
    };
  }

  function appendLog(line, type = 'dim') {
    const div = document.createElement('div');
    div.className = `log-line ${type}`;

    if (line.startsWith('[OK]')) div.className = 'log-line ok';
    else if (line.startsWith('[WARN]')) div.className = 'log-line warn';
    else if (line.startsWith('[ERR]')) div.className = 'log-line err';
    else if (line.startsWith('[STEP]')) div.className = 'log-line step';

    div.textContent = line;
    logConsole.appendChild(div);
    logConsole.scrollTop = logConsole.scrollHeight;
  }

  function showBuildError(msg) {
    buildErrorBanner.textContent = msg;
    buildErrorBanner.style.display = 'block';
  }

  // ── Build Form ──
  function setupBuildForm() {
    btnClearLog.addEventListener('click', () => {
      logConsole.innerHTML = '<div class="log-line dim">Log cleared.</div>';
    });

    buildForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      buildErrorBanner.style.display = 'none';

      const payload = {
        apk: selectedKind === 'apk',
        aab: selectedKind === 'aab',
        profile: document.getElementById('build-profile').value || 'production',
        clean: document.getElementById('opt-clean').checked,
        bump: !document.getElementById('opt-no-bump').checked,
        sync: !document.getElementById('opt-no-sync').checked,
        prebuild: !document.getElementById('opt-no-prebuild').checked,
      };

      try {
        const res = await fetch('/api/build', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (res.status === 409) {
          const errData = await res.json();
          showBuildError(errData.error || 'Build conflicts or keystore missing.');
          return;
        }

        if (!res.ok) {
          const errData = await res.json();
          showBuildError(errData.error || 'Failed to start build.');
        }
      } catch (err) {
        showBuildError(`Network error: ${err.message}`);
      }
    });
  }

  // ── Doctor Tab ──
  function setupDoctorTab() {
    btnRefreshDoctor.addEventListener('click', () => fetchDoctor());

    btnFixPkg.addEventListener('click', async () => {
      const pkg = await showPrompt(
        'Set Android Package Name',
        'Enter your Android applicationId (e.g. com.yourcompany.yourapp):',
        'com.example.app',
        'com.yourcompany.yourapp',
        (val) => {
          if (!val) return 'Package name cannot be empty.';
          if (!/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(val)) {
            return 'Need at least two dot-separated segments (e.g. com.yourcompany.yourapp).';
          }
          return null;
        }
      );
      if (!pkg) return;

      try {
        const res = await fetch('/api/doctor/fix-package', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ packageName: pkg }),
        });
        const data = await res.json();
        if (res.ok) {
          await showAlert('Success', `Package name updated to "${data.packageName}" in app.json!`, 'success');
          fetchDoctor();
        } else {
          await showAlert('Error', data.error || 'Failed to update package name.', 'error');
        }
      } catch (err) {
        await showAlert('Error', err.message, 'error');
      }
    });

    btnEasInit.addEventListener('click', () => {
      openPtyAndRun('eas-init');
    });

    btnEasConfigure.addEventListener('click', () => {
      openPtyAndRun('eas-configure');
    });

    btnDoctorRehydrate.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/doctor/rehydrate', { method: 'POST' });
        const data = await res.json();
        if (res.ok) {
          await showAlert('Success', 'Keystore rehydrated successfully!', 'success');
          fetchDoctor();
          fetchKeystoreStatus();
        } else {
          await showAlert('Error', data.error || 'Rehydration failed.', 'error');
        }
      } catch (err) {
        await showAlert('Error', err.message, 'error');
      }
    });
  }

  async function fetchDoctor() {
    try {
      doctorSummaryBanner.className = 'alert info margin-bottom';
      doctorSummaryBanner.textContent = 'Checking environment dependencies...';

      const res = await fetch('/api/doctor');
      if (!res.ok) {
        doctorSummaryBanner.className = 'alert danger margin-bottom';
        doctorSummaryBanner.textContent = 'Failed to fetch doctor checks.';
        return;
      }

      const summary = await res.json();
      renderDoctorResults(summary);
    } catch (err) {
      doctorSummaryBanner.className = 'alert danger margin-bottom';
      doctorSummaryBanner.textContent = `Error: ${err.message}`;
    }
  }

  function renderDoctorResults(summary) {
    const { results, capabilities } = summary;
    const failed = results.filter((r) => !r.ok);
    const warnings = results.filter((r) => r.ok && r.warn);

    if (failed.length > 0) {
      doctorSummaryBanner.className = 'alert danger margin-bottom';
      doctorSummaryBanner.textContent = `⚠️ ${failed.length} check(s) failing. Review recommendations below.`;
    } else if (warnings.length > 0) {
      doctorSummaryBanner.className = 'alert info margin-bottom';
      doctorSummaryBanner.textContent = `✓ Core setup ready (${warnings.length} notice/warning item).`;
    } else {
      doctorSummaryBanner.className = 'alert ok margin-bottom';
      doctorSummaryBanner.textContent = '✓ Environment checks passed! You are ready to build.';
    }

    // Render capability buttons
    let hasAction = false;
    btnFixPkg.style.display = capabilities.canFixAndroidPackage ? 'inline-flex' : 'none';
    btnEasInit.style.display = capabilities.canEasInit ? 'inline-flex' : 'none';
    btnEasConfigure.style.display = capabilities.canEasConfigure ? 'inline-flex' : 'none';
    btnDoctorRehydrate.style.display = capabilities.rehydrateAvailable ? 'inline-flex' : 'none';

    if (
      capabilities.canFixAndroidPackage ||
      capabilities.canEasInit ||
      capabilities.canEasConfigure ||
      capabilities.rehydrateAvailable
    ) {
      hasAction = true;
    }
    doctorActionsBar.style.display = hasAction ? 'flex' : 'none';

    // Render Grid Cards
    doctorGrid.innerHTML = '';
    results.forEach((check) => {
      const card = document.createElement('div');
      card.className = 'check-card';

      let statusBadge = '<span class="check-status-badge pass">PASS</span>';
      if (!check.ok) statusBadge = '<span class="check-status-badge fail">FAIL</span>';
      else if (check.warn) statusBadge = '<span class="check-status-badge warn">NOTICE</span>';

      card.innerHTML = `
        <div>
          <div class="check-name">${escapeHtml(check.name)}</div>
          <div class="check-detail">${escapeHtml(check.detail || '')}</div>
        </div>
        ${statusBadge}
      `;
      doctorGrid.appendChild(card);
    });
  }

  // ── Keystore Tab ──
  function setupKeystoreTab() {
    // Drag & Drop
    jksDropZone.addEventListener('click', () => inputJksFile.click());
    jksDropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      jksDropZone.classList.add('dragover');
    });
    jksDropZone.addEventListener('dragleave', () => jksDropZone.classList.remove('dragover'));
    jksDropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      jksDropZone.classList.remove('dragover');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        inputJksFile.files = e.dataTransfer.files;
        updateSelectedFileName();
      }
    });

    inputJksFile.addEventListener('change', () => updateSelectedFileName());

    // Upload Form
    formKsUpload.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!inputJksFile.files || !inputJksFile.files[0]) {
        await showAlert('Missing File', 'Please select or drag a .jks file first.', 'info');
        return;
      }

      const formData = new FormData();
      formData.append('jks', inputJksFile.files[0]);
      formData.append('keyAlias', document.getElementById('upload-alias').value.trim());
      formData.append('storePassword', document.getElementById('upload-store-pass').value);
      formData.append('keyPassword', document.getElementById('upload-key-pass').value);

      try {
        const res = await fetch('/api/keystore/upload', {
          method: 'POST',
          body: formData,
        });
        const data = await res.json();
        if (res.ok) {
          await showAlert('Success', 'Keystore uploaded & registered successfully!', 'success');
          formKsUpload.reset();
          selectedFileName.textContent = '';
          fetchKeystoreStatus();
        } else {
          await showAlert('Upload Failed', data.error || 'Failed to upload keystore.', 'error');
        }
      } catch (err) {
        await showAlert('Error', err.message, 'error');
      }
    });

    // Import Form
    formKsImport.addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = {
        provider: 'import',
        params: {
          srcPath: document.getElementById('import-path').value.trim(),
          keyAlias: document.getElementById('import-alias').value.trim(),
          storePassword: document.getElementById('import-store-pass').value,
          keyPassword: document.getElementById('import-key-pass').value,
        },
      };

      try {
        const res = await fetch('/api/keystore/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (res.ok) {
          await showAlert('Success', 'Keystore imported successfully!', 'success');
          fetchKeystoreStatus();
        } else {
          await showAlert('Import Failed', data.error || 'Failed to import keystore.', 'error');
        }
      } catch (err) {
        await showAlert('Error', err.message, 'error');
      }
    });

    // Generate Form
    formKsGenerate.addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = {
        provider: 'generate',
        params: {
          filename: document.getElementById('gen-filename').value.trim() || 'release.jks',
          keyAlias: document.getElementById('gen-alias').value.trim() || 'release',
          storePassword: document.getElementById('gen-store-pass').value,
          keyPassword: document.getElementById('gen-key-pass').value || document.getElementById('gen-store-pass').value,
          cn: document.getElementById('gen-cn').value.trim() || 'Release Signer',
          org: document.getElementById('gen-org').value.trim() || 'Unknown',
          country: document.getElementById('gen-country').value.trim() || 'US',
        },
      };

      try {
        const res = await fetch('/api/keystore/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (res.ok) {
          await showAlert('Success', 'Keystore generated successfully via keytool!', 'success');
          fetchKeystoreStatus();
        } else {
          await showAlert('Generation Failed', data.error || 'Failed to generate keystore.', 'error');
        }
      } catch (err) {
        await showAlert('Error', err.message, 'error');
      }
    });

    // Trigger Rehydrate
    btnTriggerRehydrate.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/keystore/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: 'rehydrate' }),
        });
        const data = await res.json();
        if (res.ok) {
          await showAlert('Success', 'Keystore rehydrated successfully!', 'success');
          fetchKeystoreStatus();
        } else {
          await showAlert('Rehydration Failed', data.error || 'Failed to rehydrate keystore.', 'error');
        }
      } catch (err) {
        await showAlert('Error', err.message, 'error');
      }
    });

    // Trigger EAS Fetch
    btnTriggerEasFetch.addEventListener('click', () => {
      openPtyAndRun('eas-credentials');
    });
  }

  function updateSelectedFileName() {
    if (inputJksFile.files && inputJksFile.files[0]) {
      selectedFileName.textContent = `Selected: ${inputJksFile.files[0].name} (${(inputJksFile.files[0].size / 1024).toFixed(1)} KB)`;
    } else {
      selectedFileName.textContent = '';
    }
  }

  async function fetchKeystoreStatus() {
    try {
      const res = await fetch('/api/keystore/status');
      if (!res.ok) return;
      const data = await res.json();

      if (data.configured && data.props) {
        keystoreStatusContent.innerHTML = `
          <div class="alert ok margin-bottom">
            <strong>Keystore Configured:</strong> <code>keystore.properties</code> is present and valid.
          </div>
          <div class="form-row">
            <div><strong>Store File:</strong> <code>${escapeHtml(data.props.storeFile)}</code></div>
            <div><strong>Key Alias:</strong> <code>${escapeHtml(data.props.keyAlias)}</code></div>
          </div>
        `;
      } else if (data.rehydrateCandidate) {
        keystoreStatusContent.innerHTML = `
          <div class="alert info margin-bottom">
            <strong>Rehydrate Available:</strong> Found <code>credentials.json</code> referencing <code>${escapeHtml(data.rehydrateCandidate.jksSource)}</code>.
          </div>
          <p>Click "Perform Rehydration" in the Rehydrate tab to quickly restore <code>keystore.properties</code> without password re-entry.</p>
        `;
      } else {
        keystoreStatusContent.innerHTML = `
          <div class="alert danger margin-bottom">
            <strong>No Active Keystore:</strong> <code>keystore.properties</code> is missing or incomplete. Use the wizard below to upload, import, or generate a keystore before building.
          </div>
        `;
      }
    } catch {
      // Ignore
    }
  }

  // ── Terminal Dock & Web PTY ──
  function setupTerminalDock() {
    btnDockToggle.addEventListener('click', () => {
      terminalDock.classList.toggle('collapsed');
      if (!terminalDock.classList.contains('collapsed') && fitAddon) {
        setTimeout(() => fitAddon.fit(), 100);
      }
      btnDockToggle.textContent = terminalDock.classList.contains('collapsed')
        ? 'Expand Terminal'
        : 'Collapse Terminal';
    });

    btnDockClear.addEventListener('click', () => {
      if (term) term.clear();
    });

    window.addEventListener('resize', () => {
      if (fitAddon && !terminalDock.classList.contains('collapsed')) {
        fitAddon.fit();
      }
    });
  }

  function ensureTerminalInitialized() {
    if (term) return;

    term = new window.Terminal({
      cursorBlink: true,
      theme: {
        background: '#0a0806',
        foreground: '#ece5d6',
        cursor: '#f0824e',
        selectionBackground: 'rgba(240, 130, 78, 0.3)',
      },
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 13,
    });

    fitAddon = new window.FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById('terminal-container'));
    fitAddon.fit();

    term.onData((data) => {
      if (ptyWs && ptyWs.readyState === WebSocket.OPEN) {
        ptyWs.send(JSON.stringify({ type: 'input', data }));
      }
    });
  }

  function openPtyAndRun(commandId) {
    terminalDock.classList.remove('collapsed');
    btnDockToggle.textContent = 'Collapse Terminal';
    ensureTerminalInitialized();
    term.focus();
    if (fitAddon) fitAddon.fit();

    connectPtyWebSocket(commandId);
  }

  function connectPtyWebSocket(commandId) {
    if (ptyWs) {
      try {
        ptyWs.close();
      } catch {
        // ignore
      }
      ptyWs = null;
    }

    const loc = window.location;
    const wsProtocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${loc.host}/pty`;

    ptyStatusText.textContent = 'Connecting...';
    ptyWs = new WebSocket(wsUrl);

    ptyWs.onopen = () => {
      ptyConnected = true;
      ptyStatusText.textContent = `Running ${commandId}`;
      term.writeln(`\r\n\x1b[33m--- Launching allowlisted command: ${commandId} ---\x1b[0m\r\n`);

      const dims = fitAddon ? fitAddon.proposeDimensions() : { cols: 80, rows: 24 };
      ptyWs.send(
        JSON.stringify({
          type: 'start',
          command: commandId,
          cols: dims ? dims.cols : 80,
          rows: dims ? dims.rows : 24,
        })
      );
    };

    ptyWs.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'output') {
          term.write(msg.data);
        } else if (msg.type === 'exit') {
          term.writeln(`\r\n\x1b[32m[Process exited with code ${msg.exitCode}]\x1b[0m\r\n`);
          ptyStatusText.textContent = 'Idle';
        } else if (msg.type === 'pty-unavailable') {
          term.writeln(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`);
          ptyStatusText.textContent = 'PTY Unavailable';
        } else if (msg.type === 'error') {
          term.writeln(`\r\n\x1b[31mError: ${msg.message}\x1b[0m\r\n`);
          ptyStatusText.textContent = 'Error';
        }
      } catch {
        term.write(event.data);
      }
    };

    ptyWs.onclose = () => {
      ptyConnected = false;
      ptyStatusText.textContent = 'Disconnected';
    };

    ptyWs.onerror = () => {
      ptyStatusText.textContent = 'Connection Error';
    };
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Run on load
  document.addEventListener('DOMContentLoaded', init);
})();
