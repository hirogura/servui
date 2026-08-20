/* serv-UI - Frontend Logic */

let currentTab = 'dashboard';
let term = null;
let ws = null;
let fitAddon = null;
let refreshInterval = null;
let wifiStatusData = null;
let selectedWifiNetwork = null;

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

// --- Terminal ---
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
  ws = new WebSocket(`${protocol}://${location.host}/ws/terminal`);

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

  // Mount/unmount button for partitions with fstype and not read-only
  let actionBtn = '';
  if (isPart && dev.fstype && !dev.readonly) {
    const safeName = escapeHtml(dev.name);
    const safeMp = escapeHtml(dev.mountpoint || '');
    const safeFs = escapeHtml(dev.fstype);
    if (dev.mountpoint) {
      actionBtn = `<button class="btn btn-sm btn-danger" onclick="unmountDisk('${safeName}','${safeMp}')" title="アンマウント">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:0.85rem;height:0.85rem;"><line x1="5" y1="12" x2="19" y2="12"/></svg>
        アンマウント
      </button>`;
    } else {
      actionBtn = `<button class="btn btn-sm btn-primary" onclick="openDiskMountModal('${safeName}','${safeFs}')" title="マウント">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:0.85rem;height:0.85rem;"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        マウント
      </button>`;
    }
  }

  let infoRows = '';
  if (dev.fstype) infoRows += `<tr><td>ファイルシステム</td><td>${escapeHtml(dev.fstype)}</td></tr>`;
  if (dev.size) infoRows += `<tr><td>サイズ</td><td>${escapeHtml(dev.size)}</td></tr>`;
  if (dev.mountpoint) infoRows += `<tr><td>マウントポイント</td><td>${escapeHtml(dev.mountpoint)}</td></tr>`;
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
        <div class="btn-group">${actionBtn}</div>
      </div>
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

async function unmountDisk(deviceName, mountPoint) {
  if (!confirm(`${mountPoint} をアンマウントしますか？`)) return;

  try {
    const resp = await fetch('/api/disks/unmount', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: deviceName, mount_point: mountPoint }),
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

// --- Helpers ---
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
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
      // Not installed - send install commands via WebSocket terminal
      switchTab('terminal');
      showStatus('selfcodeをインストール中... ターミナルで進捗を確認できます。', 'info');
      setTimeout(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          const installCmd = 'sudo apt install -y git curl nodejs npm && curl -fsSL https://raw.githubusercontent.com/hirogura/selfcode/main/install-selfcode.sh -o /tmp/install-selfcode.sh && sudo bash /tmp/install-selfcode.sh\n';
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

// --- Init ---
document.addEventListener('DOMContentLoaded', () => {
  loadDashboard();
  refreshInterval = setInterval(() => {
    if (currentTab === 'dashboard') loadDashboard();
  }, 5000);
});

