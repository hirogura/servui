/* serv-UI - Frontend Logic */

let currentTab = 'dashboard';
let term = null;
let ws = null;
let fitAddon = null;
let refreshInterval = null;
let wifiStatusData = null;
let selectedWifiNetwork = null;
let pendingTerminalCwd = null;

// --- Tab Navigation ---
document.querySelectorAll('.nav-links li').forEach(li => {
  li.addEventListener('click', () => {
    switchTab(li.dataset.tab);
  });
});

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.nav-links li').forEach(l => l.classList.toggle('active', l.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.toggle('active', t.id === `tab-${tab}`));

  // Load data for the tab
  if (tab === 'dashboard') loadDashboard();
  else if (tab === 'services') loadServices();
  else if (tab === 'packages') {} // Don't auto-check
  else if (tab === 'terminal') {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectTerminal();
    } else if (fitAddon) {
      setTimeout(() => fitAddon.fit(), 50);
    }
  } else if (tab === 'wifi') {
    loadWifiStatus();
  } else if (tab === 'disks') {
    loadDisks();
  } else if (tab === 'grub') {
    loadGrub();
  } else if (tab === 'backup') {
    loadBackupPage();
  } else if (tab === 'fleet') {
    loadFleetPage();
  }
}

function refreshCurrentTab() {
  switchTab(currentTab);
}

async function restartServUI() {
  if (!confirm('serv-UIを再起動しますか？')) return;
  try {
    const resp = await fetch('/api/servui/restart', { method: 'POST' });
    const data = await resp.json();
    if (data.success) {
      showStatus('serv-UIを再起動しました。3秒後にページを更新します。', 'success');
      setTimeout(() => location.reload(), 3000);
    } else {
      showStatus(`再起動に失敗しました: ${data.errors || data.stderr}`, 'error');
    }
  } catch (e) {
    showStatus(`再起動エラー: ${e.message}`, 'error');
  }
}

async function rebootSystem() {
  if (!confirm('PC（サーバー本体）を再起動しますか？\n再起動中はサーバーおよびserv-UIへの接続が一時的に切断されます。')) return;
  try {
    const resp = await fetch('/api/system/reboot', { method: 'POST' });
    const data = await resp.json();
    if (data.success) {
      showStatus('PCの再起動を開始しました。しばらく待ってから再度アクセスしてください。', 'info');
    } else {
      showStatus(`PC再起動に失敗しました: ${data.message || data.errors}`, 'error');
    }
  } catch (e) {
    showStatus('PCの再起動コマンドを送信しました。サーバーが再起動中です...', 'info');
  }
}

// ===== serv-UI update =====
let servuiUpdateState = null; // { t, phase }

async function updateServUI() {
  if (!confirm('serv-UIを更新しますか？\nGitHubから最新版を取得してセットアップします。\n\n・完了まで数分かかる場合があります\n・完了後、サイドバーの「serv-UI再起動」で再起動すると新版が有効になります')) return;

  showStatus('アップデートを開始しています...', 'info');
  try {
    const resp = await fetch('/api/system/selfupdate', { method: 'POST' });
    const data = await resp.json();
    if (!data.success) {
      showStatus(data.message || 'アップデートを開始できませんでした', 'error');
      return;
    }
  } catch (e) {
    showStatus(`アップデート開始エラー: ${e.message}`, 'error');
    return;
  }
  servuiUpdateState = { t: Date.now(), phase: 'watching' };
  showStatus('アップデート実行中... このページを開いたままお待ちください', 'info');
  pollServuiUpdate();
}

function pollServuiUpdate() {
  const st = servuiUpdateState;
  if (!st || st.phase !== 'watching') return;
  fetch('/api/system/selfupdate/status', { cache: 'no-store' })
    .then(r => {
      if (!r.ok) throw new Error('not ok');
      return r.json();
    })
    .then(data => {
      if (!st || st.phase !== 'watching') return;
      if (data.done && !data.running) {
        st.phase = 'done';
        showStatus('アップデート完了！サイドバーの「serv-UI再起動」を実行すると新版が有効になります', 'success');
        return;
      }
      if (!data.running && !data.done) {
        st.phase = 'done';
        const lastLine = (data.log || '').trim().split('\n').filter(Boolean).pop() || '';
        showStatus(`アップデートに失敗しました ${lastLine.slice(0, 120)}`, 'error');
        return;
      }
      if (Date.now() - st.t > 15 * 60 * 1000) {
        st.phase = 'done';
        showStatus('アップデートの状態を確認できませんでした（タイムアウト）', 'error');
        return;
      }
      setTimeout(pollServuiUpdate, 3000);
    })
    .catch(() => {
      if (!st || st.phase !== 'watching') return;
      setTimeout(pollServuiUpdate, 3000);
    });
}

async function shutdownSystem() {
  if (!confirm('PC（サーバー本体）をシャットダウンしますか？\nシャットダウン後はサーバーの電源が切れ、serv-UIにアクセスできなくなります。')) return;
  try {
    const resp = await fetch('/api/system/shutdown', { method: 'POST' });
    const data = await resp.json();
    if (data.success) {
      showStatus('PCのシャットダウンを開始しました。サーバーの電源が切れます。', 'info');
    } else {
      showStatus(`PCシャットダウンに失敗しました: ${data.message || data.errors}`, 'error');
    }
  } catch (e) {
    showStatus('PCのシャットダウンコマンドを送信しました。サーバーがシャットダウン中です...', 'info');
  }
}


// --- Dashboard ---
async function loadDashboard() {
  try {
    const resp = await fetch('/api/system/info');
    const data = await resp.json();

    // サイドバーのホスト名表示
    const hostEl = document.getElementById('sidebar-hostname');
    if (hostEl && data.hostname) hostEl.textContent = data.hostname;

    // CPU
    const cpuPct = data.cpu.percent;
    document.getElementById('cpu-usage').textContent = `${cpuPct}%`;
    const cpuBar = document.getElementById('cpu-bar');
    cpuBar.style.width = `${cpuPct}%`;
    cpuBar.className = `stat-bar-fill ${cpuPct > 80 ? 'danger' : cpuPct > 60 ? 'warn' : ''}`;
    
    // CPU Temperature
    const tempEl = document.getElementById('cpu-temp-detail');
    if (tempEl) {
      if (data.cpu.temp !== null && data.cpu.temp !== undefined) {
        const tempVal = data.cpu.temp;
        const tempClass = tempVal >= 80 ? 'text-danger' : tempVal >= 65 ? 'text-warn' : 'text-accent';
        tempEl.innerHTML = `CPU温度: <span class="${tempClass}">${tempVal}°C</span>`;
      } else {
        tempEl.textContent = 'CPU温度: --';
      }
    }

    document.getElementById('cpu-detail').textContent =
      `${data.cpu.count_physical}コア | Load: ${data.cpu.load_avg['1min']} / ${data.cpu.load_avg['5min']} / ${data.cpu.load_avg['15min']}`;

    // Memory
    const memPct = data.memory.percent;
    document.getElementById('mem-usage').textContent = `${memPct}%`;
    const memBar = document.getElementById('mem-bar');
    memBar.style.width = `${memPct}%`;
    memBar.className = `stat-bar-fill ${memPct > 80 ? 'danger' : memPct > 60 ? 'warn' : ''}`;
    const memUsedGB = (data.memory.used / 1073741824).toFixed(1);
    const memTotalGB = (data.memory.total / 1073741824).toFixed(1);
    document.getElementById('mem-detail').textContent = `${memUsedGB} GB / ${memTotalGB} GB`;

    // Disk
    const diskPct = data.disk.percent;
    document.getElementById('disk-usage').textContent = `${diskPct}%`;
    const diskBar = document.getElementById('disk-bar');
    diskBar.style.width = `${diskPct}%`;
    diskBar.className = `stat-bar-fill ${diskPct > 80 ? 'danger' : diskPct > 60 ? 'warn' : ''}`;
    const diskUsedGB = (data.disk.used / 1073741824).toFixed(1);
    const diskTotalGB = (data.disk.total / 1073741824).toFixed(1);
    document.getElementById('disk-detail').textContent = `${diskUsedGB} GB / ${diskTotalGB} GB`;

    // System info
    const uptimeH = Math.floor(data.uptime_seconds / 3600);
    const uptimeM = Math.floor((data.uptime_seconds % 3600) / 60);
    document.getElementById('sys-info').textContent =
      `ホスト名: ${data.hostname}\n` +
      `OS: ${data.os}\n` +
      `カーネル: ${data.kernel}\n` +
      `稼働時間: ${uptimeH}h ${uptimeM}m\n` +
      `ネット送信: ${(data.network.bytes_sent / 1048576).toFixed(1)} MB\n` +
      `ネット受信: ${(data.network.bytes_recv / 1048576).toFixed(1)} MB`;

    // Processes
    const procResp = await fetch('/api/system/processes');
    const procs = await procResp.json();
    const procList = document.getElementById('proc-list');
    procList.innerHTML = procs.map(p => `
      <tr>
        <td>${p.pid}</td>
        <td>${escapeHtml(p.name)}</td>
        <td>${p.cpu.toFixed(1)}</td>
        <td>${p.memory.toFixed(1)}</td>
        <td>${escapeHtml(p.user)}</td>
      </tr>
    `).join('');

  } catch (e) {
    console.error('Dashboard load error:', e);
  }
}

// --- Services ---
async function loadServices() {
  try {
    const resp = await fetch('/api/services');
    const services = await resp.json();
    window._allServices = services;
    renderServices(services);
  } catch (e) {
    console.error('Services load error:', e);
  }
}

