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
const EXTERNAL_TABS = new Set(['selfex', 'selfcode', 'easylxd', 'vmmanager', 'diskmanager']);
document.querySelectorAll('.nav-links li').forEach(li => {
  li.addEventListener('click', () => {
    // 外部ツールは別タブ/別画面で開くのみで、コンテンツ切替は行わない
    if (EXTERNAL_TABS.has(li.dataset.tab)) return;
    switchTab(li.dataset.tab);
  });
});

function switchTab(tab) {
  if (EXTERNAL_TABS.has(tab)) return;
  const target = document.getElementById(`tab-${tab}`);
  if (!target) return;
  currentTab = tab;
  document.querySelectorAll('.nav-links li').forEach(l => l.classList.toggle('active', l.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.toggle('active', t.id === `tab-${tab}`));

  // Load data for the tab
  if (tab === 'dashboard') loadDashboard();
  else if (tab === 'services') loadServices();
  else if (tab === 'packages') {} // Don't auto-check
  else if (tab === 'ports') {} // Don't auto-scan
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
  } else if (tab === 'timeshift') {
    loadTimeshiftPage();
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
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    if (!data || !data.cpu || !data.memory || !data.disk) throw new Error('invalid system info');

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

// --- Ports ---
async function scanPorts() {
  const container = document.getElementById('ports-list-container');
  container.innerHTML = '<p class="muted">スキャン中...</p>';
  try {
    const resp = await fetch('/api/ports/listen');
    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      container.innerHTML = `<p class="muted">サーバーエラー (${resp.status}): ${escapeHtml(text.slice(0, 200))}</p>`;
      return;
    }
    window._allPorts = data.ports;
    window._portIps = data.ips || [];
    renderIps(window._portIps);
    renderPorts(data.ports || []);
    if (data.error) {
      showStatus(`検出時に問題が発生しました: ${data.error}`, 'error');
    } else if (!resp.ok || !Array.isArray(data.ports)) {
      document.getElementById('ports-list-container').innerHTML =
        `<p class="muted">応答が不正です (HTTP ${resp.status})。serv-UIの再起動が必要な可能性があります。</p>`;
    }
  } catch (e) {
    container.innerHTML = `<p class="muted">エラー: ${escapeHtml(e.message)}</p>`;
  }
}

function renderIps(ips) {
  if (!ips || !ips.length) return;
  const labels = { enp: 'LAN', tailscale: 'Tailscale' };
  const items = ips.map(ip => {
    const label = Object.keys(labels).find(k => ip.iface.startsWith(k));
    return `${label ? labels[label] : ip.iface}: ${ip.address}`;
  });
  document.getElementById('ports-status').innerHTML =
    `<span class="badge badge-active">IPアドレス</span> ${items.map(escapeHtml).join(' / ')}`;
}

function ifaceLabel(iface) {
  if (iface.startsWith('tailscale')) return 'Tailscale';
  if (iface.startsWith('enp') || iface.startsWith('eth') || iface.startsWith('ens')) return 'LAN';
  return iface;
}

function addressLabel(address) {
  const ip = window._portIps.find(i => i.address === address);
  if (ip) return ifaceLabel(ip.iface);
  if (address.startsWith('fd7a:115c:a1e0')) return 'Tailscale';
  return null;
}

function renderPorts(ports) {
  const tbody = ports.map(p => {
    const proc = p.processes.length
      ? `${p.processes.map(escapeHtml).join(', ')} <span class="muted">(PID ${p.pids.join(', ')})</span>`
      : '<span class="muted">-</span>';
    let access;
    if (p.access === 'all') {
      access = '<span class="badge badge-active">✅ 可能</span>';
    } else if (p.access === 'limited') {
      const label = addressLabel(p.address);
      access = label
        ? `<span class="badge badge-other" title="${escapeHtml(p.address)}">⚠️ ${escapeHtml(label)}経由のみ</span>`
        : `<span class="badge badge-other" title="${escapeHtml(p.address)}">⚠️ ${escapeHtml(p.address)} 経由のみ</span>`;
    } else {
      access = '<span class="badge badge-inactive">❌ ローカルのみ</span>';
    }
    return `
      <tr>
        <td>${p.port}<span class="muted">/${p.proto}</span></td>
        <td>${escapeHtml(p.address)}</td>
        <td>${proc}</td>
        <td>${access}</td>
      </tr>
    `;
  }).join('');
  document.getElementById('ports-list-container').innerHTML = `
    <table class="proc-table">
      <thead>
        <tr><th>ポート</th><th>バインドアドレス</th><th>プロセス</th><th>LANアクセス</th></tr>
      </thead>
      <tbody>${tbody || '<tr><td colspan="4" class="muted">リッスン中のサービスはありません。</td></tr>'}</tbody>
    </table>
  `;
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
        <td><span class="badge ${badgeClass}">${escapeHtml(s.active)}</span></td>
        <td>${escapeHtml(s.sub)}</td>
        <td>
          <div class="btn-group">
            <button class="btn btn-sm btn-success" onclick="serviceAction('${escapeJs(s.name)}','start')" title="開始"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg></button>
            <button class="btn btn-sm btn-danger" onclick="serviceAction('${escapeJs(s.name)}','stop')" title="停止"><svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg></button>
            <button class="btn btn-sm btn-primary" onclick="serviceAction('${escapeJs(s.name)}','restart')" title="再起動"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg></button>
            <button class="btn btn-sm btn-secondary" onclick="serviceDetail('${escapeJs(s.name)}')" title="詳細"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg></button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function filterServices() {
  const _sq = document.getElementById('service-search');
  const q = (_sq && _sq.value ? _sq.value : '').toLowerCase();
  if (!Array.isArray(window._allServices)) return;
  const filtered = window._allServices.filter(s =>
    String(s.name || '').toLowerCase().includes(q)
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
          <button class="btn btn-sm btn-primary" onclick="upgradePackage('${escapeJs(p.name)}')">更新</button>
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

  if (!window._servuiTermResizeBound) {
    window._servuiTermResizeBound = true;
    window.addEventListener('resize', () => {
      if (fitAddon) { try { fitAddon.fit(); } catch (e) {} }
    });
  }
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
            const jsSSID = escapeJs(net.ssid);
            const safeBSSID = escapeHtml(net.bssid || '');
            const safeSec = escapeHtml(net.security);
            const jsSec = escapeJs(net.security);
            const jsBSSID = escapeJs(net.bssid || '');
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
                    <button class="btn btn-sm btn-danger" onclick="disconnectWifi('${jsSSID}')">切断</button>
                  ` : `
                    <button class="btn btn-sm btn-primary" onclick="openWifiConnect('${jsSSID}', '${jsSec}', '${jsBSSID}')">接続</button>
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

// --- Disks (表示専用: Disk Manager「パーティション操作」と同構成。操作は Disk Manager で行う) ---
const DISK_FS_COLORS = {
  ext4: '#16a34a', btrfs: '#0e7490', xfs: '#65a30d', ntfs: '#2563eb',
  vfat: '#eab308', exfat: '#f97316', fat32: '#eab308', fat16: '#eab308',
  swap: '#a855f7', '': '#64748b'
};

function diskFsColor(fstype) {
  fstype = (fstype || '').toLowerCase();
  return DISK_FS_COLORS[fstype] || '#0891b2';
}

function diskSegTitle(p) {
  return p.path + ' ' + p.size + (p.fstype ? ' [' + p.fstype + ']' : '') +
    (p.used ? ' 使用中' + p.used : '') + (p.mountpoint ? ' mounted:' + p.mountpoint : '');
}

async function loadDisks() {
  const container = document.getElementById('disks-container');
  const statusMsg = document.getElementById('disk-status-msg');
  container.innerHTML = '<p class="muted"><span class="spinner"></span> ディスク情報を取得中...</p>';
  statusMsg.className = 'status-msg';

  try {
    const resp = await fetch('/api/disks/info');
    const data = await resp.json();
    const devices = data.devices || [];

    if (devices.length === 0) {
      statusMsg.className = 'status-msg show info';
      statusMsg.textContent = 'ディスクデバイスが検出されませんでした。';
      container.innerHTML = '';
      document.getElementById('disk-legend').innerHTML = '';
      return;
    }

    buildDiskLegend(devices);
    container.innerHTML = devices.map(renderDiskInfo).join('');

  } catch (e) {
    statusMsg.className = 'status-msg show error';
    statusMsg.textContent = `ディスク情報取得エラー: ${e.message}`;
    container.innerHTML = '';
  }
}

function buildDiskLegend(devices) {
  const seen = {};
  devices.forEach(d => (d.partitions || []).forEach(p => { seen[(p.fstype || '').toLowerCase()] = true; }));
  const items = Object.keys(seen).map(f =>
    '<span><span class="disk-sw" style="background:' + diskFsColor(f) + '"></span>' + escapeHtml(f || '不明') + '</span>').join('') +
    '<span><span class="disk-sw disk-sw-free"></span>空き領域</span>' +
    '<span class="muted">■ 内側の暗い部分は使用中容量（参考値）</span>';
  document.getElementById('disk-legend').innerHTML = items;
}

function renderDiskInfo(d) {
  const sysBadge = d.is_system ? '<span class="disk-sys-badge">システム</span>' : '';
  const tableLabel = d.needs_init ? 'なし（未初期化）' : (d.table || '不明');
  const head = '<div class="disk-dev-path">' + escapeHtml(d.path) + ' — ' + escapeHtml(d.size) + ' [' + escapeHtml(tableLabel) + ']' + sysBadge + '</div>' +
    '<div class="disk-dev-meta">モデル: ' + escapeHtml(d.model || '-') + ' / シリアル: <span class="disk-serial">' + escapeHtml(d.serial || '-') + '</span> / 接続: ' + escapeHtml(d.tran || '不明') + '</div>';

  if (d.needs_init && !d.is_system) {
    const bar = '<div class="disk-pbar"><div class="disk-seg disk-free" style="width:100%" title="未初期化領域 ' + escapeHtml(d.size) + '">' +
      '<div class="disk-seg-label">未初期化 ' + escapeHtml(d.size) + '</div></div></div>';
    const rows = '<tr><td>未初期化領域</td><td>' + escapeHtml(d.size) + '</td><td>-</td><td>-</td><td>-</td><td>-</td></tr>';
    return '<div class="disk-dev">' + head +
      '<div class="muted" style="margin-top:8px">パーティションテーブルがありません。初期化・作成は Disk Manager で行ってください。</div>' +
      bar +
      '<table class="disk-part-table"><tr><th>パーティション</th><th>容量</th><th>FS</th><th>使用率</th><th>ラベル</th><th>マウント</th></tr>' + rows + '</table></div>';
  }

  const total = d.size_bytes || 1;
  const items = [];
  (d.partitions || []).forEach(p => items.push({ kind: 'part', start: p.start_bytes || 0, bytes: p.size_bytes || 0, p: p }));
  (d.free_spaces || []).forEach(f => items.push({ kind: 'free', start: f.start_bytes || 0, bytes: f.size_bytes || 0, f: f }));
  items.sort((a, b) => a.start - b.start);

  let bar = '<div class="disk-pbar">';
  items.forEach(it => {
    const pct = Math.max(0.6, it.bytes / total * 100);
    if (it.kind === 'part') {
      const p = it.p;
      let usePct = 0;
      if (p.used_bytes && p.size_bytes) usePct = Math.min(100, p.used_bytes / p.size_bytes * 100);
      const short = p.path.replace(d.path, '').replace('/dev/', '') || p.path;
      bar += '<div class="disk-seg" style="width:' + pct + '%;background:' + diskFsColor(p.fstype) + '" title="' + escapeHtml(diskSegTitle(p)) + '">' +
        (usePct ? '<div class="disk-used" style="width:' + usePct + '%"></div>' : '') +
        '<div class="disk-seg-label">' + escapeHtml(short) + '</div></div>';
    } else {
      const f = it.f;
      bar += '<div class="disk-seg disk-free" style="width:' + pct + '%" title="空き領域 ' + escapeHtml(f.size) + '">' +
        '<div class="disk-seg-label">空き ' + escapeHtml(f.size) + '</div></div>';
    }
  });
  bar += '</div>';

  const rows = (d.partitions || []).map(p => {
    let usePct = 0, useTxt = '-';
    if (p.used_bytes && p.size_bytes) {
      usePct = Math.min(100, p.used_bytes / p.size_bytes * 100);
      useTxt = p.use_percent || (usePct.toFixed(0) + '%');
    } else if (p.size_bytes) {
      useTxt = p.use_percent || '-';
    }
    const ubar = '<div class="disk-ubar"><div style="width:' + usePct + '%"></div></div>';
    return '<tr>' +
      '<td>' + escapeHtml(p.path) + '</td><td>' + escapeHtml(p.size) + '</td><td>' + escapeHtml(p.fstype || '-') + '</td>' +
      '<td>' + escapeHtml(useTxt) + '<br>' + ubar + '</td>' +
      '<td>' + escapeHtml(p.label || p.partlabel || '-') + '</td><td>' + escapeHtml(p.mountpoint || '-') + '</td></tr>';
  }).join('') + (d.free_spaces || []).map(f =>
    '<tr><td>空き領域</td><td>' + escapeHtml(f.size) + '</td><td>-</td><td>-</td><td>-</td><td>-</td></tr>'
  ).join('');

  return '<div class="disk-dev">' + head + bar +
    '<table class="disk-part-table"><tr><th>パーティション</th><th>容量</th><th>FS</th><th>使用率</th><th>ラベル</th><th>マウント</th></tr>' +
    (rows || '<tr><td colspan="6">パーティション情報がありません</td></tr>') + '</table></div>';
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
  loadUbuntuVersions();
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
            <input type="text" class="grub-iso-vmlinuz" data-idx="${i}" value="${escapeAttr(iso.vmlinuz)}" placeholder="/casper/vmlinuz" style="width:150px;padding:0.25rem 0.4rem;background:var(--bg-base);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);">
            <input type="text" class="grub-iso-initrd" data-idx="${i}" value="${escapeAttr(iso.initrd)}" placeholder="/casper/initrd" style="width:150px;padding:0.25rem 0.4rem;background:var(--bg-base);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);">
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
    const ubuntuFileSel = document.getElementById('ubuntu-file-select');
    const ubuntuFileBtn = document.getElementById('btn-ubuntu-files');
    if (ubuntuFileSel) ubuntuFileSel.disabled = false;
    if (ubuntuFileBtn) ubuntuFileBtn.disabled = false;
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

async function loadUbuntuVersions() {
  const sel = document.getElementById('ubuntu-version-select');
  const fileBtn = document.getElementById('btn-ubuntu-files');
  if (!sel) return;
  try {
    const resp = await fetch('/api/grub/ubuntu-versions');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    sel.innerHTML = data.versions.map(v =>
      `<option value="${escapeAttr(v.name)}">${escapeHtml(v.display)}</option>`
    ).join('') || '<option value="">バージョンがありません</option>';
    sel.disabled = false;
    fileBtn.disabled = false;
  } catch (e) {
    sel.innerHTML = '<option value="">バージョン一覧の取得に失敗しました</option>';
    document.getElementById('grub-iso-dl-status').className = 'status-msg show error';
    document.getElementById('grub-iso-dl-status').textContent = `Ubuntuバージョン取得エラー: ${e.message}`;
  }
}

async function loadUbuntuFiles() {
  const version = document.getElementById('ubuntu-version-select').value;
  const fileSel = document.getElementById('ubuntu-file-select');
  const dlBtn = document.getElementById('btn-grub-iso-dl');
  if (!version || !fileSel) return;
  fileSel.innerHTML = '<option value="">読み込み中...</option>';
  fileSel.disabled = true;
  dlBtn.disabled = true;
  try {
    const resp = await fetch(`/api/grub/ubuntu-files?version=${encodeURIComponent(version)}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    fileSel.innerHTML = data.files.map(f =>
      `<option value="${escapeAttr(f.download_url)}" data-filename="${escapeAttr(f.name)}">${escapeHtml(f.name)}</option>`
    ).join('') || '<option value="">ISOファイルがありません</option>';
    fileSel.disabled = false;
    dlBtn.disabled = false;
  } catch (e) {
    fileSel.innerHTML = '<option value="">ファイル一覧の取得に失敗しました</option>';
    document.getElementById('grub-iso-dl-status').className = 'status-msg show error';
    document.getElementById('grub-iso-dl-status').textContent = `Ubuntuファイル取得エラー: ${e.message}`;
  }
}

async function downloadUbuntuIso() {
  const fileSel = document.getElementById('ubuntu-file-select');
  const input = document.getElementById('grub-iso-dl-url');
  const statusEl = document.getElementById('grub-iso-dl-status');
  const btn = document.getElementById('btn-grub-iso-dl');
  let url = '';
  if (fileSel && fileSel.value && !fileSel.disabled) {
    url = fileSel.value;
  } else if (input && input.value.trim()) {
    url = input.value.trim();
  }
  if (!url) {
    statusEl.className = 'status-msg show error';
    statusEl.textContent = 'ISOファイルを選択するか、URLを入力してください';
    return;
  }
  btn.disabled = true;
  if (fileSel) fileSel.disabled = true;
  const fileBtn = document.getElementById('btn-ubuntu-files');
  if (fileBtn) fileBtn.disabled = true;
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
      if (fileSel) fileSel.disabled = false;
      if (fileBtn) fileBtn.disabled = false;
      return;
    }
    if (input) input.value = '';
    stopIsoDlPolling();
    pollIsoDownloadStatus();
    isoDlPollTimer = setInterval(pollIsoDownloadStatus, 1000);
  } catch (e) {
    statusEl.className = 'status-msg show error';
    statusEl.textContent = `エラー: ${e.message}`;
    btn.disabled = false;
    if (fileSel) fileSel.disabled = false;
    if (fileBtn) fileBtn.disabled = false;
  }
}

// --- Helpers ---
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeJs(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/</g, '\\x3c').replace(/>/g, '\\x3e');
}

function escapeAttr(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function showStatus(msg, type) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.style.position = 'fixed';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.className = `status-msg show ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// --- selfEx ---
async function openSelfEx() {
  let resp;
  try {
    resp = await fetch('/api/selfex/status');
  } catch (e) {
    showStatus(`selfEx確認エラー: ${e.message}`, 'error');
    return;
  }

  // 旧serv-UI（本API未搭載）で稼働中の場合は404になる。
  // そのままでは data.installed が undefined で「未インストール」扱いになり
  // 誤ってインストール誘導してしまうため、再起動案内に留めて抜ける。
  if (!resp.ok) {
    if (resp.status === 404) {
      showStatus('selfEx連携にはserv-UIの再起動が必要です。サイドバーの「serv-UI再起動」を押してから再度お試しください。', 'error');
    } else {
      showStatus(`selfEx確認エラー: HTTP ${resp.status}`, 'error');
    }
    return;
  }

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    showStatus(`selfEx確認エラー: ${e.message}`, 'error');
    return;
  }

  // active が undefined の旧バックエンドでは従来通り開く（楽観的に扱う）
  const isActive = data.active !== false;
  if (data.installed && isActive && data.url) {
    window.open(data.url, '_blank');
  } else if (data.installed && data.url) {
    switchTab('terminal');
    showStatus('selfExはインストール済みですが、サービスが停止しています。`sudo systemctl start selfex` で起動できます。', 'info');
  } else if (data.installed) {
    switchTab('terminal');
    showStatus('selfExはインストール済みです。URLを取得できませんでした。', 'info');
  } else {
    if (!confirm('selfExはまだインストールされていません。\nインストールしますか？')) return;
    switchTab('terminal');
    showStatus('selfExをインストール中... ターミナルで進捗を確認できます。', 'info');
    setTimeout(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        const installCmd = 'sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/hirogura/selfex/main/install-selfex1.sh)"\n';
        ws.send(JSON.stringify({ type: 'input', data: installCmd }));
      } else {
        showStatus('ターミナルに接続できません', 'error');
      }
    }, 500);
  }
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

// --- Disk Manager ---
async function openDiskManager() {
  let resp;
  try {
    resp = await fetch('/api/diskmanager/status');
  } catch (e) {
    showStatus(`Disk Manager確認エラー: ${e.message}`, 'error');
    return;
  }

  // 旧serv-UI（本API未搭載）で稼働中の場合は404になる。
  // そのままでは data.installed が undefined で「未インストール」扱いになり
  // 誤ってインストール誘導してしまうため、再起動案内に留めて抜ける。
  if (!resp.ok) {
    if (resp.status === 404) {
      showStatus('Disk Manager連携にはserv-UIの再起動が必要です。サイドバーの「serv-UI再起動」を押してから再度お試しください。', 'error');
    } else {
      showStatus(`Disk Manager確認エラー: HTTP ${resp.status}`, 'error');
    }
    return;
  }

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    showStatus(`Disk Manager確認エラー: ${e.message}`, 'error');
    return;
  }

  if (data.installed) {
    // Tailscale DNS取得失敗などでURLが無い場合も、要件通り別タブで開く。
    // Tailnet経由アクセス時は https、localhostアクセス時は http が正しい。
    const host = location.hostname;
    const fallbackUrl = (host === 'localhost' || host === '127.0.0.1')
      ? `http://${host}:3361/`
      : `https://${host}:3361/`;
    window.open(data.url || fallbackUrl, '_blank');
  } else {
    if (!confirm('Disk Managerはまだインストールされていません。\nインストールしますか？')) return;
    switchTab('terminal');
    showStatus('Disk Managerをインストール中... ターミナルで進捗を確認できます。', 'info');
    setTimeout(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        const installCmd = 'sudo wget -O /tmp/diskmanager-install.sh https://raw.githubusercontent.com/hirogura/diskmanager/main/install.sh && sudo bash /tmp/diskmanager-install.sh\n';
        ws.send(JSON.stringify({ type: 'input', data: installCmd }));
      } else {
        showStatus('ターミナルに接続できません', 'error');
      }
    }, 500);
  }
}

// --- Backup / Restore ---
let backupStatusData = null;

// --- Clonezilla ISO Download ---
let czDlPollTimer = null;

function stopCzDlPolling() {
  if (czDlPollTimer) {
    clearInterval(czDlPollTimer);
    czDlPollTimer = null;
  }
}

async function loadClonezillaVersions() {
  const sel = document.getElementById('cz-version-select');
  const fileBtn = document.getElementById('btn-cz-files');
  try {
    const resp = await fetch('/api/backup/clonezilla-versions');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    sel.innerHTML = data.versions.map(v =>
      `<option value="${escapeAttr(v.name)}">${escapeHtml(v.name)}</option>`
    ).join('') || '<option value="">バージョンがありません</option>';
    sel.disabled = false;
    fileBtn.disabled = false;
  } catch (e) {
    sel.innerHTML = '<option value="">バージョン一覧の取得に失敗しました</option>';
    showBackupStatus(`Clonezillaバージョン取得エラー: ${e.message}`, 'error');
  }
}

async function loadClonezillaFiles() {
  const version = document.getElementById('cz-version-select').value;
  const fileSel = document.getElementById('cz-file-select');
  const dlBtn = document.getElementById('btn-cz-dl');
  if (!version) return;
  fileSel.innerHTML = '<option value="">読み込み中...</option>';
  fileSel.disabled = true;
  dlBtn.disabled = true;
  try {
    const resp = await fetch(`/api/backup/clonezilla-files?version=${encodeURIComponent(version)}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    fileSel.innerHTML = data.files.map(f =>
      `<option value="${escapeAttr(f.download_url)}" data-filename="${escapeAttr(f.name)}">${escapeHtml(f.name)}</option>`
    ).join('') || '<option value="">ISOファイルがありません</option>';
    fileSel.disabled = false;
    dlBtn.disabled = false;
  } catch (e) {
    fileSel.innerHTML = '<option value="">ファイル一覧の取得に失敗しました</option>';
    showBackupStatus(`Clonezillaファイル取得エラー: ${e.message}`, 'error');
  }
}

async function pollCzDownloadStatus() {
  const statusEl = document.getElementById('cz-dl-status');
  const progress = document.getElementById('cz-dl-progress');
  const bar = document.getElementById('cz-dl-progress-bar');
  const text = document.getElementById('cz-dl-progress-text');
  const dlBtn = document.getElementById('btn-cz-dl');
  const cancelBtn = document.getElementById('btn-cz-dl-cancel');
  let s;
  try {
    const resp = await fetch('/api/grub/iso-download/status');
    s = await resp.json();
  } catch (e) {
    return;
  }
  if (s.running) {
    dlBtn.disabled = true;
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
  stopCzDlPolling();
  progress.style.display = 'none';
  cancelBtn.disabled = true;
  if (s.success === true || s.success === false) {
    dlBtn.disabled = false;
    document.getElementById('cz-file-select').disabled = false;
    document.getElementById('btn-cz-files').disabled = false;
    if (s.success) {
      statusEl.className = 'status-msg show success';
      statusEl.textContent = `${s.filename} を /iso に保存しました（${formatBytesJS(s.size)}）`;
      loadBackupStatus();
    } else if (s.cancelled) {
      statusEl.className = 'status-msg show error';
      statusEl.textContent = 'ダウンロードをキャンセルしました';
    } else {
      statusEl.className = 'status-msg show error';
      statusEl.textContent = `ダウンロード失敗: ${s.log || '不明なエラー'}`;
    }
  }
}

async function downloadClonezillaIso() {
  const fileSel = document.getElementById('cz-file-select');
  const statusEl = document.getElementById('cz-dl-status');
  const dlBtn = document.getElementById('btn-cz-dl');
  const opt = fileSel.options[fileSel.selectedIndex];
  const url = fileSel.value;
  const filename = opt ? opt.dataset.filename : '';
  if (!url || !filename) {
    statusEl.className = 'status-msg show error';
    statusEl.textContent = 'ISOファイルを選択してください';
    return;
  }
  dlBtn.disabled = true;
  fileSel.disabled = true;
  document.getElementById('btn-cz-files').disabled = true;
  statusEl.className = 'status-msg show info';
  statusEl.innerHTML = '<span class="spinner"></span> ダウンロードを開始しています...';
  try {
    const resp = await fetch('/api/backup/clonezilla-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, filename }),
    });
    const data = await resp.json();
    if (!data.success) {
      statusEl.className = 'status-msg show error';
      statusEl.textContent = data.message;
      dlBtn.disabled = false;
      fileSel.disabled = false;
      document.getElementById('btn-cz-files').disabled = false;
      return;
    }
    stopCzDlPolling();
    pollCzDownloadStatus();
    czDlPollTimer = setInterval(pollCzDownloadStatus, 1000);
  } catch (e) {
    statusEl.className = 'status-msg show error';
    statusEl.textContent = `エラー: ${e.message}`;
    dlBtn.disabled = false;
    fileSel.disabled = false;
    document.getElementById('btn-cz-files').disabled = false;
  }
}

async function cancelClonezillaDownload() {
  if (!confirm('ダウンロードをキャンセルしますか？\n保存中の部分ファイルは削除されます。')) return;
  document.getElementById('btn-cz-dl-cancel').disabled = true;
  try {
    await fetch('/api/grub/iso-download/cancel', { method: 'POST' });
  } catch (e) {}
  pollCzDownloadStatus();
}

function syncCzDownloadStatus() {
  fetch('/api/grub/iso-download/status')
    .then(r => r.json())
    .then(s => {
      if (s.running && !czDlPollTimer) {
        stopCzDlPolling();
        pollCzDownloadStatus();
        czDlPollTimer = setInterval(pollCzDownloadStatus, 1000);
      }
    })
    .catch(() => {});
}

async function loadBackupPage() {
  loadBackupStatus();
  loadBackupPartitions();
  loadClonezillaVersions();
  syncCzDownloadStatus();
}

function setBackupControlsEnabled(enabled) {
  ['backup-dest-select', 'btn-backup-run', 'restore-src-select', 'btn-restore-scan', 'restore-img-select', 'btn-restore-run'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !enabled;
  });
}

async function loadBackupStatus() {
  const envEl = document.getElementById('backup-env-status');
  try {
    const resp = await fetch('/api/backup/status');
    backupStatusData = await resp.json();
    const d = backupStatusData;

    let html =
      `<div>Clonezilla ISO: ${d.iso_found
        ? `<span class="text-success">検出</span> (${escapeHtml(d.iso_path || '?')})`
        : `<span class="text-danger">見つかりません</span> (/iso/${'clonezilla-live-*.iso'})`}</div>` +
      `<div>保存用パーティション (/iso): ${d.iso_mounted
        ? `<span class="text-success">マウント済み</span> (${escapeHtml(d.iso_source || '?')}${d.iso_fstype ? ', ' + escapeHtml(d.iso_fstype) : ''}${d.iso_size ? ', ' + escapeHtml(d.iso_size) : ''})`
        : '<span class="text-warn">未マウント</span>'}</div>`;
    if (d.secure_boot) {
      html += `<div class="text-warn" style="margin-top:0.3rem;">⚠ Secure Boot が有効です。ISOループバックブートは起動できないため、無効化してください。</div>`;
    }
    if (!d.grub_saved) {
      html += `<div class="muted" style="margin-top:0.3rem;">注: 初回実行時に GRUB_DEFAULT=saved へ自動変更されます（update-grub が追加で走ります）。</div>`;
    }
    if (!d.iso_found || !d.iso_mounted) {
      html += `<div class="text-warn" style="margin-top:0.3rem;">${!d.iso_mounted
        ? '/iso に保存用パーティションをマウントしてください。'
        : `${escapeHtml('/iso')} に clonezilla-live-*.iso を配置してください。`}</div>`;
    }
    envEl.innerHTML = html;
    setBackupControlsEnabled(d.iso_found && d.iso_mounted);
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
      return `<option value="${escapeAttr(p.device)}">${escapeHtml(label)}</option>`;
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
  if (infoMsg) showStatus(infoMsg, 'info');
  const startTime = Date.now();
  const trySend = () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      setTimeout(() => {
        ws.send(JSON.stringify({ type: 'input', data: cmd + '\n' }));
      }, 300);
    } else if (Date.now() - startTime < 8000) {
      setTimeout(trySend, 150);
    } else {
      showStatus('ターミナルに接続できませんでした', 'error');
    }
  };
  trySend();
}

async function prepareClonezillaRun(mode, device, image, confirmMsg) {
  if (!confirm(confirmMsg)) return false;
  setBackupControlsEnabled(false);
  showBackupStatus('GRUBエントリを準備中... (update-grub のため数十秒かかります)', 'info');
  try {
    const resp = await fetch('/api/backup/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, device, image }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.success) {
      throw new Error(data.detail || `HTTP ${resp.status}`);
    }
    showBackupStatus(`${data.message}\nまもなく再起動します...`, 'info');
    setTimeout(async () => {
      await fetch('/api/system/reboot', { method: 'POST' });
    }, 2000);
    return true;
  } catch (e) {
    showBackupStatus(`準備エラー: ${e.message}`, 'error');
    setBackupControlsEnabled(true);
    return false;
  }
}

async function runBackup() {
  const device = document.getElementById('backup-dest-select').value;
  if (!device) {
    showBackupStatus('保存先パーティションを選択してください', 'error');
    return;
  }
  await prepareClonezillaRun('backup', device, '',
    `バックアップを開始しますか？\n\n保存先パーティション: ${device}\n\n・GRUBエントリを作成して自動的に再起動します\n・再起動後、Clonezilla Live がバックアップを行い、完了後に自動で再起動します`);
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
      `<option value="${escapeAttr(img)}">${escapeHtml(img)}</option>`).join('');
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
  await prepareClonezillaRun('restore', device, image,
    `復元を開始しますか？\n\n復元元パーティション: ${device}\nバックアップイメージ: ${image}\n\n⚠️ 現在のシステムは選択したバックアップの内容で上書きされます\n⚠️ GRUBエントリを作成して自動的に再起動し、Clonezilla Live が復元を行います\n⚠️ 処理中に電源を切らないでください`);
}

// --- Timeshift ---
let timeshiftStatusData = null;
let timeshiftExcludes = [];
let timeshiftExcludesDirty = false;
let tsExcludeLoadSeq = 0;

async function loadTimeshiftPage() {
  loadTimeshiftStatus();
  timeshiftExcludesDirty = false;
  loadTimeshiftSnapshots();
}

async function loadTimeshiftStatus() {
  const envEl = document.getElementById('timeshift-env-status');
  const installBtn = document.getElementById('btn-timeshift-install');
  const createBtn = document.getElementById('btn-timeshift-create');
  const saveBtn = document.getElementById('btn-timeshift-save-excludes');
  const refreshBtn = document.getElementById('btn-timeshift-refresh');
  try {
    const resp = await fetch('/api/timeshift/status');
    timeshiftStatusData = await resp.json();
    if (timeshiftStatusData.installed) {
      const modeLabel = timeshiftStatusData.mode === 'btrfs' ? 'btrfs モード' : timeshiftStatusData.mode === 'rsync' ? 'rsync モード' : '不明';
      envEl.innerHTML = `<span class="text-success">✔ インストール済み</span> <span class="muted">(${escapeHtml(modeLabel)})</span>`;
      installBtn.style.display = 'none';
      createBtn.disabled = false;
      saveBtn.disabled = false;
      refreshBtn.disabled = false;
    } else {
      envEl.innerHTML = `<span class="text-danger">未インストール</span>`;
      installBtn.disabled = false;
      installBtn.style.display = '';
      createBtn.disabled = true;
      saveBtn.disabled = true;
      refreshBtn.disabled = true;
    }
  } catch (e) {
    envEl.innerHTML = `<span class="text-danger">状態の取得に失敗しました: ${escapeHtml(e.message)}</span>`;
  }
}

async function installTimeshift() {
  const btn = document.getElementById('btn-timeshift-install');
  if (!confirm('Timeshift のインストールを開始しますか？')) return;
  btn.disabled = true;
  const cmd = 'sudo apt update && sudo apt install -y timeshift';
  await sendToTerminal(cmd, 'Timeshift をインストール中...');
}

function renderTimeshiftExcludes() {
  const container = document.getElementById('timeshift-exclude-list');
  if (!container) return;
  if (!timeshiftExcludes || timeshiftExcludes.length === 0) {
    container.innerHTML = '<p class="muted" style="font-size:0.85rem;margin:0.25rem 0;">除外フォルダはありません（すべてのファイルが対象）</p>';
    return;
  }
  let html = '<div style="display:flex;flex-direction:column;gap:0.35rem;">';
  timeshiftExcludes.forEach((path, idx) => {
    html += `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem;background:var(--bg-elevated, #1f2128);border:1px solid var(--border);border-radius:4px;padding:0.3rem 0.55rem;font-family:monospace;font-size:0.83rem;">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(path)}">${escapeHtml(path)}</span>
        <button type="button" class="btn btn-danger btn-sm" onclick="removeTimeshiftExclude(${idx})" title="除外を解除" style="padding:0.1rem 0.45rem;font-size:0.85rem;line-height:1.2;flex-shrink:0;">－</button>
      </div>`;
  });
  html += '</div>';
  container.innerHTML = html;
}

function addTimeshiftExclude() {
  const input = document.getElementById('timeshift-new-exclude');
  if (!input) return;
  const path = input.value.trim();
  if (!path) return;
  if (timeshiftExcludes.includes(path)) {
    showTimeshiftStatus('そのパスは既に除外リストに含まれています', 'error');
    return;
  }
  timeshiftExcludes.push(path);
  timeshiftExcludesDirty = true;
  input.value = '';
  renderTimeshiftExcludes();
}

function addTimeshiftExcludePath(path) {
  path = (path || '').trim();
  if (!path) return;
  if (timeshiftExcludes.includes(path)) {
    showTimeshiftStatus('そのパスは既に除外リストに含まれています', 'error');
    return;
  }
  timeshiftExcludes.push(path);
  timeshiftExcludesDirty = true;
  renderTimeshiftExcludes();
}

function removeTimeshiftExclude(idx) {
  if (idx >= 0 && idx < timeshiftExcludes.length) {
    timeshiftExcludes.splice(idx, 1);
    timeshiftExcludesDirty = true;
    renderTimeshiftExcludes();
  }
}

async function saveTimeshiftExcludes() {
  const btn = document.getElementById('btn-timeshift-save-excludes');
  btn.disabled = true;
  btn.textContent = '保存中...';
  try {
    const resp = await fetch('/api/timeshift/excludes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ excludes: timeshiftExcludes }),
    });
    const data = await resp.json();
    if (data.success) {
      timeshiftExcludesDirty = false;
      showTimeshiftStatus('除外設定を保存しました', 'success');
      loadTimeshiftSnapshots();
    } else {
      showTimeshiftStatus(data.message || '除外設定の保存に失敗しました', 'error');
    }
  } catch (e) {
    showTimeshiftStatus(`エラー: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '除外設定を保存';
  }
}

async function loadTimeshiftSnapshots() {
  const seq = ++tsExcludeLoadSeq;
  const listEl = document.getElementById('timeshift-snapshot-list');
  listEl.innerHTML = '<p class="muted"><span class="spinner"></span> 読み込み中...</p>';
  try {
    const resp = await fetch('/api/timeshift/snapshots');
    const data = await resp.json();
    if (seq !== tsExcludeLoadSeq) return;
    const snaps = data.snapshots || [];
    if (data.excludes && !timeshiftExcludesDirty) {
      timeshiftExcludes = [...data.excludes];
      renderTimeshiftExcludes();
    }
    if (snaps.length === 0) {
      listEl.innerHTML = '<p class="muted">スナップショットはありません。</p>';
      return;
    }
    let html = '<table style="width:100%;border-collapse:collapse;font-size:0.9rem;">';
    html += '<thead><tr style="border-bottom:1px solid var(--border);text-align:left;">';
    html += '<th style="padding:0.5rem;">ID</th><th style="padding:0.5rem;">名前</th><th style="padding:0.5rem;">タグ</th><th style="padding:0.5rem;">説明</th><th style="padding:0.5rem;">容量</th><th style="padding:0.5rem;"></th></tr></thead><tbody>';
    for (const s of snaps) {
      html += `<tr style="border-bottom:1px solid var(--border);">`;
      html += `<td style="padding:0.5rem;">${escapeHtml(String(s.id))}</td>`;
      html += `<td style="padding:0.5rem;font-family:monospace;font-size:0.85rem;">${escapeHtml(s.name)}</td>`;
      html += `<td style="padding:0.5rem;">${escapeHtml(s.tags)}</td>`;
      html += `<td style="padding:0.5rem;">${escapeHtml(s.description)}</td>`;
      html += `<td style="padding:0.5rem;white-space:nowrap;font-size:0.85rem;">${escapeHtml(s.size || '-')}</td>`;
      html += `<td style="padding:0.5rem;"><button class="btn btn-primary" onclick="restoreSnapshot(${Number(s.id) || 0},'${escapeJs(s.name)}')" style="font-size:0.8rem;padding:0.25rem 0.6rem;">復元</button> <button class="btn btn-danger" onclick="deleteSnapshot(${Number(s.id) || 0},'${escapeJs(s.name)}')" style="font-size:0.8rem;padding:0.25rem 0.6rem;">削除</button></td>`;
      html += '</tr>';
    }
    html += '</tbody></table>';
    listEl.innerHTML = html;
  } catch (e) {
    listEl.innerHTML = `<p class="text-danger">一覧の取得に失敗しました: ${escapeHtml(e.message)}</p>`;
  }
}

async function createSnapshot() {
  const comment = document.getElementById('timeshift-comment').value.trim();
  if (!confirm('スナップショットを作成しますか？\n\nターミナルに切り替わって進捗を表示します')) return;
  try {
    const resp = await fetch('/api/timeshift/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment, excludes: timeshiftExcludes }),
    });
    const data = await resp.json();
    if (!data.success) {
      showTimeshiftStatus(data.message || 'スナップショット作成の開始に失敗しました', 'error');
      return;
    }
    await sendToTerminal(data.cmd, data.message);
  } catch (e) {
    showTimeshiftStatus(`エラー: ${e.message}`, 'error');
  }
}

async function restoreSnapshot(id, name) {
  if (!confirm(`スナップショット ${id} (${name}) を復元しますか？\n\n⚠️ 現在のシステムは選択したスナップショットの状態に戻ります\n⚠️ 実行すると自動的に再起動します`)) return;
  try {
    const resp = await fetch('/api/timeshift/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshot_id: id }),
    });
    const data = await resp.json();
    if (!data.success) {
      showTimeshiftStatus('復元コマンドの生成に失敗しました', 'error');
      return;
    }
    await sendToTerminal(data.cmd, data.message);
  } catch (e) {
    showTimeshiftStatus(`エラー: ${e.message}`, 'error');
  }
}

async function deleteSnapshot(id, name) {
  if (!confirm(`スナップショット ${id} (${name}) を削除しますか？\n\n⚠️ この操作は取り消せません`)) return;
  try {
    const resp = await fetch('/api/timeshift/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshot_id: id }),
    });
    const data = await resp.json();
    if (data.success) {
      showTimeshiftStatus(data.message, 'success');
      loadTimeshiftSnapshots();
    } else {
      showTimeshiftStatus(data.message || '削除に失敗しました', 'error');
    }
  } catch (e) {
    showTimeshiftStatus(`エラー: ${e.message}`, 'error');
  }
}

function showTimeshiftStatus(msg, type) {
  const el = document.getElementById('timeshift-status-msg');
  el.textContent = msg;
  el.className = `status-msg show ${type}`;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.className = 'status-msg'; }, 6000);
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
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(data => {
      const pinnedKeys = new Set((data.pins || []).map(p => p.key));
      fleetNodes.forEach(n => { n.pinned = pinnedKeys.has(n.key); });
      renderFleetDetect();
    })
    .catch((e) => { console.error('Fleet pins refresh error:', e); });
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

