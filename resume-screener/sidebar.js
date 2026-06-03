'use strict';

const API_ENDPOINT = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-chat';

const STATUS_MAP = {
  '满足':   { icon: '✅', cls: 'ok' },
  '不满足': { icon: '❌', cls: 'fail' },
  '不确定': { icon: '⚠️', cls: 'warn' },
};

// ─── DOM refs ──────────────────────────────────────────────────────────────
const settingsToggle    = document.getElementById('settings-toggle');
const settingsPanel     = document.getElementById('settings-panel');
const apiKeyInput       = document.getElementById('api-key-input');
const jdInput           = document.getElementById('jd-input');
const saveBtn           = document.getElementById('save-btn');
const clearBtn          = document.getElementById('clear-btn');
const startBtn          = document.getElementById('start-btn');
const statusBar         = document.getElementById('status-bar');
const candidatesContainer = document.getElementById('candidates-container');

// ─── Init ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get(['jdText', 'apiKey'], (data) => {
    if (data.jdText) jdInput.value = data.jdText;
    if (data.apiKey) apiKeyInput.value = data.apiKey;
  });
});

// ─── Settings toggle ───────────────────────────────────────────────────────
settingsToggle.addEventListener('click', () => {
  const collapsed = settingsPanel.classList.contains('collapsed');
  settingsPanel.classList.toggle('collapsed', !collapsed);
  settingsToggle.classList.toggle('active', collapsed);
});

// ─── Save ──────────────────────────────────────────────────────────────────
saveBtn.addEventListener('click', () => {
  chrome.storage.local.set({ jdText: jdInput.value.trim(), apiKey: apiKeyInput.value.trim() }, () => {
    showStatus('✓ 已保存', 'success');
    setTimeout(hideStatus, 1800);
  });
});

// ─── Clear ─────────────────────────────────────────────────────────────────
clearBtn.addEventListener('click', () => {
  jdInput.value = '';
  candidatesContainer.innerHTML = '';
  hideStatus();
});

// ─── Start ─────────────────────────────────────────────────────────────────
startBtn.addEventListener('click', runScreening);

async function runScreening() {
  const jdText = jdInput.value.trim();
  if (!jdText) {
    showStatus('请先粘贴职位描述（JD）', 'error');
    return;
  }

  const apiKey = apiKeyInput.value.trim();
  if (!apiKey || apiKey === 'YOUR_API_KEY') {
    settingsPanel.classList.remove('collapsed');
    settingsToggle.classList.add('active');
    showStatus('请先在 ⚙ 设置中填写 API Key', 'error');
    return;
  }

  startBtn.disabled = true;
  candidatesContainer.innerHTML = '';
  hideStatus();

  // Get current tab
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    showStatus('无法获取当前标签页', 'error');
    startBtn.disabled = false;
    return;
  }

  // Extract candidates from page
  showStatus('正在读取页面内容...', 'loading');
  let pageData;
  try {
    pageData = await extractFromTab(tab.id);
  } catch (e) {
    showStatus(`读取失败：${e.message}`, 'error');
    startBtn.disabled = false;
    return;
  }

  const { candidates } = pageData;
  if (!candidates?.length || !candidates[0]?.content) {
    showStatus('未读取到有效内容，请确认页面已加载完成', 'error');
    startBtn.disabled = false;
    return;
  }

  hideStatus();
  const isMulti = candidates.length > 1;

  // Create placeholder cards, then fill them one by one
  const cards = candidates.map(c => createPlaceholderCard(c.name, isMulti));
  cards.forEach(card => candidatesContainer.appendChild(card));

  // Scroll to results
  candidatesContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Analyze each candidate (sequentially to avoid rate limits)
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const card = cards[i];

    if (candidates.length > 1) {
      showStatus(`正在分析第 ${i + 1} / ${candidates.length} 位候选人...`, 'loading');
    } else {
      showStatus('正在分析简历，请稍候...', 'loading');
    }

    try {
      const result = await analyzeWithDeepSeek(apiKey, jdText, candidate.content);
      fillCard(card, result);
    } catch (e) {
      fillCardError(card, e.message);
    }
  }

  hideStatus();
  startBtn.disabled = false;
}

// ─── Page extraction ───────────────────────────────────────────────────────
async function extractFromTab(tabId) {
  const tryMessage = async () => {
    const resp = await chrome.tabs.sendMessage(tabId, { action: 'extractResume' });
    if (resp?.success) return resp.data;
    throw new Error(resp?.error || '读取失败');
  };

  try {
    return await tryMessage();
  } catch (e) {
    const isConnectionError = ['Could not establish connection', 'Receiving end does not exist', 'No tab']
      .some(msg => e.message?.includes(msg));

    if (isConnectionError) {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      return await tryMessage();
    }
    throw e;
  }
}