function renderServices(services) {
  const tbody = document.getElementById('service-list');
  tbody.innerHTML = services.map(s => {
    const badgeClass = s.active === 'active' ? 'badge-active' :
                       s.active === 'inactive' ? 'badge-inactive' : 'badge-other';
    return `
      <tr>
        <td>${escapeHtml(s.name.replace('.service', ''))}</td>
        <td><span class="badge ${badgeClass}">${s.active}</span></td>
        <td>${s.sub}</td>
        <td>
          <div class="btn-group">
            <button class="btn btn-sm btn-success" onclick="serviceAction('${s.name}','start')" title="開始"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg></button>
            <button class="btn btn-sm btn-danger" onclick="serviceAction('${s.name}','stop')" title="停止"><svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg></button>
            <button class="btn btn-sm btn-primary" onclick="serviceAction('${s.name}','restart')" title="再起動"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg></button>
            <button class="btn btn-sm btn-secondary" onclick="serviceDetail('${s.name}')" title="詳細"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg></button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function filterServices() {
  const q = document.getElementById('service-search').value.toLowerCase();
  const filtered = window._allServices.filter(s =>
    s.name.toLowerCase().includes(q)
  );
  renderServices(filtered);
}

async function serviceAction(name, action) {
  try {
    const resp = await fetch(`/api/services/${encodeURIComponent(name)}/${action}`, { method: 'POST' });
    const data = await resp.json();
    if (data.success) {
      showStatus(`サービスを${action === 'start' ? '開始' : action === 'stop' ? '停止' : '再起動'}しました: ${name}`, 'success');
    } else {
      showStatus(`操作に失敗しました: ${data.stderr || data.stdout}`, 'error');
    }
    loadServices();
  } catch (e) {
    showStatus(`エラー: ${e.message}`, 'error');
  }
}

async function serviceDetail(name) {
  try {
    const resp = await fetch(`/api/services/${encodeURIComponent(name)}/status`);
    const data = await resp.json();
    document.getElementById('service-detail-name').textContent = data.name;
    document.getElementById('service-detail-output').textContent = data.status_output;
    document.getElementById('service-detail').style.display = 'block';
  } catch (e) {
    showStatus(`エラー: ${e.message}`, 'error');
  }
}

// --- Packages ---
function sanitizeAptError(err) {
  if (!err) return '';
  return err
    .replace(/^WARNING: apt does not have a stable CLI interface\..*\n?/gm, '')
    .trim();
}

async function checkUpdates() {
  const status = document.getElementById('package-status');
  status.className = 'status-msg show info';
  status.innerHTML = '<span class="spinner"></span> アップデート確認中...';

  try {
    const resp = await fetch('/api/packages/updates');
    const data = await resp.json();

    if (data.count === 0) {
      status.className = 'status-msg show success';
      status.textContent = '全パッケージが最新です。';
      document.getElementById('btn-upgrade-all').style.display = 'none';
      document.getElementById('package-list-container').innerHTML =
        '<p class="muted">利用可能なアップデートはありません。</p>';
    } else {
      status.className = 'status-msg show info';
      status.textContent = `${data.count}個のパッケージがアップデート可能です。`;
      document.getElementById('btn-upgrade-all').style.display = 'inline-block';

      const container = document.getElementById('package-list-container');
      container.innerHTML = data.packages.map(p => `
        <div class="package-item">
          <span>${escapeHtml(p.name)}</span>
          <button class="btn btn-sm btn-primary" onclick="upgradePackage('${escapeHtml(p.name)}')">更新</button>
        </div>
      `).join('');
    }
  } catch (e) {
    status.className = 'status-msg show error';
    status.textContent = `エラー: ${e.message}`;
  }
}

async function upgradePackage(name) {
  const status = document.getElementById('package-status');
  status.className = 'status-msg show info';
  status.innerHTML = `<span class="spinner"></span> ${name} を更新中...`;

  try {
    const resp = await fetch(`/api/packages/upgrade/${encodeURIComponent(name)}`, { method: 'POST' });
    const data = await resp.json();
    if (data.success) {
      status.className = 'status-msg show success';
      status.textContent = `${name} を更新しました。`;
      checkUpdates();
    } else {
      status.className = 'status-msg show error';
      const cleanErr = sanitizeAptError(data.errors);
      status.textContent = cleanErr ? `更新に失敗しました: ${cleanErr}` : '更新に失敗しました。';
    }
  } catch (e) {
    status.className = 'status-msg show error';
    status.textContent = `エラー: ${e.message}`;
  }
}

async function upgradeAll() {
  if (!confirm('全パッケージを更新しますか？')) return;

  const status = document.getElementById('package-status');
  status.className = 'status-msg show info';
  status.innerHTML = '<span class="spinner"></span> 全パッケージを更新中... (数分かかる場合があります)';

  try {
    const resp = await fetch('/api/packages/upgrade', { method: 'POST' });
    const data = await resp.json();
    if (data.success) {
      status.className = 'status-msg show success';
      status.textContent = data.output ? `全パッケージの更新が完了しました。\n${data.output}` : '全パッケージの更新が完了しました。';
      checkUpdates();
    } else {
      status.className = 'status-msg show error';
      const cleanErr = sanitizeAptError(data.errors);
      status.textContent = cleanErr ? `更新に失敗しました: ${cleanErr}` : '更新に失敗しました。';
    }
  } catch (e) {
    status.className = 'status-msg show error';
    status.textContent = `エラー: ${e.message}`;
  }
}

async function fixPackages() {
  const status = document.getElementById('package-status');
  status.className = 'status-msg show info';
  status.innerHTML = '<span class="spinner"></span> パッケージの依存関係を修復中...';

  try {
    const resp = await fetch('/api/packages/fix', { method: 'POST' });
    const data = await resp.json();
    if (data.success) {
      status.className = 'status-msg show success';
      status.textContent = 'パッケージの依存関係を修復しました。';
      checkUpdates();
    } else {
      status.className = 'status-msg show error';
      const cleanErr = sanitizeAptError(data.errors);
      status.textContent = cleanErr ? `修復に失敗しました: ${cleanErr}` : '修復に失敗しました。';
    }
  } catch (e) {
    status.className = 'status-msg show error';
    status.textContent = `エラー: ${e.message}`;
  }
}

async function forceUpgradeAll() {
  if (!confirm('Phased Updates も含めて全パッケージを強制更新しますか？')) return;

  const status = document.getElementById('package-status');
  status.className = 'status-msg show info';
  status.innerHTML = '<span class="spinner"></span> 全パッケージを強制更新中... (数分かかる場合があります)';

  try {
    const resp = await fetch('/api/packages/force-upgrade', { method: 'POST' });
    const data = await resp.json();
    if (data.success) {
      status.className = 'status-msg show success';
      status.textContent = '全パッケージの強制更新が完了しました。';
      checkUpdates();
    } else {
      status.className = 'status-msg show error';
      const cleanErr = sanitizeAptError(data.errors);
      status.textContent = cleanErr ? `更新に失敗しました: ${cleanErr}` : '更新に失敗しました。';
    }
  } catch (e) {
    status.className = 'status-msg show error';
    status.textContent = `エラー: ${e.message}`;
  }
}

async function autoremovePackages() {
  if (!confirm('不要なパッケージを削除しますか？')) return;

  const status = document.getElementById('package-status');
  status.className = 'status-msg show info';
  status.innerHTML = '<span class="spinner"></span> 不要なパッケージを削除中...';

  try {
    const resp = await fetch('/api/packages/autoremove', { method: 'POST' });
    const data = await resp.json();
    if (data.success) {
      status.className = 'status-msg show success';
      status.textContent = '不要なパッケージを削除しました。';
      checkUpdates();
    } else {
      status.className = 'status-msg show error';
      const cleanErr = sanitizeAptError(data.errors);
      status.textContent = cleanErr ? `削除に失敗しました: ${cleanErr}` : '削除に失敗しました。';
    }
  } catch (e) {
    status.className = 'status-msg show error';
    status.textContent = `エラー: ${e.message}`;
  }
}

// --- Terminal ---
function openTerminalAt(path) {
  if (!path) return;
  pendingTerminalCwd = path;
  const cwdLabel = document.getElementById('terminal-cwd-label');
  if (cwdLabel) cwdLabel.textContent = '';
  if (ws) {
    ws.onclose = null;
    ws.onerror = null;
    try { ws.close(); } catch (e) {}
    ws = null;
  }
  switchTab('terminal');
}

function connectTerminal() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
    return;
  }

  const container = document.getElementById('terminal-container');
  container.innerHTML = '';

  if (term) {
    term.dispose();
  }

  term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: '"Fira Code", "SF Mono", Menlo, monospace',
    theme: {
      background: '#1a1b26',
      foreground: '#c0caf5',
      cursor: '#c0caf5',
      selectionBackground: '#33467c',
      black: '#15161e',
      red: '#f7768e',
      green: '#9ece6a',
      yellow: '#e0af68',
      blue: '#7aa2f7',
      magenta: '#bb9af7',
      cyan: '#7dcfff',
      white: '#a9b1d6',
    },
  });

  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);
  setTimeout(() => fitAddon.fit(), 50);

  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const cwdParam = pendingTerminalCwd ? `?cwd=${encodeURIComponent(pendingTerminalCwd)}` : '';
  const cwdLabel = document.getElementById('terminal-cwd-label');
  if (cwdLabel) {
    cwdLabel.textContent = pendingTerminalCwd ? `— ${pendingTerminalCwd} で開いています` : '';
  }
  pendingTerminalCwd = null;
  ws = new WebSocket(`${protocol}://${location.host}/ws/terminal${cwdParam}`);

  ws.onopen = () => {
    term.writeln('\x1b[36m接続中...\x1b[0m\r\n');
    ws.send(JSON.stringify({
      type: 'resize',
      cols: term.cols,
      rows: term.rows,
    }));
  };

  ws.onmessage = (event) => {
    term.write(event.data);
  };

  ws.onclose = () => {
    term.writeln('\r\n\x1b[31m接続が閉じました。再接続するには「接続」ボタンを押してください。\x1b[0m');
  };

  ws.onerror = (e) => {
    term.writeln('\r\n\x1b[31m接続エラー\x1b[0m');
  };

  term.onData(data => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data }));
    }
  });

  term.onResize(({ cols, rows }) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  });

  window.addEventListener('resize', () => {
    if (fitAddon) fitAddon.fit();
  });
}

// --- Wi-Fi ---
async function loadWifiStatus() {
  const statusMsg = document.getElementById('wifi-status-msg');
  const currentCard = document.getElementById('wifi-current-card');

  try {
    const resp = await fetch('/api/wifi/status');
    const data = await resp.json();
    wifiStatusData = data;

    const toggleText = document.getElementById('wifi-toggle-text');
    if (toggleText) {
      toggleText.textContent = data.enabled ? 'Wi-FiをOFFにする' : 'Wi-FiをONにする';
    }

    if (!data.available) {
      statusMsg.className = 'status-msg show info';
      statusMsg.textContent = data.message || '利用可能なWi-Fiインターフェースが見つかりません。Wi-Fiアダプターが接続されているか確認してください。';
      currentCard.style.display = 'none';
      document.getElementById('wifi-networks-container').innerHTML =
        '<p class="muted">Wi-Fiインターフェースが無効または接続されていません。</p>';
      return;
    }

    if (!data.enabled) {
      statusMsg.className = 'status-msg show info';
      statusMsg.textContent = 'Wi-Fi機能が無効化されています。「Wi-FiをONにする」ボタンをクリックして有効化してください。';
      currentCard.style.display = 'none';
      return;
    }

    statusMsg.className = 'status-msg';

    if (data.connected && data.current) {
      currentCard.style.display = 'block';
      document.getElementById('wifi-current-ssid').textContent = data.current.ssid;
      const sig = data.current.signal ? `信号強度: ${data.current.signal}% | ` : '';
      const ip = data.current.ip ? `IP: ${data.current.ip} | ` : '';
      const dev = data.current.device ? `デバイス: ${data.current.device}` : '';
      document.getElementById('wifi-current-detail').textContent = `${sig}${ip}${dev}`;
    } else {
      currentCard.style.display = 'none';
    }

    // Auto-scan on load
    scanWifi();

  } catch (e) {
    statusMsg.className = 'status-msg show error';
    statusMsg.textContent = `Wi-Fiステータス取得エラー: ${e.message}`;
  }
}

async function scanWifi() {
  const container = document.getElementById('wifi-networks-container');
  const statusMsg = document.getElementById('wifi-status-msg');
  container.innerHTML = '<p class="muted"><span class="spinner"></span> 周囲のWi-Fiネットワークをスキャン中...</p>';

  try {
    const resp = await fetch('/api/wifi/scan');
    const data = await resp.json();

    if (!data.success) {
      container.innerHTML = `<p class="muted text-danger">${escapeHtml(data.error || 'スキャンに失敗しました。')}</p>`;
      return;
    }

    if (!data.networks || data.networks.length === 0) {
      container.innerHTML = '<p class="muted">検出されたWi-Fiネットワークはありません。「Wi-Fiスキャン」をクリックして再試行してください。</p>';
      return;
    }

    container.innerHTML = `
      <table class="proc-table">
        <thead>
          <tr>
            <th>SSID</th>
            <th>電波強度</th>
            <th>セキュリティ</th>
            <th>周波数 / Ch</th>
            <th>状態</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${data.networks.map(net => {
            const isConnected = net.in_use;
            const isOpen = !net.security || net.security.toLowerCase() === 'open' || net.security.includes('--');
            const safeSSID = escapeHtml(net.ssid);
            const safeBSSID = escapeHtml(net.bssid || '');
            const safeSec = escapeHtml(net.security);
            const freqStr = net.freq ? `${net.freq} (${net.chan || '-'})` : (net.chan || '-');

            let sigClass = 'signal-good';
            if (net.signal < 40) sigClass = 'signal-weak';
            else if (net.signal < 70) sigClass = 'signal-medium';

            return `
              <tr>
                <td>
                  <div class="wifi-ssid-cell">
                    ${isOpen ? '' : '<svg class="icon-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>'}
                    <span style="font-weight:600;">${safeSSID}</span>
                  </div>
                </td>
                <td>
                  <div class="wifi-signal-wrap">
                    <span class="wifi-signal-bar ${sigClass}" style="width:${Math.max(10, net.signal)}%;"></span>
                    <span>${net.signal}%</span>
                  </div>
                </td>
                <td><span class="badge badge-other">${safeSec}</span></td>
                <td>${escapeHtml(freqStr)}</td>
                <td>
                  ${isConnected ? '<span class="badge badge-active">接続中</span>' : '<span class="badge badge-other">未接続</span>'}
                </td>
                <td>
                  ${isConnected ? `
                    <button class="btn btn-sm btn-danger" onclick="disconnectWifi('${safeSSID}')">切断</button>
                  ` : `
                    <button class="btn btn-sm btn-primary" onclick="openWifiConnect('${safeSSID}', '${safeSec}', '${safeBSSID}')">接続</button>
                  `}
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;

  } catch (e) {
    container.innerHTML = `<p class="muted text-danger">スキャンエラー: ${escapeHtml(e.message)}</p>`;
  }
}

function openWifiConnect(ssid, security, bssid) {
  selectedWifiNetwork = { ssid, security, bssid };
  document.getElementById('wifi-modal-title').textContent = `「${ssid}」に接続`;
  document.getElementById('wifi-modal-subtitle').textContent = `セキュリティ: ${security || 'Open'}`;
  
  const pwdInput = document.getElementById('wifi-password');
  pwdInput.value = '';
  document.getElementById('wifi-modal-status').className = 'status-msg';

  const isOpen = !security || security.toLowerCase() === 'open' || security.includes('--');
  const pwdGroup = document.getElementById('wifi-pwd-group');
  if (isOpen) {
    pwdGroup.style.display = 'none';
  } else {
    pwdGroup.style.display = 'block';
    setTimeout(() => pwdInput.focus(), 100);
  }

  document.getElementById('wifi-modal').style.display = 'flex';
}

function closeWifiModal() {
  document.getElementById('wifi-modal').style.display = 'none';
  selectedWifiNetwork = null;
}

function togglePwdVisibility() {
  const pwdInput = document.getElementById('wifi-password');
  pwdInput.type = pwdInput.type === 'password' ? 'text' : 'password';
}

