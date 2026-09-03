const chatEl = document.getElementById('chat');
const formEl = document.getElementById('chat-form');
const promptEl = document.getElementById('prompt');
const sendBtn = document.getElementById('send-btn');
const modelBadge = document.getElementById('model-badge');

const history = [];

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const config = await res.json();
    modelBadge.textContent = config.model;
  } catch {
    modelBadge.textContent = 'unknown';
  }
}

function addMessage(role, text) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.textContent = text;
  chatEl.appendChild(el);
  chatEl.scrollTop = chatEl.scrollHeight;
  return el;
}

function autoResize() {
  promptEl.style.height = 'auto';
  promptEl.style.height = `${promptEl.scrollHeight}px`;
}

promptEl.addEventListener('input', autoResize);

promptEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    formEl.requestSubmit();
  }
});

formEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = promptEl.value.trim();
  if (!text) return;

  promptEl.value = '';
  autoResize();
  sendBtn.disabled = true;

  addMessage('user', text);
  history.push({ role: 'user', content: text });

  const assistantEl = addMessage('assistant', '');

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history }),
    });

    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTPエラー: ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let full = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      full += decoder.decode(value, { stream: true });
      assistantEl.textContent = full;
      chatEl.scrollTop = chatEl.scrollHeight;
    }

    history.push({ role: 'assistant', content: full });
  } catch (err) {
    assistantEl.remove();
    addMessage('error', err.message || 'エラーが発生しました');
    history.pop();
  } finally {
    sendBtn.disabled = false;
    promptEl.focus();
  }
});

loadConfig();
