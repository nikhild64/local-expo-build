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
  const btnStopBuild = document.getElementById('btn-stop-build');
  const buildTimer = document.getElementById('build-timer');
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
  const easAuthStatus = document.getElementById('eas-auth-status');
  const easTokenForm = document.getElementById('eas-token-form');
  const easTokenInput = document.getElementById('eas-token');
  const btnRefreshAuth = document.getElementById('btn-refresh-auth');
  const easLoginHint = document.getElementById('eas-login-hint');

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
  const easKeystoreStatus = document.getElementById('eas-keystore-status');
  const easKeystoreList = document.getElementById('eas-keystore-list');
  const scaffoldStatus = document.getElementById('scaffold-status');
  const btnScaffold = document.getElementById('btn-scaffold');

  // Custom Modal Elements
  const modalOverlay = document.getElementById('custom-modal-overlay');
  const modalTitle = document.getElementById('modal-title');
  const modalMessage = document.getElementById('modal-message');
  const modalIconBadge = document.getElementById('modal-icon-badge');
  const modalInputContainer = document.getElementById('modal-input-container');
  const modalInputField = document.getElementById('modal-input-field');
  const modalInputError = document.getElementById('modal-input-error');
  const modalChoiceContainer = document.getElementById('modal-choice-container');
  const modalBtnCancel = document.getElementById('modal-btn-cancel');
  const modalBtnConfirm = document.getElementById('modal-btn-confirm');

  // Application State
  let selectedKind = 'aab';
  let isBuilding = false;
  let buildTimerInterval = null;
  let buildStartTime = null;
  let eventSource = null;
  let easAuth = null;
  let easKeystores = [];
  let doctorRequest = null;

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
      modalChoiceContainer.style.display = 'none';
      modalChoiceContainer.innerHTML = '';

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
        try {
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
        } catch (err) {
          modalInputError.textContent = err?.message || 'Invalid input.';
          modalInputError.style.display = 'block';
        }
      };

      if (showInput) {
        modalInputField.onkeydown = (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            modalBtnConfirm.click();
          }
        };
      } else {
        modalInputField.onkeydown = null;
      }
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

  function showChoiceModal({ title, message, options, confirmText = 'Select' }) {
    return new Promise((resolve) => {
      let selected = options.length === 1 ? options[0].value : null;
      modalTitle.textContent = title;
      modalMessage.textContent = message;
      modalIconBadge.className = 'modal-icon-badge info';
      modalIconBadge.textContent = 'ℹ';
      modalInputContainer.style.display = 'none';
      modalChoiceContainer.innerHTML = '';
      modalChoiceContainer.style.display = 'grid';
      modalBtnConfirm.textContent = confirmText;
      modalBtnCancel.textContent = 'Cancel';
      modalBtnCancel.style.display = 'inline-flex';
      options.forEach((option) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'choice-option';
        button.innerHTML = `<strong>${escapeHtml(option.label)}</strong>${option.detail ? `<span>${escapeHtml(option.detail)}</span>` : ''}`;
        button.addEventListener('click', () => {
          selected = option.value;
          modalChoiceContainer.querySelectorAll('.choice-option').forEach((item) => item.classList.remove('selected'));
          button.classList.add('selected');
        });
        if (selected === option.value) button.classList.add('selected');
        modalChoiceContainer.appendChild(button);
      });
      modalOverlay.style.display = 'flex';
      const cleanup = () => {
        modalOverlay.style.display = 'none';
        modalChoiceContainer.style.display = 'none';
        modalBtnConfirm.onclick = null;
        modalBtnCancel.onclick = null;
      };
      modalBtnCancel.onclick = () => { cleanup(); resolve(null); };
      modalBtnConfirm.onclick = () => {
        if (!selected) return;
        cleanup();
        resolve(selected);
      };
    });
  }

  // ── Initialization ──
  function init() {
    setupTabNavigation();
    setupPillSelector();
    setupBuildForm();
    setupDoctorTab();
    setupKeystoreTab();
    setupScaffoldTab();
    initSse();
    fetchStatus();
    fetchDoctor();
    fetchKeystoreStatus();
    fetchEasAuth();
    fetchScaffoldStatus();
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
        if (targetTab === 'scaffold') fetchScaffoldStatus();
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
      btnStopBuild.style.display = 'inline-flex';
      btnStopBuild.disabled = false;
      startBuildTimer();
    } else {
      statusPill.className = 'status-pill idle';
      statusText.textContent = 'Idle';
      btnStartBuild.disabled = false;
      btnStartBuild.querySelector('.btn-text').textContent = 'Start Local Build';
      btnStartBuild.querySelector('.btn-spinner').style.display = 'none';
      btnStopBuild.style.display = 'none';
      stopBuildTimer();
    }
  }

  function startBuildTimer() {
    stopBuildTimer();
    buildStartTime = Date.now();
    buildTimer.textContent = '00:00';
    buildTimer.style.display = 'inline-block';
    buildTimerInterval = setInterval(() => {
      if (!buildStartTime) return;
      const elapsed = Math.floor((Date.now() - buildStartTime) / 1000);
      const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const secs = String(elapsed % 60).padStart(2, '0');
      buildTimer.textContent = `${mins}:${secs}`;
    }, 1000);
  }

  function stopBuildTimer() {
    if (buildTimerInterval) {
      clearInterval(buildTimerInterval);
      buildTimerInterval = null;
    }
    buildStartTime = null;
    // keep the final time visible briefly, then hide on next build
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
      btnStopBuild.textContent = 'Stop Build';
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
      fetchEasKeystores();
    });

    eventSource.addEventListener('keystore-updated', () => {
      fetchKeystoreStatus();
      fetchDoctor();
      fetchEasKeystores();
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

    btnStopBuild.addEventListener('click', async () => {
      btnStopBuild.disabled = true;
      btnStopBuild.textContent = 'Stopping...';
      try {
        await fetch('/api/build/stop', { method: 'POST' });
      } catch {
        // ignore — the build-complete SSE will reset state
      }
    });

    buildForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      buildErrorBanner.style.display = 'none';

      const payload = {
        apk: selectedKind === 'apk',
        aab: selectedKind === 'aab',
        debug: document.getElementById('opt-debug').checked,
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

    btnEasInit.addEventListener('click', linkEasProject);
    btnEasConfigure.addEventListener('click', configureEas);
    btnRefreshAuth.addEventListener('click', fetchEasAuth);
    easTokenForm.addEventListener('submit', submitEasToken);

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
    if (doctorRequest) return doctorRequest;
    doctorRequest = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        setDoctorLoading(true);
        doctorSummaryBanner.className = 'alert info margin-bottom';
        doctorSummaryBanner.textContent = 'Checking environment dependencies...';

        const res = await fetch('/api/doctor', { signal: controller.signal });
        if (!res.ok) {
          doctorSummaryBanner.className = 'alert danger margin-bottom';
          doctorSummaryBanner.textContent = 'Failed to fetch doctor checks.';
          return;
        }

        const summary = await res.json();
        renderDoctorResults(summary);
      } catch (err) {
        doctorSummaryBanner.className = 'alert danger margin-bottom';
        doctorSummaryBanner.textContent = err.name === 'AbortError'
          ? 'Doctor checks timed out after 30 seconds. Click Refresh Doctor to retry.'
          : `Error: ${err.message}`;
      } finally {
        clearTimeout(timeout);
        doctorRequest = null;
        btnRefreshDoctor.disabled = false;
      }
    })();
    return doctorRequest;
  }

  function setDoctorLoading(isLoading) {
    btnRefreshDoctor.disabled = isLoading;
    if (!isLoading) return;
    doctorActionsBar.style.display = 'none';
    doctorGrid.innerHTML = '';
  }

  function renderDoctorResults(summary) {
    setDoctorLoading(false);
    const { capabilities } = summary;
    // The browser UI currently supports Android builds only. Keep iOS diagnostics
    // available to the CLI doctor command, but do not surface them here.
    const results = summary.results.filter((check) => check.name !== 'iOS build prerequisites');
    const failed = results.filter((r) => !r.ok);
    const warnings = results.filter((r) => r.ok && r.warn);

    if (failed.length > 0) {
      doctorSummaryBanner.className = 'alert danger margin-bottom';
      renderDoctorSummary(
        `⚠️ ${failed.length} check(s) failing. Fix these before building:`,
        failed,
        warnings
      );
    } else if (warnings.length > 0) {
      doctorSummaryBanner.className = 'alert info margin-bottom';
      renderDoctorSummary(
        `✓ Core setup ready. ${warnings.length} notice/warning item${warnings.length === 1 ? '' : 's'} to review:`,
        warnings
      );
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

  function renderDoctorSummary(message, primaryChecks, secondaryWarnings = []) {
    doctorSummaryBanner.replaceChildren();
    const heading = document.createElement('strong');
    heading.textContent = message;
    doctorSummaryBanner.appendChild(heading);

    const checks = [...primaryChecks, ...secondaryWarnings];
    const list = document.createElement('ul');
    list.className = 'doctor-summary-list';
    checks.forEach((check) => {
      const item = document.createElement('li');
      const name = document.createElement('strong');
      name.textContent = check.name;
      item.appendChild(name);
      if (check.detail) {
        const detail = document.createElement('span');
        detail.textContent = ` — ${check.detail}`;
        item.appendChild(detail);
      }
      list.appendChild(item);
    });
    doctorSummaryBanner.appendChild(list);
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

    btnTriggerEasFetch.addEventListener('click', fetchEasKeystore);
  }

  async function apiRequest(url, options = {}, retryAuth = true) {
    const res = await fetch(url, options);
    let data = {};
    try { data = await res.json(); } catch { /* empty response */ }
    if (res.status === 401 && retryAuth && await requestEasToken()) {
      return apiRequest(url, options, false);
    }
    return { res, data };
  }

  async function requestEasToken() {
    const token = await showPrompt(
      'EAS authentication required',
      'Paste an Expo access token to continue. It is kept only in this local server process.',
      '',
      'Expo access token',
      (value) => value ? null : 'An access token is required.'
    );
    if (!token) return false;
    return authenticateEasToken(token);
  }

  async function authenticateEasToken(token) {
    try {
      const { res, data } = await apiRequest('/api/eas/auth', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
      }, false);
      if (!res.ok) {
        await showAlert('Unable to authenticate', data.error || 'The access token was rejected.', 'error');
        return false;
      }
      easTokenInput.value = '';
      easAuth = data;
      renderEasAuth();
      return true;
    } catch (err) {
      await showAlert('Authentication error', err.message, 'error');
      return false;
    }
  }

  async function submitEasToken(event) {
    event.preventDefault();
    const token = easTokenInput.value.trim();
    if (token) await authenticateEasToken(token);
  }

  async function fetchEasAuth() {
    try {
      const { res, data } = await apiRequest('/api/eas/auth', {}, false);
      easAuth = res.ok ? data : { authenticated: false, source: 'none' };
      renderEasAuth();
      if (easAuth.authenticated) fetchEasKeystores();
    } catch {
      easAuth = { authenticated: false, source: 'none' };
      renderEasAuth();
    }
  }

  function renderEasAuth() {
    if (easAuth && easAuth.authenticated) {
      const accountNames = (easAuth.accounts || []).map((account) => account.name).join(', ');
      easAuthStatus.textContent = `Connected as ${easAuth.username}${accountNames ? ` · ${accountNames}` : ''}`;
      easTokenForm.style.display = 'none';
      if (easLoginHint) easLoginHint.style.display = 'none';
    } else {
      easAuthStatus.textContent = 'Connect an Expo access token to link projects and fetch EAS credentials.';
      easTokenForm.style.display = 'block';
      if (easLoginHint) easLoginHint.style.display = 'block';
    }
  }

  async function linkEasProject() {
    const originalText = btnEasInit.textContent;
    btnEasInit.disabled = true;
    try {
      if (!easAuth?.authenticated && !await requestEasToken()) return;
      const accounts = easAuth.accounts || [];
      if (!accounts.length) return showAlert('No EAS accounts', 'The authenticated account has no available EAS accounts.', 'error');
      const accountId = await showChoiceModal({
        title: 'Select EAS account', message: 'Choose where the project is managed.',
        options: accounts.map((account) => ({ value: account.id, label: account.name, detail: account.id })),
        confirmText: 'Continue',
      });
      if (!accountId) return;
      const account = accounts.find((item) => item.id === accountId);
      btnEasInit.textContent = 'Loading EAS projects…';
      const { res, data } = await apiRequest(`/api/eas/projects?account=${encodeURIComponent(account.name)}`);
      if (!res.ok) return showAlert('Could not load projects', data.error || 'Please try again.', 'error');
      const projects = Array.isArray(data.projects) ? data.projects : [];
      const options = projects.map((project) => ({ value: project.id, label: project.fullName || project.name, detail: project.slug || project.id }));
      options.push({ value: '__create__', label: 'Create a new EAS project', detail: `in ${account.name}` });
      const projectId = await showChoiceModal({ title: 'Link EAS project', message: 'Select an existing project or create one.', options });
      if (!projectId) return;
      let payload;
      if (projectId === '__create__') {
        const projectName = await showPrompt('Create EAS project', 'Enter a project name.', '', 'my-app', (value) => {
          if (!value) return 'A project name is required.';
          if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) return 'Use letters, numbers, dots, underscores, and hyphens; start with a letter or number.';
          return null;
        });
        if (!projectName) return;
        payload = { accountId, projectName };
      } else {
        payload = { projectId };
      }
      const requestLink = (body) => apiRequest('/api/eas/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      let result = await requestLink(payload);
      if (result.res.status === 409 && /already linked/i.test(result.data.error || '')) {
        const confirmed = await showModal({ title: 'Replace EAS project link?', message: result.data.error, type: 'info', confirmText: 'Replace link', showCancel: true });
        if (!confirmed) return;
        result = await requestLink({ ...payload, overwrite: true });
      }
      if (!result.res.ok) return showAlert('Could not link project', result.data.error || 'Please try again.', 'error');
      await showAlert('EAS project linked', `Project ${result.data.projectId} is now linked.`, 'success');
      fetchDoctor(); fetchEasKeystores();
    } catch (err) {
      await showAlert('Could not link EAS project', err.message || 'A network error occurred while contacting EAS.', 'error');
    } finally {
      btnEasInit.disabled = false;
      btnEasInit.textContent = originalText;
    }
  }

  async function configureEas() {
    const { res, data } = await apiRequest('/api/eas/configure', { method: 'POST' });
    if (!res.ok) return showAlert('Could not create eas.json', data.error || 'Please try again.', 'error');
    await showAlert('EAS configured', data.created ? 'EAS CLI generated eas.json for Android.' : 'eas.json already exists and was left unchanged.', 'success');
    fetchDoctor();
  }

  async function fetchEasKeystores() {
    easKeystoreStatus.textContent = 'Loading EAS Android keystores...';
    const { res, data } = await apiRequest('/api/eas/keystores');
    if (!res.ok) {
      easKeystores = [];
      easKeystoreList.innerHTML = '';
      easKeystoreStatus.textContent = data.error || 'Link an EAS project and authenticate to list stored keystores.';
      return;
    }
    easKeystores = data.keystores || [];
    renderEasKeystores();
  }

  function renderEasKeystores() {
    if (!easKeystores.length) {
      easKeystoreStatus.textContent = 'No Android keystores are stored for this EAS project.';
      easKeystoreList.innerHTML = '';
      return;
    }
    easKeystoreStatus.textContent = 'Choose the Android build credentials to fetch.';
    easKeystoreList.innerHTML = easKeystores.map((store) => `<label class="remote-list-item"><input type="radio" name="eas-keystore" value="${escapeHtml(store.buildCredentialsId)}" ${store.isDefault ? 'checked' : ''}><span><strong>${escapeHtml(store.name)}</strong>${store.isDefault ? ' <em>Default</em>' : ''}<small>${escapeHtml(store.keyAlias || 'No alias')} · ${escapeHtml(store.type)}${store.applicationIdentifier ? ` · ${escapeHtml(store.applicationIdentifier)}` : ''}</small></span></label>`).join('');
  }

  async function fetchEasKeystore() {
    if (!easKeystores.length) await fetchEasKeystores();
    const selection = document.querySelector('input[name="eas-keystore"]:checked');
    if (!selection) return showAlert('No EAS keystore selected', 'Choose a keystore to fetch first.', 'error');
    const fetchStore = async (overwrite) => apiRequest('/api/keystore/fetch-eas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ buildCredentialsId: selection.value, overwrite }) });
    let result = await fetchStore(false);
    if (result.res.status === 409 && /Confirm replacement|already exists/i.test(result.data.error || '')) {
      const confirmed = await showModal({ title: 'Replace local keystore?', message: result.data.error, type: 'info', confirmText: 'Replace', showCancel: true });
      if (!confirmed) return;
      result = await fetchStore(true);
    }
    if (!result.res.ok) return showAlert('Could not fetch keystore', result.data.error || 'Please try again.', 'error');
    await showAlert('Keystore fetched', `Saved ${result.data.storeFile} with alias ${result.data.keyAlias}.`, 'success');
    fetchKeystoreStatus(); fetchDoctor();
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

  // ── Scaffold Tab ──
  function setupScaffoldTab() {
    btnScaffold.addEventListener('click', scaffoldProjectAction);
  }

  async function fetchScaffoldStatus() {
    try {
      const res = await fetch('/api/scaffold/status');
      if (!res.ok) throw new Error('Non-OK response');
      const data = await res.json();
      renderScaffoldStatus(data);
    } catch {
      scaffoldStatus.innerHTML = '<div class="alert danger">Could not load scaffold status.</div>';
    }
  }

  function renderScaffoldStatus(data) {
    const existing = (data.scripts || []).filter((s) => s.exists);
    const texts = data.scripts ? data.scripts.map((s) => (s.exists ? `<strong>${escapeHtml(s.name)}</strong>` : escapeHtml(s.name))).join(' · ') : '';
    const pkg = data.pkgScripts || {};
    let html = `<div class="alert ${data.hasScripts ? 'ok' : 'info'} margin-bottom"><strong>${data.hasScripts ? `${existing.length} scaffolded script(s) present` : 'No scaffolded scripts yet'}</strong></div>`;
    html += `<div class="status-content"><p>Scripts: ${texts || 'none'}</p>`;
    html += `<div class="form-row"><div><strong>build:android:apk:</strong> <code>${escapeHtml(pkg.apk || 'not set')}</code></div><div><strong>build:android:aab:</strong> <code>${escapeHtml(pkg.aab || 'not set')}</code></div></div></div>`;
    scaffoldStatus.innerHTML = html;
  }

  async function scaffoldProjectAction() {
    let hasScripts = true;
    try {
      const statusRes = await fetch('/api/scaffold/status');
      if (statusRes.ok) {
        hasScripts = !!(await statusRes.json()).hasScripts;
      }
    } catch {
      // default to showing the choice if status is unavailable
    }

    let choice = 'keep';
    if (hasScripts) {
      choice = await showChoiceModal({
        title: 'Scaffold local build scripts',
        message: 'Scaffolded scripts already exist. How should we handle them?',
        options: [
          { value: 'keep', label: 'Scaffold (keep existing files)', detail: 'Adds missing scripts + npm entries only' },
          { value: 'overwrite', label: 'Scaffold & overwrite', detail: 'Replaces existing scripts/*.js and npm scripts' },
        ],
        confirmText: 'Continue',
      });
    }
    if (!choice) return;
    try {
      const res = await fetch('/api/scaffold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: choice === 'overwrite' }),
      });
      const data = await res.json();
      if (!res.ok) return showAlert('Scaffold failed', data.error || 'Please try again.', 'error');
      let msg = `Scaffolded ${data.wroteFiles.length} script(s).`;
      if (data.skippedFiles && data.skippedFiles.length) {
        msg += ` Skipped ${data.skippedFiles.length} existing file(s).`;
      }
      await showAlert('Scaffold complete', msg, 'success');
      fetchScaffoldStatus();
      fetchDoctor();
      await showModal({
        title: 'Now build from the terminal',
        message: 'npm run build:android:aab   (or: npm run build:android:apk)',
        type: 'info',
        confirmText: 'OK',
      });
    } catch (err) {
      await showAlert('Error', err.message, 'error');
    }
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