async function submitWifiConnect() {
  if (!selectedWifiNetwork) return;

  const password = document.getElementById('wifi-password').value;
  const statusEl = document.getElementById('wifi-modal-status');
  const submitBtn = document.getElementById('btn-wifi-connect-submit');

  statusEl.className = 'status-msg show info';
  statusEl.innerHTML = '<span class="spinner"></span> 接続中... (十数秒かかる場合があります)';
  submitBtn.disabled = true;

  try {
    const resp = await fetch('/api/wifi/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ssid: selectedWifiNetwork.ssid,
        password: password,
        bssid: selectedWifiNetwork.bssid,
      }),
    });

    const data = await resp.json();
    submitBtn.disabled = false;

    if (data.success) {
      statusEl.className = 'status-msg show success';
      statusEl.textContent = '接続に成功しました！';
      showStatus(`Wi-Fi「${selectedWifiNetwork.ssid}」に接続しました`, 'success');
      setTimeout(() => {
        closeWifiModal();
        loadWifiStatus();
      }, 1200);
    } else {
      statusEl.className = 'status-msg show error';
      statusEl.textContent = `接続エラー: ${data.message || '接続できませんでした'}`;
    }
  } catch (e) {
    submitBtn.disabled = false;
    statusEl.className = 'status-msg show error';
    statusEl.textContent = `エラー: ${e.message}`;
  }
}

async function disconnectWifi(ssid) {
  if (!confirm(`Wi-Fi接続を切断しますか？`)) return;

  try {
    const resp = await fetch('/api/wifi/disconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ssid: ssid || (wifiStatusData?.current?.ssid || '') }),
    });
    const data = await resp.json();
    if (data.success) {
      showStatus('Wi-Fiを切断しました', 'success');
      loadWifiStatus();
    } else {
      showStatus(`切断に失敗しました: ${data.message}`, 'error');
    }
  } catch (e) {
    showStatus(`エラー: ${e.message}`, 'error');
  }
}

async function forgetWifi() {
  const ssid = wifiStatusData?.current?.ssid;
  if (!ssid) return;
  if (!confirm(`「${ssid}」の接続設定を削除しますか？`)) return;

  try {
    const resp = await fetch('/api/wifi/forget', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ssid }),
    });
    const data = await resp.json();
    if (data.success) {
      showStatus(`「${ssid}」の設定を削除しました`, 'success');
      loadWifiStatus();
    } else {
      showStatus(`削除に失敗しました: ${data.message}`, 'error');
    }
  } catch (e) {
    showStatus(`エラー: ${e.message}`, 'error');
  }
}

async function toggleWifi() {
  if (!wifiStatusData) return;
  const targetState = !wifiStatusData.enabled;
  try {
    const resp = await fetch('/api/wifi/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enable: targetState }),
    });
    const data = await resp.json();
    if (data.success) {
      showStatus(`Wi-Fiを${targetState ? '有効化' : '無効化'}しました`, 'success');
      setTimeout(loadWifiStatus, 1000);
    } else {
      showStatus(`操作に失敗しました: ${data.message}`, 'error');
    }
  } catch (e) {
    showStatus(`エラー: ${e.message}`, 'error');
  }
}

// --- Disks ---
let pendingMountDevice = null;
let pendingMountFstype = null;

async function loadDisks() {
  const container = document.getElementById('disks-container');
  const statusMsg = document.getElementById('disk-status-msg');
  container.innerHTML = '<p class="muted"><span class="spinner"></span> ディスク情報を取得中...</p>';
  statusMsg.className = 'status-msg';

  try {
    const resp = await fetch('/api/disks/info');
    const data = await resp.json();

    if (!data.devices || data.devices.length === 0) {
      statusMsg.className = 'status-msg show info';
      statusMsg.textContent = 'ディスクデバイスが検出されませんでした。';
      container.innerHTML = '';
      return;
    }

    container.innerHTML = data.devices.map(dev => renderDiskDevice(dev, 0)).join('');

  } catch (e) {
    statusMsg.className = 'status-msg show error';
    statusMsg.textContent = `ディスク情報取得エラー: ${e.message}`;
    container.innerHTML = '';
  }
}

function fsColor(fstype) {
  const colors = {
    'vfat': '#e67e22', 'fat32': '#e67e22', 'fat16': '#e67e22',
    'ext4': '#3498db', 'ext3': '#2980b9', 'ext2': '#2471a3',
    'xfs': '#27ae60',
    'btrfs': '#8e44ad',
    'swap': '#e74c3c',
    'linux-swap': '#e74c3c', 'linux-swap(v1)': '#e74c3c',
    'LVM2_member': '#16a085',
    'ntfs': '#f39c12',
    'exfat': '#d35400',
    'iso9660': '#7f8c8d',
  };
  return colors[fstype] || '#5a5e6b';
}

function flattenPartitions(dev) {
  const parts = [];
  for (const child of (dev.children || [])) {
    if (child.type === 'part' || child.type === 'lvm') {
      parts.push(child);
    }
  }
  return parts;
}

function renderDiskLayoutBar(dev) {
  const partitions = flattenPartitions(dev);
  if (partitions.length === 0) return '';

  const totalBytes = dev.size_bytes || 1;
  let segments = [];
  let usedBytes = 0;

  for (const p of partitions) {
    const pBytes = p.size_bytes || 0;
    const pct = Math.max((pBytes / totalBytes) * 100, 0.8);
    usedBytes += pBytes;
    const color = fsColor(p.fstype);
    const fsLabel = p.fstype || '未割当';
    const mountLabel = p.mountpoint ? ` (${p.mountpoint})` : '';
    const tooltip = `${p.name}: ${p.size} - ${fsLabel}${mountLabel}`;
    segments.push({ pct, color, tooltip, name: p.name, size: p.size, fstype: fsLabel });
  }

  const freeBytes = totalBytes - usedBytes;
  if (freeBytes > 0) {
    const freePct = Math.max((freeBytes / totalBytes) * 100, 0.3);
    segments.push({ pct: freePct, color: '#2c2f38', tooltip: '空き領域', name: '', size: '', fstype: '' });
  }

  const segmentsHtml = segments.map(s =>
    `<div class="disk-layout-seg" style="flex:${s.pct};background:${s.color};" title="${escapeHtml(s.tooltip)}">
      ${s.pct > 4 ? `<span class="disk-layout-seg-label">${escapeHtml(s.name)}<br>${escapeHtml(s.size)}</span>` : ''}
    </div>`
  ).join('');

  const legendHtml = partitions.map(p => {
    const color = fsColor(p.fstype);
    const mountLabel = p.mountpoint ? ` → ${p.mountpoint}` : '';
    return `<span class="disk-layout-legend-item">
      <span class="disk-layout-legend-dot" style="background:${color};"></span>
      ${escapeHtml(p.name)} <span class="disk-layout-legend-size">${escapeHtml(p.size)}</span>
      ${p.fstype ? `<span class="disk-layout-legend-fs">${escapeHtml(p.fstype)}</span>` : ''}
      ${mountLabel ? `<span class="disk-layout-legend-mount">${escapeHtml(p.mountpoint)}</span>` : ''}
    </span>`;
  }).join('');

  return `
    <div class="disk-layout-wrap">
      <div class="disk-layout-bar">${segmentsHtml}</div>
      <div class="disk-layout-legend">${legendHtml}</div>
    </div>`;
}

