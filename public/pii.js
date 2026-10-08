const piiForm = document.getElementById('pii-form');
const piiFileInput = document.getElementById('pii-file');
const piiCheckBtn = document.getElementById('pii-check-btn');
const modelBadge = document.getElementById('model-badge');
const piiResultEl = document.getElementById('pii-result');
const dropzone = document.getElementById('dropzone');
const dropzoneFilename = document.getElementById('dropzone-filename');
const categoryChipsEl = document.getElementById('category-chips');

const SOURCE_LABELS = {
  pattern: 'パターン検出',
  llm: 'AI(Gemma)検出',
  column: '列見出し検出',
  label: 'ラベル検出',
};

let categoryIndex = new Map(); // category key -> color index

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function badgeClass(categoryKey) {
  const idx = categoryIndex.has(categoryKey) ? categoryIndex.get(categoryKey) : 14;
  return `badge-cat-${idx}`;
}

async function loadCategoryChips() {
  try {
    const res = await fetch('/api/pii-categories');
    const data = await res.json();
    const categories = data.categories || [];
    categories.forEach((c, i) => categoryIndex.set(c.key, i));
    categoryChipsEl.innerHTML = categories
      .map((c) => `<span class="chip ${badgeClass(c.key)}">${escapeHtml(c.label)}</span>`)
      .join('');
  } catch {
    categoryChipsEl.innerHTML = '';
  }
}

let modelAvailable = false;

function setModelUnavailable(message) {
  modelAvailable = false;
  modelBadge.textContent = '利用不可';
  modelBadge.classList.add('model-badge-warn');
  piiCheckBtn.disabled = true;
  piiResultEl.innerHTML = `<div class="pii-summary pii-summary-warn">⚠️ ${escapeHtml(message)}</div>`;
}

async function checkPiiModel() {
  try {
    const res = await fetch('/api/models');
    const data = await res.json();
    const modelName = data.default;
    if (!data.models?.includes(modelName)) {
      // 設定されているモデル(MODEL_NAME)がOllama側にまだ取得されていない状態。
      // 存在しないモデルで呼び出すと「model not found」エラーになるだけなので、
      // チェックできない状態にして原因が分かるメッセージを表示する。
      setModelUnavailable(
        `モデル「${modelName}」が取得されていません。サーバーで ollama pull ${modelName} を実行してから再読み込みしてください。`
      );
      return;
    }
    modelAvailable = true;
    modelBadge.textContent = modelName;
    modelBadge.classList.remove('model-badge-warn');
  } catch {
    setModelUnavailable('モデルの状態を確認できませんでした。ページを再読み込みしてください。');
  }
}

function setSelectedFile(file) {
  if (!file) return;
  const dt = new DataTransfer();
  dt.items.add(file);
  piiFileInput.files = dt.files;
  dropzoneFilename.textContent = file.name;
}

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
});

dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('dragover');
});

dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  const file = e.dataTransfer.files?.[0];
  if (file) setSelectedFile(file);
});

piiFileInput.addEventListener('change', () => {
  const file = piiFileInput.files?.[0];
  dropzoneFilename.textContent = file ? file.name : '';
});

function renderResult(data) {
  const parts = [];

  if (data.extractionFailed) {
    parts.push('<div class="pii-summary pii-summary-warn">❓ ファイルの内容を読み取れなかったため、判定できませんでした。</div>');
  } else if (data.isClean) {
    parts.push('<div class="pii-summary pii-summary-ok">✅ 指定した種類の個人情報は検出されませんでした。</div>');
  } else {
    parts.push(`<div class="pii-summary pii-summary-ng">⚠️ ${data.findings.length}件の個人情報の可能性がある記述が見つかりました。内容を確認してください。</div>`);
  }

  if (data.warnings?.length) {
    parts.push('<ul class="pii-warnings">');
    for (const w of data.warnings) {
      parts.push(`<li>${escapeHtml(w)}</li>`);
    }
    parts.push('</ul>');
  }

  if (data.findings?.length) {
    const categoryLabel = (key) => data.categories?.find((c) => c.key === key)?.label || key;

    parts.push('<div class="pii-table-wrap"><table class="pii-table"><thead><tr><th>種類</th><th>検出内容</th><th>検出方法</th><th>場所</th></tr></thead><tbody>');
    for (const item of data.findings) {
      const sources = item.sources.map((s) => SOURCE_LABELS[s] || s).join(' / ');
      const locations = item.locations.join(', ');
      const badge = `<span class="chip ${badgeClass(item.category)}">${escapeHtml(categoryLabel(item.category))}</span>`;
      parts.push(
        `<tr><td>${badge}</td><td>${escapeHtml(item.text)}</td><td>${escapeHtml(sources)}</td><td class="location">${escapeHtml(locations)}</td></tr>`
      );
    }
    parts.push('</tbody></table></div>');
  }

  piiResultEl.innerHTML = parts.join('\n');
}

piiForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = piiFileInput.files[0];
  if (!file) return;

  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  if (ext !== '.xlsx' && ext !== '.pdf') {
    piiResultEl.innerHTML = '<div class="pii-summary pii-summary-ng">対応していないファイル形式です(.xlsxまたは.pdfのみ対応)。</div>';
    return;
  }

  if (!modelAvailable) {
    piiResultEl.innerHTML = '<div class="pii-summary pii-summary-warn">⚠️ 利用可能なモデルがありません。Ollamaの状態を確認してから再読み込みしてください。</div>';
    return;
  }

  piiCheckBtn.disabled = true;
  piiResultEl.innerHTML = '<div class="pii-loading"><span class="spinner"></span>チェック中です。AIによる解析にはファイルサイズに応じて時間がかかる場合があります…</div>';

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch('/api/pii-check', { method: 'POST', body: formData });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `HTTPエラー: ${res.status}`);
    }
    renderResult(data);
  } catch (err) {
    piiResultEl.innerHTML = `<div class="pii-summary pii-summary-ng">${escapeHtml(err.message || 'エラーが発生しました')}</div>`;
  } finally {
    piiCheckBtn.disabled = false;
  }
});

loadCategoryChips();
checkPiiModel();
