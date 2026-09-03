import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const MODEL_NAME = process.env.MODEL_NAME || 'gemma3';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (_req, res) => {
  res.json({ model: MODEL_NAME });
});

app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  let ollamaRes;
  try {
    ollamaRes = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL_NAME, messages, stream: true }),
    });
  } catch (err) {
    return res.status(502).json({
      error: `Ollamaに接続できませんでした (${OLLAMA_HOST})。Ollamaが起動しているか確認してください。`,
    });
  }

  if (!ollamaRes.ok || !ollamaRes.body) {
    const text = await ollamaRes.text().catch(() => '');
    return res.status(502).json({ error: `Ollamaエラー: ${ollamaRes.status} ${text}` });
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');

  const reader = ollamaRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;

        let json;
        try {
          json = JSON.parse(line);
        } catch {
          continue;
        }

        if (json.message?.content) {
          res.write(json.message.content);
        }
        if (json.done) {
          reader.cancel().catch(() => {});
          break;
        }
      }
    }
  } catch (err) {
    // クライアント側の切断などは無視してストリームを終了する
  }

  res.end();
});

app.listen(PORT, () => {
  console.log(`Local Gemma chat app listening on http://localhost:${PORT}`);
  console.log(`Using Ollama model "${MODEL_NAME}" at ${OLLAMA_HOST}`);
});