function renderLvmInfo(dev) {
  const lvm = dev.lvm;
  const vgName = lvm.vg_name;
  const vgSize = lvm.vg_size || lvm.pv_size;
  const vgFree = lvm.vg_free || lvm.pv_free;
  const lvs = lvm.lvs || [];

  // Build LV layout bar (similar to disk layout bar)
  const parseSize = (s) => {
    if (!s) return 0;
    const m = {'K':1024,'M':1024**2,'G':1024**3,'T':1024**4};
    s = s.replace(/[<>]/g, '').trim();
    if (s.slice(-1).toUpperCase() in m) return parseFloat(s) * m[s.slice(-1).toUpperCase()];
    return parseFloat(s) || 0;
  };

  const vgTotalBytes = parseSize(vgSize);
  const vgFreeBytes = parseSize(vgFree);
  const vgUsedBytes = vgTotalBytes - vgFreeBytes;

  const lvColors = ['#3498db', '#27ae60', '#e67e22', '#8e44ad', '#16a085', '#e74c3c', '#f39c12', '#2c3e50'];

  let segments = [];
  lvs.forEach((lv, i) => {
    const lvBytes = parseSize(lv.size);
    const pct = vgTotalBytes > 0 ? Math.max((lvBytes / vgTotalBytes) * 100, 1) : 0;
    const color = lvColors[i % lvColors.length];
    const mountLabel = lv.mountpoint ? ` → ${lv.mountpoint}` : '';
    segments.push({
      pct, color,
      tooltip: `${lv.name}: ${lv.size}${mountLabel}`,
      name: lv.name, size: lv.size, mountpoint: lv.mountpoint,
    });
  });

  if (vgFreeBytes > 0 && vgTotalBytes > 0) {
    const freePct = Math.max((vgFreeBytes / vgTotalBytes) * 100, 0.3);
    segments.push({ pct: freePct, color: '#2c2f38', tooltip: `空き: ${vgFree}`, name: '', size: '' });
  }

  const segmentsHtml = segments.map(s =>
    `<div class="disk-layout-seg" style="flex:${s.pct};background:${s.color};" title="${escapeHtml(s.tooltip)}">
      ${s.pct > 5 ? `<span class="disk-layout-seg-label">${escapeHtml(s.name)}<br>${escapeHtml(s.size)}</span>` : ''}
    </div>`
  ).join('');

  // LV rows
  const lvRows = lvs.map((lv, i) => {
    const color = lvColors[i % lvColors.length];
    const mountLabel = lv.mountpoint ? `<span class="disk-layout-legend-mount"> → ${escapeHtml(lv.mountpoint)}</span>` : '';
    const safeLvPath = escapeHtml(lv.path || `${vgName}-${lv.name}`.replace(/-/g, '--'));
    let lvBtns = '';
    if (lv.mountpoint) {
      lvBtns += `<button class="btn btn-sm btn-danger" onclick="unmountDisk('${safeLvPath}','${escapeHtml(lv.mountpoint)}')" title="アンマウント">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:0.85rem;height:0.85rem;"><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>`;
      const lvMp = escapeHtml(lv.mountpoint);
      lvBtns += `<button class="btn btn-sm btn-secondary" onclick="openTerminalAt('${lvMp}')" title="${lvMp} でターミナルを開く" style="margin-left:0.15rem;">ターミナルで開く</button>`;
      lvBtns += `<button class="btn btn-sm btn-secondary" onclick="unmountDisk('${safeLvPath}','${lvMp}',true)" title="強制アンマウント（使用中でも切り離す）" style="margin-left:0.15rem;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:0.85rem;height:0.85rem;"><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>`;
    } else {
      const mountDev = lv.path ? lv.path.replace('/dev/', '') : safeLvPath;
      const fsType = 'ext4';
      lvBtns += `<button class="btn btn-sm btn-primary" onclick="openDiskMountModal('${escapeHtml(mountDev)}','${fsType}')" title="マウント">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:0.85rem;height:0.85rem;"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>`;
    }
    if (vgFreeBytes > 0) {
      lvBtns += `<button class="btn btn-sm btn-secondary" onclick="openLvResizeModal('${escapeHtml(vgName)}','${escapeHtml(lv.name)}','${escapeHtml(lv.size)}','${escapeHtml(vgFree)}')" title="VG空き領域で拡張" style="margin-left:0.15rem;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:0.85rem;height:0.85rem;"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>
      </button>`;
    }
    lvBtns += `<button class="btn btn-sm btn-danger" onclick="deleteLv('${escapeHtml(vgName)}','${escapeHtml(lv.name)}')" title="論理ボリュームを削除" style="margin-left:0.15rem;">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:0.85rem;height:0.85rem;"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
    </button>`;
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:0.35rem 0;border-bottom:1px solid var(--border);">
      <div style="display:flex;align-items:center;gap:0.4rem;">
        <span style="width:8px;height:8px;border-radius:2px;background:${color};flex-shrink:0;"></span>
        <span style="font-size:0.8rem;font-weight:500;">${escapeHtml(lv.name)}</span>
        <span style="font-size:0.75rem;color:var(--text-muted);">${escapeHtml(lv.size)}</span>
        ${mountLabel}
      </div>
      <div class="btn-group">${lvBtns}</div>
    </div>`;
  }).join('');

  const createLvBtn = vgFreeBytes > 0
    ? `<button class="btn btn-sm btn-success" onclick="openLvCreateModal('${escapeHtml(vgName)}','${escapeHtml(vgFree)}')" title="論理ボリュームを作成" style="margin-top:0.4rem;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:0.85rem;height:0.85rem;"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        LV 作成
      </button>`
    : '';

  return `
    <div style="margin-top:0.6rem;padding:0.6rem;background:var(--bg-base);border:1px solid var(--border);border-radius:var(--radius-sm);">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.4rem;">
        <div style="display:flex;align-items:center;gap:0.5rem;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" style="width:1rem;height:1rem;color:var(--accent);flex-shrink:0;">
            <rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/>
          </svg>
          <span style="font-size:0.82rem;font-weight:600;">VG: ${escapeHtml(vgName)}</span>
          <span style="font-size:0.72rem;color:var(--text-muted);">PV: ${escapeHtml(vgSize)} / 空き: <span class="text-success">${escapeHtml(vgFree)}</span></span>
        </div>
        ${createLvBtn}
      </div>
      ${segmentsHtml ? `<div class="disk-layout-wrap"><div class="disk-layout-bar" style="height:24px;">${segmentsHtml}</div></div>` : ''}
      ${lvRows}
    </div>`;
}

function renderDiskDevice(dev, depth) {
  const indent = depth * 1.5;
  const isDisk = dev.type === 'disk';
  const isPart = dev.type === 'part';
  const isLoop = dev.name.startsWith('loop');
  const isRam = dev.name.startsWith('ram');

  if (isLoop || isRam) return '';

  const removableBadge = dev.removable
    ? '<span class="badge badge-warn" style="margin-left:0.5rem;">取り外し可能</span>'
    : '';
  const readonlyBadge = dev.readonly
    ? '<span class="badge badge-other" style="margin-left:0.5rem;">読み取り専用</span>'
    : '';

  const typeLabel = isDisk ? 'ディスク' : isPart ? 'パーティション' : dev.type;
  const typeBadgeClass = isDisk ? 'badge-active' : isPart ? 'badge-other' : 'badge-inactive';
  const fsLabel = dev.label ? ` <span style="font-size:0.8rem;color:var(--text-muted);margin-left:0.3rem;">${escapeHtml(dev.label)}</span>` : '';

  let actionBtn = '';
  const isLvmMember = dev.fstype === 'LVM2_member';
  if (isPart && dev.fstype && !dev.readonly && !isLvmMember) {
    const safeName = escapeHtml(dev.name);
    const safeMp = escapeHtml(dev.mountpoint || '');
    const safeFs = escapeHtml(dev.fstype);
    if (dev.mountpoint) {
      actionBtn = `<button class="btn btn-sm btn-danger" onclick="unmountDisk('${safeName}','${safeMp}')" title="アンマウント">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:0.85rem;height:0.85rem;"><line x1="5" y1="12" x2="19" y2="12"/></svg>
        アンマウント
      </button>`;
      actionBtn += `<button class="btn btn-sm btn-secondary" onclick="unmountDisk('${safeName}','${safeMp}',true)" title="強制アンマウント（使用中でも切り離す）" style="margin-left:0.25rem;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:0.85rem;height:0.85rem;"><line x1="5" y1="12" x2="19" y2="12"/></svg>
        強制アンマウント
      </button>`;
    } else {
      actionBtn = `<button class="btn btn-sm btn-primary" onclick="openDiskMountModal('${safeName}','${safeFs}')" title="マウント">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:0.85rem;height:0.85rem;"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        マウント
      </button>`;
    }
    if (dev.extendable) {
      const maxMb = Math.floor((dev.max_extend_bytes || 0) / (1024 * 1024));
      actionBtn += `<button class="btn btn-sm btn-secondary" onclick="openDiskExtendModal('${safeName}',${dev.size_bytes || 0},${dev.max_extend_bytes || 0})" title="隣接空き領域で拡張" style="margin-left:0.25rem;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:0.85rem;height:0.85rem;"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>
        拡張
      </button>`;
    }
  }

  // Delete button for partitions
  let deleteBtn = '';
  if (isPart && !isLvmMember) {
    deleteBtn = `<button class="btn btn-sm btn-danger" onclick="deletePartition('${escapeHtml(dev.name)}')" title="パーティションを削除" style="margin-left:0.25rem;">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:0.85rem;height:0.85rem;"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
    </button>`;
  }

  // Create button for disks with free space
  let createBtn = '';
  if (isDisk && dev.free_bytes > 0) {
    createBtn = `<button class="btn btn-sm btn-success" onclick="openDiskCreateModal('${escapeHtml(dev.name)}',${dev.size_bytes || 0},${dev.free_bytes || 0})" title="空き領域にパーティションを作成">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:0.85rem;height:0.85rem;"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      作成
    </button>`;
  }

  // Delete button for disks (wipe all partitions)
  let diskDeleteBtn = '';
  if (isDisk) {
    diskDeleteBtn = `<button class="btn btn-sm btn-danger" onclick="wipeDisk('${escapeHtml(dev.name)}')" title="ディスクの全パーティションを削除" style="margin-left:0.25rem;">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:0.85rem;height:0.85rem;"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
    </button>`;
  }

  let infoRows = '';
  if (dev.fstype) infoRows += `<tr><td>ファイルシステム</td><td>${escapeHtml(dev.fstype)}</td></tr>`;
  if (dev.size) infoRows += `<tr><td>サイズ</td><td>${escapeHtml(dev.size)}</td></tr>`;
  if (dev.mountpoint) {
    const mpSafe = escapeHtml(dev.mountpoint);
    infoRows += `<tr><td>マウントポイント</td><td>${mpSafe} <button class="btn btn-sm btn-secondary" onclick="openTerminalAt('${mpSafe}')" title="${mpSafe} でターミナルを開く" style="margin-left:0.4rem;">ターミナルで開く</button></td></tr>`;
  }
  if (dev.model) infoRows += `<tr><td>モデル</td><td>${escapeHtml(dev.model)}</td></tr>`;
  if (dev.serial) infoRows += `<tr><td>シリアル</td><td>${escapeHtml(dev.serial)}</td></tr>`;
  if (dev.uuid) infoRows += `<tr><td>UUID</td><td style="font-size:0.75rem;">${escapeHtml(dev.uuid)}</td></tr>`;
  if (dev.partlabel) infoRows += `<tr><td>パーティションラベル</td><td>${escapeHtml(dev.partlabel)}</td></tr>`;
  if (dev.label) infoRows += `<tr><td>ボリュームラベル</td><td>${escapeHtml(dev.label)}</td></tr>`;

  let usageHtml = '';
  if (dev.df) {
    const pctNum = parseInt(dev.df.use_percent) || 0;
    const barClass = pctNum > 80 ? 'danger' : pctNum > 60 ? 'warn' : '';
    usageHtml = `
      <div style="margin-top:0.5rem;">
        <div style="display:flex;justify-content:space-between;font-size:0.8rem;color:var(--text-muted);margin-bottom:0.25rem;">
          <span>${escapeHtml(dev.df.used)} / ${escapeHtml(dev.df.size)}</span>
          <span>${escapeHtml(dev.df.avail)} 空き</span>
        </div>
        <div class="stat-bar"><div class="stat-bar-fill ${barClass}" style="width:${pctNum}%;"></div></div>
        <div style="text-align:right;font-size:0.75rem;color:var(--text-muted);margin-top:0.15rem;">${escapeHtml(dev.df.use_percent)} 使用中</div>
      </div>`;
  }

  const layoutBar = isDisk ? renderDiskLayoutBar(dev) : '';
  const lvmHtml = dev.lvm ? renderLvmInfo(dev) : '';
  const children = (dev.children || []).map(c => renderDiskDevice(c, depth + 1)).filter(Boolean).join('');

  return `
    <div class="stat-card" style="margin-bottom:1rem;margin-left:${indent}rem;${isPart ? 'border-left:3px solid var(--border);' : ''}">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem;">
        <div style="display:flex;align-items:center;gap:0.5rem;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" style="width:1.2rem;height:1.2rem;flex-shrink:0;${isDisk ? 'color:var(--accent);' : ''}">
            ${isDisk
              ? '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>'
              : '<rect x="2" y="4" width="20" height="16" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>'}
          </svg>
          <span style="font-weight:600;font-size:0.95rem;">${escapeHtml(dev.name)}</span>
          <span class="badge ${typeBadgeClass}" style="font-size:0.7rem;">${typeLabel}</span>${fsLabel}
          ${removableBadge}${readonlyBadge}
        </div>
        <div class="btn-group">${createBtn}${diskDeleteBtn}${actionBtn}${deleteBtn}</div>
      </div>
      ${layoutBar}
      ${lvmHtml}
      ${infoRows ? `<table class="proc-table" style="margin:0;"><tbody>${infoRows}</tbody></table>` : ''}
      ${usageHtml}
    </div>
    ${children}
  `;
}

function openDiskMountModal(deviceName, fstype) {
  pendingMountDevice = deviceName;
  pendingMountFstype = fstype;

  document.getElementById('disk-mount-device').textContent = `/dev/${deviceName} (${fstype})`;
  document.getElementById('disk-mount-point').value = '';
  document.getElementById('disk-mount-status').className = 'status-msg';
  document.querySelector('input[name="disk-mount-type"][value="temp"]').checked = true;
  document.getElementById('disk-mount-persist-warn').style.display = 'none';
  document.getElementById('disk-mount-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('disk-mount-point').focus(), 100);
}

function closeDiskMountModal() {
  document.getElementById('disk-mount-modal').style.display = 'none';
  pendingMountDevice = null;
  pendingMountFstype = null;
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('input[name="disk-mount-type"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      document.getElementById('disk-mount-persist-warn').style.display =
        e.target.value === 'persist' ? 'block' : 'none';
    });
  });

  document.getElementById('disk-create-persistent').addEventListener('change', (e) => {
    document.getElementById('disk-create-persistent-warn').style.display =
      e.target.checked ? 'block' : 'none';
  });

  document.getElementById('lv-create-persistent').addEventListener('change', (e) => {
    document.getElementById('lv-create-persistent-warn').style.display =
      e.target.checked ? 'block' : 'none';
  });
});

async function submitDiskMount() {
  if (!pendingMountDevice) return;

  const mountPoint = document.getElementById('disk-mount-point').value.trim();
  const persistent = document.querySelector('input[name="disk-mount-type"]:checked').value === 'persist';
  const statusEl = document.getElementById('disk-mount-status');
  const submitBtn = document.getElementById('btn-disk-mount-submit');

  if (!mountPoint) {
    statusEl.className = 'status-msg show error';
    statusEl.textContent = 'マウント先パスを入力してください。';
    return;
  }

  statusEl.className = 'status-msg show info';
  statusEl.innerHTML = '<span class="spinner"></span> マウント中...';
  submitBtn.disabled = true;

  try {
    const resp = await fetch('/api/disks/mount', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device: pendingMountDevice,
        mount_point: mountPoint,
        persistent: persistent,
        fstype: pendingMountFstype,
      }),
    });
    const data = await resp.json();
    submitBtn.disabled = false;

    if (data.success) {
      statusEl.className = 'status-msg show success';
      statusEl.textContent = data.message;
      showStatus(data.message, 'success');
      setTimeout(() => {
        closeDiskMountModal();
        loadDisks();
      }, 1000);
    } else {
      statusEl.className = 'status-msg show error';
      statusEl.textContent = data.message;
    }
  } catch (e) {
    submitBtn.disabled = false;
    statusEl.className = 'status-msg show error';
    statusEl.textContent = `エラー: ${e.message}`;
  }
}

async function unmountDisk(deviceName, mountPoint, force = false) {
  const confirmMsg = force
    ? `${mountPoint} を強制アンマウントしますか？\n（使用中のプロセスがあっても強制的に切り離します）`
    : `${mountPoint} をアンマウントしますか？`;
  if (!confirm(confirmMsg)) return;

  try {
    const resp = await fetch('/api/disks/unmount', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: deviceName, mount_point: mountPoint, force }),
    });
    const data = await resp.json();
    if (data.success) {
      showStatus(data.message, 'success');
      if (data.fstab_entry) {
        showStatus('注意: /etc/fstabにエントリが残っています', 'info');
      }
      loadDisks();
    } else {
      showStatus(data.message, 'error');
    }
  } catch (e) {
    showStatus(`エラー: ${e.message}`, 'error');
  }
}

// --- Create Partition ---
let pendingCreateDisk = null;
let pendingCreateMaxBytes = 0;

function formatBytesJS(b) {
  if (b >= 1024**3) return (b / 1024**3).toFixed(1) + ' GB';
  if (b >= 1024**2) return (b / 1024**2).toFixed(0) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
  return b + ' B';
}

function openDiskCreateModal(diskName, totalBytes, freeBytes) {
  pendingCreateDisk = diskName;
  pendingCreateMaxBytes = freeBytes;

  const freeMb = Math.floor(freeBytes / (1024 * 1024));
  document.getElementById('disk-create-info').textContent = `/dev/${diskName} - 空き領域: ${formatBytesJS(freeBytes)}`;
  document.getElementById('disk-create-size').value = Math.min(freeMb, 1024);
  document.getElementById('disk-create-size').max = freeMb;
  document.getElementById('disk-create-size-max').textContent = `${freeMb} MB`;
  document.getElementById('disk-create-fstype').value = 'ext4';
  document.getElementById('disk-create-label').value = '';
  document.getElementById('disk-create-mount').value = '';
  document.getElementById('disk-create-persistent').checked = false;
  document.getElementById('disk-create-persistent-warn').style.display = 'none';
  document.getElementById('disk-create-status').className = 'status-msg';
  document.getElementById('disk-create-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('disk-create-size').focus(), 100);
}

function closeDiskCreateModal() {
  document.getElementById('disk-create-modal').style.display = 'none';
  pendingCreateDisk = null;
  pendingCreateMaxBytes = 0;
}

async function submitDiskCreate() {
  if (!pendingCreateDisk) return;

  const sizeMb = parseInt(document.getElementById('disk-create-size').value) || 0;
  const fstype = document.getElementById('disk-create-fstype').value;
  const label = document.getElementById('disk-create-label').value.trim();
  const mountPoint = document.getElementById('disk-create-mount').value.trim();
  const persistent = document.getElementById('disk-create-persistent').checked;
  const statusEl = document.getElementById('disk-create-status');
  const submitBtn = document.getElementById('btn-disk-create-submit');

  if (sizeMb < 8) {
    statusEl.className = 'status-msg show error';
    statusEl.textContent = 'サイズは8MB以上を指定してください。';
    return;
  }

  if (fstype === 'swap' && mountPoint) {
    statusEl.className = 'status-msg show error';
    statusEl.textContent = 'swapにはマウント先パスを指定できません。';
    return;
  }

  if (persistent && !mountPoint) {
    statusEl.className = 'status-msg show error';
    statusEl.textContent = '永続マウントを指定する場合はマウント先パスを入力してください。';
    return;
  }

  if (label && !/^[a-zA-Z0-9._-]+$/.test(label)) {
    statusEl.className = 'status-msg show error';
    statusEl.textContent = 'ラベル名は半角英数字と . _ - のみ使用できます。';
    return;
  }

  const labelInfo = label ? ` ラベル「${label}」` : '';
  if (!confirm(`'/dev/${pendingCreateDisk}' に ${sizeMb}MB の ${fstype} パーティション${labelInfo}を作成しますか？`)) return;

  const sizeSectors = Math.floor(sizeMb * 1024 * 1024 / 512);
  statusEl.className = 'status-msg show info';
  statusEl.innerHTML = '<span class="spinner"></span> パーティションを作成中...';
  submitBtn.disabled = true;

  try {
    const resp = await fetch('/api/disks/partition/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        disk: pendingCreateDisk,
        size_sectors: sizeSectors,
        fstype: fstype,
        label: label,
        mount_point: mountPoint,
        persistent: persistent,
      }),
    });
    const data = await resp.json();
    submitBtn.disabled = false;

    if (data.success) {
      statusEl.className = 'status-msg show success';
      statusEl.textContent = data.message;
      showStatus(data.message, 'success');
      setTimeout(() => {
        closeDiskCreateModal();
        loadDisks();
      }, 1200);
    } else {
      statusEl.className = 'status-msg show error';
      statusEl.textContent = data.message;
    }
  } catch (e) {
    submitBtn.disabled = false;
    statusEl.className = 'status-msg show error';
    statusEl.textContent = `エラー: ${e.message}`;
  }
}

// --- Extend Partition ---
let pendingExtendDevice = null;
let pendingExtendMaxBytes = 0;

function openDiskExtendModal(deviceName, currentBytes, maxExtendBytes) {
  pendingExtendDevice = deviceName;
  pendingExtendMaxBytes = maxExtendBytes;

  const currentMb = Math.floor(currentBytes / (1024 * 1024));
  const maxMb = Math.floor(maxExtendBytes / (1024 * 1024));
  const afterMb = currentMb + maxMb;

  document.getElementById('disk-extend-info').textContent = `/dev/${deviceName}`;
  document.getElementById('disk-extend-current').textContent = formatBytesJS(currentBytes);
  document.getElementById('disk-extend-max').textContent = `+${formatBytesJS(maxExtendBytes)}`;
  document.getElementById('disk-extend-after').textContent = `${formatBytesJS(currentBytes + maxExtendBytes)} (${currentMb + maxMb} MB)`;
  document.getElementById('disk-extend-status').className = 'status-msg';
  document.getElementById('disk-extend-modal').style.display = 'flex';
}

function closeDiskExtendModal() {
  document.getElementById('disk-extend-modal').style.display = 'none';
  pendingExtendDevice = null;
  pendingExtendMaxBytes = 0;
}

async function submitDiskExtend() {
  if (!pendingExtendDevice) return;

  if (!confirm(`'/dev/${pendingExtendDevice}' を最大容量まで拡張しますか？\n\n注意: ファイルシステムも自動的に拡張されます。`)) return;

  const statusEl = document.getElementById('disk-extend-status');
  const submitBtn = document.getElementById('btn-disk-extend-submit');

  statusEl.className = 'status-msg show info';
  statusEl.innerHTML = '<span class="spinner"></span> 拡張中...';
  submitBtn.disabled = true;

  try {
    const resp = await fetch('/api/disks/partition/extend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: pendingExtendDevice }),
    });
    const data = await resp.json();
    submitBtn.disabled = false;

    if (data.success) {
      statusEl.className = 'status-msg show success';
      statusEl.textContent = data.message;
      showStatus(data.message, 'success');
      setTimeout(() => {
        closeDiskExtendModal();
        loadDisks();
      }, 1200);
    } else {
      statusEl.className = 'status-msg show error';
      statusEl.textContent = data.message;
    }
  } catch (e) {
    submitBtn.disabled = false;
    statusEl.className = 'status-msg show error';
    statusEl.textContent = `エラー: ${e.message}`;
  }
}

// --- Create LV ---
let pendingCreateLvVg = null;

function openLvCreateModal(vgName, vgFree) {
  pendingCreateLvVg = vgName;
  document.getElementById('lv-create-info').textContent = `VG: ${vgName} - 空き: ${vgFree}`;
  document.getElementById('lv-create-name').value = '';
  document.getElementById('lv-create-size').value = '';
  document.getElementById('lv-create-fstype').value = 'ext4';
  document.getElementById('lv-create-mount').value = '';
  document.getElementById('lv-create-persistent').checked = false;
  document.getElementById('lv-create-persistent-warn').style.display = 'none';
  document.getElementById('lv-create-status').className = 'status-msg';
  document.getElementById('lv-create-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('lv-create-name').focus(), 100);
}

function closeLvCreateModal() {
  document.getElementById('lv-create-modal').style.display = 'none';
  pendingCreateLvVg = null;
}

async function submitLvCreate() {
  if (!pendingCreateLvVg) return;

  const lvName = document.getElementById('lv-create-name').value.trim();
  const size = document.getElementById('lv-create-size').value.trim();
  const fstype = document.getElementById('lv-create-fstype').value;
  const mountPoint = document.getElementById('lv-create-mount').value.trim();
  const persistent = document.getElementById('lv-create-persistent').checked;
  const statusEl = document.getElementById('lv-create-status');
  const submitBtn = document.getElementById('btn-lv-create-submit');

  if (!lvName || !size) {
    statusEl.className = 'status-msg show error';
    statusEl.textContent = 'LV名とサイズを入力してください。';
    return;
  }

  if (fstype === 'swap' && mountPoint) {
    statusEl.className = 'status-msg show error';
    statusEl.textContent = 'swapにはマウント先パスを指定できません。';
    return;
  }

  if (persistent && !mountPoint) {
    statusEl.className = 'status-msg show error';
    statusEl.textContent = '永続マウントを指定する場合はマウント先パスを入力してください。';
    return;
  }

  if (!confirm(`VG '${pendingCreateLvVg}' に LV '${lvName}' (${size}, ${fstype}) を作成しますか？`)) return;

  statusEl.className = 'status-msg show info';
  statusEl.innerHTML = '<span class="spinner"></span> 論理ボリュームを作成中...';
  submitBtn.disabled = true;

  try {
    const resp = await fetch('/api/disks/lv/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vg_name: pendingCreateLvVg,
        lv_name: lvName,
        size: size,
        fstype: fstype,
        mount_point: mountPoint,
        persistent: persistent,
      }),
    });
    const data = await resp.json();
    submitBtn.disabled = false;

    if (data.success) {
      statusEl.className = 'status-msg show success';
      statusEl.textContent = data.message;
      showStatus(data.message, 'success');
      setTimeout(() => {
        closeLvCreateModal();
        loadDisks();
      }, 1200);
    } else {
      statusEl.className = 'status-msg show error';
      statusEl.textContent = data.message;
    }
  } catch (e) {
    submitBtn.disabled = false;
    statusEl.className = 'status-msg show error';
    statusEl.textContent = `エラー: ${e.message}`;
  }
}

// --- Resize LV ---
let pendingResizeLvVg = null;
let pendingResizeLvName = null;

function openLvResizeModal(vgName, lvName, lvSize, vgFree) {
  pendingResizeLvVg = vgName;
  pendingResizeLvName = lvName;
  document.getElementById('lv-resize-info').textContent = `/dev/${vgName}/${lvName}`;
  document.getElementById('lv-resize-current').textContent = lvSize;
  document.getElementById('lv-resize-free').textContent = `+${vgFree}`;
  document.getElementById('lv-resize-size').value = '';
  document.getElementById('lv-resize-status').className = 'status-msg';
  document.getElementById('lv-resize-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('lv-resize-size').focus(), 100);
}

function closeLvResizeModal() {
  document.getElementById('lv-resize-modal').style.display = 'none';
  pendingResizeLvVg = null;
  pendingResizeLvName = null;
}

async function submitLvResize() {
  if (!pendingResizeLvVg || !pendingResizeLvName) return;

  const size = document.getElementById('lv-resize-size').value.trim();
  const statusEl = document.getElementById('lv-resize-status');
  const submitBtn = document.getElementById('btn-lv-resize-submit');

  if (!size) {
    statusEl.className = 'status-msg show error';
    statusEl.textContent = 'サイズを入力してください。';
    return;
  }

  if (!confirm(`'/dev/${pendingResizeLvVg}/${pendingResizeLvName}' を ${size} にリサイズしますか？\n\nファイルシステムも自動的に拡張されます。`)) return;

  statusEl.className = 'status-msg show info';
  statusEl.innerHTML = '<span class="spinner"></span> リサイズ中...';
  submitBtn.disabled = true;

  try {
    const resp = await fetch('/api/disks/lv/resize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vg_name: pendingResizeLvVg,
        lv_name: pendingResizeLvName,
        size: size,
      }),
    });
    const data = await resp.json();
    submitBtn.disabled = false;

    if (data.success) {
      statusEl.className = 'status-msg show success';
      statusEl.textContent = data.message;
      showStatus(data.message, 'success');
      setTimeout(() => {
        closeLvResizeModal();
        loadDisks();
      }, 1200);
    } else {
      statusEl.className = 'status-msg show error';
      statusEl.textContent = data.message;
    }
  } catch (e) {
    submitBtn.disabled = false;
    statusEl.className = 'status-msg show error';
    statusEl.textContent = `エラー: ${e.message}`;
  }
}

// --- Delete Disk (wipe all partitions) ---
async function wipeDisk(diskName) {
  if (!confirm(`ディスク '/dev/${diskName}' の全パーティションを削除しますか？\n\n⚠️ このディスク上のすべてのデータが失われます。`)) return;

  try {
    const resp = await fetch('/api/disks/disk/wipe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: diskName }),
    });
    const data = await resp.json();
    if (data.success) {
      showStatus(data.message, 'success');
      loadDisks();
    } else {
      showStatus(data.message, 'error');
    }
  } catch (e) {
    showStatus(`エラー: ${e.message}`, 'error');
  }
}

// --- Delete Partition ---
async function deletePartition(deviceName) {
  if (!confirm(`パーティション '/dev/${deviceName}' を削除しますか？\n\nデータは完全に失われます。`)) return;

  try {
    const resp = await fetch('/api/disks/partition/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: deviceName }),
    });
    const data = await resp.json();
    if (data.success) {
      showStatus(data.message, 'success');
      loadDisks();
    } else {
      showStatus(data.message, 'error');
    }
  } catch (e) {
    showStatus(`エラー: ${e.message}`, 'error');
  }
}

// --- Delete LV ---
async function deleteLv(vgName, lvName) {
  if (!confirm(`論理ボリューム '${lvName}' (VG: ${vgName}) を削除しますか？\n\nデータは完全に失われます。`)) return;

  try {
    const resp = await fetch('/api/disks/lv/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vg_name: vgName, lv_name: lvName }),
    });
    const data = await resp.json();
    if (data.success) {
      showStatus(data.message, 'success');
      loadDisks();
    } else {
      showStatus(data.message, 'error');
    }
  } catch (e) {
    showStatus(`エラー: ${e.message}`, 'error');
  }
}

// --- GRUB ---
let grubPartitions = [];
let grubIsoResult = null;

async function loadGrub() {
  const statusMsg = document.getElementById('grub-status-msg');
  try {
    const resp = await fetch('/api/grub/info');
    const data = await resp.json();
    renderGrubInfo(data);
  } catch (e) {
    statusMsg.className = 'status-msg show error';
    statusMsg.textContent = `GRUB情報取得エラー: ${e.message}`;
  }
  loadGrubPartitions();
  syncIsoDownloadStatus();
}

function renderGrubInfo(data) {
  // Next-boot menu button state
  const nextBtn = document.getElementById('btn-grub-next-menu');
  if (nextBtn) {
    if (data.next_menu_armed) {
      nextBtn.classList.remove('btn-primary');
      nextBtn.classList.add('btn-success');
      nextBtn.textContent = '設定済み（次回起動時のみメニュー表示）';
    } else {
      nextBtn.classList.add('btn-primary');
      nextBtn.classList.remove('btn-success');
      nextBtn.textContent = '次回PC起動時にGRUBメニューを表示';
    }
  }

  // Current settings
  const s = data.settings || {};
  const rfBadge = s.recordfail === '1'
    ? '<span class="badge badge-warn">1（残存）</span>'
    : '<span class="badge badge-active">なし</span>';
  document.getElementById('grub-settings-container').innerHTML = `
    <table class="proc-table" style="max-width:620px;">
      <tbody>
        <tr><td style="width:40%;color:var(--text-muted);">設定ファイル</td><td>${escapeHtml(data.cfg_path || '見つかりません')}</td></tr>
        <tr><td style="color:var(--text-muted);">GRUB_DEFAULT</td><td><b>${escapeHtml(s.default ?? '未設定')}</b></td></tr>
        <tr><td style="color:var(--text-muted);">GRUB_TIMEOUT</td><td><b>${escapeHtml(s.timeout ?? '未設定')}</b> 秒</td></tr>
        <tr><td style="color:var(--text-muted);">saved_entry</td><td>${escapeHtml(s.saved_entry || '（なし）')}</td></tr>
        <tr><td style="color:var(--text-muted);">next_entry</td><td>${escapeHtml(s.next_entry || '（なし）')}</td></tr>
        <tr><td style="color:var(--text-muted);">recordfail</td><td>${rfBadge}</td></tr>
      </tbody>
    </table>`;

  // Entry list
  const typeLabel = { toplevel: 'エントリー', submenu_header: 'サブメニュー', sub_entry: '└ 子エントリ' };
  const rows = (data.entries || []).map((e, i) => {
    const indent = e.class === 'sub_entry' ? '&nbsp;&nbsp;&nbsp;&nbsp;' : '';
    const srcBadge = e.source === 'custom'
      ? '<span class="badge badge-active">custom</span>'
      : '<span class="badge badge-other">auto</span>';
    const delBtn = (e.source === 'custom' && e.class !== 'submenu_header')
      ? `<button class="btn btn-sm btn-danger" onclick="deleteGrubEntry(${i}, '${escapeJs(e.name)}')" title="40_customから削除">削除</button>`
      : '';
    return `<tr>
      <td>${i}</td>
      <td>${escapeHtml(e.grub_id)}</td>
      <td>${typeLabel[e.class] || escapeHtml(e.class)}</td>
      <td>${srcBadge}</td>
      <td>${indent}${escapeHtml(e.name)}</td>
      <td>${delBtn}</td>
    </tr>`;
  }).join('');
  document.getElementById('grub-entries-container').innerHTML =
    (!data.entries || data.entries.length === 0)
      ? '<p class="muted">menuentryが見つかりませんでした。</p>'
      : `<table class="proc-table">
          <thead><tr><th>No.</th><th>GRUB ID</th><th>種別</th><th>出所</th><th>エントリー名</th><th>操作</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;

  // Stale backups in /etc/grub.d
  const staleEl = document.getElementById('grub-stale-backups');
  if (data.stale_backups && data.stale_backups.length > 0) {
    staleEl.style.display = 'block';
    staleEl.innerHTML = '/etc/grub.d/に古いバックアップがあります（削除したエントリーが復活する原因）:<br>' +
      data.stale_backups.map(b => escapeHtml(b)).join('<br>') +
      ' <button class="btn btn-sm btn-danger" onclick="cleanupGrubBackups()" style="margin-top:0.4rem;">古いバックアップを削除</button>';
  } else {
    staleEl.style.display = 'none';
  }

  // EFI entries
  const efiEl = document.getElementById('grub-efi-container');
  if (!data.efi || data.efi.length === 0) {
    efiEl.innerHTML = '<p class="muted">efibootmgrが利用できないか、EFIブートエントリーがありません。</p>';
  } else {
    efiEl.innerHTML = `<table class="proc-table" style="max-width:760px;"><tbody>` +
      data.efi.map(e =>
        `<tr><td>${e.active ? '<span class="text-success">●</span>' : '<span class="muted">○</span>'} ${escapeHtml(e.text)}</td></tr>`
      ).join('') +
      '</tbody></table>';
  }
}

async function loadGrubPartitions() {
  try {
    const resp = await fetch('/api/grub/partitions');
    const data = await resp.json();
    grubPartitions = data.partitions || [];
    const sel = document.getElementById('grub-part-select');
    if (grubPartitions.length === 0) {
      sel.innerHTML = '<option value="">対象のパーティションがありません</option>';
      return;
    }
    sel.innerHTML = grubPartitions.map((p, i) => {
      const warn = p.supported ? '' : ' ⚠';
      const mp = p.mountpoint ? ` / ${p.mountpoint}` : '';
      return `<option value="${i}">${escapeHtml(p.name)} (${escapeHtml(p.size)}, ${escapeHtml(p.fstype || '不明')}${escapeHtml(mp)})${warn}</option>`;
    }).join('');
  } catch (e) {
    console.error('GRUB partitions load error:', e);
  }
}

function selectedGrubPartition() {
  const sel = document.getElementById('grub-part-select');
  return grubPartitions[parseInt(sel.value)] || null;
}

async function scanGrubIsos() {
  const p = selectedGrubPartition();
  const listEl = document.getElementById('grub-iso-list');
  const statusEl = document.getElementById('grub-add-status');
  if (!p) {
    statusEl.className = 'status-msg show error';
    statusEl.textContent = 'パーティションを選択してください。';
    return;
  }
  statusEl.className = 'status-msg show info';
  statusEl.innerHTML = '<span class="spinner"></span> ISOファイルを検索中... (マウントとカーネル自動検出のため時間がかかる場合があります)';
  listEl.innerHTML = '';
  document.getElementById('btn-grub-add').style.display = 'none';

  try {
    const resp = await fetch('/api/grub/isos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: p.name }),
    });
    const data = await resp.json();
    if (!data.success) {
      statusEl.className = 'status-msg show error';
      statusEl.textContent = data.error || 'ISO検索に失敗しました';
      return;
    }
    statusEl.className = 'status-msg';
    grubIsoResult = data;
    if (data.isos.length === 0) {
      listEl.innerHTML = '<p class="muted">ISOファイルが見つかりませんでした。</p>';
      return;
    }
    listEl.innerHTML = `<p class="muted" style="margin-bottom:0.5rem;">デバイス: ${escapeHtml(data.device)} | UUID: ${escapeHtml(data.uuid || '（なし）')} — 追加するISOにチェックを入れてください（vmlinuz/initrdは編集可）:</p>` +
      data.isos.map((iso, i) => `
        <div class="package-item" style="flex-wrap:wrap;gap:0.5rem;">
          <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;flex:1;min-width:220px;">
            <input type="checkbox" class="grub-iso-check" data-idx="${i}">
            <span>
              <b>${escapeHtml(iso.path)}</b> <span class="muted">(${escapeHtml(iso.size)})</span><br>
              <span class="muted" style="font-size:0.72rem;">起動方式: ${iso.boot_type === 'UNKNOWN' || iso.vmlinuz === 'UNKNOWN' ? '<span class="text-warn">要手動入力</span>' : escapeHtml(iso.boot_type)}</span>
            </span>
          </label>
          <div style="display:flex;gap:0.35rem;font-size:0.72rem;">
            <input type="text" class="grub-iso-vmlinuz" data-idx="${i}" value="${escapeHtml(iso.vmlinuz)}" placeholder="/casper/vmlinuz" style="width:150px;padding:0.25rem 0.4rem;background:var(--bg-base);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);">
            <input type="text" class="grub-iso-initrd" data-idx="${i}" value="${escapeHtml(iso.initrd)}" placeholder="/casper/initrd" style="width:150px;padding:0.25rem 0.4rem;background:var(--bg-base);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);">
          </div>
        </div>`).join('');
    document.getElementById('btn-grub-add').style.display = 'inline-block';
  } catch (e) {
    statusEl.className = 'status-msg show error';
    statusEl.textContent = `エラー: ${e.message}`;
  }
}

async function submitGrubAdd() {
  const p = selectedGrubPartition();
  if (!p || !grubIsoResult) return;

  const checks = Array.from(document.querySelectorAll('.grub-iso-check:checked'));
  if (checks.length === 0) {
    showStatus('追加するISOを選択してください', 'error');
    return;
  }

  const isos = checks.map(c => {
    const idx = c.dataset.idx;
    return {
      path: grubIsoResult.isos[idx].path,
      vmlinuz: document.querySelector(`.grub-iso-vmlinuz[data-idx="${idx}"]`).value.trim(),
      initrd: document.querySelector(`.grub-iso-initrd[data-idx="${idx}"]`).value.trim(),
      boot_type: grubIsoResult.isos[idx].boot_type,
    };
  });

  if (isos.some(i => !i.vmlinuz.startsWith('/') || !i.initrd.startsWith('/'))) {
    showStatus('vmlinuz/initrdのパスは「/」で始まる必要があります', 'error');
    return;
  }

  const names = isos.map(i => i.path).join('\n');
  if (!confirm(`以下のISOループブートエントリーを追加しますか？\n\n${names}\n\n追加後、update-grubが実行されます。`)) return;

  const statusEl = document.getElementById('grub-add-status');
  const btn = document.getElementById('btn-grub-add');
  statusEl.className = 'status-msg show info';
  statusEl.innerHTML = '<span class="spinner"></span> エントリーを追加中... (update-grubに数十秒かかる場合があります)';
  btn.disabled = true;

  try {
    const resp = await fetch('/api/grub/entries/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: p.name, isos }),
    });
    const data = await resp.json();
    btn.disabled = false;
    statusEl.className = `status-msg show ${data.success ? 'success' : 'error'}`;
    statusEl.textContent = data.message;
    if (data.success) {
      showStatus('GRUBエントリーを追加しました', 'success');
      grubIsoResult = null;
      document.getElementById('grub-iso-list').innerHTML = '';
      document.getElementById('btn-grub-add').style.display = 'none';
      loadGrub();
    }
  } catch (e) {
    btn.disabled = false;
    statusEl.className = 'status-msg show error';
    statusEl.textContent = `エラー: ${e.message}`;
  }
}

