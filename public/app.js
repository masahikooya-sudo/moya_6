const chatEl = document.getElementById('chat');
const formEl = document.getElementById('chat-form');
const promptEl = document.getElementById('prompt');
const sendBtn = document.getElementById('send-btn');
const modelSelect = document.getElementById('model-select');
const newChatBtn = document.getElementById('new-chat-btn');
const conversationListEl = document.getElementById('conversation-list');

const STORAGE_KEY = 'gemma-chat-conversations';
const CURRENT_KEY = 'gemma-chat-current-id';

let conversations = [];
let currentId = null;
let defaultModel = 'gemma4';

function loadConversations() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    conversations = raw ? JSON.parse(raw) : [];
  } catch {
    conversations = [];
  }
}

function saveConversations() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
}

function getCurrentConversation() {
  return conversations.find((c) => c.id === currentId) || null;
}

function createConversation() {
  const conversation = {
    id: crypto.randomUUID(),
    title: '新しいチャット',
    model: modelSelect.value || defaultModel,
    messages: [],
    updatedAt: Date.now(),
  };
  conversations.unshift(conversation);
  currentId = conversation.id;
  localStorage.setItem(CURRENT_KEY, currentId);
  saveConversations();
  renderConversationList();
  renderMessages();
}

function deleteConversation(id) {
  conversations = conversations.filter((c) => c.id !== id);
  saveConversations();
  if (currentId === id) {
    currentId = conversations[0]?.id || null;
    localStorage.setItem(CURRENT_KEY, currentId || '');
  }
  renderConversationList();
  renderMessages();
}

function selectConversation(id) {
  currentId = id;
  localStorage.setItem(CURRENT_KEY, id);
  const conversation = getCurrentConversation();
  if (conversation && [...modelSelect.options].some((o) => o.value === conversation.model)) {
    modelSelect.value = conversation.model;
  }
  renderConversationList();
  renderMessages();
}

function renderConversationList() {
  conversationListEl.innerHTML = '';
  for (const conversation of conversations) {
    const item = document.createElement('div');
    item.className = `conversation-item${conversation.id === currentId ? ' active' : ''}`;

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = conversation.title;
    item.appendChild(title);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-btn';
    deleteBtn.textContent = '✕';
    deleteBtn.title = '削除';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteConversation(conversation.id);
    });
    item.appendChild(deleteBtn);

    item.addEventListener('click', () => selectConversation(conversation.id));
    conversationListEl.appendChild(item);
  }
}

function addMessageEl(role, text) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.textContent = text;
  chatEl.appendChild(el);
  chatEl.scrollTop = chatEl.scrollHeight;
  return el;
}

function renderMessages() {
  chatEl.innerHTML = '';
  const conversation = getCurrentConversation();
  if (!conversation) return;
  for (const msg of conversation.messages) {
    addMessageEl(msg.role, msg.content);
  }
}

function autoResize() {
  promptEl.style.height = 'auto';
  promptEl.style.height = `${promptEl.scrollHeight}px`;
}

async function loadModels() {
  try {
    const res = await fetch('/api/models');
    const data = await res.json();
    defaultModel = data.default || defaultModel;

    modelSelect.innerHTML = '';
    const names = data.models?.length ? data.models : [defaultModel];
    for (const name of names) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      modelSelect.appendChild(opt);
    }

    const conversation = getCurrentConversation();
    const preferred = conversation?.model || defaultModel;
    if (names.includes(preferred)) {
      modelSelect.value = preferred;
    }
  } catch {
    modelSelect.innerHTML = `<option value="${defaultModel}">${defaultModel}</option>`;
  }
}

modelSelect.addEventListener('change', () => {
  const conversation = getCurrentConversation();
  if (conversation) {
    conversation.model = modelSelect.value;
    saveConversations();
  }
});

newChatBtn.addEventListener('click', createConversation);

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

  let conversation = getCurrentConversation();
  if (!conversation) {
    createConversation();
    conversation = getCurrentConversation();
  }

  promptEl.value = '';
  autoResize();
  sendBtn.disabled = true;

  addMessageEl('user', text);
  conversation.messages.push({ role: 'user', content: text });
  if (conversation.messages.length === 1) {
    conversation.title = text.slice(0, 30) || '新しいチャット';
  }
  conversation.updatedAt = Date.now();
  saveConversations();
  renderConversationList();

  const assistantEl = addMessageEl('assistant', '');

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: conversation.messages, model: conversation.model }),
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

    conversation.messages.push({ role: 'assistant', content: full });
    saveConversations();
  } catch (err) {
    assistantEl.remove();
    addMessageEl('error', err.message || 'エラーが発生しました');
    conversation.messages.pop();
    saveConversations();
  } finally {
    sendBtn.disabled = false;
    promptEl.focus();
  }
});

async function init() {
  loadConversations();
  currentId = localStorage.getItem(CURRENT_KEY);
  if (!conversations.some((c) => c.id === currentId)) {
    currentId = conversations[0]?.id || null;
  }

  await loadModels();

  if (!currentId) {
    createConversation();
  } else {
    renderConversationList();
    renderMessages();
  }
}

init();

const tabButtons = document.querySelectorAll('.tab-btn');
const chatSidebar = document.getElementById('chat-sidebar');
const chatView = document.getElementById('chat-view');
const piiView = document.getElementById('pii-view');

tabButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    tabButtons.forEach((b) => b.classList.toggle('active', b === btn));
    const view = btn.dataset.view;
    chatSidebar.hidden = view !== 'chat';
    chatView.hidden = view !== 'chat';
    piiView.hidden = view !== 'pii';
  });
});
