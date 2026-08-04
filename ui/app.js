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

  const projectChip = document.getElementById('project-chip');
  const projectNameText = document.getElementById('project-name-text');

  const doctorGrid = document.getElementById('doctor-grid');
  const doctorSummaryBanner = document.getElementById('doctor-summary-banner');
  const btnRefreshDoctor = document.getElementById('btn-refresh-doctor');
  const doctorActionsBar = document.getElementById('doctor-actions-bar');
  const btnFixAll = document.getElementById('btn-fix-all');
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
  const btnTriggerEasAuto = document.getElementById('btn-trigger-eas-auto-gen');
  const btnTriggerEasUploadLocal = document.getElementById('btn-trigger-eas-upload-local');
  const btnTriggerEasLink = document.getElementById('btn-trigger-eas-link');
  const easLinkSummary = document.getElementById('eas-link-summary');
  const easKeystoreStatus = document.getElementById('eas-keystore-status');
  const easKeystoreList = document.getElementById('eas-keystore-list');
  const easActionButtons = document.getElementById('eas-action-buttons');
  const scaffoldStatus = document.getElementById('scaffold-status');
  const btnScaffold = document.getElementById('btn-scaffold');

  const buildTabDoctorBanner = document.getElementById('build-tab-doctor-banner');
  const buildDoctorTitle = document.getElementById('build-doctor-title');
  const buildDoctorBadge = document.getElementById('build-doctor-badge');
  const buildDoctorText = document.getElementById('build-doctor-text');
  const buildDoctorList = document.getElementById('build-doctor-list');
  const btnBuildFixAll = document.getElementById('btn-build-fix-all');
  const btnBuildGotoDoctor = document.getElementById('btn-build-goto-doctor');

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
  let currentStatusData = null;

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
      modalIconBadge.innerHTML = type === 'success'
        ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>'
        : type === 'error'
        ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>'
        : '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>';

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
      modalIconBadge.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>';
      modalInputContainer.style.display = 'none';
      modalChoiceContainer.innerHTML = '';
      modalChoiceContainer.style.display = 'flex';
      modalChoiceContainer.style.flexDirection = 'column';
      modalChoiceContainer.style.gap = '8px';
      modalBtnConfirm.textContent = confirmText;
      modalBtnCancel.textContent = 'Cancel';
      modalBtnCancel.style.display = 'inline-flex';

      if (options.length > 3) {
        const searchBox = document.createElement('div');
        searchBox.className = 'choice-search-box';
        searchBox.style.marginBottom = '4px';
        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.className = 'form-input';
        searchInput.placeholder = 'Search / filter projects...';
        searchInput.style.padding = '8px 12px';
        searchInput.style.fontSize = '13px';
        searchBox.appendChild(searchInput);
        modalChoiceContainer.appendChild(searchBox);

        searchInput.addEventListener('input', () => {
          const q = searchInput.value.toLowerCase().trim();
          modalChoiceContainer.querySelectorAll('.choice-option').forEach((optBtn) => {
            const val = optBtn.getAttribute('data-value') || '';
            const text = optBtn.textContent.toLowerCase();
            if (val === '__create__' || !q || text.includes(q)) {
              optBtn.style.display = 'flex';
            } else {
              optBtn.style.display = 'none';
            }
          });
        });

        setTimeout(() => searchInput.focus(), 50);
      }

      options.forEach((option) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'choice-option';
        button.setAttribute('data-value', option.value);
        button.innerHTML = `<strong>${escapeHtml(option.label)}</strong>${option.detail ? `<span>${escapeHtml(option.detail)}</span>` : ''}`;
        button.addEventListener('click', () => {
          selected = option.value;
          modalChoiceContainer.querySelectorAll('.choice-option').forEach((item) => item.classList.remove('selected'));
          button.classList.add('selected');
        });
        button.addEventListener('dblclick', () => {
          selected = option.value;
          cleanup();
          resolve(selected);
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

  function switchTab(targetTab) {
    tabBtns.forEach((b) => {
      if (b.getAttribute('data-tab') === targetTab) b.classList.add('active');
      else b.classList.remove('active');
    });
    tabPanels.forEach((p) => {
      if (p.id === `panel-${targetTab}`) p.classList.add('active');
      else p.classList.remove('active');
    });
    if (targetTab === 'doctor') fetchDoctor();
    if (targetTab === 'keystore') fetchKeystoreStatus();
    if (targetTab === 'scaffold') fetchScaffoldStatus();
  }

  // ── Tab Navigation ──
  function setupTabNavigation() {
    tabBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        switchTab(btn.getAttribute('data-tab'));
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
      currentStatusData = data;
      hostInfo.textContent = `127.0.0.1:${data.port}`;

      if (data.projectName || data.folderName) {
        const name = data.projectName || data.folderName;
        if (projectNameText && projectChip) {
          projectNameText.textContent = name;
          projectChip.title = data.cwd ? `Folder: ${data.cwd}` : name;
          projectChip.style.display = 'inline-flex';
        }
      }

      if (data.easLink) {
        updateEasLinkUI(data.easLink);
      }

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

  function updateEasLinkUI(easLink) {
    if (!easLinkSummary || !btnTriggerEasLink) return;
    if (easLink && easLink.kind === 'linked' && easLink.projectId) {
      easLinkSummary.innerHTML = `Linked to EAS project ID <code>${escapeHtml(easLink.projectId)}</code>`;
      btnTriggerEasLink.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" style="margin-right: 4px; vertical-align: middle;"><path fill="currentColor" d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74A7.93 7.93 0 0 0 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>Relink / Change Project`;
      btnTriggerEasLink.className = 'btn btn-secondary btn-sm';
    } else if (easLink && easLink.kind === 'linked') {
      easLinkSummary.textContent = 'Linked to EAS project';
      btnTriggerEasLink.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" style="margin-right: 4px; vertical-align: middle;"><path fill="currentColor" d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74A7.93 7.93 0 0 0 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>Relink / Change Project`;
      btnTriggerEasLink.className = 'btn btn-secondary btn-sm';
    } else {
      easLinkSummary.textContent = 'Not linked to an EAS project';
      btnTriggerEasLink.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" style="margin-right: 4px; vertical-align: middle;"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>Link / Create EAS Project`;
      btnTriggerEasLink.className = 'btn btn-primary btn-sm';
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
    const welcome = logConsole.querySelector('.log-welcome-box');
    if (welcome) welcome.remove();

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
    if (btnBuildFixAll) {
      btnBuildFixAll.addEventListener('click', () => fixAllDoctorIssues());
    }
    if (btnBuildGotoDoctor) {
      btnBuildGotoDoctor.addEventListener('click', () => switchTab('doctor'));
    }

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
    btnRefreshDoctor.addEventListener('click', () => fetchDoctor(true));

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

    if (btnFixAll) btnFixAll.addEventListener('click', fixAllDoctorIssues);
    btnEasInit.addEventListener('click', linkEasProject);
    if (btnTriggerEasLink) btnTriggerEasLink.addEventListener('click', () => linkEasProject(btnTriggerEasLink));
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

  let doctorAbortController = null;
  let lastDoctorSummary = null;

  async function fixAllDoctorIssues() {
    const originalText = btnFixAll ? btnFixAll.textContent : '';
    if (btnFixAll) {
      btnFixAll.disabled = true;
      btnFixAll.textContent = 'Fixing all issues...';
    }

    try {
      const caps = lastDoctorSummary?.capabilities || {};
      const fixesApplied = [];

      // 1. Fix Package Name if invalid or missing
      if (caps.canFixAndroidPackage) {
        const rawFolder = (currentStatusData && currentStatusData.folderName) || 'app';
        const cleanName = rawFolder.toLowerCase().replace(/[^a-z0-9]/g, '') || 'app';
        const defaultPkg = `com.example.${cleanName}`;

        const selectedPkg = await showPrompt(
          'Set Android Package Name',
          'Enter your Android applicationId (e.g. com.yourcompany.yourapp):',
          defaultPkg,
          'com.yourcompany.yourapp',
          (val) => {
            if (!val) return 'Package name cannot be empty.';
            if (!/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(val)) {
              return 'Need at least two dot-separated segments (e.g. com.yourcompany.yourapp).';
            }
            return null;
          }
        );

        if (selectedPkg) {
          const res = await apiRequest('/api/doctor/fix-package', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ packageName: selectedPkg }),
          });
          if (res.res.ok) fixesApplied.push(`Set package name to ${selectedPkg}`);
        }
      }

      // 2. Link EAS Project
      if (caps.canEasInit) {
        await linkEasProject();
        fixesApplied.push('Linked EAS Project');
      }

      // 3. Create eas.json
      if (caps.canEasConfigure) {
        const res = await apiRequest('/api/eas/configure', { method: 'POST' });
        if (res.res.ok) fixesApplied.push('Created eas.json');
      }

      // 4. Keystore Setup (Rehydrate / Fetch from EAS Cloud / Generate)
      if (caps.rehydrateAvailable) {
        const res = await apiRequest('/api/doctor/rehydrate', { method: 'POST' });
        if (res.res.ok) fixesApplied.push('Synced credentials.json & keystore configuration');
      } else if (caps.canSetupKeystore) {
        let easFetched = false;
        try {
          const fetchRes = await apiRequest('/api/keystore/fetch-eas', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ overwrite: true }),
          });
          if (fetchRes.res.ok) {
            easFetched = true;
            fixesApplied.push(`Fetched cloud release keystore (${fetchRes.data.storeFile || 'release.jks'}) & credentials.json from EAS`);
          }
        } catch {
          // No EAS keystore available or unlinked/unauthenticated
        }

        if (!easFetched) {
          const pass = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(36)).join('').slice(0, 16);
          const res = await apiRequest('/api/keystore/setup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              provider: 'generate',
              params: {
                filename: 'release.p12',
                keyAlias: 'release',
                storePassword: pass,
                keyPassword: pass,
                cn: 'Release Signer',
                org: 'LocalExpoBuild',
                country: 'US',
              },
            }),
          });
          if (res.res.ok) {
            let easUploadMsg = '';
            try {
              const uploadRes = await apiRequest('/api/eas/keystores/upload', { method: 'POST' });
              if (uploadRes.res.ok) {
                easUploadMsg = ' & uploaded to EAS Cloud';
              }
            } catch {}
            fixesApplied.push(`Generated new release keystore (release.p12) & credentials.json${easUploadMsg}`);
          }
        }
      }

      await showAlert(
        'Quick Fix Complete!',
        fixesApplied.length
          ? `Successfully applied the following fixes:\n\n• ` + fixesApplied.join('\n• ')
          : 'Environment checks updated.',
        'success'
      );

      fetchDoctor(true);
      fetchKeystoreStatus();
    } catch (err) {
      await showAlert('Error', err?.message || 'An error occurred during quick fix.', 'error');
    } finally {
      if (btnFixAll) {
        btnFixAll.disabled = false;
        btnFixAll.textContent = originalText;
      }
    }
  }

  async function fetchDoctor(force = false) {
    if (force) {
      if (doctorAbortController) {
        doctorAbortController.abort();
        doctorAbortController = null;
      }
      doctorRequest = null;
    } else if (doctorRequest) {
      return doctorRequest;
    }

    doctorRequest = (async () => {
      const controller = new AbortController();
      doctorAbortController = controller;
      const timeout = setTimeout(() => controller.abort(), 15_000);
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
        if (err.name === 'AbortError' && doctorAbortController !== controller) {
          return;
        }
        doctorSummaryBanner.className = 'alert danger margin-bottom';
        doctorSummaryBanner.textContent = err.name === 'AbortError'
          ? 'Doctor checks timed out. Click Refresh Doctor to retry.'
          : `Error: ${err.message}`;
      } finally {
        clearTimeout(timeout);
        if (doctorAbortController === controller) {
          doctorAbortController = null;
          doctorRequest = null;
        }
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

    doctorSummaryBanner.className = 'alert info margin-bottom';
    doctorSummaryBanner.innerHTML = '<div style="display: flex; align-items: center; gap: 10px; font-size: 13px; font-weight: 600;"><span class="spinner"></span><span>Running environment diagnostics...</span></div>';

    if (buildTabDoctorBanner) {
      buildTabDoctorBanner.style.display = 'block';
      if (buildDoctorBadge) {
        buildDoctorBadge.textContent = 'Analyzing...';
        buildDoctorBadge.className = 'check-status-badge warn';
      }
      if (buildDoctorTitle) {
        buildDoctorTitle.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align: -2px; margin-right: 4px; fill: currentColor;"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>Running Environment Diagnostics...';
      }
      if (buildDoctorText) {
        buildDoctorText.textContent = 'Checking SDK dependencies, keystore signing configuration, and EAS status...';
      }
      if (buildDoctorList) {
        buildDoctorList.innerHTML = '<div style="display: flex; align-items: center; gap: 10px; padding: 6px 0; color: var(--color-text-secondary); font-size: 12px;"><span class="spinner"></span><span>Evaluating system configuration...</span></div>';
      }
    }
  }

  function renderDoctorResults(summary) {
    setDoctorLoading(false);
    const { capabilities } = summary;
    // The browser UI currently supports Android builds only. Keep iOS diagnostics
    // available to the CLI doctor command, but do not surface them here.
    const results = summary.results.filter((check) => check.name !== 'iOS build prerequisites');
    const failed = results.filter((r) => !r.ok);
    const warnings = results.filter((r) => r.ok && r.warn);

    let actionCount = 0;
    if (capabilities.canFixAndroidPackage) actionCount++;
    if (capabilities.canEasInit) actionCount++;
    if (capabilities.canEasConfigure) actionCount++;
    if (capabilities.rehydrateAvailable) actionCount++;
    if (capabilities.canSetupKeystore && !capabilities.rehydrateAvailable) actionCount++;

    if (failed.length > 0) {
      doctorSummaryBanner.className = 'alert danger margin-bottom';
      const msg = warnings.length > 0
        ? `${failed.length} check(s) failing & ${warnings.length} setup notice(s):`
        : `${failed.length} check(s) failing. Fix these before building:`;
      renderDoctorSummary(msg, failed, warnings);
    } else if (warnings.length > 0 || actionCount > 0) {
      doctorSummaryBanner.className = 'alert info margin-bottom';
      renderDoctorSummary(
        `Core setup ready. ${warnings.length || actionCount} setup item(s) / notice(s) to review:`,
        warnings
      );
    } else {
      doctorSummaryBanner.className = 'alert ok margin-bottom';
      doctorSummaryBanner.textContent = 'All environment checks passed! You are ready to build.';
    }

    // Render capability buttons
    lastDoctorSummary = summary;
    let hasAction = false;
    btnFixPkg.style.display = capabilities.canFixAndroidPackage ? 'inline-flex' : 'none';
    btnEasInit.style.display = capabilities.canEasInit ? 'inline-flex' : 'none';
    btnEasConfigure.style.display = capabilities.canEasConfigure ? 'inline-flex' : 'none';
    btnDoctorRehydrate.style.display = capabilities.rehydrateAvailable ? 'inline-flex' : 'none';

    if (btnFixAll) {
      btnFixAll.style.display = actionCount > 0 ? 'inline-flex' : 'none';
    }

    if (
      actionCount > 0 ||
      capabilities.canFixAndroidPackage ||
      capabilities.canEasInit ||
      capabilities.canEasConfigure ||
      capabilities.rehydrateAvailable
    ) {
      hasAction = true;
    }
    doctorActionsBar.style.display = hasAction ? 'flex' : 'none';

    // Render Build Tab Doctor Attention / Success Banner
    if (buildTabDoctorBanner) {
      if (actionCount > 0 || failed.length > 0 || warnings.length > 0) {
        buildTabDoctorBanner.style.display = 'block';
        buildTabDoctorBanner.style.background = 'rgba(216, 182, 56, 0.08)';
        buildTabDoctorBanner.style.borderColor = 'var(--color-border-hi)';

        if (buildDoctorBadge) {
          if (failed.length > 0 && warnings.length > 0) {
            buildDoctorBadge.textContent = `${failed.length} Failing • ${warnings.length} Notice(s)`;
            buildDoctorBadge.className = 'check-status-badge fail';
          } else if (failed.length > 0) {
            buildDoctorBadge.textContent = `${failed.length} Failing Check(s)`;
            buildDoctorBadge.className = 'check-status-badge fail';
          } else {
            buildDoctorBadge.textContent = `${warnings.length || actionCount} Setup Notice(s)`;
            buildDoctorBadge.className = 'check-status-badge warn';
          }
        }

        if (buildDoctorTitle) {
          const svgIcon = '<svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align: -2px; margin-right: 4px; fill: currentColor;"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>';
          if (failed.length > 0 && warnings.length > 0) {
            buildDoctorTitle.innerHTML = `${svgIcon}Project Setup & Signing Attention Required (${failed.length} Failing, ${warnings.length} Notice(s))`;
            buildDoctorTitle.style.color = 'var(--color-danger)';
          } else if (failed.length > 0) {
            buildDoctorTitle.innerHTML = `${svgIcon}Project Setup Attention Required (${failed.length} Failing)`;
            buildDoctorTitle.style.color = 'var(--color-danger)';
          } else {
            buildDoctorTitle.innerHTML = `${svgIcon}Signing & EAS Setup Recommendations (${warnings.length || actionCount} Notice(s))`;
            buildDoctorTitle.style.color = 'var(--color-warn)';
          }
        }

        if (buildDoctorText) {
          buildDoctorText.textContent = 'Want to sign your release app with a custom keystore or link with EAS? Resolve setup items below:';
        }

        if (buildDoctorList) {
          let listHtml = '<ul style="margin: 4px 0 0 16px; padding: 0; font-size: 12px; line-height: 1.6;">';
          failed.forEach((f) => {
            listHtml += `<li style="color: var(--color-danger); margin-bottom: 2px;"><strong>${escapeHtml(f.name)}:</strong> ${escapeHtml(f.detail || 'failing check')}</li>`;
          });
          warnings.forEach((w) => {
            listHtml += `<li style="color: var(--color-warn); margin-bottom: 2px;"><strong>${escapeHtml(w.name)}:</strong> ${escapeHtml(w.detail || 'setup notice')}</li>`;
          });
          listHtml += '</ul>';
          buildDoctorList.innerHTML = listHtml;
          buildDoctorList.style.display = 'block';
        }
        if (btnBuildFixAll) btnBuildFixAll.style.display = 'inline-flex';
      } else {
        // All checks & setup items passed — render green success banner
        buildTabDoctorBanner.style.display = 'block';
        buildTabDoctorBanner.style.background = 'rgba(34, 197, 94, 0.08)';
        buildTabDoctorBanner.style.borderColor = 'rgba(34, 197, 94, 0.3)';

        if (buildDoctorBadge) {
          buildDoctorBadge.textContent = 'ALL PASS';
          buildDoctorBadge.className = 'check-status-badge pass';
        }

        if (buildDoctorTitle) {
          const checkSvg = '<svg viewBox="0 0 24 24" width="16" height="16" style="vertical-align: -3px; margin-right: 6px; fill: currentColor;"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>';
          buildDoctorTitle.innerHTML = `${checkSvg}Project Setup & Release Signing Ready`;
          buildDoctorTitle.style.color = '#4ade80';
        }

        if (buildDoctorText) {
          buildDoctorText.textContent = 'All environment checks, Android package config, EAS linking, and release signing credentials passed. You are ready to start building!';
        }

        if (buildDoctorList) {
          buildDoctorList.innerHTML = '';
          buildDoctorList.style.display = 'none';
        }

        if (btnBuildFixAll) btnBuildFixAll.style.display = 'none';
      }
    }

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

    if (primaryChecks.length > 0) {
      const list = document.createElement('ul');
      list.className = 'doctor-summary-list';
      primaryChecks.forEach((check) => {
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

    if (secondaryWarnings.length > 0) {
      if (primaryChecks.length > 0) {
        const subHeading = document.createElement('div');
        subHeading.style.marginTop = '10px';
        subHeading.style.marginBottom = '4px';
        subHeading.style.fontWeight = '700';
        subHeading.style.fontSize = '12px';
        subHeading.style.color = 'var(--color-text-secondary)';
        subHeading.textContent = 'Notices & Recommendations:';
        doctorSummaryBanner.appendChild(subHeading);
      }

      const warnList = document.createElement('ul');
      warnList.className = 'doctor-summary-list';
      secondaryWarnings.forEach((check) => {
        const item = document.createElement('li');
        const name = document.createElement('strong');
        name.textContent = check.name;
        item.appendChild(name);
        if (check.detail) {
          const detail = document.createElement('span');
          detail.textContent = ` — ${check.detail}`;
          item.appendChild(detail);
        }
        warnList.appendChild(item);
      });
      doctorSummaryBanner.appendChild(warnList);
    }
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
          filename: document.getElementById('gen-filename').value.trim() || 'release.p12',
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
    if (btnTriggerEasAuto) btnTriggerEasAuto.addEventListener('click', generateKeystoreAuto);
    if (btnTriggerEasUploadLocal) btnTriggerEasUploadLocal.addEventListener('click', uploadLocalKeystoreToEasUI);
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

  async function linkEasProject(targetBtn) {
    const btn = (targetBtn && targetBtn.target ? null : targetBtn) || btnEasInit;
    const originalText = btn ? btn.textContent : '';
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Loading EAS projects…';
    }
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
      if (btn) btn.textContent = 'Loading EAS projects…';
      const { res, data } = await apiRequest(`/api/eas/projects?account=${encodeURIComponent(account.name)}`);
      if (!res.ok) return showAlert('Could not load projects', data.error || 'Please try again.', 'error');
      const projects = Array.isArray(data.projects) ? data.projects : [];
      const options = [
        { value: '__create__', label: '+ Create a new EAS project', detail: `in ${account.name}` },
        ...projects.map((project) => ({ value: project.id, label: project.fullName || project.name, detail: project.slug || project.id })),
      ];
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
      if (btn) {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    }
  }

  async function configureEas() {
    const originalText = btnEasConfigure ? btnEasConfigure.textContent : '';
    if (btnEasConfigure) {
      btnEasConfigure.disabled = true;
      btnEasConfigure.textContent = 'Creating eas.json...';
    }
    try {
      const { res, data } = await apiRequest('/api/eas/configure', { method: 'POST' });
      if (!res.ok) return showAlert('Could not create eas.json', data.error || 'Please try again.', 'error');
      await showAlert('EAS configured', data.created ? 'Generated eas.json for Android successfully.' : 'eas.json already exists and was left unchanged.', 'success');
      fetchDoctor();
    } catch (err) {
      await showAlert('Could not create eas.json', err?.message || 'An error occurred.', 'error');
    } finally {
      if (btnEasConfigure) {
        btnEasConfigure.disabled = false;
        btnEasConfigure.textContent = originalText;
      }
    }
  }

  async function fetchEasKeystores() {
    easKeystoreStatus.textContent = 'Loading EAS Android keystores...';
    const { res, data } = await apiRequest('/api/eas/keystores');
    if (!res.ok) {
      easKeystores = [];
      easKeystoreList.innerHTML = '';
      easKeystoreStatus.textContent = data.error || 'Link an EAS project and authenticate to list stored keystores.';
      updateEasLinkUI({ kind: 'not-linked' });
      if (easActionButtons) easActionButtons.style.display = 'none';
      return;
    }
    updateEasLinkUI({ kind: 'linked', projectId: data.projectId });
    if (easActionButtons) easActionButtons.style.display = 'flex';
    easKeystores = data.keystores || [];
    renderEasKeystores();
  }

  function renderEasKeystores() {
    if (!easKeystores.length) {
      easKeystoreStatus.textContent = 'No Android keystores are stored for this EAS project.';
      easKeystoreList.innerHTML = '';
      if (btnTriggerEasFetch) btnTriggerEasFetch.style.display = 'none';
      return;
    }
    if (btnTriggerEasFetch) btnTriggerEasFetch.style.display = 'inline-flex';
    easKeystoreStatus.textContent = 'Choose the Android build credentials to fetch.';
    easKeystoreList.innerHTML = easKeystores.map((store) => `<label class="remote-list-item"><input type="radio" name="eas-keystore" value="${escapeHtml(store.buildCredentialsId)}" ${store.isDefault ? 'checked' : ''}><span><strong>${escapeHtml(store.name)}</strong>${store.isDefault ? ' <em>Default</em>' : ''}<small>${escapeHtml(store.keyAlias || 'No alias')} · ${escapeHtml(store.type)}${store.applicationIdentifier ? ` · ${escapeHtml(store.applicationIdentifier)}` : ''}</small></span></label>`).join('');
  }

  async function fetchEasKeystore() {
    if (!easKeystores.length) await fetchEasKeystores();
    if (!easKeystores.length) {
      return showAlert(
        'No Keystores Found on EAS',
        'No Android keystores exist on your EAS project yet.\n\n' +
        '• To generate a new keystore on EAS directly: Run `eas credentials` in terminal and select "Set up build credentials / Create a new Android keystore".\n\n' +
        '• To generate a local keystore instantly: Click the "Generate Keystore" tab above.',
        'info'
      );
    }
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

  async function generateKeystoreAuto() {
    const originalText = btnTriggerEasAuto ? btnTriggerEasAuto.textContent : '';
    if (btnTriggerEasAuto) {
      btnTriggerEasAuto.disabled = true;
      btnTriggerEasAuto.textContent = 'Generating...';
    }
    try {
      const pass = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(36)).join('').slice(0, 16);
      const { res, data } = await apiRequest('/api/keystore/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'generate',
          params: {
            filename: 'release.p12',
            keyAlias: 'release',
            storePassword: pass,
            keyPassword: pass,
            cn: 'Release Signer',
            org: 'LocalExpoBuild',
            country: 'US',
          },
        }),
      });
      if (!res.ok) {
        return showAlert('Could not generate keystore', data.error || 'Keytool generation failed.', 'error');
      }

      let easSynced = false;
      let easSyncError = '';
      try {
        const uploadResult = await apiRequest('/api/eas/keystores/upload', { method: 'POST' });
        if (uploadResult.res.ok) {
          easSynced = true;
        } else {
          easSyncError = uploadResult.data.error || 'Could not sync to EAS.';
        }
      } catch (err) {
        easSyncError = err?.message || 'EAS sync failed.';
      }

      const syncMsg = easSynced
        ? '✓ Uploaded & Synced directly to Expo EAS Cloud!'
        : `(Saved locally & to credentials.json. Note for EAS: ${easSyncError})`;

      await showAlert(
        'Keystore Created & Configured!',
        `Generated a new release keystore (release.p12) with alias "release".\n\n` +
          `• Saved locally to android/app/release.p12\n` +
          `• Configured in keystore.properties\n` +
          `• Synced with credentials.json\n` +
          `• ${syncMsg}`,
        'success'
      );
      fetchKeystoreStatus();
      fetchDoctor();
      fetchEasKeystores();
    } catch (err) {
      await showAlert('Error', err?.message || 'An error occurred.', 'error');
    } finally {
      if (btnTriggerEasAuto) {
        btnTriggerEasAuto.disabled = false;
        btnTriggerEasAuto.textContent = originalText;
      }
    }
  }

  async function uploadLocalKeystoreToEasUI() {
    const originalText = btnTriggerEasUploadLocal ? btnTriggerEasUploadLocal.textContent : '';
    if (btnTriggerEasUploadLocal) {
      btnTriggerEasUploadLocal.disabled = true;
      btnTriggerEasUploadLocal.textContent = 'Syncing...';
    }
    try {
      const { res, data } = await apiRequest('/api/eas/keystores/upload', { method: 'POST' });
      if (!res.ok) {
        return showAlert('Could not sync to EAS', data.error || 'Upload to EAS failed.', 'error');
      }
      await showAlert(
        'Synced to EAS Cloud!',
        `Successfully uploaded your local keystore to your linked EAS project.`,
        'success'
      );
      fetchEasKeystores();
    } catch (err) {
      await showAlert('Error', err?.message || 'An error occurred.', 'error');
    } finally {
      if (btnTriggerEasUploadLocal) {
        btnTriggerEasUploadLocal.disabled = false;
        btnTriggerEasUploadLocal.textContent = originalText;
      }
    }
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