async function deleteGrubEntry(index, name) {
  if (!confirm(`エントリー「${name}」を削除しますか？\n40_customから削除され、update-grubが実行されます。\n（バックアップは ${'/root/grub-backups/'} に保存されます）`)) return;
  try {
    const resp = await fetch('/api/grub/entries/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ indices: [index] }),
    });
    const data = await resp.json();
    if (data.success) {
      showStatus('エントリーを削除しました', 'success');
    } else {
      showStatus(data.message || '削除に失敗しました', 'error');
    }
    loadGrub();
  } catch (e) {
    showStatus(`エラー: ${e.message}`, 'error');
  }
}

async function armNextBootMenu() {
  const btn = document.getElementById('btn-grub-next-menu');
  if (!confirm('次回のPC起動時のみGRUBメニューを5秒間表示します。\nその次の起動からは元の設定に自動的に戻ります。\n\nよろしいですか？')) return;

  const statusMsg = document.getElementById('grub-status-msg');
  btn.disabled = true;
  statusMsg.className = 'status-msg show info';
  statusMsg.innerHTML = '<span class="spinner"></span> 設定中... (update-grubを実行するため数十秒かかる場合があります)';

  try {
    const resp = await fetch('/api/grub/next-boot-menu', { method: 'POST' });
    const data = await resp.json();
    statusMsg.className = `status-msg show ${data.success ? 'success' : 'error'}`;
    statusMsg.textContent = data.message;
    if (data.success) {
      showStatus('次回起動時にGRUBメニューが表示されます', 'success');
    }
  } catch (e) {
    statusMsg.className = 'status-msg show error';
    statusMsg.textContent = `エラー: ${e.message}`;
  }
  btn.disabled = false;
  loadGrub();
}