// ─── DeepSeek API ──────────────────────────────────────────────────────────
async function analyzeWithDeepSeek(apiKey, jdText, resumeContent) {
  const prompt = `你是专业招聘助理，请完成以下两步任务：

**第一步：** 从下方JD中提取3-5条最核心的硬性要求（不满足即淘汰的条件）。

**第二步：** 逐条判断候选人简历是否满足，并给出综合匹配评分。

---
【JD内容】
${jdText.substring(0, 3000)}

---
【候选人简历】
${resumeContent}

---
请严格按照以下JSON格式输出，不输出任何其他内容：
{
  "score": <整数0到100>,
  "requirements": [
    {
      "name": "<要求名称，最多8个字>",
      "status": "<只能是：满足 或 不满足 或 不确定>",
      "note": "<判断依据，最多15个字>"
    }
  ]
}

评分参考：每条"不满足"扣15-25分，"不确定"扣5-10分，基础分100分。`;

  const response = await fetch(API_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    let msg = `HTTP ${response.status}`;
    try { const err = await response.json(); msg = err?.error?.message || msg; } catch (_) {}
    throw new Error(msg);
  }

  const data = await response.json();
  const raw = data?.choices?.[0]?.message?.content;
  if (!raw) throw new Error('API 返回内容为空');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) parsed = JSON.parse(match[0]);
    else throw new Error('无法解析 API 返回');
  }

  if (typeof parsed?.score !== 'number' || !Array.isArray(parsed?.requirements)) {
    throw new Error('API 返回格式不符合预期');
  }

  parsed.score = Math.min(100, Math.max(0, Math.round(parsed.score)));
  return parsed;
}

// ─── Card rendering ────────────────────────────────────────────────────────
function createPlaceholderCard(name, showName) {
  const card = document.createElement('div');
  card.className = 'candidate-card';

  const nameBar = (showName && name)
    ? `<div class="candidate-name-bar">${escHtml(name)}</div>`
    : '';

  card.innerHTML = `
    ${nameBar}
    <div class="card-loading-state">
      <span class="spinner"></span>
      <span>分析中...</span>
    </div>
  `;
  return card;
}

function fillCard(card, result) {
  const score = result.score;
  const scoreColor = score >= 75 ? 'var(--ok)' : score >= 50 ? 'var(--warn)' : 'var(--fail)';

  const counts = { ok: 0, fail: 0, warn: 0 };
  const reqsHtml = result.requirements.map(r => {
    const info = STATUS_MAP[r.status] || { icon: '⚠️', cls: 'warn' };
    counts[info.cls]++;
    return `
      <div class="req-row ${info.cls}">
        <span class="req-icon">${info.icon}</span>
        <span class="req-name">${escHtml(r.name)}</span>
        <span class="req-note">${escHtml(r.note || '')}</span>
      </div>`;
  }).join('');

  const summaryParts = [];
  if (counts.ok)   summaryParts.push(`${counts.ok} 满足`);
  if (counts.fail) summaryParts.push(`${counts.fail} 不满足`);
  if (counts.warn) summaryParts.push(`${counts.warn} 不确定`);

  // Preserve the name bar if it exists
  const existingNameBar = card.querySelector('.candidate-name-bar');
  const nameBarHtml = existingNameBar ? existingNameBar.outerHTML : '';

  card.innerHTML = `
    ${nameBarHtml}
    <div class="score-section">
      <div class="score-top">
        <div class="score-number" style="color:${scoreColor}">${score}</div>
        <div class="score-unit">/ 100</div>
      </div>
      <div class="score-bar-wrap">
        <div class="score-bar-track">
          <div class="score-bar-fill" style="background:${scoreColor};width:0%"></div>
        </div>
      </div>
      <div class="score-summary">${summaryParts.join(' · ')}</div>
    </div>
    <div class="reqs-divider"></div>
    <div class="reqs-list">${reqsHtml}</div>
  `;

  // Animate bar
  requestAnimationFrame(() => {
    const fill = card.querySelector('.score-bar-fill');
    if (fill) setTimeout(() => { fill.style.width = `${score}%`; }, 60);
  });
}

function fillCardError(card, msg) {
  const existingNameBar = card.querySelector('.candidate-name-bar');
  const nameBarHtml = existingNameBar ? existingNameBar.outerHTML : '';
  card.innerHTML = `
    ${nameBarHtml}
    <div class="card-loading-state" style="color:var(--fail)">
      ✗ 分析失败：${escHtml(msg)}
    </div>
  `;
}

// ─── Helpers ───────────────────────────────────────────────────────────────
function showStatus(msg, type = 'info') {
  statusBar.className = `status-bar ${type}`;
  statusBar.innerHTML = type === 'loading'
    ? `<span class="spinner"></span><span>${escHtml(msg)}</span>`
    : escHtml(msg);
  statusBar.classList.remove('hidden');
}

function hideStatus() { statusBar.classList.add('hidden'); }

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
