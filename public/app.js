/* global io, Terminal, FitAddon, AsciinemaPlayer */
(() => {
  'use strict';

  // ---------------------------------------------------------------------
  //   State
  // ---------------------------------------------------------------------
  const state = {
    me: null,
    services: [],
    tabs: [], // [{serviceId, hostEl, term, fitAddon, ro}]
    activeTabId: null,
    users: [],
    sftp: { path: '.' }, // active SFTP browsing state
    recPlayer: null,
    activeRecording: null,
    serviceMetrics: new Map(), // serviceId -> latest LOCAL sidebar metrics
    contextMetrics: new Map(), // serviceId -> latest scoped metrics snapshot
    contextWatched: new Set(), // serviceIds we've asked the server to poll
    lastHostMetrics: null,
    alertState: new Map(), // serviceId -> { count, severity, lastAt }
    tunnels: new Map(), // serviceId -> { active, url, port }
    tunnelStarting: new Set(), // serviceIds mid-flight so double-clicks are ignored
    inspectors: new Map(), // serviceId -> { active, listenPort, targetPort, captured }
    inspectorHistory: new Map(), // serviceId -> [record, ...]
    inspectorGitWatched: new Set(), // serviceIds we're watching git for
    inspectorUi: {
      openFor: null, // serviceId whose modal is currently open, or null
      filter: '',
      selectedRecordId: null,
    },
    gitStatus: new Map(), // serviceId -> snapshot
    portConflict: { serviceId: null, port: null },
    macrosEditor: { serviceId: null, rows: [] },
    alertsEditor: { serviceId: null, rows: [] },
    workspaces: [], // template + status summary from the server
    activeWorkspaceId: null,
    workspaceView: {
      // Frontend-only UI knobs for the currently-focused workspace viewer.
      autoConnect: true,
      resize: true,
      quality: 'medium',
    },
  };

  let socket = null;

  // ---------------------------------------------------------------------
  //   DOM
  // ---------------------------------------------------------------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const els = {
    loginView: $('#login-view'),
    dashboard: $('#dashboard-view'),
    loginForm: $('#login-form'),
    loginError: $('#login-error'),

    list: $('#service-list'),
    refresh: $('#refresh-btn'),
    scratchpadBtn: $('#scratchpad-btn'),
    scratchpadNetwork: $('#scratchpad-network'),
    activeName: $('#active-name'),
    activeMeta: $('#active-meta'),
    sftpBtn: $('#sftp-btn'),
    logsBtn: $('#logs-btn'),
    tunnelBtn: $('#tunnel-btn'),
    tunnelBar: $('#tunnel-bar'),
    tunnelUrl: $('#tunnel-url'),
    tunnelPort: $('#tunnel-port'),
    tunnelCopyBtn: $('#tunnel-copy-btn'),
    tunnelCopyLabel: $('#tunnel-copy-label'),
    tunnelDisconnectBtn: $('#tunnel-disconnect-btn'),
    tunnelModal: $('#tunnel-modal'),
    tunnelForm: $('#tunnel-form'),
    tunnelPortInput: $('#tunnel-port-input'),
    tunnelPortSuggestions: $('#tunnel-port-suggestions'),
    tunnelOpenBtn: $('#tunnel-open-btn'),
    tunnelError: $('#tunnel-error'),

    // Port conflict
    portConflictModal: $('#port-conflict-modal'),
    portConflictSummary: $('#port-conflict-summary'),
    portConflictPort: $('#port-conflict-port'),
    portConflictPid: $('#port-conflict-pid'),
    portConflictCmd: $('#port-conflict-cmd'),
    portConflictUser: $('#port-conflict-user'),
    portConflictKill: $('#port-conflict-kill'),
    portConflictForce: $('#port-conflict-force'),
    portConflictCancel: $('#port-conflict-cancel'),
    portConflictError: $('#port-conflict-error'),

    // HTTP inspector
    inspectorBtn: $('#inspector-btn'),
    inspectorModal: $('#inspector-modal'),
    inspectorTitle: $('#inspector-title'),
    inspectorStateDot: $('#inspector-state-dot'),
    inspectorStateLabel: $('#inspector-state-label'),
    inspectorListenBanner: $('#inspector-listen-banner'),
    inspectorListenUrl: $('#inspector-listen-url'),
    inspectorListenCopy: $('#inspector-listen-copy'),
    inspectorListenTarget: $('#inspector-listen-target'),
    inspectorFilter: $('#inspector-filter'),
    inspectorTargetPort: $('#inspector-target-port'),
    inspectorToggleBtn: $('#inspector-toggle-btn'),
    inspectorClearBtn: $('#inspector-clear-btn'),
    inspectorRows: $('#inspector-rows'),
    inspectorEmpty: $('#inspector-empty'),
    inspectorDetails: $('#inspector-details'),
    inspectorDetailMethod: $('#inspector-detail-method'),
    inspectorDetailUrl: $('#inspector-detail-url'),
    inspectorDetailClose: $('#inspector-detail-close'),
    inspectorDetailReqHeaders: $('#inspector-detail-req-headers'),
    inspectorDetailReqBody: $('#inspector-detail-req-body'),
    inspectorDetailReqMeta: $('#inspector-detail-req-meta'),
    inspectorDetailResHeaders: $('#inspector-detail-res-headers'),
    inspectorDetailResBody: $('#inspector-detail-res-body'),
    inspectorDetailResMeta: $('#inspector-detail-res-meta'),
    inspectorError: $('#inspector-error'),

    // Git widget
    gitWidget: $('#git-widget'),
    gitWidgetBranch: $('#git-widget-branch'),
    gitWidgetTrack: $('#git-widget-track'),
    gitWidgetDirty: $('#git-widget-dirty'),
    gitPullBtn: $('#git-pull-btn'),
    gitStashBtn: $('#git-stash-btn'),
    gitFetchBtn: $('#git-fetch-btn'),

    startBtn: $('#start-btn'),
    stopBtn: $('#stop-btn'),
    restartBtn: $('#restart-btn'),
    clearBtn: $('#clear-btn'),
    tabBar: $('#tab-bar'),
    terminalsContainer: $('#terminals-container'),
    placeholder: $('#terminal-placeholder'),
    connection: $('#connection-status'),

    meName: $('#me-username'),
    meRole: $('#me-role'),
    adminBtn: $('#admin-btn'),
    prefsBtn: $('#prefs-btn'),
    passwdBtn: $('#passwd-btn'),
    logoutBtn: $('#logout-btn'),

    prefsModal: $('#prefs-modal'),
    prefsThemePicker: $('#prefs-theme-picker'),
    prefsCustomTheme: $('#prefs-custom-theme'),
    prefsCustomInputs: $('#prefs-custom-inputs'),
    prefsFontForm: $('#prefs-font-form'),
    prefsFontFamily: $('#prefs-font-family'),
    prefsFontSize: $('#prefs-font-size'),
    prefsFontSizeVal: $('#prefs-font-size-val'),
    prefsPreview: $('#prefs-preview'),
    prefsReset: $('#prefs-reset'),
    prefsSave: $('#prefs-save'),
    prefsError: $('#prefs-error'),

    adminModal: $('#admin-modal'),
    adminUserList: $('#admin-user-list'),
    adminUserForm: $('#admin-user-form'),
    adminShellList: $('#admin-shell-list'),
    adminShellForm: $('#admin-shell-form'),
    shellType: $('#shell-type'),
    sshAuthMethod: $('#ssh-auth-method'),
    allowedUsersPicker: $('#allowed-users-picker'),
    adminHostsList: $('#admin-hosts-list'),

    passwdModal: $('#passwd-modal'),
    passwdForm: $('#passwd-form'),

    sftpModal: $('#sftp-modal'),
    sftpTitle: $('#sftp-title'),
    sftpPath: $('#sftp-path'),
    sftpGo: $('#sftp-go'),
    sftpUp: $('#sftp-up'),
    sftpMkdir: $('#sftp-mkdir'),
    sftpUpload: $('#sftp-upload'),
    sftpList: $('#sftp-list'),
    sftpError: $('#sftp-error'),

    recModal: $('#rec-modal'),
    recTitle: $('#rec-title'),
    recList: $('#rec-list'),
    recPlayerHost: $('#rec-player-host'),

    logsModal: $('#logs-modal'),
    logsTitle: $('#logs-title'),
    logsBody: $('#logs-body'),
    logsRefresh: $('#logs-refresh'),

    metricsPanel: $('.metrics-panel'),
    metricsScopeLabel: $('#metrics-scope-label'),
    metricsScopeSub: $('#metrics-scope-sub'),
    hostCpuFill: $('#host-cpu-fill'),
    hostCpuValue: $('#host-cpu-value'),
    hostMemFill: $('#host-mem-fill'),
    hostMemValue: $('#host-mem-value'),
    hostDiskFill: $('#host-disk-fill'),
    hostDiskValue: $('#host-disk-value'),
    hostDiskRow: $('#host-disk-row'),
    serviceMetrics: $('#service-metrics'),
    svcCpuValue: $('#svc-cpu-value'),
    svcMemValue: $('#svc-mem-value'),
    svcSparkline: $('#svc-sparkline'),
    macroBar: $('#macro-bar'),
    macrosModal: $('#macros-modal'),
    macrosTitle: $('#macros-title'),
    macrosRows: $('#macros-rows'),
    macrosAdd: $('#macros-add'),
    macrosSave: $('#macros-save'),
    macrosError: $('#macros-error'),
    alertsModal: $('#alerts-modal'),
    alertsTitle: $('#alerts-title'),
    alertsRows: $('#alerts-rows'),
    alertsAdd: $('#alerts-add'),
    alertsSave: $('#alerts-save'),
    alertsError: $('#alerts-error'),
    toastHost: $('#toast-host'),

    // Workspaces (graphical container streaming)
    workspaceList: $('#workspace-list'),
    workspacesRefresh: $('#workspaces-refresh-btn'),
    workspaceControls: $('#workspace-controls'),
    workspaceControlsName: $('#workspace-controls-name'),
    workspaceControlsStatus: $('#workspace-controls-status'),
    workspaceAutoConnect: $('#workspace-autoconnect'),
    workspaceResize: $('#workspace-resize'),
    workspaceQuality: $('#workspace-quality'),
    workspaceStartBtn: $('#workspace-start-btn'),
    workspaceStopBtn: $('#workspace-stop-btn'),
    workspaceReloadBtn: $('#workspace-reload-btn'),
    workspaceFullscreenBtn: $('#workspace-fullscreen-btn'),
    workspaceClipboardBtn: $('#workspace-clipboard-btn'),
    workspaceViewport: $('#workspace-viewport'),
    workspaceFrame: $('#workspace-frame'),
    workspaceLoading: $('#workspace-loading'),
    workspaceLoadingText: $('#workspace-loading-text'),
    adminWorkspaceList: $('#admin-workspace-list'),
    adminWorkspaceForm: $('#admin-workspace-form'),
    workspaceAllowedUsers: $('#workspace-allowed-users'),
  };

  // ---------------------------------------------------------------------
  //   API helpers
  // ---------------------------------------------------------------------
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      credentials: 'include',
      headers: opts.body
        ? { 'content-type': 'application/json', ...(opts.headers || {}) }
        : opts.headers || {},
      ...opts,
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* no body */
    }
    if (!res.ok) {
      const err = new Error((body && body.error) || `${res.status} ${res.statusText}`);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  function showError(el, message) {
    el.hidden = false;
    el.textContent = message;
  }
  function clearError(el) {
    el.hidden = true;
    el.textContent = '';
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  }
  function formatBytes(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  // ---------------------------------------------------------------------
  //   Auth
  // ---------------------------------------------------------------------
  async function bootstrap() {
    try {
      const { user } = await api('/api/auth/me');
      state.me = user;
      showDashboard();
    } catch {
      showLogin();
    }
  }

  function showLogin() {
    els.dashboard.hidden = true;
    els.loginView.hidden = false;
    $('input[name="username"]', els.loginForm).focus();
  }

  function showDashboard() {
    els.loginView.hidden = true;
    els.dashboard.hidden = false;
    els.meName.textContent = state.me.username;
    els.meRole.textContent = state.me.role;
    els.adminBtn.hidden = state.me.role !== 'admin';
    connectSocket();
  }

  els.loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearError(els.loginError);
    const data = new FormData(els.loginForm);
    try {
      const { user } = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          username: data.get('username'),
          password: data.get('password'),
        }),
      });
      state.me = user;
      els.loginForm.reset();
      showDashboard();
    } catch (err) {
      showError(els.loginError, err.message);
    }
  });

  els.logoutBtn.addEventListener('click', async () => {
    if (socket) {
      socket.disconnect();
      socket = null;
    }
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      /* noop */
    }
    closeAllTabs();
    state.me = null;
    state.services = [];
    showLogin();
  });

  // ---------------------------------------------------------------------
  //   Tabs / Terminals
  // ---------------------------------------------------------------------
  function findTab(serviceId) {
    return state.tabs.find((t) => t.serviceId === serviceId) || null;
  }

  function openOrFocusTab(serviceId) {
    let tab = findTab(serviceId);
    if (!tab) tab = createTab(serviceId);
    activateTab(tab.serviceId);
  }

  function createTab(serviceId) {
    const hostEl = document.createElement('div');
    hostEl.className = 'term-host';
    els.terminalsContainer.appendChild(hostEl);

    // Open xterm on a visible element (activation will show it). We temporarily
    // give it dimensions so open() sizes the canvas correctly, then fit later.
    hostEl.classList.add('active');
    const others = state.tabs.map((t) => t.hostEl);
    others.forEach((el) => el.classList.remove('active'));

    const prefs = effectivePrefs();
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: prefs.fontFamily,
      fontSize: prefs.fontSize,
      lineHeight: 1.25,
      scrollback: 5000,
      convertEol: false,
      allowProposedApi: true,
      theme: activeThemeObject(prefs),
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(hostEl);

    // Restore any tab that was active before this one — we'll switch below.
    hostEl.classList.remove('active');
    others.forEach((el, idx) => {
      if (state.tabs[idx].serviceId === state.activeTabId) el.classList.add('active');
    });

    const tab = { serviceId, hostEl, term, fitAddon, ro: null };
    state.tabs.push(tab);

    tab.ro = new ResizeObserver(() => fitTerminalFor(tab));
    tab.ro.observe(hostEl);

    term.onData((data) => {
      const svc = svcById(serviceId);
      if (!svc || !svc.status || svc.status.state !== 'running') {
        warnNotRunning(term);
        return;
      }
      socket && socket.emit('service-input', { id: serviceId, data });
    });

    hostEl.addEventListener('click', () => term.focus());

    subscribe(serviceId, tab);
    watchGit(serviceId);
    renderTabBar();
    return tab;
  }

  function closeTab(serviceId, opts = {}) {
    const idx = state.tabs.findIndex((t) => t.serviceId === serviceId);
    if (idx < 0) return;
    const svc = svcById(serviceId);
    // Ephemeral scratchpads self-destruct on close — warn once unless the caller
    // has already handled the confirmation (e.g. bulk logout close).
    if (
      !opts.skipEphemeralConfirm &&
      svc &&
      svc.ephemeral &&
      !confirm(
        'Close this scratchpad? It will be destroyed and its shell session ended.',
      )
    ) {
      return;
    }
    const tab = state.tabs[idx];
    try {
      tab.ro && tab.ro.disconnect();
    } catch {
      /* noop */
    }
    try {
      tab.term.dispose();
    } catch {
      /* noop */
    }
    tab.hostEl.remove();
    state.tabs.splice(idx, 1);
    unwatchContext(serviceId);
    unwatchGit(serviceId);
    state.contextMetrics.delete(serviceId);
    state.gitStatus.delete(serviceId);
    clearAlertState(serviceId);
    if (socket) socket.emit('unsubscribe-service', { id: serviceId });
    // Belt & braces: the server also reaps on last-viewer leave, but hitting the
    // REST endpoint gives the user a definite error if the tear-down failed.
    if (svc && svc.ephemeral) {
      api(`/api/scratchpad/${encodeURIComponent(serviceId)}`, {
        method: 'DELETE',
      }).catch(() => {/* server may have already reaped it */});
    }

    if (state.activeTabId === serviceId) {
      const next = state.tabs[idx] || state.tabs[idx - 1] || null;
      state.activeTabId = null;
      if (next) activateTab(next.serviceId);
      else {
        els.placeholder.classList.remove('hidden');
        renderActiveHeader();
      }
    }
    renderServiceList();
    renderTabBar();
  }

  function closeAllTabs() {
    for (const t of state.tabs.slice())
      closeTab(t.serviceId, { skipEphemeralConfirm: true });
    state.activeTabId = null;
  }

  function activateTab(serviceId) {
    const tab = findTab(serviceId);
    if (!tab) return;
    // Switching to a shell tab hides the workspace viewer (and releases its
    // refcount so idle-reaping resumes).
    if (state.activeWorkspaceId) deactivateWorkspace();
    state.activeTabId = serviceId;
    for (const t of state.tabs) {
      t.hostEl.classList.toggle('active', t.serviceId === serviceId);
    }
    els.placeholder.classList.add('hidden');
    requestAnimationFrame(() => {
      fitTerminalFor(tab);
      tab.term.focus();
    });
    watchContext(serviceId);
    // Reading a tab clears its outstanding alert state.
    clearAlertState(serviceId);
    renderTabBar();
    renderServiceList();
    renderActiveHeader();
    renderMetricsPanel();
  }

  function watchContext(serviceId) {
    if (!socket || !serviceId) return;
    if (state.contextWatched.has(serviceId)) return;
    state.contextWatched.add(serviceId);
    socket.emit('watch-context', { id: serviceId });
  }

  function unwatchContext(serviceId) {
    if (!serviceId) return;
    if (!state.contextWatched.has(serviceId)) return;
    state.contextWatched.delete(serviceId);
    if (socket) socket.emit('unwatch-context', { id: serviceId });
  }

  function subscribe(serviceId, tab) {
    if (!socket) return;
    socket.emit('subscribe-service', { id: serviceId }, (ack) => {
      if (!ack || !ack.ok) {
        tab.term.writeln(
          `\x1b[31m[shellHelper] subscribe failed: ${
            ack?.error || 'unknown'
          }\x1b[0m`,
        );
        return;
      }
      fitTerminalFor(tab);
      const svc = svcById(serviceId);
      if (!svc || !svc.status || svc.status.state !== 'running') {
        tab.term.writeln(
          '\x1b[36m[shellHelper] service is stopped. Click "Start" (top-right) to spawn it.\x1b[0m',
        );
      }
    });
  }

  function fitTerminalFor(tab) {
    if (!tab || !tab.hostEl.clientWidth || !tab.hostEl.clientHeight) return;
    try {
      tab.fitAddon.fit();
      if (socket) {
        socket.emit('resize', {
          id: tab.serviceId,
          cols: tab.term.cols,
          rows: tab.term.rows,
        });
      }
    } catch {
      /* xterm complains without pixel dims */
    }
  }

  let warnedNotRunning = false;
  function warnNotRunning(term) {
    if (warnedNotRunning) return;
    warnedNotRunning = true;
    term.writeln(
      '\r\n\x1b[33m[shellHelper] this service is not running — click "Start" to spawn it, then type here.\x1b[0m',
    );
    setTimeout(() => (warnedNotRunning = false), 3000);
  }

  function renderTabBar() {
    if (state.tabs.length === 0) {
      els.tabBar.hidden = true;
      els.tabBar.innerHTML = '';
      return;
    }
    els.tabBar.hidden = false;
    els.tabBar.innerHTML = '';
    for (const t of state.tabs) {
      const svc = svcById(t.serviceId);
      const div = document.createElement('div');
      div.className = 'term-tab';
      if (t.serviceId === state.activeTabId) div.classList.add('active');
      const alert = state.alertState.get(t.serviceId);
      if (alert && alert.count > 0) {
        div.classList.add(alert.severity === 'crit' ? 'alert-crit' : 'alert-warn');
      }

      const dot = document.createElement('span');
      dot.className = 'tab-dot';
      if (svc && svc.status && svc.status.state === 'running')
        dot.classList.add('running');

      const name = document.createElement('span');
      name.className = 'tab-name';
      name.textContent = (svc && svc.name) || t.serviceId;
      if (svc && svc.ephemeral) {
        const mark = document.createElement('span');
        mark.className = 'ephemeral-mark';
        mark.textContent = 'temp';
        mark.title = 'Ephemeral scratchpad — destroyed on close';
        name.appendChild(mark);
      }
      if (alert && alert.count > 0) {
        const alertBadge = document.createElement('span');
        alertBadge.className =
          'alert-badge' + (alert.severity === 'crit' ? ' crit' : '');
        alertBadge.textContent = alert.count > 99 ? '99+' : String(alert.count);
        name.appendChild(alertBadge);
      }

      const close = document.createElement('button');
      close.className = 'tab-close';
      close.textContent = '✕';
      close.title = 'Close tab';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTab(t.serviceId);
      });

      div.appendChild(dot);
      div.appendChild(name);
      div.appendChild(close);
      div.addEventListener('click', () => activateTab(t.serviceId));
      els.tabBar.appendChild(div);
    }
  }

  // ---------------------------------------------------------------------
  //   Sidebar / Header
  // ---------------------------------------------------------------------
  function svcById(id) {
    return state.services.find((s) => s.id === id) || null;
  }

  function renderServiceList() {
    if (state.services.length === 0) {
      els.list.innerHTML =
        '<li class="service-empty">No services available. Ask an admin to grant access.</li>';
      return;
    }
    els.list.innerHTML = '';
    for (const svc of state.services) {
      const li = document.createElement('li');
      li.className = 'service-item';
      if (svc.id === state.activeTabId) li.classList.add('active');
      const alert = state.alertState.get(svc.id);
      if (alert && alert.count > 0) {
        li.classList.add(alert.severity === 'crit' ? 'alert-crit' : 'alert-warn');
      }

      const dot = document.createElement('span');
      const status = (svc.status && svc.status.state) || 'stopped';
      dot.className = `service-dot ${status}`;

      const body = document.createElement('div');
      body.className = 'service-body';

      const name = document.createElement('div');
      name.className = 'service-name';
      name.textContent = svc.name || svc.id;
      const badge = document.createElement('span');
      badge.className = 'service-type-badge';
      badge.textContent = svc.type;
      name.appendChild(badge);
      if (alert && alert.count > 0) {
        const alertBadge = document.createElement('span');
        alertBadge.className =
          'alert-badge' + (alert.severity === 'crit' ? ' crit' : '');
        alertBadge.textContent = alert.count > 99 ? '99+' : String(alert.count);
        alertBadge.title = 'Log alerts — click tab to review';
        name.appendChild(alertBadge);
      }

      const sub = document.createElement('div');
      sub.className = 'service-sub';
      const openIndicator = findTab(svc.id) ? ' · open' : '';
      sub.textContent = formatStatusLine(svc) + openIndicator;

      body.appendChild(name);
      body.appendChild(sub);
      li.appendChild(dot);
      li.appendChild(body);

      li.addEventListener('click', () => openOrFocusTab(svc.id));
      els.list.appendChild(li);
    }
  }

  function formatStatusLine(svc) {
    const s = svc.status || {};
    if (s.state === 'running')
      return s.pid ? `PID ${s.pid} · running` : 'running';
    if (s.exitCode != null)
      return `stopped · exit ${s.exitCode}${s.signal ? ` (${s.signal})` : ''}`;
    return 'stopped';
  }

  function renderActiveHeader() {
    const svc = state.activeTabId ? svcById(state.activeTabId) : null;
    renderMacroBar();
    if (!svc) {
      els.activeName.textContent = 'No service selected';
      els.activeMeta.textContent =
        'Pick a service from the sidebar to open a terminal tab.';
      setControlsEnabled({
        start: false,
        stop: false,
        restart: false,
        clear: false,
        sftp: false,
        logs: false,
        tunnel: false,
      });
      els.sftpBtn.hidden = true;
      els.inspectorBtn.hidden = true;
      els.gitWidget.hidden = true;
      clearServiceMetrics();
      renderMetricsPanel();
      renderTunnelBar();
      return;
    }
    // The compact header badges are LOCAL-only (pidusage). SSH/Docker context
    // metrics live in the sidebar panel via renderMetricsPanel.
    if (svc.type === 'local' && svc.status && svc.status.state === 'running') {
      const cached = state.serviceMetrics.get(svc.id);
      if (cached) renderServiceMetrics(cached);
      else clearServiceMetrics();
    } else {
      clearServiceMetrics();
    }
    els.activeName.textContent = svc.name || svc.id;
    let cmdSummary;
    if (svc.type === 'ssh') {
      cmdSummary = `ssh ${svc.sshUser || ''}@${svc.host || ''}${
        svc.port && svc.port !== 22 ? `:${svc.port}` : ''
      }`;
    } else if (svc.type === 'docker') {
      const short = svc.containerId ? String(svc.containerId).slice(0, 12) : '?';
      const cmd = Array.isArray(svc.dockerCommand)
        ? svc.dockerCommand.join(' ')
        : svc.dockerCommand || '/bin/sh';
      cmdSummary = `docker exec ${short} ${cmd}`;
    } else {
      cmdSummary =
        [svc.command, ...(svc.args || [])].filter(Boolean).join(' ') ||
        'default shell';
    }
    els.activeMeta.textContent = `${cmdSummary} · ${formatStatusLine(svc)}`;
    const running = svc.status && svc.status.state === 'running';
    els.sftpBtn.hidden = svc.type !== 'ssh';
    setControlsEnabled({
      start: !running,
      stop: running,
      restart: running,
      clear: true,
      sftp: svc.type === 'ssh',
      logs: true,
      // A tunnel targets a local port opened by the process — no point wiring
      // it up when nothing is running behind it.
      tunnel: running,
    });
    renderMetricsPanel();
    renderTunnelBar();
    renderInspectorHeaderButton();
    renderGitWidget();
  }

  function setControlsEnabled({ start, stop, restart, clear, sftp, logs, tunnel }) {
    els.startBtn.disabled = !start;
    els.stopBtn.disabled = !stop;
    els.restartBtn.disabled = !restart;
    els.clearBtn.disabled = !clear;
    els.sftpBtn.disabled = !sftp;
    els.logsBtn.disabled = !logs;
    els.tunnelBtn.disabled = !tunnel;
  }

  // ---------------------------------------------------------------------
  //   Header buttons
  // ---------------------------------------------------------------------
  els.refresh.addEventListener('click', async () => {
    try {
      const body = await api('/api/services');
      state.services = body.services || [];
      renderServiceList();
      renderActiveHeader();
    } catch (err) {
      console.error('refresh failed', err);
    }
  });

  els.scratchpadBtn.addEventListener('click', async () => {
    els.scratchpadBtn.disabled = true;
    const network = !!(els.scratchpadNetwork && els.scratchpadNetwork.checked);
    try {
      const svc = await api('/api/scratchpad/create', {
        method: 'POST',
        body: JSON.stringify({ network }),
      });
      // The service will also arrive via the socket broadcast, but merging it
      // in now means openOrFocusTab finds it immediately.
      if (svc && svc.id && !svcById(svc.id)) state.services.push(svc);
      openOrFocusTab(svc.id);
      renderServiceList();
    } catch (err) {
      alert('Could not create scratchpad: ' + err.message);
    } finally {
      els.scratchpadBtn.disabled = false;
    }
  });

  function activeTab() {
    return findTab(state.activeTabId);
  }

  els.startBtn.addEventListener('click', () => {
    const tab = activeTab();
    if (!tab) return;
    requestServiceStart(tab.serviceId, { force: false });
  });

  async function requestServiceStart(serviceId, { force }) {
    const tab = findTab(serviceId);
    try {
      const res = await fetch(`/api/services/${serviceId}/start`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force: !!force }),
      });
      let body = null;
      try {
        body = await res.json();
      } catch {
        /* noop */
      }
      if (res.status === 409 && body && body.conflict) {
        openPortConflictModal(serviceId, body.conflict);
        return;
      }
      if (!res.ok) {
        const msg = (body && body.error) || `${res.status} ${res.statusText}`;
        if (tab) tab.term.writeln(`\x1b[31m[shellHelper] start failed: ${msg}\x1b[0m`);
        return;
      }
      if (tab) {
        fitTerminalFor(tab);
        tab.term.focus();
      }
    } catch (err) {
      if (tab) tab.term.writeln(`\x1b[31m[shellHelper] start failed: ${err.message}\x1b[0m`);
    }
  }

  els.stopBtn.addEventListener('click', () => {
    const tab = activeTab();
    if (!tab || !socket) return;
    socket.emit('stop-service', { id: tab.serviceId }, (ack) => {
      if (ack && !ack.ok)
        tab.term.writeln(`\x1b[31m[shellHelper] stop failed: ${ack.error}\x1b[0m`);
    });
  });

  els.restartBtn.addEventListener('click', () => {
    const tab = activeTab();
    if (!tab || !socket) return;
    socket.emit('restart-service', { id: tab.serviceId }, (ack) => {
      if (ack && !ack.ok)
        tab.term.writeln(`\x1b[31m[shellHelper] restart failed: ${ack.error}\x1b[0m`);
    });
  });

  els.clearBtn.addEventListener('click', () => {
    const tab = activeTab();
    if (tab) tab.term.reset();
  });

  els.logsBtn.addEventListener('click', () => openLogsFor(state.activeTabId));
  els.sftpBtn.addEventListener('click', () => openSftpFor(state.activeTabId));

  // ---------------------------------------------------------------------
  //   Public tunnel (cloudflared)
  // ---------------------------------------------------------------------
  els.tunnelBtn.addEventListener('click', () => {
    const id = state.activeTabId;
    if (!id) return;
    const info = state.tunnels.get(id);
    if (info && info.active) {
      disconnectTunnel(id);
      return;
    }
    openTunnelPrompt(id);
  });

  els.tunnelDisconnectBtn.addEventListener('click', () => {
    if (state.activeTabId) disconnectTunnel(state.activeTabId);
  });

  els.tunnelCopyBtn.addEventListener('click', async () => {
    const info = state.tunnels.get(state.activeTabId);
    if (!info || !info.url) return;
    try {
      await navigator.clipboard.writeText(info.url);
      els.tunnelCopyLabel.textContent = 'Copied!';
      setTimeout(() => {
        els.tunnelCopyLabel.textContent = 'Copy';
      }, 1400);
    } catch {
      // Fallback: select the anchor text so the user can Cmd/Ctrl+C manually.
      const range = document.createRange();
      range.selectNodeContents(els.tunnelUrl);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  });

  els.tunnelPortSuggestions.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-port]');
    if (!btn) return;
    els.tunnelPortInput.value = btn.dataset.port;
    els.tunnelPortInput.focus();
  });

  els.tunnelForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = state.activeTabId;
    if (!id) return;
    clearError(els.tunnelError);
    const port = Number(els.tunnelPortInput.value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      showError(els.tunnelError, 'Port must be an integer 1–65535.');
      return;
    }
    els.tunnelOpenBtn.disabled = true;
    els.tunnelOpenBtn.textContent = 'Opening…';
    state.tunnelStarting.add(id);
    // Optimistically mark active so the toolbar switches to "connecting" state.
    state.tunnels.set(id, { active: true, url: null, port });
    renderTunnelBar();
    renderTunnelButton();
    try {
      const body = await api(`/api/services/${id}/tunnel/start`, {
        method: 'POST',
        body: JSON.stringify({ port }),
      });
      state.tunnels.set(id, {
        active: true,
        url: body.url,
        port: body.port || port,
      });
      els.tunnelModal.hidden = true;
      renderTunnelBar();
      renderTunnelButton();
      showTunnelToast('Public tunnel opened', body.url);
    } catch (err) {
      state.tunnels.delete(id);
      showError(els.tunnelError, err.message);
      renderTunnelBar();
      renderTunnelButton();
    } finally {
      state.tunnelStarting.delete(id);
      els.tunnelOpenBtn.disabled = false;
      els.tunnelOpenBtn.textContent = 'Open tunnel';
    }
  });

  function openTunnelPrompt(serviceId) {
    clearError(els.tunnelError);
    const cached = state.tunnels.get(serviceId);
    if (cached && cached.port) els.tunnelPortInput.value = String(cached.port);
    openModal(els.tunnelModal);
    setTimeout(() => els.tunnelPortInput.select(), 30);
  }

  async function disconnectTunnel(serviceId) {
    try {
      await api(`/api/services/${serviceId}/tunnel/stop`, { method: 'POST' });
      state.tunnels.delete(serviceId);
      renderTunnelBar();
      renderTunnelButton();
    } catch (err) {
      showTunnelToast('Could not stop tunnel', err.message, 'crit');
    }
  }

  function renderTunnelButton() {
    const id = state.activeTabId;
    const info = id ? state.tunnels.get(id) : null;
    const label = els.tunnelBtn.querySelector('.tunnel-label');
    if (info && info.active) {
      els.tunnelBtn.classList.add('active');
      if (label) label.textContent = info.url ? 'Tunnel live' : 'Connecting…';
    } else {
      els.tunnelBtn.classList.remove('active');
      if (label) label.textContent = 'Public Tunnel';
    }
  }

  function renderTunnelBar() {
    const id = state.activeTabId;
    const info = id ? state.tunnels.get(id) : null;
    if (!info || !info.active) {
      els.tunnelBar.hidden = true;
      renderTunnelButton();
      return;
    }
    els.tunnelBar.hidden = false;
    if (info.url) {
      els.tunnelUrl.textContent = info.url;
      els.tunnelUrl.href = info.url;
      els.tunnelCopyBtn.disabled = false;
    } else {
      els.tunnelUrl.textContent = 'waiting for cloudflared…';
      els.tunnelUrl.removeAttribute('href');
      els.tunnelCopyBtn.disabled = true;
    }
    els.tunnelPort.textContent = info.port ? `→ localhost:${info.port}` : '';
    renderTunnelButton();
  }

  function showTunnelToast(title, detail, severity) {
    showToast(title, detail, severity);
  }

  function showToast(title, detail, severity) {
    if (!els.toastHost) return;
    const div = document.createElement('div');
    div.className = 'toast' + (severity === 'crit' ? ' crit' : '');
    const t = document.createElement('div');
    t.className = 'toast-title';
    const left = document.createElement('span');
    left.textContent = title;
    t.appendChild(left);
    const line = document.createElement('div');
    line.className = 'toast-line';
    line.textContent = detail || '';
    div.appendChild(t);
    div.appendChild(line);
    els.toastHost.appendChild(div);
    while (els.toastHost.children.length > 5) {
      els.toastHost.firstElementChild.remove();
    }
    setTimeout(() => {
      div.style.transition = 'opacity 300ms ease';
      div.style.opacity = '0';
      setTimeout(() => div.remove(), 350);
    }, 5000);
  }

  // ---------------------------------------------------------------------
  //   Port conflict modal
  // ---------------------------------------------------------------------
  function openPortConflictModal(serviceId, conflict) {
    state.portConflict = { serviceId, port: conflict.servicePort || conflict.port };
    clearError(els.portConflictError);
    const svc = svcById(serviceId);
    els.portConflictSummary.textContent = svc
      ? `"${svc.name}" wants port ${conflict.port}, but it's already bound.`
      : `Port ${conflict.port} is already bound.`;
    els.portConflictPort.textContent = conflict.port;
    els.portConflictPid.textContent = conflict.pid ?? '(unknown)';
    els.portConflictCmd.textContent = conflict.command || '(unknown)';
    els.portConflictUser.textContent = conflict.user || '(unknown)';
    els.portConflictKill.disabled = !conflict.pid;
    openModal(els.portConflictModal);
  }

  els.portConflictCancel.addEventListener('click', () => {
    els.portConflictModal.hidden = true;
  });

  els.portConflictForce.addEventListener('click', () => {
    const { serviceId } = state.portConflict;
    els.portConflictModal.hidden = true;
    if (serviceId) requestServiceStart(serviceId, { force: true });
  });

  els.portConflictKill.addEventListener('click', async () => {
    const { serviceId } = state.portConflict;
    if (!serviceId) return;
    clearError(els.portConflictError);
    els.portConflictKill.disabled = true;
    els.portConflictKill.textContent = 'Killing…';
    try {
      const res = await api(`/api/services/${serviceId}/kill-blocker`, {
        method: 'POST',
      });
      showToast(
        'Port freed',
        res.killed ? `PID ${res.pid} terminated on port ${res.port}` : 'Port was already free',
      );
      els.portConflictModal.hidden = true;
      // Retry — the port should be free now. `force: true` skips the pre-check
      // so we don't loop into the same modal if lsof is slow to update.
      requestServiceStart(serviceId, { force: true });
    } catch (err) {
      showError(els.portConflictError, err.message);
    } finally {
      els.portConflictKill.disabled = false;
      els.portConflictKill.textContent = 'Kill & Start';
    }
  });

  // ---------------------------------------------------------------------
  //   HTTP inspector
  // ---------------------------------------------------------------------
  els.inspectorBtn.addEventListener('click', () => {
    const svc = state.activeTabId ? svcById(state.activeTabId) : null;
    if (!svc) return;
    openInspectorModal(svc);
  });

  els.inspectorDetailClose.addEventListener('click', () => {
    state.inspectorUi.selectedRecordId = null;
    els.inspectorDetails.hidden = true;
    renderInspectorRows();
  });

  els.inspectorFilter.addEventListener('input', () => {
    state.inspectorUi.filter = els.inspectorFilter.value.trim().toLowerCase();
    renderInspectorRows();
  });

  els.inspectorToggleBtn.addEventListener('click', async () => {
    const serviceId = state.inspectorUi.openFor;
    if (!serviceId) return;
    const status = state.inspectors.get(serviceId);
    clearError(els.inspectorError);
    if (status && status.active) {
      try {
        await api(`/api/services/${serviceId}/inspector/stop`, { method: 'POST' });
      } catch (err) {
        showError(els.inspectorError, err.message);
      }
      return;
    }
    const port = Number(els.inspectorTargetPort.value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      showError(els.inspectorError, 'Enter a target port (1–65535).');
      return;
    }
    els.inspectorToggleBtn.disabled = true;
    try {
      await api(`/api/services/${serviceId}/inspector/start`, {
        method: 'POST',
        body: JSON.stringify({ targetPort: port }),
      });
    } catch (err) {
      showError(els.inspectorError, err.message);
    } finally {
      els.inspectorToggleBtn.disabled = false;
    }
  });

  // Clear `openFor` whenever the inspector modal is hidden — otherwise, live
  // captures for a service we're no longer viewing would still re-render the
  // (invisible) table.
  new MutationObserver(() => {
    if (els.inspectorModal.hidden) state.inspectorUi.openFor = null;
  }).observe(els.inspectorModal, { attributes: true, attributeFilter: ['hidden'] });

  els.inspectorListenCopy.addEventListener('click', async () => {
    const url = els.inspectorListenUrl.textContent || '';
    if (!url || url === '—') return;
    try {
      await navigator.clipboard.writeText(url);
      els.inspectorListenCopy.textContent = 'Copied!';
      setTimeout(() => (els.inspectorListenCopy.textContent = 'Copy'), 1200);
    } catch {
      /* clipboard may be blocked; the URL is right there next to the button */
    }
  });

  els.inspectorClearBtn.addEventListener('click', async () => {
    const serviceId = state.inspectorUi.openFor;
    if (!serviceId) return;
    try {
      await api(`/api/services/${serviceId}/inspector/clear`, { method: 'POST' });
      state.inspectorHistory.set(serviceId, []);
      state.inspectorUi.selectedRecordId = null;
      els.inspectorDetails.hidden = true;
      renderInspectorRows();
    } catch (err) {
      showError(els.inspectorError, err.message);
    }
  });

  async function openInspectorModal(svc) {
    state.inspectorUi.openFor = svc.id;
    state.inspectorUi.selectedRecordId = null;
    state.inspectorUi.filter = '';
    els.inspectorFilter.value = '';
    els.inspectorTitle.textContent = `HTTP Traffic — ${svc.name}`;
    els.inspectorDetails.hidden = true;
    clearError(els.inspectorError);
    // Seed target port from the service definition when known.
    const cached = state.inspectors.get(svc.id);
    if (cached && cached.targetPort) els.inspectorTargetPort.value = cached.targetPort;
    else if (svc.servicePort) els.inspectorTargetPort.value = svc.servicePort;
    openModal(els.inspectorModal);
    renderInspectorState();
    renderInspectorRows();
    try {
      const { history } = await api(`/api/services/${svc.id}/inspector/history`);
      state.inspectorHistory.set(svc.id, history || []);
      renderInspectorRows();
    } catch {
      /* history is best-effort */
    }
  }

  function renderInspectorHeaderButton() {
    const id = state.activeTabId;
    const svc = id ? svcById(id) : null;
    // The button is only meaningful for local services — the inspector proxies
    // HTTP to a port on this host, which docker/ssh services don't expose here.
    const eligible = !!(svc && svc.type === 'local');
    els.inspectorBtn.hidden = !eligible;
    els.inspectorBtn.disabled = !eligible;
    const status = id ? state.inspectors.get(id) : null;
    const active = !!(status && status.active);
    const label = els.inspectorBtn.querySelector('.inspector-label');
    if (active) {
      els.inspectorBtn.classList.add('active');
      if (label) label.textContent = `HTTP Traffic · ${status.captured || 0}`;
    } else {
      els.inspectorBtn.classList.remove('active');
      if (label) label.textContent = 'HTTP Traffic';
    }
  }

  function renderInspectorState() {
    const serviceId = state.inspectorUi.openFor;
    const status = serviceId ? state.inspectors.get(serviceId) : null;
    const active = !!(status && status.active);
    els.inspectorStateDot.classList.toggle('active', active);
    els.inspectorStateLabel.textContent = active ? 'capturing' : 'inactive';
    els.inspectorToggleBtn.textContent = active ? 'Stop capture' : 'Start capture';
    els.inspectorToggleBtn.classList.toggle('btn-primary', !active);
    els.inspectorToggleBtn.classList.toggle('btn-stop', active);
    if (active) {
      const url = `http://127.0.0.1:${status.listenPort}`;
      els.inspectorListenBanner.hidden = false;
      els.inspectorListenUrl.textContent = url;
      els.inspectorListenUrl.href = url;
      els.inspectorListenTarget.textContent = `→ forwards to localhost:${status.targetPort}`;
    } else {
      els.inspectorListenBanner.hidden = true;
    }
    // Toolbar button in the header
    const btnLabel = els.inspectorBtn.querySelector('.inspector-label');
    if (active) {
      els.inspectorBtn.classList.add('active');
      if (btnLabel) btnLabel.textContent = `HTTP Traffic · ${status.captured || 0}`;
    } else {
      els.inspectorBtn.classList.remove('active');
      if (btnLabel) btnLabel.textContent = 'HTTP Traffic';
    }
  }

  function renderInspectorRows() {
    const serviceId = state.inspectorUi.openFor;
    if (!serviceId) return;
    const records = state.inspectorHistory.get(serviceId) || [];
    const filter = state.inspectorUi.filter;
    const filtered = filter
      ? records.filter(
          (r) =>
            r.method.toLowerCase().includes(filter) ||
            (r.url || '').toLowerCase().includes(filter),
        )
      : records;
    els.inspectorEmpty.style.display = filtered.length ? 'none' : '';
    els.inspectorRows.innerHTML = '';
    // Newest first is easier to read for live capture.
    for (const r of filtered.slice().reverse()) {
      const tr = document.createElement('tr');
      if (r.id === state.inspectorUi.selectedRecordId) tr.classList.add('selected');
      const method = document.createElement('td');
      const mBadge = document.createElement('span');
      mBadge.className = 'inspector-method ' + String(r.method || '').toLowerCase();
      mBadge.textContent = r.method || '?';
      method.appendChild(mBadge);
      const status = document.createElement('td');
      status.className = 'inspector-status ' + statusClass(r.status);
      status.textContent = r.status;
      const url = document.createElement('td');
      url.className = 'col-url';
      url.textContent = r.url || '';
      url.title = r.url || '';
      const latency = document.createElement('td');
      latency.textContent = `${r.durationMs} ms`;
      const time = document.createElement('td');
      const d = new Date(r.timestamp);
      time.textContent = d.toLocaleTimeString([], { hour12: false });
      tr.appendChild(method);
      tr.appendChild(status);
      tr.appendChild(url);
      tr.appendChild(latency);
      tr.appendChild(time);
      tr.addEventListener('click', () => openInspectorDetails(r));
      els.inspectorRows.appendChild(tr);
    }
  }

  function statusClass(status) {
    const s = Number(status) || 0;
    if (s >= 500) return 'err';
    if (s >= 400) return 'warn';
    if (s >= 300) return 'redir';
    if (s >= 200) return 'ok';
    return '';
  }

  function openInspectorDetails(record) {
    state.inspectorUi.selectedRecordId = record.id;
    els.inspectorDetails.hidden = false;
    els.inspectorDetailMethod.textContent = record.method || '?';
    els.inspectorDetailUrl.textContent = record.url || '';
    els.inspectorDetailReqHeaders.textContent = formatHeaders(record.requestHeaders);
    els.inspectorDetailReqBody.textContent = record.requestBody
      ? record.requestBody.text || '(empty)'
      : '(empty)';
    els.inspectorDetailReqMeta.textContent = bodyMeta(record.requestBody);
    els.inspectorDetailResHeaders.textContent = formatHeaders(record.responseHeaders);
    els.inspectorDetailResBody.textContent = record.responseBody
      ? record.responseBody.text || '(empty)'
      : '(empty)';
    els.inspectorDetailResMeta.textContent = bodyMeta(record.responseBody);
    renderInspectorRows();
  }

  function formatHeaders(h) {
    if (!h) return '';
    return Object.entries(h)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
      .join('\n');
  }

  function bodyMeta(body) {
    if (!body) return '';
    const size = typeof body.size === 'number' ? `${body.size} B` : '';
    const enc = body.encoding && body.encoding !== 'utf8' ? ` · ${body.encoding}` : '';
    const trunc = body.truncated ? ' · truncated' : '';
    return [size, enc, trunc].filter(Boolean).join('');
  }

  // ---------------------------------------------------------------------
  //   Git widget
  // ---------------------------------------------------------------------
  els.gitPullBtn.addEventListener('click', () => runGitAction('pull'));
  els.gitStashBtn.addEventListener('click', () => runGitAction('stash'));
  els.gitFetchBtn.addEventListener('click', () => runGitAction('fetch'));

  async function runGitAction(action) {
    const id = state.activeTabId;
    if (!id) return;
    setGitActionsDisabled(true);
    try {
      const res = await api(`/api/services/${id}/git/${action}`, { method: 'POST' });
      if (res.ok) {
        showToast(`git ${action}`, (res.stdout || res.stderr || '').split('\n')[0] || 'ok');
      } else {
        showToast(`git ${action} failed`, res.stderr || 'see server logs', 'crit');
      }
      // The action's refresh already emitted a git-status event; render just
      // in case the socket is currently offline.
      if (res.snapshot) {
        state.gitStatus.set(id, res.snapshot);
        if (id === state.activeTabId) renderGitWidget();
      }
    } catch (err) {
      showToast(`git ${action} failed`, err.message, 'crit');
    } finally {
      setGitActionsDisabled(false);
    }
  }

  function setGitActionsDisabled(disabled) {
    els.gitPullBtn.disabled = disabled;
    els.gitStashBtn.disabled = disabled;
    els.gitFetchBtn.disabled = disabled;
  }

  function watchGit(serviceId) {
    if (!socket || state.inspectorGitWatched.has(serviceId)) return;
    state.inspectorGitWatched.add(serviceId);
    socket.emit('watch-git', { id: serviceId });
  }

  function unwatchGit(serviceId) {
    if (!socket || !state.inspectorGitWatched.has(serviceId)) return;
    state.inspectorGitWatched.delete(serviceId);
    socket.emit('unwatch-git', { id: serviceId });
  }

  function renderGitWidget() {
    const id = state.activeTabId;
    const svc = id ? svcById(id) : null;
    // The server resolves the cwd (falling back to $HOME) — trust its verdict
    // rather than second-guessing here. If `repo: false` comes back, the
    // widget stays hidden.
    if (!svc || svc.type !== 'local') {
      els.gitWidget.hidden = true;
      return;
    }
    const snap = state.gitStatus.get(id);
    if (!snap || !snap.repo) {
      els.gitWidget.hidden = true;
      return;
    }
    els.gitWidget.hidden = false;
    els.gitWidgetBranch.textContent = snap.branch || '(detached)';
    const trackBits = [];
    if (snap.ahead) trackBits.push(`↑${snap.ahead}`);
    if (snap.behind) trackBits.push(`↓${snap.behind}`);
    els.gitWidgetTrack.textContent = trackBits.join(' ');
    const dirty = (snap.staged || 0) + (snap.modified || 0) + (snap.untracked || 0);
    els.gitWidgetDirty.textContent = dirty ? `● ${dirty}` : '';
    els.gitWidget.classList.toggle('dirty', dirty > 0);
    els.gitWidget.classList.toggle('ahead', (snap.ahead || 0) > 0);
    els.gitWidget.classList.toggle('behind', (snap.behind || 0) > 0);
    els.gitPullBtn.disabled = !snap.upstream;
    els.gitFetchBtn.disabled = !snap.upstream;
    // Enrich the tooltip so hover reveals a fuller picture without opening a modal.
    const parts = [
      `branch: ${snap.branch}`,
      snap.upstream ? `upstream: ${snap.upstream}` : 'no upstream',
      `staged: ${snap.staged}, modified: ${snap.modified}, untracked: ${snap.untracked}`,
    ];
    if (snap.lastCommit) parts.push(`last: ${snap.lastCommit.sha} ${snap.lastCommit.subject}`);
    els.gitWidget.title = parts.join('\n');
  }

  // ---------------------------------------------------------------------
  //   Socket
  // ---------------------------------------------------------------------
  function connectSocket() {
    if (socket) return;
    socket = io({ transports: ['websocket', 'polling'], withCredentials: true });

    socket.on('connect', () => {
      els.connection.textContent = 'connected';
      els.connection.classList.remove('conn-disconnected');
      els.connection.classList.add('conn-connected');
      // Re-subscribe any open tabs after reconnect.
      for (const t of state.tabs) subscribe(t.serviceId, t);
      resubscribeContexts();
      // Rebuild git watches from scratch — the server clears them on disconnect.
      const gitIds = Array.from(state.inspectorGitWatched);
      state.inspectorGitWatched.clear();
      for (const id of gitIds) watchGit(id);
    });

    socket.on('disconnect', () => {
      els.connection.textContent = 'disconnected';
      els.connection.classList.add('conn-disconnected');
      els.connection.classList.remove('conn-connected');
    });

    socket.on('auth-required', () => {
      socket.disconnect();
      socket = null;
      showLogin();
    });

    socket.on('services', (services) => {
      state.services = Array.isArray(services) ? services : [];
      renderServiceList();
      renderActiveHeader();
      renderTabBar();
      // Drop tabs whose service was removed / lost access.
      for (const t of state.tabs.slice()) {
        if (!svcById(t.serviceId)) closeTab(t.serviceId, { skipEphemeralConfirm: true });
      }
    });

    socket.on('service-status', (svc) => {
      if (!svc || !svc.id) return;
      const idx = state.services.findIndex((s) => s.id === svc.id);
      if (idx >= 0) state.services[idx] = svc;
      else state.services.push(svc);
      renderServiceList();
      renderTabBar();
      if (svc.id === state.activeTabId) renderActiveHeader();
    });

    socket.on('service-output', ({ id, data }) => {
      const tab = findTab(id);
      if (tab) tab.term.write(data);
    });

    socket.on('service-error', ({ id, message }) => {
      const tab = findTab(id);
      if (tab) tab.term.writeln(`\r\n\x1b[31m[shellHelper] ${message}\x1b[0m`);
    });

    // Fires when an ephemeral scratchpad is torn down server-side (shell exit,
    // last viewer leaving on another socket, etc.). Silently drop the tab.
    socket.on('service-removed', ({ id }) => {
      state.services = state.services.filter((s) => s.id !== id);
      if (findTab(id)) closeTab(id, { skipEphemeralConfirm: true });
      renderServiceList();
    });

    socket.on('host-metrics', (snapshot) => {
      state.lastHostMetrics = snapshot;
      // Only refresh the metrics panel when it's currently in host mode.
      if (!state.activeTabId) renderMetricsPanel();
    });

    socket.on('service-metrics', (metrics) => {
      // Sidebar sparkline for LOCAL services still runs off this stream.
      state.serviceMetrics.set(metrics.id, metrics);
      if (metrics.id === state.activeTabId) renderServiceMetrics(metrics);
    });

    socket.on('service-context-metrics', (metrics) => {
      state.contextMetrics.set(metrics.id, metrics);
      if (metrics.id === state.activeTabId) renderMetricsPanel();
    });

    socket.on('log-alert', handleLogAlert);

    socket.on('tunnel-status', ({ id, active, url, port }) => {
      if (!id) return;
      if (active) {
        state.tunnels.set(id, { active: true, url: url || null, port: port || null });
      } else {
        state.tunnels.delete(id);
      }
      if (id === state.activeTabId) {
        renderTunnelBar();
        renderTunnelButton();
      }
    });

    socket.on('tunnel-error', ({ id, message }) => {
      if (!id) return;
      // The starter promise already surfaces its own error via the modal —
      // avoid double-toasting while the request is in flight.
      if (state.tunnelStarting.has(id)) return;
      showTunnelToast('Tunnel error', message, 'crit');
    });

    socket.on('inspector-status', ({ id, active, listenPort, targetPort, captured }) => {
      if (!id) return;
      if (active) {
        state.inspectors.set(id, {
          active: true,
          listenPort,
          targetPort,
          captured: captured || 0,
        });
      } else {
        state.inspectors.delete(id);
      }
      // Only refresh the header for the currently-active tab. The modal
      // refreshes its own state whenever it's open for the affected service.
      if (id === state.activeTabId) renderInspectorHeaderButton();
      if (state.inspectorUi.openFor === id) renderInspectorState();
    });

    socket.on('http-capture', ({ id, record }) => {
      if (!id || !record) return;
      const arr = state.inspectorHistory.get(id) || [];
      arr.push(record);
      // Match the server's rolling limit so the UI doesn't grow unbounded.
      while (arr.length > 200) arr.shift();
      state.inspectorHistory.set(id, arr);
      const cur = state.inspectors.get(id);
      if (cur) {
        cur.captured = (cur.captured || 0) + 1;
        if (id === state.activeTabId) renderInspectorHeaderButton();
      }
      if (state.inspectorUi.openFor === id) renderInspectorRows();
    });

    socket.on('inspector-cleared', ({ id }) => {
      state.inspectorHistory.set(id, []);
      if (state.inspectorUi.openFor === id) {
        state.inspectorUi.selectedRecordId = null;
        els.inspectorDetails.hidden = true;
        renderInspectorRows();
      }
    });

    socket.on('git-status', ({ id, snapshot }) => {
      if (!id) return;
      state.gitStatus.set(id, snapshot);
      if (id === state.activeTabId) renderGitWidget();
    });

    socket.on('workspaces', (list) => {
      state.workspaces = Array.isArray(list) ? list : [];
      renderWorkspaceList();
      renderWorkspaceControls();
    });

    socket.on('workspace-status', ({ id, instance, state: wsState }) => {
      const idx = state.workspaces.findIndex((w) => w.id === id);
      if (idx >= 0) {
        state.workspaces[idx] = {
          ...state.workspaces[idx],
          status: {
            state: wsState === 'stopped' ? 'stopped' : 'running',
            ready: wsState === 'ready',
            hostPort: instance ? instance.hostPort : null,
            containerId: instance ? instance.containerId : null,
            startedAt: instance ? instance.startedAt : null,
          },
        };
        renderWorkspaceList();
      }
      if (state.activeWorkspaceId === id) {
        renderWorkspaceControls();
        // Auto-load the iframe as soon as the container reports ready.
        if (wsState === 'ready') loadWorkspaceIframe(id);
        if (wsState === 'stopped') clearWorkspaceIframe();
      }
    });
  }

  // Re-request context polling for every open tab after reconnect so the
  // server-side refcounts match what the UI expects.
  function resubscribeContexts() {
    const set = new Set(state.contextWatched);
    state.contextWatched.clear();
    for (const id of set) watchContext(id);
  }

  // ---------------------------------------------------------------------
  //   Modals (generic)
  // ---------------------------------------------------------------------
  function openModal(modal) {
    modal.hidden = false;
    modal.querySelectorAll('[data-close]').forEach((el) =>
      el.addEventListener('click', () => (modal.hidden = true), { once: true }),
    );
  }

  els.adminBtn.addEventListener('click', () => {
    openModal(els.adminModal);
    refreshAdminUsers();
    refreshAdminShells();
    refreshKnownHosts();
    updateShellTypeFields();
    updateSshAuthFields();
  });

  els.passwdBtn.addEventListener('click', () => openModal(els.passwdModal));

  $$('.tab', els.adminModal).forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab', els.adminModal).forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const which = tab.dataset.tab;
      $$('[data-panel]', els.adminModal).forEach((panel) => {
        panel.hidden = panel.dataset.panel !== which;
      });
    });
  });

  // ---------------------------------------------------------------------
  //   Change password
  // ---------------------------------------------------------------------
  els.passwdForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const err = $('[data-error]', els.passwdForm);
    clearError(err);
    const data = new FormData(els.passwdForm);
    try {
      await api('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({
          currentPassword: data.get('currentPassword'),
          newPassword: data.get('newPassword'),
        }),
      });
      els.passwdForm.reset();
      els.passwdModal.hidden = true;
    } catch (e) {
      showError(err, e.message);
    }
  });

  // ---------------------------------------------------------------------
  //   Admin users
  // ---------------------------------------------------------------------
  async function refreshAdminUsers() {
    try {
      const { users } = await api('/api/admin/users');
      state.users = users;
      renderAdminUsers();
      renderAllowedUsersPicker();
    } catch (err) {
      els.adminUserList.innerHTML = `<li class="service-empty">${err.message}</li>`;
    }
  }

  function renderAdminUsers() {
    if (state.users.length === 0) {
      els.adminUserList.innerHTML = '<li class="service-empty">No users.</li>';
      return;
    }
    els.adminUserList.innerHTML = '';
    for (const u of state.users) {
      const li = document.createElement('li');
      const body = document.createElement('div');
      body.className = 'row-body';
      body.innerHTML = `
        <div class="row-name">${escapeHtml(u.username)}</div>
        <div class="row-sub">${u.role} · created ${new Date(u.createdAt).toLocaleDateString()}</div>`;
      const del = document.createElement('button');
      del.className = 'icon-btn';
      del.title = 'Delete user';
      del.textContent = '🗑';
      del.addEventListener('click', async () => {
        if (!confirm(`Delete user "${u.username}"?`)) return;
        try {
          await api(`/api/admin/users/${u.id}`, { method: 'DELETE' });
          refreshAdminUsers();
        } catch (err) {
          alert(err.message);
        }
      });
      li.appendChild(body);
      li.appendChild(del);
      els.adminUserList.appendChild(li);
    }
  }

  els.adminUserForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const err = $('[data-error]', els.adminUserForm);
    clearError(err);
    const data = new FormData(els.adminUserForm);
    try {
      await api('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          username: data.get('username'),
          password: data.get('password'),
          role: data.get('role'),
        }),
      });
      els.adminUserForm.reset();
      refreshAdminUsers();
    } catch (e) {
      showError(err, e.message);
    }
  });

  // ---------------------------------------------------------------------
  //   Admin shells
  // ---------------------------------------------------------------------
  async function refreshAdminShells() {
    try {
      const { services } = await api('/api/services');
      // Scratchpads are transient and not admin-manageable; keep them out.
      renderAdminShells(services.filter((s) => !s.ephemeral));
    } catch (err) {
      els.adminShellList.innerHTML = `<li class="service-empty">${err.message}</li>`;
    }
  }

  function renderAdminShells(services) {
    if (services.length === 0) {
      els.adminShellList.innerHTML =
        '<li class="service-empty">No shells yet. Add one on the right.</li>';
      return;
    }
    els.adminShellList.innerHTML = '';
    for (const svc of services) {
      const li = document.createElement('li');
      const body = document.createElement('div');
      body.className = 'row-body';
      let conn;
      if (svc.type === 'ssh') {
        conn = `ssh · ${svc.sshUser || ''}@${svc.host || ''}:${svc.port || 22} · ${
          svc.sshAuthMethod || 'password'
        }`;
      } else if (svc.type === 'docker') {
        const short = svc.containerId
          ? String(svc.containerId).slice(0, 12)
          : '?';
        const cmd = Array.isArray(svc.dockerCommand)
          ? svc.dockerCommand.join(' ')
          : svc.dockerCommand || '/bin/sh';
        conn = `docker · ${short} · ${cmd}`;
      } else {
        conn = `local · ${
          [svc.command, ...(svc.args || [])].filter(Boolean).join(' ') ||
          '(default shell)'
        }`;
      }
      const allowed =
        svc.allowedUsers && svc.allowedUsers.length
          ? ` · allowed: ${svc.allowedUsers.join(', ')}`
          : ' · admins only';
      const flags = [
        svc.autoRestart ? 'auto-restart' : null,
        svc.autostart ? 'autostart' : null,
        svc.recording ? 'recording' : null,
      ].filter(Boolean).join(', ');
      body.innerHTML = `
        <div class="row-name">${escapeHtml(svc.name)}</div>
        <div class="row-sub">${escapeHtml(conn + allowed + (flags ? ' · ' + flags : ''))}</div>`;

      const actions = document.createElement('div');
      actions.className = 'row-actions';

      const macrosBtn = document.createElement('button');
      macrosBtn.className = 'icon-btn neutral';
      macrosBtn.title = 'Edit macros';
      macrosBtn.textContent = '✎';
      macrosBtn.addEventListener('click', () => openMacrosEditor(svc));
      actions.appendChild(macrosBtn);

      const alertsBtn = document.createElement('button');
      alertsBtn.className = 'icon-btn neutral';
      alertsBtn.title = 'Log alert rules';
      alertsBtn.textContent = '⚠';
      alertsBtn.addEventListener('click', () => openAlertsEditor(svc));
      actions.appendChild(alertsBtn);

      const recBtn = document.createElement('button');
      recBtn.className = 'icon-btn neutral';
      recBtn.title = 'Recordings';
      recBtn.textContent = '⏺';
      recBtn.addEventListener('click', () => openRecordingsFor(svc.id, svc.name));
      actions.appendChild(recBtn);

      const del = document.createElement('button');
      del.className = 'icon-btn';
      del.title = 'Delete shell';
      del.textContent = '🗑';
      del.addEventListener('click', async () => {
        if (!confirm(`Delete shell "${svc.name}"?`)) return;
        try {
          await api(`/api/admin/services/${svc.id}`, { method: 'DELETE' });
          refreshAdminShells();
        } catch (err) {
          alert(err.message);
        }
      });
      actions.appendChild(del);

      li.appendChild(body);
      li.appendChild(actions);
      els.adminShellList.appendChild(li);
    }
  }

  function renderAllowedUsersPicker() {
    const nonAdmins = state.users.filter((u) => u.role !== 'admin');
    if (nonAdmins.length === 0) {
      els.allowedUsersPicker.innerHTML =
        '<span class="service-empty">Create non-admin users first to grant them access.</span>';
      return;
    }
    els.allowedUsersPicker.innerHTML = '';
    for (const u of nonAdmins) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.name = 'allowedUser';
      input.value = u.username;
      label.appendChild(input);
      label.appendChild(document.createTextNode(u.username));
      els.allowedUsersPicker.appendChild(label);
    }
  }

  function updateShellTypeFields() {
    const type = els.shellType.value;
    $$('[data-when-type]', els.adminShellForm).forEach((el) => {
      el.hidden = el.dataset.whenType !== type;
    });
  }
  function updateSshAuthFields() {
    const method = els.sshAuthMethod.value;
    $$('[data-when-auth]', els.adminShellForm).forEach((el) => {
      el.hidden = el.dataset.whenAuth !== method;
    });
  }
  els.shellType.addEventListener('change', updateShellTypeFields);
  els.sshAuthMethod.addEventListener('change', updateSshAuthFields);

  els.adminShellForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const err = $('[data-error]', els.adminShellForm);
    clearError(err);
    const data = new FormData(els.adminShellForm);
    const type = data.get('type');
    const allowedUsers = $$(
      'input[name="allowedUser"]:checked',
      els.adminShellForm,
    ).map((el) => el.value);
    const payload = {
      type,
      name: data.get('name'),
      allowedUsers,
      autostart: !!data.get('autostart'),
      autoRestart: !!data.get('autoRestart'),
      recording: !!data.get('recording'),
    };
    if (type === 'ssh') {
      payload.host = data.get('host');
      payload.port = Number(data.get('port')) || 22;
      payload.sshUser = data.get('sshUser');
      payload.sshAuthMethod = data.get('sshAuthMethod');
      if (payload.sshAuthMethod === 'key') {
        payload.sshPrivateKey = data.get('sshPrivateKey');
        payload.sshPassphrase = data.get('sshPassphrase');
      } else {
        payload.sshPassword = data.get('sshPassword');
      }
    } else if (type === 'docker') {
      payload.containerId = data.get('containerId');
      payload.dockerCommand = data.get('dockerCommand') || '/bin/sh';
      const user = data.get('dockerUser');
      const wd = data.get('dockerWorkingDir');
      if (user) payload.dockerUser = user;
      if (wd) payload.dockerWorkingDir = wd;
    } else {
      payload.command = data.get('command') || undefined;
      payload.args = data.get('args') || '';
      payload.cwd = data.get('cwd') || null;
      const sp = data.get('servicePort');
      if (sp) payload.servicePort = Number(sp);
    }
    try {
      await api('/api/admin/services', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      els.adminShellForm.reset();
      updateShellTypeFields();
      updateSshAuthFields();
      refreshAdminShells();
    } catch (e) {
      showError(err, e.message);
    }
  });

  // ---------------------------------------------------------------------
  //   Known SSH hosts
  // ---------------------------------------------------------------------
  async function refreshKnownHosts() {
    try {
      const { hosts } = await api('/api/admin/known-hosts');
      if (!hosts.length) {
        els.adminHostsList.innerHTML =
          '<li class="service-empty">No hosts pinned yet. They get pinned on first successful SSH connect.</li>';
        return;
      }
      els.adminHostsList.innerHTML = '';
      for (const h of hosts) {
        const li = document.createElement('li');
        const body = document.createElement('div');
        body.className = 'row-body';
        body.innerHTML = `
          <div class="row-name">${escapeHtml(h.host)}</div>
          <div class="row-sub">${escapeHtml(h.fingerprint)} · trusted ${new Date(h.trustedAt).toLocaleString()}</div>`;
        const del = document.createElement('button');
        del.className = 'icon-btn';
        del.title = 'Forget host key';
        del.textContent = '🗑';
        del.addEventListener('click', async () => {
          if (!confirm(`Forget host key for ${h.host}?`)) return;
          const [host, port] = h.host.split(':');
          try {
            await api(
              `/api/admin/known-hosts?host=${encodeURIComponent(host)}&port=${port || 22}`,
              { method: 'DELETE' },
            );
            refreshKnownHosts();
          } catch (err) {
            alert(err.message);
          }
        });
        li.appendChild(body);
        li.appendChild(del);
        els.adminHostsList.appendChild(li);
      }
    } catch (err) {
      els.adminHostsList.innerHTML = `<li class="service-empty">${err.message}</li>`;
    }
  }

  // ---------------------------------------------------------------------
  //   Logs viewer
  // ---------------------------------------------------------------------
  async function openLogsFor(serviceId) {
    if (!serviceId) return;
    const svc = svcById(serviceId);
    els.logsTitle.textContent = `Persistent log — ${svc ? svc.name : serviceId}`;
    els.logsBody.textContent = 'Loading…';
    openModal(els.logsModal);
    await loadLogs(serviceId);
  }
  async function loadLogs(serviceId) {
    try {
      const body = await api(`/api/services/${serviceId}/logs?bytes=131072`);
      els.logsBody.textContent = body.log || '(no log yet)';
      els.logsBody.scrollTop = els.logsBody.scrollHeight;
      els.logsRefresh.onclick = () => loadLogs(serviceId);
    } catch (err) {
      els.logsBody.textContent = err.message;
    }
  }

  // ---------------------------------------------------------------------
  //   SFTP browser
  // ---------------------------------------------------------------------
  async function openSftpFor(serviceId) {
    if (!serviceId) return;
    const svc = svcById(serviceId);
    if (!svc || svc.type !== 'ssh') return;
    els.sftpTitle.textContent = `Files — ${svc.name}`;
    state.sftp = { serviceId, path: '.' };
    clearError(els.sftpError);
    openModal(els.sftpModal);
    await sftpNavigate('.');
  }

  async function sftpNavigate(target) {
    const serviceId = state.sftp.serviceId;
    if (!serviceId) return;
    els.sftpList.innerHTML = '<div class="service-empty">Loading…</div>';
    clearError(els.sftpError);
    try {
      const result = await api(
        `/api/services/${serviceId}/sftp/list?path=${encodeURIComponent(target)}`,
      );
      state.sftp.path = result.path;
      els.sftpPath.value = result.path;
      renderSftpList(result.items);
    } catch (err) {
      showError(els.sftpError, err.message);
      els.sftpList.innerHTML = '';
    }
  }

  function renderSftpList(items) {
    if (!items.length) {
      els.sftpList.innerHTML =
        '<div class="service-empty">(empty directory)</div>';
      return;
    }
    els.sftpList.innerHTML = '';
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'sftp-entry' + (item.isDir ? ' dir' : '');
      const icon = document.createElement('span');
      icon.className = 'sftp-icon';
      icon.textContent = item.isDir ? '📁' : '📄';
      const name = document.createElement('span');
      name.className = 'sftp-name';
      name.textContent = item.name;
      const size = document.createElement('span');
      size.className = 'sftp-size';
      size.textContent = item.isDir ? '' : formatBytes(item.size);
      const time = document.createElement('span');
      time.className = 'sftp-time';
      time.textContent = item.mtime
        ? new Date(item.mtime).toLocaleString()
        : '';
      const actions = document.createElement('span');
      actions.className = 'sftp-actions';

      if (!item.isDir) {
        const dl = document.createElement('button');
        dl.className = 'ghost-btn';
        dl.textContent = '⇩';
        dl.title = 'Download';
        dl.addEventListener('click', () => sftpDownload(item.name));
        actions.appendChild(dl);
      }
      const rm = document.createElement('button');
      rm.className = 'icon-btn';
      rm.textContent = '🗑';
      rm.title = 'Delete';
      rm.addEventListener('click', () => sftpDelete(item));
      actions.appendChild(rm);

      row.appendChild(icon);
      row.appendChild(name);
      row.appendChild(size);
      row.appendChild(time);
      row.appendChild(actions);

      if (item.isDir) {
        name.addEventListener('click', () =>
          sftpNavigate(joinRemote(state.sftp.path, item.name)),
        );
      }
      els.sftpList.appendChild(row);
    }
  }

  function joinRemote(base, name) {
    if (!base || base === '.') return name;
    return base.replace(/\/$/, '') + '/' + name;
  }

  function parentPath(p) {
    if (!p || p === '/' || p === '.') return '.';
    const trimmed = p.replace(/\/$/, '');
    const idx = trimmed.lastIndexOf('/');
    if (idx <= 0) return '/';
    return trimmed.slice(0, idx);
  }

  els.sftpUp.addEventListener('click', () =>
    sftpNavigate(parentPath(state.sftp.path)),
  );
  els.sftpGo.addEventListener('click', () => sftpNavigate(els.sftpPath.value));
  els.sftpPath.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sftpNavigate(els.sftpPath.value);
  });

  els.sftpMkdir.addEventListener('click', async () => {
    const serviceId = state.sftp.serviceId;
    if (!serviceId) return;
    const name = prompt('New folder name:');
    if (!name) return;
    try {
      await api(`/api/services/${serviceId}/sftp/mkdir`, {
        method: 'POST',
        body: JSON.stringify({ path: joinRemote(state.sftp.path, name) }),
      });
      sftpNavigate(state.sftp.path);
    } catch (err) {
      showError(els.sftpError, err.message);
    }
  });

  async function sftpDelete(item) {
    if (!confirm(`Delete ${item.isDir ? 'folder' : 'file'} "${item.name}"?`)) return;
    const serviceId = state.sftp.serviceId;
    try {
      await api(`/api/services/${serviceId}/sftp/delete`, {
        method: 'POST',
        body: JSON.stringify({
          path: joinRemote(state.sftp.path, item.name),
          isDir: !!item.isDir,
        }),
      });
      sftpNavigate(state.sftp.path);
    } catch (err) {
      showError(els.sftpError, err.message);
    }
  }

  function sftpDownload(name) {
    const serviceId = state.sftp.serviceId;
    const full = joinRemote(state.sftp.path, name);
    const url = `/api/services/${serviceId}/sftp/download?path=${encodeURIComponent(full)}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  els.sftpUpload.addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const serviceId = state.sftp.serviceId;
    const form = new FormData();
    form.append('file', file, file.name);
    try {
      const res = await fetch(
        `/api/services/${serviceId}/sftp/upload?path=${encodeURIComponent(state.sftp.path)}`,
        { method: 'POST', body: form, credentials: 'include' },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `${res.status} ${res.statusText}`);
      }
      event.target.value = '';
      sftpNavigate(state.sftp.path);
    } catch (err) {
      showError(els.sftpError, err.message);
    }
  });

  // ---------------------------------------------------------------------
  //   Recordings
  // ---------------------------------------------------------------------
  async function openRecordingsFor(serviceId, name) {
    els.recTitle.textContent = `Recordings — ${name}`;
    els.recList.innerHTML = '<li class="service-empty">Loading…</li>';
    disposeRecPlayer();
    els.recPlayerHost.innerHTML =
      '<div class="service-empty">Select a recording to play.</div>';
    openModal(els.recModal);
    try {
      const { recordings } = await api(
        `/api/admin/services/${serviceId}/recordings`,
      );
      renderRecordingsList(serviceId, recordings);
    } catch (err) {
      els.recList.innerHTML = `<li class="service-empty">${err.message}</li>`;
    }
  }

  function renderRecordingsList(serviceId, recordings) {
    if (!recordings.length) {
      els.recList.innerHTML =
        '<li class="service-empty">No recordings yet. Enable "Record sessions" on the shell.</li>';
      return;
    }
    els.recList.innerHTML = '';
    for (const rec of recordings) {
      const li = document.createElement('li');
      li.dataset.name = rec.name;
      const body = document.createElement('div');
      body.className = 'row-body';
      body.innerHTML = `
        <div class="row-name">${new Date(rec.mtime).toLocaleString()}</div>
        <div class="row-sub">${formatBytes(rec.size)} · ${escapeHtml(rec.name)}</div>`;
      const del = document.createElement('button');
      del.className = 'icon-btn';
      del.textContent = '🗑';
      del.title = 'Delete';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Delete this recording?')) return;
        try {
          await api(`/api/admin/recordings/${encodeURIComponent(rec.name)}`, {
            method: 'DELETE',
          });
          openRecordingsFor(serviceId, els.recTitle.textContent.replace(/^Recordings — /, ''));
        } catch (err) {
          alert(err.message);
        }
      });
      li.appendChild(body);
      li.appendChild(del);
      li.addEventListener('click', () => playRecording(rec.name, li));
      els.recList.appendChild(li);
    }
  }

  function disposeRecPlayer() {
    if (state.recPlayer) {
      try {
        state.recPlayer.dispose();
      } catch {
        /* noop */
      }
      state.recPlayer = null;
    }
    els.recPlayerHost.innerHTML = '';
  }

  function playRecording(name, listItem) {
    disposeRecPlayer();
    $$('#rec-list li').forEach((li) => li.classList.remove('active'));
    if (listItem) listItem.classList.add('active');
    els.recPlayerHost.innerHTML = '';
    state.recPlayer = AsciinemaPlayer.create(
      `/api/admin/recordings/${encodeURIComponent(name)}`,
      els.recPlayerHost,
      { autoPlay: true, theme: 'monokai' },
    );
  }

  // Dispose the player when the recordings modal closes.
  const recCloseObserver = new MutationObserver(() => {
    if (els.recModal.hidden) disposeRecPlayer();
  });
  recCloseObserver.observe(els.recModal, { attributes: true, attributeFilter: ['hidden'] });

  // ---------------------------------------------------------------------
  //   Metrics rendering
  // ---------------------------------------------------------------------
  function classForPercent(p) {
    if (p >= 90) return 'crit';
    if (p >= 70) return 'warn';
    return '';
  }

  function renderMetricsPanel() {
    const svc = state.activeTabId ? svcById(state.activeTabId) : null;
    if (!svc) return renderHostMetricsInPanel();
    const ctx = state.contextMetrics.get(svc.id);
    if (!ctx) {
      // No context snapshot yet — leave whatever's shown, but change the label
      // so the user knows something's incoming.
      setScopeLabel(svc);
      // First-load placeholder so the user isn't staring at stale host stats.
      if (svc.type === 'ssh' || svc.type === 'docker') clearContextBars('polling…');
      return;
    }
    if (ctx.error) {
      setScopeLabel(svc, ctx.error);
      clearContextBars('—');
      return;
    }
    setScopeLabel(svc);
    renderContextMetricsInPanel(ctx);
  }

  function renderHostMetricsInPanel() {
    els.metricsPanel.classList.remove('scope-service');
    els.metricsScopeLabel.textContent = 'Host';
    els.metricsScopeSub.textContent = 'panel machine';
    els.hostDiskRow.hidden = false;
    const snapshot = state.lastHostMetrics;
    if (!snapshot) {
      clearContextBars('—');
      return;
    }
    const { cpu, mem, disk } = snapshot;
    setBar(els.hostCpuFill, cpu.percent);
    els.hostCpuValue.textContent = `${cpu.percent.toFixed(1)}%`;
    setBar(els.hostMemFill, mem.percent);
    els.hostMemValue.textContent = `${formatBytes(mem.used)} / ${formatBytes(mem.total)}`;
    if (disk) {
      setBar(els.hostDiskFill, disk.percent);
      els.hostDiskValue.textContent = `${disk.percent.toFixed(1)}%`;
    } else {
      setBar(els.hostDiskFill, 0);
      els.hostDiskValue.textContent = '—';
    }
  }

  function renderContextMetricsInPanel(ctx) {
    els.metricsPanel.classList.add('scope-service');
    setBar(els.hostCpuFill, ctx.cpuPercent || 0);
    els.hostCpuValue.textContent = `${(ctx.cpuPercent || 0).toFixed(1)}%`;
    if (ctx.memTotalBytes) {
      setBar(els.hostMemFill, ctx.memPercent || 0);
      els.hostMemValue.textContent = `${formatBytes(ctx.memBytes)} / ${formatBytes(ctx.memTotalBytes)}`;
    } else if (ctx.memBytes != null) {
      setBar(els.hostMemFill, 0);
      els.hostMemValue.textContent = formatBytes(ctx.memBytes);
    } else {
      setBar(els.hostMemFill, 0);
      els.hostMemValue.textContent = '—';
    }
    if (ctx.disk) {
      els.hostDiskRow.hidden = false;
      setBar(els.hostDiskFill, ctx.disk.percent);
      els.hostDiskValue.textContent = `${ctx.disk.percent.toFixed(1)}%`;
    } else {
      // Local/docker contexts don't report a disk — hide the row for clarity.
      els.hostDiskRow.hidden = ctx.contextType !== 'ssh';
      setBar(els.hostDiskFill, 0);
      els.hostDiskValue.textContent = '—';
    }
  }

  function setScopeLabel(svc, subOverride) {
    els.metricsPanel.classList.add('scope-service');
    const labels = { local: 'Process', ssh: 'Remote host', docker: 'Container' };
    els.metricsScopeLabel.textContent = labels[svc.type] || 'Service';
    let sub;
    if (subOverride) sub = subOverride;
    else if (svc.type === 'ssh')
      sub = `${svc.sshUser || ''}@${svc.host || ''}`.replace(/^@/, '') || svc.name;
    else if (svc.type === 'docker')
      sub = (svc.containerId ? String(svc.containerId).slice(0, 12) : '') || svc.name;
    else sub = svc.name;
    els.metricsScopeSub.textContent = sub;
  }

  function clearContextBars(placeholder) {
    setBar(els.hostCpuFill, 0);
    setBar(els.hostMemFill, 0);
    setBar(els.hostDiskFill, 0);
    els.hostCpuValue.textContent = placeholder;
    els.hostMemValue.textContent = placeholder;
    els.hostDiskValue.textContent = placeholder;
  }

  function setBar(el, percent) {
    const clamped = Math.max(0, Math.min(100, percent || 0));
    el.style.width = clamped + '%';
    el.classList.remove('warn', 'crit');
    const cls = classForPercent(clamped);
    if (cls) el.classList.add(cls);
  }

  function renderServiceMetrics(metrics) {
    els.serviceMetrics.hidden = false;
    els.svcCpuValue.textContent = `${metrics.cpu.toFixed(1)}%`;
    els.svcMemValue.textContent = formatBytes(metrics.mem);
    drawSparkline(els.svcSparkline, metrics.history.cpu);
  }

  function clearServiceMetrics() {
    els.serviceMetrics.hidden = true;
    els.svcCpuValue.textContent = '—';
    els.svcMemValue.textContent = '—';
    const ctx = els.svcSparkline.getContext('2d');
    ctx.clearRect(0, 0, els.svcSparkline.width, els.svcSparkline.height);
  }

  function drawSparkline(canvas, values) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (!values || values.length < 2) return;
    // Dynamic max, floor 100 so idle graphs don't oscillate wildly.
    const max = Math.max(100, ...values);
    ctx.strokeStyle = '#7c9eff';
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    values.forEach((v, i) => {
      const x = (i / (values.length - 1)) * (w - 2) + 1;
      const y = h - (v / max) * (h - 2) - 1;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fillStyle = 'rgba(124, 158, 255, 0.18)';
    ctx.fill();
  }

  // ---------------------------------------------------------------------
  //   Macro toolbar
  // ---------------------------------------------------------------------
  function renderMacroBar() {
    const svc = state.activeTabId ? svcById(state.activeTabId) : null;
    if (!svc || !Array.isArray(svc.macros) || svc.macros.length === 0) {
      els.macroBar.hidden = true;
      els.macroBar.innerHTML = '';
      return;
    }
    const running = svc.status && svc.status.state === 'running';
    els.macroBar.hidden = false;
    els.macroBar.innerHTML = '';
    for (const macro of svc.macros) {
      const btn = document.createElement('button');
      btn.className = 'macro-btn';
      btn.type = 'button';
      btn.textContent = macro.label;
      btn.title = macro.command;
      btn.disabled = !running;
      btn.addEventListener('click', () => fireMacro(svc.id, macro.id));
      els.macroBar.appendChild(btn);
    }
  }

  function fireMacro(serviceId, macroId) {
    if (!socket) return;
    socket.emit('service-macro', { id: serviceId, macroId }, (ack) => {
      if (ack && !ack.ok) {
        const tab = findTab(serviceId);
        if (tab) tab.term.writeln(`\r\n\x1b[31m[shellHelper] macro failed: ${ack.error}\x1b[0m`);
      }
    });
  }

  // ---------------------------------------------------------------------
  //   Macros editor (admin)
  // ---------------------------------------------------------------------
  function openMacrosEditor(service) {
    state.macrosEditor.serviceId = service.id;
    state.macrosEditor.rows = (service.macros || []).map((m) => ({ ...m }));
    els.macrosTitle.textContent = `Macros — ${service.name}`;
    clearError(els.macrosError);
    renderMacroRows();
    openModal(els.macrosModal);
  }

  function renderMacroRows() {
    els.macrosRows.innerHTML = '';
    if (!state.macrosEditor.rows.length) {
      const empty = document.createElement('div');
      empty.className = 'service-empty';
      empty.textContent = 'No macros yet. Click "+ Add macro" to create one.';
      els.macrosRows.appendChild(empty);
      return;
    }
    state.macrosEditor.rows.forEach((row, idx) => {
      const container = document.createElement('div');
      container.className = 'macro-row';

      const labelInput = document.createElement('input');
      labelInput.value = row.label || '';
      labelInput.placeholder = 'Button label';
      labelInput.addEventListener('input', () => {
        state.macrosEditor.rows[idx].label = labelInput.value;
      });

      const cmdInput = document.createElement('textarea');
      cmdInput.value = row.command || '';
      cmdInput.placeholder = 'Command to send (end with \\n to auto-run)';
      cmdInput.rows = 2;
      cmdInput.addEventListener('input', () => {
        state.macrosEditor.rows[idx].command = cmdInput.value;
      });

      const remove = document.createElement('button');
      remove.className = 'icon-btn';
      remove.textContent = '🗑';
      remove.title = 'Remove macro';
      remove.addEventListener('click', () => {
        state.macrosEditor.rows.splice(idx, 1);
        renderMacroRows();
      });

      container.appendChild(labelInput);
      container.appendChild(cmdInput);
      container.appendChild(remove);
      els.macrosRows.appendChild(container);
    });
  }

  els.macrosAdd.addEventListener('click', () => {
    state.macrosEditor.rows.push({ label: '', command: '' });
    renderMacroRows();
  });

  els.macrosSave.addEventListener('click', async () => {
    clearError(els.macrosError);
    const serviceId = state.macrosEditor.serviceId;
    if (!serviceId) return;
    // Strip blank rows before sending.
    const macros = state.macrosEditor.rows
      .map((r) => ({
        id: r.id || undefined,
        label: (r.label || '').trim(),
        command: r.command || '',
      }))
      .filter((r) => r.label && r.command);
    try {
      await api(`/api/admin/services/${serviceId}`, {
        method: 'PATCH',
        body: JSON.stringify({ macros }),
      });
      els.macrosModal.hidden = true;
      refreshAdminShells();
    } catch (err) {
      showError(els.macrosError, err.message);
    }
  });

  // ---------------------------------------------------------------------
  //   Log alerts (toast + tab colouring)
  // ---------------------------------------------------------------------
  function handleLogAlert(alert) {
    if (!alert || !alert.serviceId) return;
    const cur = state.alertState.get(alert.serviceId) || {
      count: 0,
      severity: 'warn',
      lastAt: 0,
    };
    cur.count += 1;
    cur.lastAt = alert.timestamp || Date.now();
    // Crit trumps warn once set — keeps the colouring "worst wins".
    if (alert.rule && alert.rule.severity === 'crit') cur.severity = 'crit';
    else if (cur.severity !== 'crit') cur.severity = 'warn';
    state.alertState.set(alert.serviceId, cur);
    renderServiceList();
    renderTabBar();
    showAlertToast(alert);
  }

  function clearAlertState(serviceId) {
    if (!serviceId) return;
    if (state.alertState.delete(serviceId)) {
      renderServiceList();
      renderTabBar();
    }
  }

  function showAlertToast(alert) {
    if (!els.toastHost) return;
    const svc = svcById(alert.serviceId);
    const div = document.createElement('div');
    div.className = 'toast' + (alert.rule.severity === 'crit' ? ' crit' : '');
    const title = document.createElement('div');
    title.className = 'toast-title';
    const left = document.createElement('span');
    left.textContent = alert.rule.name || alert.rule.pattern;
    const right = document.createElement('span');
    right.className = 'toast-svc';
    right.textContent = svc ? svc.name : alert.serviceId;
    title.appendChild(left);
    title.appendChild(right);
    const line = document.createElement('div');
    line.className = 'toast-line';
    line.textContent = alert.line;
    div.appendChild(title);
    div.appendChild(line);
    div.title = 'Click to jump to this service';
    div.addEventListener('click', () => {
      div.remove();
      openOrFocusTab(alert.serviceId);
    });
    els.toastHost.appendChild(div);
    // Cap the toast queue at 5 so runaway matches don't cover the whole panel.
    while (els.toastHost.children.length > 5) {
      els.toastHost.firstElementChild.remove();
    }
    setTimeout(() => {
      div.style.transition = 'opacity 300ms ease';
      div.style.opacity = '0';
      setTimeout(() => div.remove(), 350);
    }, 6000);
  }

  // ---------------------------------------------------------------------
  //   Alert rules editor (admin)
  // ---------------------------------------------------------------------
  async function openAlertsEditor(service) {
    state.alertsEditor.serviceId = service.id;
    state.alertsEditor.rows = [];
    els.alertsTitle.textContent = `Log alerts — ${service.name}`;
    clearError(els.alertsError);
    openModal(els.alertsModal);
    try {
      const { rules } = await api(
        `/api/admin/services/${service.id}/alerts`,
      );
      state.alertsEditor.rows = (rules || []).map((r) => ({ ...r }));
      renderAlertRows();
    } catch (err) {
      showError(els.alertsError, err.message);
    }
  }

  function renderAlertRows() {
    els.alertsRows.innerHTML = '';
    if (!state.alertsEditor.rows.length) {
      const empty = document.createElement('div');
      empty.className = 'service-empty';
      empty.textContent = 'No rules yet. Click "+ Add rule" to create one.';
      els.alertsRows.appendChild(empty);
      return;
    }
    state.alertsEditor.rows.forEach((row, idx) => {
      const container = document.createElement('div');
      container.className = 'macro-row alert-row';

      const nameInput = document.createElement('input');
      nameInput.value = row.name || '';
      nameInput.placeholder = 'Rule name';
      nameInput.addEventListener('input', () => {
        state.alertsEditor.rows[idx].name = nameInput.value;
      });

      const patternInput = document.createElement('input');
      patternInput.value = row.pattern || '';
      patternInput.placeholder = 'Regex, e.g. ERROR|FATAL|panic';
      patternInput.addEventListener('input', () => {
        state.alertsEditor.rows[idx].pattern = patternInput.value;
      });

      const sevSelect = document.createElement('select');
      for (const opt of ['warn', 'crit']) {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt;
        if ((row.severity || 'warn') === opt) o.selected = true;
        sevSelect.appendChild(o);
      }
      sevSelect.addEventListener('change', () => {
        state.alertsEditor.rows[idx].severity = sevSelect.value;
      });

      const remove = document.createElement('button');
      remove.className = 'icon-btn';
      remove.textContent = '🗑';
      remove.title = 'Remove rule';
      remove.addEventListener('click', () => {
        state.alertsEditor.rows.splice(idx, 1);
        renderAlertRows();
      });

      container.appendChild(nameInput);
      container.appendChild(patternInput);
      container.appendChild(sevSelect);
      container.appendChild(remove);
      els.alertsRows.appendChild(container);
    });
  }

  els.alertsAdd.addEventListener('click', () => {
    state.alertsEditor.rows.push({
      name: '',
      pattern: '',
      severity: 'warn',
    });
    renderAlertRows();
  });

  els.alertsSave.addEventListener('click', async () => {
    clearError(els.alertsError);
    const serviceId = state.alertsEditor.serviceId;
    if (!serviceId) return;
    const rules = state.alertsEditor.rows
      .map((r) => ({
        id: r.id || undefined,
        name: (r.name || '').trim(),
        pattern: (r.pattern || '').trim(),
        severity: r.severity === 'crit' ? 'crit' : 'warn',
      }))
      .filter((r) => r.pattern);
    try {
      await api(`/api/admin/services/${serviceId}/alerts`, {
        method: 'PUT',
        body: JSON.stringify({ rules }),
      });
      els.alertsModal.hidden = true;
    } catch (err) {
      showError(els.alertsError, err.message);
    }
  });

  // ---------------------------------------------------------------------
  //   Terminal preferences modal
  // ---------------------------------------------------------------------
  // Working copy used while the modal is open; committed to state.me on save.
  const prefsDraft = { theme: null, fontSize: null, fontFamily: null, customTheme: null };

  els.prefsBtn.addEventListener('click', () => openPrefsModal());

  function openPrefsModal() {
    const current = effectivePrefs();
    Object.assign(prefsDraft, current);
    if (!prefsDraft.customTheme) prefsDraft.customTheme = { ...THEME_PRESETS.shellHelper };
    clearError(els.prefsError);
    renderThemePicker();
    renderFontControls();
    renderCustomThemeInputs();
    renderPrefsPreview();
    openModal(els.prefsModal);
  }

  function renderThemePicker() {
    els.prefsThemePicker.innerHTML = '';
    const names = Object.keys(THEME_PRESETS).concat('custom');
    for (const name of names) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'theme-swatch';
      if (name === prefsDraft.theme) btn.classList.add('active');
      const theme = name === 'custom'
        ? (prefsDraft.customTheme || THEME_PRESETS.shellHelper)
        : THEME_PRESETS[name];
      btn.style.background = theme.background;
      btn.style.color = theme.foreground;
      // Small ANSI palette strip along the bottom edge so presets don't all
      // look identical at a glance.
      const palette = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan']
        .map((k) => `<span style="background:${theme[k]}"></span>`)
        .join('');
      btn.innerHTML = `<span class="theme-swatch-name">${name}</span>
        <span class="theme-swatch-strip">${palette}</span>`;
      btn.addEventListener('click', () => {
        prefsDraft.theme = name;
        renderThemePicker();
        renderCustomThemeInputs();
        renderPrefsPreview();
      });
      els.prefsThemePicker.appendChild(btn);
    }
    els.prefsCustomTheme.hidden = prefsDraft.theme !== 'custom';
  }

  function renderCustomThemeInputs() {
    if (prefsDraft.theme !== 'custom') return;
    const keys = [
      'background', 'foreground', 'cursor',
      'black', 'red', 'green', 'yellow',
      'blue', 'magenta', 'cyan', 'white',
    ];
    els.prefsCustomInputs.innerHTML = '';
    for (const k of keys) {
      const row = document.createElement('label');
      row.className = 'custom-color-row';
      const swatch = document.createElement('input');
      swatch.type = 'color';
      swatch.value = normalizeHex(prefsDraft.customTheme[k]) || '#000000';
      swatch.addEventListener('input', () => {
        prefsDraft.customTheme[k] = swatch.value;
        renderPrefsPreview();
        renderThemePicker();
      });
      const label = document.createElement('span');
      label.textContent = k;
      row.appendChild(swatch);
      row.appendChild(label);
      els.prefsCustomInputs.appendChild(row);
    }
  }

  // <input type="color"> only accepts #rrggbb — coerce rgba()/short hex so it
  // doesn't silently reset to black on open.
  function normalizeHex(v) {
    if (typeof v !== 'string') return null;
    if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
    if (/^#[0-9a-fA-F]{3}$/.test(v)) {
      return '#' + v.slice(1).split('').map((c) => c + c).join('').toLowerCase();
    }
    return null;
  }

  function renderFontControls() {
    els.prefsFontFamily.innerHTML = '';
    let matched = false;
    for (const f of FONT_FAMILY_PRESETS) {
      const opt = document.createElement('option');
      opt.value = f;
      // Show only the primary family name in the dropdown; the full stack is
      // still what actually gets applied.
      opt.textContent = f.split(',')[0].replace(/["']/g, '').trim();
      if (f === prefsDraft.fontFamily) {
        opt.selected = true;
        matched = true;
      }
      els.prefsFontFamily.appendChild(opt);
    }
    if (!matched) {
      // User has a custom family stored — surface it so they don't clobber it.
      const opt = document.createElement('option');
      opt.value = prefsDraft.fontFamily;
      opt.textContent = '(current) ' + prefsDraft.fontFamily.split(',')[0];
      opt.selected = true;
      els.prefsFontFamily.appendChild(opt);
    }
    els.prefsFontSize.value = String(prefsDraft.fontSize);
    els.prefsFontSizeVal.textContent = String(prefsDraft.fontSize);
  }

  els.prefsFontFamily && els.prefsFontFamily.addEventListener('change', () => {
    prefsDraft.fontFamily = els.prefsFontFamily.value;
    renderPrefsPreview();
  });
  els.prefsFontSize && els.prefsFontSize.addEventListener('input', () => {
    prefsDraft.fontSize = Number(els.prefsFontSize.value) || DEFAULT_PREFS.fontSize;
    els.prefsFontSizeVal.textContent = String(prefsDraft.fontSize);
    renderPrefsPreview();
  });

  function renderPrefsPreview() {
    const theme = prefsDraft.theme === 'custom'
      ? { ...THEME_PRESETS.shellHelper, ...(prefsDraft.customTheme || {}) }
      : THEME_PRESETS[prefsDraft.theme] || THEME_PRESETS.shellHelper;
    els.prefsPreview.style.background = theme.background;
    els.prefsPreview.style.color = theme.foreground;
    els.prefsPreview.style.fontFamily = prefsDraft.fontFamily;
    els.prefsPreview.style.fontSize = prefsDraft.fontSize + 'px';
    els.prefsPreview.innerHTML = [
      `<span style="color:${theme.brightBlack}">$</span> <span style="color:${theme.green}">echo</span> "Hello, $(whoami)"`,
      `<span style="color:${theme.brightBlack}">$</span> <span style="color:${theme.blue}">ls</span> <span style="color:${theme.cyan}">-al</span> <span style="color:${theme.yellow}">/tmp</span>`,
      `<span style="color:${theme.red}">error:</span> connection refused`,
      `<span style="color:${theme.magenta}">warning:</span> disk 87% full`,
    ].join('\n');
  }

  els.prefsReset.addEventListener('click', () => {
    Object.assign(prefsDraft, DEFAULT_PREFS);
    prefsDraft.customTheme = { ...THEME_PRESETS.shellHelper };
    renderThemePicker();
    renderFontControls();
    renderCustomThemeInputs();
    renderPrefsPreview();
  });

  els.prefsSave.addEventListener('click', async () => {
    clearError(els.prefsError);
    els.prefsSave.disabled = true;
    try {
      const body = {
        theme: prefsDraft.theme,
        fontSize: prefsDraft.fontSize,
        fontFamily: prefsDraft.fontFamily,
        customTheme: prefsDraft.theme === 'custom' ? prefsDraft.customTheme : null,
      };
      const { user } = await api('/api/auth/preferences', {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      state.me = user;
      applyPrefsToAllTerms();
      els.prefsModal.hidden = true;
    } catch (err) {
      showError(els.prefsError, err.message);
    } finally {
      els.prefsSave.disabled = false;
    }
  });

  // ---------------------------------------------------------------------
  //   Xterm theme presets + user font preferences
  // ---------------------------------------------------------------------
  // Keep every colour spelled out so xterm doesn't fall back to defaults for
  // ANSI slots the preset didn't override. Add entries here to expose new
  // presets in the picker automatically.
  const THEME_PRESETS = {
    shellHelper: {
      background: '#05070c', foreground: '#e6e9f2', cursor: '#7c9eff',
      cursorAccent: '#05070c', selectionBackground: 'rgba(124, 158, 255, 0.30)',
      black: '#1e222d', red: '#f87171', green: '#4ade80', yellow: '#fbbf24',
      blue: '#7c9eff', magenta: '#c084fc', cyan: '#67e8f9', white: '#e6e9f2',
      brightBlack: '#5b6478', brightRed: '#fca5a5', brightGreen: '#86efac',
      brightYellow: '#fde68a', brightBlue: '#a3bffa', brightMagenta: '#d8b4fe',
      brightCyan: '#a5f3fc', brightWhite: '#ffffff',
    },
    Dracula: {
      background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2',
      cursorAccent: '#282a36', selectionBackground: 'rgba(68, 71, 90, 0.99)',
      black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
      blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94',
      brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df',
      brightCyan: '#a4ffff', brightWhite: '#ffffff',
    },
    Nord: {
      background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9',
      cursorAccent: '#2e3440', selectionBackground: 'rgba(67, 76, 94, 0.99)',
      black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b',
      blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
      brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c',
      brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead',
      brightCyan: '#8fbcbb', brightWhite: '#eceff4',
    },
    Monokai: {
      background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f0',
      cursorAccent: '#272822', selectionBackground: 'rgba(73, 72, 62, 0.99)',
      black: '#272822', red: '#f92672', green: '#a6e22e', yellow: '#f4bf75',
      blue: '#66d9ef', magenta: '#ae81ff', cyan: '#a1efe4', white: '#f8f8f2',
      brightBlack: '#75715e', brightRed: '#f92672', brightGreen: '#a6e22e',
      brightYellow: '#f4bf75', brightBlue: '#66d9ef', brightMagenta: '#ae81ff',
      brightCyan: '#a1efe4', brightWhite: '#f9f8f5',
    },
    'Solarized Dark': {
      background: '#002b36', foreground: '#93a1a1', cursor: '#93a1a1',
      cursorAccent: '#002b36', selectionBackground: 'rgba(7, 54, 66, 0.99)',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
      blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75',
      brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    },
    Matrix: {
      background: '#000000', foreground: '#00ff41', cursor: '#00ff41',
      cursorAccent: '#000000', selectionBackground: 'rgba(0, 255, 65, 0.25)',
      black: '#000000', red: '#008f11', green: '#00ff41', yellow: '#00cc33',
      blue: '#008f11', magenta: '#00b32d', cyan: '#00ff41', white: '#00ff41',
      brightBlack: '#003b00', brightRed: '#00cc33', brightGreen: '#39ff14',
      brightYellow: '#00e639', brightBlue: '#00b32d', brightMagenta: '#39ff14',
      brightCyan: '#39ff14', brightWhite: '#c7ffcf',
    },
  };

  const FONT_FAMILY_PRESETS = [
    'JetBrains Mono, Menlo, Monaco, Consolas, "Courier New", monospace',
    'Fira Code, Menlo, Monaco, Consolas, monospace',
    'Menlo, Monaco, Consolas, "Courier New", monospace',
    'Consolas, "Courier New", monospace',
    'Cascadia Code, Menlo, Monaco, monospace',
    'IBM Plex Mono, Menlo, Monaco, monospace',
    'monospace',
  ];

  const DEFAULT_PREFS = {
    theme: 'shellHelper',
    fontSize: 13,
    fontFamily: FONT_FAMILY_PRESETS[0],
    customTheme: null,
  };

  function effectivePrefs() {
    const p = (state.me && state.me.terminalPrefs) || {};
    return {
      theme: p.theme || DEFAULT_PREFS.theme,
      fontSize: Number(p.fontSize) || DEFAULT_PREFS.fontSize,
      fontFamily: p.fontFamily || DEFAULT_PREFS.fontFamily,
      customTheme: p.customTheme || null,
    };
  }

  function activeThemeObject(prefs) {
    const p = prefs || effectivePrefs();
    if (p.theme === 'custom' && p.customTheme) {
      // Layer partial custom overrides on top of the current default so any
      // ANSI slot the user hasn't set still resolves to a sensible colour.
      return { ...THEME_PRESETS.shellHelper, ...p.customTheme };
    }
    return THEME_PRESETS[p.theme] || THEME_PRESETS.shellHelper;
  }

  // Apply prefs to every existing tab; re-fits after font changes because the
  // char cell size shifts and xterm's own resize doesn't refit column count.
  function applyPrefsToAllTerms() {
    const p = effectivePrefs();
    const theme = activeThemeObject(p);
    for (const tab of state.tabs) {
      try {
        tab.term.options.theme = theme;
        tab.term.options.fontFamily = p.fontFamily;
        tab.term.options.fontSize = p.fontSize;
      } catch {
        /* xterm may throw if a value fails validation — skip silently */
      }
      // Give the DOM a tick to re-render before fitting.
      requestAnimationFrame(() => fitTerminalFor(tab));
    }
  }

  window.addEventListener('resize', () => {
    const tab = activeTab();
    if (tab) fitTerminalFor(tab);
  });

  // ---------------------------------------------------------------------
  //   Workspaces (graphical container streaming via KasmVNC/noVNC)
  // ---------------------------------------------------------------------
  function wsById(id) {
    return state.workspaces.find((w) => w.id === id) || null;
  }

  function renderWorkspaceList() {
    if (!els.workspaceList) return;
    if (state.workspaces.length === 0) {
      els.workspaceList.innerHTML =
        '<li class="service-empty">No workspaces available. Ask an admin.</li>';
      return;
    }
    els.workspaceList.innerHTML = '';
    for (const w of state.workspaces) {
      const li = document.createElement('li');
      li.className = 'service-item workspace-item';
      if (w.id === state.activeWorkspaceId) li.classList.add('active');

      const dot = document.createElement('span');
      const state_ = w.status && w.status.state;
      dot.className = 'service-dot';
      if (state_ === 'running') {
        dot.classList.add(w.status.ready ? 'ready' : 'starting');
      } else {
        dot.classList.add('stopped');
      }

      const body = document.createElement('div');
      body.className = 'service-body';
      const name = document.createElement('div');
      name.className = 'service-name';
      name.textContent = w.name;
      const badge = document.createElement('span');
      badge.className = 'service-type-badge';
      badge.textContent = 'ws';
      name.appendChild(badge);

      const sub = document.createElement('div');
      sub.className = 'service-sub';
      if (state_ === 'running') {
        sub.textContent = w.status.ready ? 'running · ready' : 'starting…';
      } else {
        sub.textContent = w.image;
      }

      body.appendChild(name);
      body.appendChild(sub);
      li.appendChild(dot);
      li.appendChild(body);
      li.addEventListener('click', () => activateWorkspace(w.id));
      els.workspaceList.appendChild(li);
    }
  }

  async function activateWorkspace(id) {
    const w = wsById(id);
    if (!w) return;
    // Leaving a shell tab? Blur it so the terminal stops receiving keystrokes.
    state.activeTabId = null;
    for (const t of state.tabs) t.hostEl.classList.remove('active');
    els.tabBar.hidden = true;
    els.placeholder.classList.add('hidden');
    if (els.macroBar) els.macroBar.hidden = true;

    state.activeWorkspaceId = id;
    els.workspaceControls.hidden = false;
    els.workspaceViewport.hidden = false;
    renderWorkspaceList();
    renderWorkspaceControls();
    renderActiveHeader();

    if (w.status && w.status.state === 'running' && w.status.ready) {
      loadWorkspaceIframe(id);
    } else if (w.status && w.status.state === 'running') {
      showWorkspaceLoading('Waiting for container to become ready…');
    } else {
      showWorkspaceLoading('Starting workspace container…');
      try {
        await api(`/api/workspaces/${encodeURIComponent(id)}/start`, {
          method: 'POST',
        });
      } catch (err) {
        showWorkspaceLoading('Failed to start: ' + err.message);
      }
    }
  }

  function deactivateWorkspace() {
    state.activeWorkspaceId = null;
    els.workspaceControls.hidden = true;
    els.workspaceViewport.hidden = true;
    clearWorkspaceIframe();
    renderWorkspaceList();
  }

  function renderWorkspaceControls() {
    const w = state.activeWorkspaceId ? wsById(state.activeWorkspaceId) : null;
    if (!w) return;
    els.workspaceControlsName.textContent = w.name;
    const running = w.status && w.status.state === 'running';
    const ready = running && w.status.ready;
    const statusText = ready ? 'ready' : running ? 'starting' : 'stopped';
    els.workspaceControlsStatus.textContent = statusText;
    els.workspaceControlsStatus.className =
      'workspace-controls-status state-' + statusText;
    els.workspaceStartBtn.hidden = running;
    els.workspaceStopBtn.hidden = !running;
    els.workspaceReloadBtn.disabled = !ready;
    els.workspaceClipboardBtn.disabled = !ready;
    els.workspaceFullscreenBtn.disabled = !ready;
    // Update main header meta so users know they're on a workspace tab.
    els.activeName.textContent = w.name;
    els.activeMeta.textContent = `${w.image} · workspace · ${statusText}`;
    setControlsEnabled({
      start: false,
      stop: false,
      restart: false,
      clear: false,
      sftp: false,
      logs: false,
    });
    els.sftpBtn.hidden = true;
  }

  function showWorkspaceLoading(text) {
    els.workspaceLoading.hidden = false;
    els.workspaceLoading.classList.remove('done');
    els.workspaceLoadingText.textContent = text;
    els.workspaceFrame.hidden = true;
  }

  function hideWorkspaceLoading() {
    els.workspaceLoading.classList.add('done');
    // Actually hide it after the fade so it stops blocking pointer events.
    setTimeout(() => {
      if (els.workspaceLoading.classList.contains('done')) {
        els.workspaceLoading.hidden = true;
      }
    }, 260);
  }

  function clearWorkspaceIframe() {
    els.workspaceFrame.hidden = true;
    els.workspaceFrame.src = 'about:blank';
    showWorkspaceLoading('Workspace stopped.');
  }

  async function loadWorkspaceIframe(id) {
    const w = wsById(id);
    if (!w) return;
    let info = null;
    try {
      const body = await api(`/api/workspaces/${encodeURIComponent(id)}`);
      info = body.instance;
    } catch (err) {
      showWorkspaceLoading('Unable to fetch workspace info: ' + err.message);
      return;
    }
    if (!info) {
      showWorkspaceLoading('Container is not running.');
      return;
    }
    const params = new URLSearchParams();
    if (state.workspaceView.autoConnect) {
      params.set('autoconnect', '1');
      // Both noVNC and KasmVNC accept `password` in the URL.
      if (info.vncPassword) params.set('password', info.vncPassword);
    }
    if (state.workspaceView.resize) {
      params.set('resize', 'remote');
    }
    // Rough quality mapping: KasmVNC honours these in its query string.
    const qMap = { low: '3', medium: '6', high: '9' };
    if (qMap[state.workspaceView.quality]) {
      params.set('quality', qMap[state.workspaceView.quality]);
    }
    const url =
      `/api/workspaces/${encodeURIComponent(id)}/stream/?` + params.toString();
    els.workspaceFrame.hidden = false;
    els.workspaceFrame.src = url;
    els.workspaceFrame.onload = () => hideWorkspaceLoading();
    // Safety net: some noVNC builds fire load only after the connection
    // settles, so drop the overlay after a short delay too.
    setTimeout(hideWorkspaceLoading, 1500);
  }

  els.workspaceStartBtn.addEventListener('click', () => {
    if (state.activeWorkspaceId) activateWorkspace(state.activeWorkspaceId);
  });

  els.workspaceStopBtn.addEventListener('click', async () => {
    if (!state.activeWorkspaceId) return;
    const id = state.activeWorkspaceId;
    try {
      await api(`/api/workspaces/${encodeURIComponent(id)}/stop`, {
        method: 'POST',
      });
    } catch (err) {
      alert('Stop failed: ' + err.message);
    }
  });

  els.workspaceReloadBtn.addEventListener('click', () => {
    if (state.activeWorkspaceId) loadWorkspaceIframe(state.activeWorkspaceId);
  });

  els.workspaceFullscreenBtn.addEventListener('click', () => {
    const target = els.workspaceViewport;
    if (!target) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else if (target.requestFullscreen) {
      target.requestFullscreen().catch(() => {});
    }
  });

  els.workspaceClipboardBtn.addEventListener('click', async () => {
    if (!state.activeWorkspaceId) return;
    try {
      const body = await api(
        `/api/workspaces/${encodeURIComponent(state.activeWorkspaceId)}`,
      );
      const pw = body.instance && body.instance.vncPassword;
      if (!pw) return alert('Password not available yet.');
      await navigator.clipboard.writeText(pw);
      const btn = els.workspaceClipboardBtn;
      const original = btn.textContent;
      btn.textContent = 'Copied ✓';
      setTimeout(() => (btn.textContent = original), 1400);
    } catch (err) {
      alert('Clipboard copy failed: ' + err.message);
    }
  });

  els.workspaceAutoConnect.addEventListener('change', () => {
    state.workspaceView.autoConnect = els.workspaceAutoConnect.checked;
  });
  els.workspaceResize.addEventListener('change', () => {
    state.workspaceView.resize = els.workspaceResize.checked;
  });
  els.workspaceQuality.addEventListener('change', () => {
    state.workspaceView.quality = els.workspaceQuality.value;
  });

  els.workspacesRefresh.addEventListener('click', async () => {
    try {
      const body = await api('/api/workspaces');
      state.workspaces = body.workspaces || [];
      renderWorkspaceList();
      renderWorkspaceControls();
    } catch (err) {
      console.error('workspace refresh failed', err);
    }
  });

  // ---------------------------------------------------------------------
  //   Admin: workspace templates
  // ---------------------------------------------------------------------
  async function refreshAdminWorkspaces() {
    if (!els.adminWorkspaceList) return;
    try {
      const { workspaces: list } = await api('/api/admin/workspaces');
      renderAdminWorkspaces(list);
    } catch (err) {
      els.adminWorkspaceList.innerHTML = `<li class="service-empty">${err.message}</li>`;
    }
  }

  function renderAdminWorkspaces(list) {
    if (!list.length) {
      els.adminWorkspaceList.innerHTML =
        '<li class="service-empty">No workspaces yet. Add one on the right.</li>';
      return;
    }
    els.adminWorkspaceList.innerHTML = '';
    for (const w of list) {
      const li = document.createElement('li');
      const body = document.createElement('div');
      body.className = 'row-body';
      const allowed =
        w.allowedUsers && w.allowedUsers.length
          ? ' · allowed: ' + w.allowedUsers.join(', ')
          : ' · admins only';
      body.innerHTML = `
        <div class="row-name">${escapeHtml(w.name)}</div>
        <div class="row-sub">${escapeHtml(
          `${w.image} · ${w.resolution} · shm=${w.shmSize}` + allowed,
        )}</div>`;
      const actions = document.createElement('div');
      actions.className = 'row-actions';
      const del = document.createElement('button');
      del.className = 'icon-btn';
      del.title = 'Delete workspace';
      del.textContent = '🗑';
      del.addEventListener('click', async () => {
        if (!confirm(`Delete workspace "${w.name}"?`)) return;
        try {
          await api(`/api/admin/workspaces/${w.id}`, { method: 'DELETE' });
          refreshAdminWorkspaces();
        } catch (err) {
          alert(err.message);
        }
      });
      actions.appendChild(del);
      li.appendChild(body);
      li.appendChild(actions);
      els.adminWorkspaceList.appendChild(li);
    }
  }

  function renderWorkspaceAllowedUsersPicker() {
    if (!els.workspaceAllowedUsers) return;
    const nonAdmins = state.users.filter((u) => u.role !== 'admin');
    if (nonAdmins.length === 0) {
      els.workspaceAllowedUsers.innerHTML =
        '<span class="service-empty">Create non-admin users first to grant them access.</span>';
      return;
    }
    els.workspaceAllowedUsers.innerHTML = '';
    for (const u of nonAdmins) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.name = 'wsAllowedUser';
      input.value = u.username;
      label.appendChild(input);
      label.appendChild(document.createTextNode(u.username));
      els.workspaceAllowedUsers.appendChild(label);
    }
  }

  if (els.adminWorkspaceForm) {
    els.adminWorkspaceForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const err = $('[data-error]', els.adminWorkspaceForm);
      clearError(err);
      const data = new FormData(els.adminWorkspaceForm);
      const allowedUsers = $$(
        'input[name="wsAllowedUser"]:checked',
        els.adminWorkspaceForm,
      ).map((el) => el.value);
      const payload = {
        name: data.get('name'),
        image: data.get('image'),
        description: data.get('description') || '',
        internalPort: Number(data.get('internalPort')) || 6901,
        resolution: data.get('resolution') || '1280x800',
        shmSize: data.get('shmSize') || '512m',
        useHttps: !!data.get('useHttps'),
        allowedUsers,
      };
      try {
        await api('/api/admin/workspaces', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        els.adminWorkspaceForm.reset();
        // Restore the useHttps default checkbox state after reset.
        const httpsBox = els.adminWorkspaceForm.querySelector(
          'input[name="useHttps"]',
        );
        if (httpsBox) httpsBox.checked = true;
        refreshAdminWorkspaces();
      } catch (e) {
        showError(err, e.message);
      }
    });
  }

  // Refresh admin workspace UI whenever the admin modal opens. Piggyback on
  // the existing admin-btn handler by observing tab clicks.
  $$('.tab', els.adminModal).forEach((tab) => {
    if (tab.dataset.tab === 'workspaces') {
      tab.addEventListener('click', () => {
        refreshAdminWorkspaces();
        renderWorkspaceAllowedUsersPicker();
      });
    }
  });
  // Also refresh when the admin panel opens (the initial refreshAdminUsers
  // populates state.users, which the picker depends on).
  els.adminBtn.addEventListener('click', () => {
    setTimeout(renderWorkspaceAllowedUsersPicker, 0);
    setTimeout(refreshAdminWorkspaces, 0);
  });

  bootstrap();
})();