async function cleanupGrubBackups() {
  if (!confirm('/etc/grub.d/内の古い40_customバックアップファイルを削除しますか？')) return;
  try {
    const resp = await fetch('/api/grub/cleanup-backups', { method: 'POST' });
    const data = await resp.json();
    showStatus(data.message, data.success ? 'success' : 'error');
    loadGrub();
  } catch (e) {
    showStatus(`エラー: ${e.message}`, 'error');
  }
}

let isoDlPollTimer = null;

function stopIsoDlPolling() {
  if (isoDlPollTimer) {
    clearInterval(isoDlPollTimer);
    isoDlPollTimer = null;
  }
}

async function pollIsoDownloadStatus() {
  const statusEl = document.getElementById('grub-iso-dl-status');
  const progress = document.getElementById('grub-iso-dl-progress');
  const bar = document.getElementById('grub-iso-dl-progress-bar');
  const text = document.getElementById('grub-iso-dl-progress-text');
  const btn = document.getElementById('btn-grub-iso-dl');
  const cancelBtn = document.getElementById('btn-grub-iso-dl-cancel');
  let s;
  try {
    const resp = await fetch('/api/grub/iso-download/status');
    s = await resp.json();
  } catch (e) {
    return;
  }
  if (s.running) {
    btn.disabled = true;
    cancelBtn.disabled = false;
    progress.style.display = 'block';
    if (s.total > 0) {
      const pct = Math.min(100, Math.round((s.size / s.total) * 100));
      bar.style.width = pct + '%';
      text.textContent = `${s.filename} — ${formatBytesJS(s.size)} / ${formatBytesJS(s.total)} (${pct}%)`;
    } else {
      bar.style.width = '0%';
      text.textContent = `${s.filename} — ${formatBytesJS(s.size)}`;
    }
    statusEl.className = 'status-msg show info';
    statusEl.innerHTML = '<span class="spinner"></span> /iso にダウンロード中...';
    return;
  }
  stopIsoDlPolling();
  progress.style.display = 'none';
  cancelBtn.disabled = true;
  if (s.success === true || s.success === false) {
    btn.disabled = false;
    if (s.success) {
      statusEl.className = 'status-msg show success';
      statusEl.textContent = `${s.filename} を /iso に保存しました（${formatBytesJS(s.size)}）`;
    } else if (s.cancelled) {
      statusEl.className = 'status-msg show error';
      statusEl.textContent = 'ダウンロードをキャンセルしました';
    } else {
      statusEl.className = 'status-msg show error';
      statusEl.textContent = `ダウンロード失敗: ${s.log || '不明なエラー'}`;
    }
  }
}

