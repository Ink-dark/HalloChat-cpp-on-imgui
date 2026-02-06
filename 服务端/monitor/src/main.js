const baseUrlInput = document.getElementById('baseUrl');
const applyUrlButton = document.getElementById('applyUrl');
const healthStatus = document.getElementById('healthStatus');
const statsGrid = document.getElementById('statsGrid');
const lastUpdated = document.getElementById('lastUpdated');
const eventLog = document.getElementById('eventLog');
const clearLog = document.getElementById('clearLog');

const STORAGE_KEY = 'hallochat_monitor_base_url';
const DEFAULT_BASE = 'http://localhost:3001';

const state = {
  baseUrl: localStorage.getItem(STORAGE_KEY) || DEFAULT_BASE,
  lastHealth: null,
  lastError: null
};

baseUrlInput.value = state.baseUrl;

const cards = [
  { key: 'activeConnections', label: '在线连接', format: formatNumber },
  { key: 'totalConnections', label: '累计连接', format: formatNumber },
  { key: 'totalMessages', label: '累计消息', format: formatNumber },
  { key: 'messagesLastMinute', label: '1 分钟消息数', format: formatNumber },
  { key: 'errorCount', label: '错误计数', format: formatNumber },
  { key: 'uptimeSec', label: '运行时长', format: formatDuration },
  { key: 'eventLoopDelayMs', label: '事件循环延迟', format: (v) => `${v} ms` },
  { key: 'loadAvg', label: 'CPU 负载 (1m)', format: (v) => v?.[0]?.toFixed(2) ?? '--' },
  { key: 'heapUsed', label: '堆内存使用', format: formatBytes },
  { key: 'rss', label: 'RSS 内存', format: formatBytes }
];

renderCards();

applyUrlButton.addEventListener('click', () => {
  const url = baseUrlInput.value.trim();
  if (!url) return;
  state.baseUrl = url.replace(/\/$/, '');
  localStorage.setItem(STORAGE_KEY, state.baseUrl);
  logEvent(`切换服务端地址为 ${state.baseUrl}`);
  refresh();
});

clearLog.addEventListener('click', () => {
  eventLog.innerHTML = '';
});

async function fetchJson(path) {
  const url = `${state.baseUrl}${path}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`${path} ${res.status}`);
  }
  return res.json();
}

async function refresh() {
  try {
    const [health, stats, metrics] = await Promise.all([
      fetchJson('/health'),
      fetchJson('/stats'),
      fetchJson('/metrics')
    ]);

    state.lastHealth = health;
    state.lastError = null;

    updateStatus('online');
    updateCards({
      ...stats,
      ...metrics
    });

    lastUpdated.textContent = `最后更新 ${formatTime(new Date())}`;
  } catch (err) {
    state.lastError = err;
    updateStatus('offline');
    logEvent(`请求失败：${err.message}`);
  }
}

function updateStatus(status) {
  if (status === 'online') {
    healthStatus.textContent = '在线';
    healthStatus.style.background = 'rgba(26, 156, 107, 0.12)';
    healthStatus.style.color = 'var(--ok)';
  } else {
    healthStatus.textContent = '离线';
    healthStatus.style.background = 'rgba(214, 69, 69, 0.12)';
    healthStatus.style.color = 'var(--bad)';
  }
}

function renderCards() {
  statsGrid.innerHTML = '';
  cards.forEach((card) => {
    const el = document.createElement('div');
    el.className = 'card';
    el.dataset.key = card.key;
    el.innerHTML = `
      <h3>${card.label}</h3>
      <div class="value">--</div>
      <div class="meta">等待数据</div>
    `;
    statsGrid.appendChild(el);
  });
}

function updateCards(data) {
  cards.forEach((card) => {
    const el = statsGrid.querySelector(`[data-key="${card.key}"]`);
    if (!el) return;
    const valueEl = el.querySelector('.value');
    const metaEl = el.querySelector('.meta');
    const value = data[card.key];
    valueEl.textContent = value === undefined ? '--' : card.format(value);
    metaEl.textContent = card.key;
  });
}

function logEvent(message) {
  const item = document.createElement('div');
  item.className = 'log-item';
  item.textContent = `${formatTime(new Date())}  ${message}`;
  eventLog.prepend(item);

  const items = eventLog.querySelectorAll('.log-item');
  if (items.length > 20) {
    items[items.length - 1].remove();
  }
}

function formatNumber(value) {
  if (typeof value !== 'number') return '--';
  return value.toLocaleString('zh-CN');
}

function formatDuration(seconds) {
  if (typeof seconds !== 'number') return '--';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hrs > 0) return `${hrs}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function formatBytes(bytes) {
  if (typeof bytes !== 'number') return '--';
  const units = ['B', 'KB', 'MB', 'GB'];
  let idx = 0;
  let value = bytes;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(1)} ${units[idx]}`;
}

function formatTime(date) {
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

refresh();
setInterval(refresh, 2000);
