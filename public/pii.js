const piiForm = document.getElementById('pii-form');
const piiFileInput = document.getElementById('pii-file');
const piiCheckBtn = document.getElementById('pii-check-btn');
const piiModelSelect = document.getElementById('pii-model-select');
const piiResultEl = document.getElementById('pii-result');

const SOURCE_LABELS = {
  pattern: 'パターン検出',
  llm: 'AI(Gemma)検出',
};

async function loadPiiModels() {
  try {
    const res = await fetch('/api/models');
    const data = await res.json();
    const names = data.models?.length ? data.models : [data.default || 'gemma3'];
    piiModelSelect.innerHTML = '';
    for (const name of names) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      piiModelSelect.appendChild(opt);
    }
  } catch {
    piiModelSelect.innerHTML = '<option value="gemma3">gemma3</option>';
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function renderResult(data) {
  const parts = [];

  if (data.isClean) {
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
    const byCategory = new Map();
    for (const f of data.findings) {
      if (!byCategory.has(f.category)) byCategory.set(f.category, []);
      byCategory.get(f.category).push(f);
    }
    const categoryLabel = (key) => data.categories?.find((c) => c.key === key)?.label || key;

    parts.push('<table class="pii-table"><thead><tr><th>種類</th><th>検出内容</th><th>検出方法</th><th>場所</th></tr></thead><tbody>');
    for (const [category, items] of byCategory) {
      for (const item of items) {
        const sources = item.sources.map((s) => SOURCE_LABELS[s] || s).join(' / ');
        const locations = item.locations.join(', ');
        parts.push(
          `<tr><td>${escapeHtml(categoryLabel(category))}</td><td>${escapeHtml(item.text)}</td><td>${escapeHtml(sources)}</td><td>${escapeHtml(locations)}</td></tr>`
        );
      }
    }
    parts.push('</tbody></table>');
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

  piiCheckBtn.disabled = true;
  piiResultEl.innerHTML = '<div class="pii-loading">チェック中です。AIによる解析にはファイルサイズに応じて時間がかかる場合があります…</div>';

  const formData = new FormData();
  formData.append('file', file);
  formData.append('model', piiModelSelect.value);

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

loadPiiModels();