async function downloadIsoFromWeb() {
  const input = document.getElementById('grub-iso-dl-url');
  const statusEl = document.getElementById('grub-iso-dl-status');
  const btn = document.getElementById('btn-grub-iso-dl');
  const url = (input.value || '').trim();
  if (!url) {
    statusEl.className = 'status-msg show error';
    statusEl.textContent = 'ISOイメージのURLを入力してください';
    return;
  }
  btn.disabled = true;
  statusEl.className = 'status-msg show info';
  statusEl.innerHTML = '<span class="spinner"></span> ダウンロードを開始しています...';
  try {
    const resp = await fetch('/api/grub/iso-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await resp.json();
    if (!data.success) {
      statusEl.className = 'status-msg show error';
      statusEl.textContent = data.message;
      btn.disabled = false;
      return;
    }
    input.value = '';
    stopIsoDlPolling();
    pollIsoDownloadStatus();
    isoDlPollTimer = setInterval(pollIsoDownloadStatus, 1000);
  } catch (e) {
    statusEl.className = 'status-msg show error';
    statusEl.textContent = `エラー: ${e.message}`;
    btn.disabled = false;
  }
}

async function cancelIsoDownload() {
  if (!confirm('ダウンロードをキャンセルしますか？\n保存中の部分ファイルは削除されます。')) return;
  document.getElementById('btn-grub-iso-dl-cancel').disabled = true;
  try {
    await fetch('/api/grub/iso-download/cancel', { method: 'POST' });
  } catch (e) {}
  pollIsoDownloadStatus();
}

function syncIsoDownloadStatus() {
  fetch('/api/grub/iso-download/status')
    .then(r => r.json())
    .then(s => {
      if (s.running && !isoDlPollTimer) {
        stopIsoDlPolling();
        pollIsoDownloadStatus();
        isoDlPollTimer = setInterval(pollIsoDownloadStatus, 1000);
      }
    })
    .catch(() => {});
}

// --- Helpers ---
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeJs(str) {
  if (!str) return '';
  return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function showStatus(msg, type) {
  const el = document.createElement('div');
  el.className = `status-msg show ${type}`;
  el.textContent = msg;
  el.style.position = 'fixed';
  el.style.bottom = '1rem';
  el.style.right = '1rem';
  el.style.zIndex = '100';
  el.style.minWidth = '300px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// --- Selfcode ---
async function openSelfcode() {
  try {
    const resp = await fetch('/api/selfcode/status');
    const data = await resp.json();

    if (data.installed && data.url) {
      // Open selfcode in new tab
      window.open(data.url, '_blank');
    } else if (data.installed) {
      // Installed but URL unknown
      switchTab('terminal');
      showStatus('selfcodeはインストール済みです。URLを取得できませんでした。', 'info');
    } else {
      // Not installed - confirm before installing
      if (!confirm('selfcodeはまだインストールされていません。\nインストールしますか？')) return;
      switchTab('terminal');
      showStatus('selfcodeをインストール中... ターミナルで進捗を確認できます。', 'info');
      setTimeout(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          const installCmd = 'sudo apt install -y git curl && { command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 || sudo apt install -y nodejs npm; } && curl -fsSL https://raw.githubusercontent.com/hirogura/selfcode/main/install-selfcode.sh -o /tmp/install-selfcode.sh && sudo bash /tmp/install-selfcode.sh\n';
          ws.send(JSON.stringify({ type: 'input', data: installCmd }));
        } else {
          showStatus('ターミナルに接続できません', 'error');
        }
      }, 500);
    }
  } catch (e) {
    showStatus(`selfcode確認エラー: ${e.message}`, 'error');
  }
}

// --- Easy LXD ---
async function openEasyLXD() {
  try {
    const resp = await fetch('/api/easylxd/status');
    const data = await resp.json();

    if (data.installed && data.url) {
      window.open(data.url, '_blank');
    } else {
      if (!confirm('Easy LXDはまだインストールされていません。\nインストールしますか？')) return;
      switchTab('terminal');
      showStatus('Easy LXDをインストール中...', 'info');
      setTimeout(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          const installCmd = 'curl -fsSL -o /tmp/install-easylxd1.sh https://raw.githubusercontent.com/hirogura/easylxd/main/install-easylxd1.sh && chmod +x /tmp/install-easylxd1.sh && sudo /tmp/install-easylxd1.sh\n';
          ws.send(JSON.stringify({ type: 'input', data: installCmd }));
        } else {
          showStatus('ターミナルに接続できません', 'error');
        }
      }, 500);
    }
  } catch (e) {
    showStatus(`Easy LXD確認エラー: ${e.message}`, 'error');
  }
}

// --- VM Manager ---
async function openVMManager() {
  try {
    const resp = await fetch('/api/vmmanager/status');
    const data = await resp.json();

    if (data.installed && data.url) {
      window.open(data.url, '_blank');
    } else {
      if (!confirm('VM Managerはまだインストールされていません。\nインストールしますか？')) return;
      switchTab('terminal');
      showStatus('VM Managerをインストール中...', 'info');
      setTimeout(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          const installCmd = 'curl -fsSL -o /tmp/install-vmmanager1.sh https://raw.githubusercontent.com/hirogura/vmmanager/main/install-vmmanager1.sh && chmod +x /tmp/install-vmmanager1.sh && sudo /tmp/install-vmmanager1.sh\n';
          ws.send(JSON.stringify({ type: 'input', data: installCmd }));
        } else {
          showStatus('ターミナルに接続できません', 'error');
        }
      }, 500);
    }
  } catch (e) {
    showStatus(`VM Manager確認エラー: ${e.message}`, 'error');
  }
}

// --- Backup / Restore ---
let backupStatusData = null;

async function loadBackupPage() {
  loadBackupStatus();
  loadBackupPartitions();
}

function setBackupControlsEnabled(enabled) {
  ['backup-dest-select', 'btn-backup-run', 'restore-src-select', 'btn-restore-scan', 'restore-img-select', 'btn-restore-run'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !enabled;
  });
}

async function loadBackupStatus() {
  const envEl = document.getElementById('backup-env-status');
  const installBtn = document.getElementById('btn-backup-install');
  try {
    const resp = await fetch('/api/backup/status');
    backupStatusData = await resp.json();
    const installed = backupStatusData.installed;
    const isoMounted = backupStatusData.iso_mounted;

    envEl.innerHTML =
      `<div>Clonezilla: ${installed
        ? '<span class="text-success">インストール済み</span>'
        : '<span class="text-danger">未インストール</span>'}</div>` +
      `<div>保存用パーティション (/iso): ${isoMounted
        ? `<span class="text-success">マウント済み</span> (${escapeHtml(backupStatusData.iso_source || '?')}${backupStatusData.iso_fstype ? ', ' + escapeHtml(backupStatusData.iso_fstype) : ''}${backupStatusData.iso_size ? ', ' + escapeHtml(backupStatusData.iso_size) : ''})`
        : '<span class="text-warn">未マウント</span>'}</div>` +
      (installed && isoMounted ? '' :
        `<div class="text-warn" style="margin-top:0.3rem;">${!installed
          ? '先に「Clonezillaをインストール」を実行してください。'
          : '/iso に保存用パーティションをマウントしてください。'}</div>`);

    installBtn.disabled = installed;
    installBtn.textContent = installed ? 'Clonezillaをインストール済み' : 'Clonezillaをインストール';
    setBackupControlsEnabled(installed);
  } catch (e) {
    envEl.innerHTML = `<span class="text-danger">状態の取得に失敗しました: ${escapeHtml(e.message)}</span>`;
  }
}

async function loadBackupPartitions() {
  const destSel = document.getElementById('backup-dest-select');
  const srcSel = document.getElementById('restore-src-select');
  try {
    const resp = await fetch('/api/backup/partitions');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const options = data.partitions.map(p => {
      const label = [p.device, p.size, p.fstype || '(fs不明)', p.mountpoint ? `mount=${p.mountpoint}` : null]
        .filter(Boolean).join(' / ');
      return `<option value="${escapeHtml(p.device)}">${escapeHtml(label)}</option>`;
    }).join('');
    destSel.innerHTML = options || '<option value="">パーティションがありません</option>';
    srcSel.innerHTML = options || '<option value="">パーティションがありません</option>';
  } catch (e) {
    destSel.innerHTML = '<option value="">パーティション一覧の取得に失敗しました</option>';
    srcSel.innerHTML = '<option value="">パーティション一覧の取得に失敗しました</option>';
    showBackupStatus(`パーティション一覧の取得エラー: ${e.message}`, 'error');
  }
}

function showBackupStatus(msg, type) {
  const el = document.getElementById('backup-status-msg');
  el.textContent = msg;
  el.className = `status-msg show ${type}`;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.className = 'status-msg'; }, 6000);
}

async function sendToTerminal(cmd, infoMsg) {
  switchTab('terminal');
  showStatus(infoMsg, 'info');
  setTimeout(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data: cmd + '\n' }));
    } else {
      showStatus('ターミナルに接続できません', 'error');
    }
  }, 500);
}

async function installClonezilla() {
  const btn = document.getElementById('btn-backup-install');
  if (!confirm('Clonezillaのインストールを開始しますか？\n\nGitHubからcloneautoを取得してインストールします。\n・完了まで数分かかる場合があります\n・ターミナルで進捗を確認できます')) return;
  btn.disabled = true;
  const installCmd = 'cd ~ && wget https://github.com/hirogura/cloneauto/archive/refs/heads/main.tar.gz && tar xzf main.tar.gz && cd cloneauto-main && sudo ./install-clonezilla.sh';
  await sendToTerminal(installCmd, 'Clonezillaをインストール中... ターミナルで進捗を確認できます。');
  showBackupStatus('Clonezillaをインストール中... 完成後、このページを再表示すると状態が更新されます。', 'info');
}

async function runBackup() {
  const device = document.getElementById('backup-dest-select').value;
  if (!device) {
    showBackupStatus('保存先パーティションを選択してください', 'error');
    return;
  }
  let cmdData;
  try {
    const resp = await fetch('/api/backup/cmd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'backup', device }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${resp.status}`);
    }
    cmdData = await resp.json();
  } catch (e) {
    showBackupStatus(`バックアップ準備エラー: ${e.message}`, 'error');
    return;
  }
  if (!confirm(`バックアップを開始しますか？\n\n保存先パーティション: ${device}\n\n・実行すると自動的に再起動し、Clonezilla Live がバックアップを行います\n・バックアップ完了後、自動的に再起動します`)) return;
  showBackupStatus(`${cmdData.message} でバックアップを開始します...`, 'info');
  await sendToTerminal(cmdData.cmd, `${cmdData.message} でバックアップを開始します（自動的に再起動します）`);
}

async function loadRestoreImages() {
  const srcSel = document.getElementById('restore-src-select');
  const imgSel = document.getElementById('restore-img-select');
  const device = srcSel.value;
  if (!device) {
    showBackupStatus('パーティションを選択してください', 'error');
    return;
  }
  const scanBtn = document.getElementById('btn-restore-scan');
  scanBtn.disabled = true;
  imgSel.innerHTML = '<option value="">検索中...</option>';
  try {
    const resp = await fetch('/api/backup/images', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${resp.status}`);
    }
    const data = await resp.json();
    if (data.images.length === 0) {
      imgSel.innerHTML = `<option value="">バックアップイメージが見つかりません (${escapeHtml(data.prefix)}-*)</option>`;
      showBackupStatus(`${device} にバックアップイメージが見つかりませんでした`, 'error');
      return;
    }
    imgSel.innerHTML = data.images.map(img =>
      `<option value="${escapeHtml(img)}">${escapeHtml(img)}</option>`).join('');
    showBackupStatus(`${data.images.length} 件のバックアップイメージが見つかりました`, 'success');
  } catch (e) {
    imgSel.innerHTML = '<option value="">イメージ一覧の取得に失敗しました</option>';
    showBackupStatus(`イメージ一覧の取得エラー: ${e.message}`, 'error');
  } finally {
    scanBtn.disabled = false;
  }
}

async function runRestore() {
  const device = document.getElementById('restore-src-select').value;
  const image = document.getElementById('restore-img-select').value;
  if (!device || !image) {
    showBackupStatus('パーティションとイメージを選択してください', 'error');
    return;
  }
  let cmdData;
  try {
    const resp = await fetch('/api/backup/cmd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'restore', device, image }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${resp.status}`);
    }
    cmdData = await resp.json();
  } catch (e) {
    showBackupStatus(`復元準備エラー: ${e.message}`, 'error');
    return;
  }
  if (!confirm(`復元を開始しますか？\n\n復元元パーティション: ${device}\nバックアップイメージ: ${image}\n\n⚠️ 現在のシステムは選択したバックアップの内容で上書きされます\n⚠️ 実行すると自動的に再起動し、Clonezilla Live が復元を行います\n⚠️ 処理中に電源を切らないでください`)) return;
  showBackupStatus(`${cmdData.message} で復元を開始します...`, 'info');
  await sendToTerminal(cmdData.cmd, `${cmdData.message} で復元を開始します（自動的に再起動します）`);
}

// --- serv-UI Fleet (一括管理) ---
let fleetNodes = [];
let fleetDetectLoading = false;
let fleetSettings = { intervalMs: 5000, pauseHidden: false };
let fleetTimer = null;

const FLEET_SETTINGS_KEY = 'servui_fleet_settings';

function loadFleetSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(FLEET_SETTINGS_KEY) || '{}');
    if ([5000, 10000, 15000, 30000, 60000].includes(raw.intervalMs)) {
      fleetSettings.intervalMs = raw.intervalMs;
    }
    if (typeof raw.pauseHidden === 'boolean') {
      fleetSettings.pauseHidden = raw.pauseHidden;
    }
  } catch (e) {}
  const selI = document.getElementById('fleet-interval-select');
  const selH = document.getElementById('fleet-hidden-select');
  if (selI) selI.value = String(fleetSettings.intervalMs);
  if (selH) selH.value = fleetSettings.pauseHidden ? 'on' : 'off';
}

function saveFleetSettings() {
  const selI = document.getElementById('fleet-interval-select');
  const selH = document.getElementById('fleet-hidden-select');
  if (selI) fleetSettings.intervalMs = parseInt(selI.value, 10) || 5000;
  if (selH) fleetSettings.pauseHidden = selH.value === 'on';
  try {
    localStorage.setItem(FLEET_SETTINGS_KEY, JSON.stringify(fleetSettings));
  } catch (e) {}
  restartFleetTimer();
  // 間隔を短くした場合は即時更新
  if (currentTab === 'fleet' && !(fleetSettings.pauseHidden && document.hidden)) {
    loadFleetPins();
  }
}

function restartFleetTimer() {
  if (fleetTimer) clearInterval(fleetTimer);
  fleetTimer = setInterval(() => {
    if (currentTab !== 'fleet') return;
    if (fleetSettings.pauseHidden && document.hidden) return;
    loadFleetPins();
  }, fleetSettings.intervalMs);
}

async function loadFleetPage() {
  loadFleetPins();
  if (fleetNodes.length) renderFleetDetect();
}

async function loadFleetPins() {
  const container = document.getElementById('fleet-pinned-container');
  try {
    const resp = await fetch('/api/fleet/pins', { cache: 'no-store' });
    const data = await resp.json();
    renderFleetPinned(data.pins || []);
  } catch (e) {
    container.innerHTML = `<p class="muted text-danger">ピン留め情報の取得エラー: ${escapeHtml(e.message)}</p>`;
  }
}

function renderFleetPinned(pins) {
  const container = document.getElementById('fleet-pinned-container');
  if (!pins.length) {
    container.innerHTML = '<p class="muted">ピン留めされたserv-UIはありません。「serv-UI自動検出」で検出したサーバーをピン留めすると、ここに固定表示されます。</p>';
    return;
  }
  container.innerHTML = `<div class="stats-grid">${pins.map(n => renderFleetCard(n)).join('')}</div>`;
}

function renderFleetCard(n) {
  const name = n.hostname || n.key;
  const selfBadge = n.is_self ? '<span class="badge badge-active" style="font-size:0.62rem;">このPC</span>' : '';
  const offBadge = n.reachable ? '' : '<span class="badge badge-warn" style="font-size:0.62rem;">応答なし</span>';

  let body;
  if (n.reachable && n.info) {
    const inf = n.info;
    const tempTxt = (inf.cpu_temp !== null && inf.cpu_temp !== undefined) ? `${inf.cpu_temp}°C` : '--';
    body =
      fleetMetricRow('CPU使用率・温度', inf.cpu_percent, tempTxt) +
      fleetMetricRow('メモリ使用率', inf.mem_percent, `${fmtGiB(inf.mem_used)} / ${fmtGiB(inf.mem_total)}`) +
      fleetMetricRow('ディスク使用量', inf.disk_percent, `${fmtGiB(inf.disk_used)} / ${fmtGiB(inf.disk_total)}`);
  } else {
    body = '<div class="muted" style="font-size:0.78rem;padding:0.4rem 0;">serv-UIに接続できませんでした。</div>';
  }

  return `
    <div class="stat-card fleet-card${n.reachable ? '' : ' fleet-offline'}">
      <div class="fleet-card-head">
        <div class="wifi-ssid-cell">
          <svg class="icon-pin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"/></svg>
          <a class="fleet-host-link" href="${escapeHtml(n.url || '#')}" target="_blank" rel="noopener" title="新しいタブで開く">${escapeHtml(name)}</a>
          ${selfBadge}${offBadge}
        </div>
        <button class="btn btn-sm btn-secondary" onclick="unpinFleetNode('${escapeJs(n.key)}')" title="ピン留めを解除">解除</button>
      </div>
      ${body}
    </div>`;
}

function fleetMetricRow(label, pct, detail) {
  const p = (typeof pct === 'number') ? Math.round(pct) : null;
  const barClass = p === null ? '' : p > 80 ? 'danger' : p > 60 ? 'warn' : '';
  return `
    <div class="fleet-metric">
      <div class="fleet-metric-label">
        <span>${label}</span>
        <span><span class="fleet-metric-val">${p === null ? '--' : p + '%'}</span> <span class="fleet-metric-detail">${escapeHtml(detail || '')}</span></span>
      </div>
      <div class="stat-bar"><div class="stat-bar-fill ${barClass}" style="width:${p === null ? 0 : p}%;"></div></div>
    </div>`;
}

function fmtGiB(bytes) {
  if (bytes === null || bytes === undefined) return '--';
  const g = bytes / 1073741824;
  return g >= 1024 ? (g / 1024).toFixed(1) + ' TB' : g.toFixed(1) + ' GB';
}

async function detectFleet() {
  if (fleetDetectLoading) return;
  const btn = document.getElementById('btn-fleet-detect');
  const container = document.getElementById('fleet-detect-container');
  fleetDetectLoading = true;
  btn.disabled = true;
  container.innerHTML = '<p class="muted"><span class="spinner"></span> Tailnet内のserv-UIを検出中... (ノード数によっては時間がかかります)</p>';
  try {
    const resp = await fetch('/api/fleet/detect', { cache: 'no-store' });
    const data = await resp.json();
    if (!resp.ok || data.success === false) throw new Error(data.error || `HTTP ${resp.status}`);
    fleetNodes = data.nodes || [];
    renderFleetDetect();
    showStatus(`稼働中のserv-UIを${data.count}件検出しました`, data.count ? 'success' : 'info');
  } catch (e) {
    container.innerHTML = `<p class="muted text-danger">検出エラー: ${escapeHtml(e.message)}</p>`;
  } finally {
    fleetDetectLoading = false;
    btn.disabled = false;
  }
}

function renderFleetDetect() {
  const container = document.getElementById('fleet-detect-container');
  if (!fleetNodes.length) {
    container.innerHTML = '<p class="muted">Tailnet内に稼働中のserv-UIは見つかりませんでした。</p>';
    return;
  }
  const rows = fleetNodes.map((n, i) => {
    const inf = n.info || {};
    const pinBtn = n.pinned
      ? `<button class="btn btn-sm btn-secondary" onclick="unpinFleetNode('${escapeJs(n.key)}')">解除</button>`
      : `<button class="btn btn-sm btn-primary" onclick="pinFleetNode(${i})">ピン留め</button>`;
    const st = n.reachable
      ? '<span class="badge badge-active">稼働中</span>'
      : '<span class="badge badge-other">応答なし</span>';
    let cpu = '--', mem = '--', disk = '--';
    if (n.reachable) {
      cpu = (inf.cpu_percent === null || inf.cpu_percent === undefined) ? '--'
        : `${Math.round(inf.cpu_percent)}%${(inf.cpu_temp !== null && inf.cpu_temp !== undefined) ? ` / ${inf.cpu_temp}°C` : ''}`;
      mem = (inf.mem_percent === null || inf.mem_percent === undefined) ? '--'
        : `${Math.round(inf.mem_percent)}% (${fmtGiB(inf.mem_used)} / ${fmtGiB(inf.mem_total)})`;
      disk = (inf.disk_percent === null || inf.disk_percent === undefined) ? '--'
        : `${Math.round(inf.disk_percent)}% (${fmtGiB(inf.disk_used)} / ${fmtGiB(inf.disk_total)})`;
    }
    return `
      <tr>
        <td>
          <a class="fleet-host-link" href="${escapeHtml(n.url || '#')}" target="_blank" rel="noopener" title="新しいタブで開く">${escapeHtml(n.hostname)}</a>
          ${n.is_self ? '<span class="badge badge-other" style="font-size:0.62rem;margin-left:0.3rem;">このPC</span>' : ''}
        </td>
        <td>${st}</td>
        <td>${cpu}</td>
        <td>${mem}</td>
        <td>${disk}</td>
        <td>${pinBtn}</td>
      </tr>`;
  }).join('');
  container.innerHTML = `
    <table class="proc-table">
      <thead>
        <tr><th>ホスト名</th><th>状態</th><th>CPU使用率・温度</th><th>メモリ使用率</th><th>ディスク使用量</th><th>操作</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

async function pinFleetNode(idx) {
  const n = fleetNodes[idx];
  if (!n) return;
  try {
    const resp = await fetch('/api/fleet/pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: n.key, fqdn: n.fqdn, hostname: n.hostname, ips: n.ips }),
    });
    const data = await resp.json();
    showStatus(data.message || 'ピン留めしました', data.success !== false ? 'success' : 'error');
  } catch (e) {
    showStatus(`エラー: ${e.message}`, 'error');
  }
  refreshFleetView();
}

async function unpinFleetNode(key) {
  try {
    const resp = await fetch('/api/fleet/unpin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    const data = await resp.json();
    showStatus(data.message || 'ピン留めを解除しました', data.success !== false ? 'success' : 'error');
  } catch (e) {
    showStatus(`エラー: ${e.message}`, 'error');
  }
  refreshFleetView();
}

function refreshFleetView() {
  const dn = key => fleetNodes.find(n => n.key === key);
  fetch('/api/fleet/pins', { cache: 'no-store' })
    .then(r => r.json())
    .then(data => {
      const pinnedKeys = new Set((data.pins || []).map(p => p.key));
      fleetNodes.forEach(n => { n.pinned = pinnedKeys.has(n.key); });
      renderFleetDetect();
    })
    .catch(() => {});
  loadFleetPins();
}

// --- Init ---
document.addEventListener('DOMContentLoaded', () => {
  loadDashboard();
  loadFleetSettings();
  restartFleetTimer();

  // 非表示中の更新を停止している場合、再表示したタイミングで即時更新
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && currentTab === 'fleet' && fleetSettings.pauseHidden) {
      loadFleetPins();
    }
  });

  refreshInterval = setInterval(() => {
    if (currentTab === 'dashboard') loadDashboard();
  }, 5000);
});

