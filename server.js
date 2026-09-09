import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PII_CATEGORIES,
  MAX_CHUNKS,
  extractXlsx,
  extractPdf,
  scanTextWithPatterns,
  scanLabeledFields,
  buildLlmMessages,
  parseLlmFindings,
  mergeFindings,
} from './lib/pii.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const MODEL_NAME = process.env.MODEL_NAME || 'gemma4';

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.xlsx' && ext !== '.pdf') {
      cb(new Error('対応していないファイル形式です(.xlsxまたは.pdfのみ対応)'));
      return;
    }
    cb(null, true);
  },
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/models', async (_req, res) => {
  try {
    const tagsRes = await fetch(`${OLLAMA_HOST}/api/tags`);
    if (!tagsRes.ok) throw new Error(`status ${tagsRes.status}`);
    const data = await tagsRes.json();
    const models = (data.models || []).map((m) => m.name).sort();
    res.json({ models, default: MODEL_NAME });
  } catch (err) {
    res.json({ models: [], default: MODEL_NAME });
  }
});

const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 5 * 60 * 1000; // 5分
// Ollamaのnum_predict既定値は実質無制限(-1)。個人情報チェックの応答は短いJSONのみで
// 十分なため、上限を設けて「終了しそこねて延々と生成し続ける」ことによる
// タイムアウトを防ぐ。
const OLLAMA_NUM_PREDICT = Number(process.env.OLLAMA_NUM_PREDICT) || 500;

async function callOllamaJson(model, messages) {
  let res;
  try {
    res = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        format: 'json',
        options: { num_predict: OLLAMA_NUM_PREDICT, temperature: 0 },
      }),
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    });
  } catch (err) {
    // fetch()の失敗理由は「そもそも接続できない(DNS解決失敗/接続拒否)」と
    // 「応答がタイムアウトした(モデルの推論に時間がかかりすぎている等)」の
    // 2通りが考えられるため、区別して原因が分かるメッセージにする。
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      const timeoutErr = new Error(
        `Ollamaの応答が${OLLAMA_TIMEOUT_MS / 1000}秒以内に返ってきませんでした(タイムアウト)。` +
          'CPUのみで大きいモデルを動かしている場合、推論に時間がかかっている可能性があります。'
      );
      timeoutErr.isTimeout = true;
      throw timeoutErr;
    }
    const reason = err.cause?.code || err.cause?.message || err.message;
    const connErr = new Error(`Ollamaに接続できませんでした(${reason})`);
    connErr.isConnectionError = true;
    throw connErr;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ollamaエラー: ${res.status} ${text}`);
  }
  const data = await res.json();
  return data.message?.content || '';
}

app.get('/api/pii-categories', (_req, res) => {
  res.json({ categories: PII_CATEGORIES });
});

app.post('/api/pii-check', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'ファイルが指定されていません。' });
  }
  const model = typeof req.body.model === 'string' && req.body.model.trim() ? req.body.model.trim() : MODEL_NAME;
  const ext = path.extname(req.file.originalname).toLowerCase();

  let extracted;
  try {
    extracted = ext === '.xlsx' ? await extractXlsx(req.file.buffer) : await extractPdf(req.file.buffer);
  } catch (err) {
    return res.status(400).json({
      error: `ファイルの解析に失敗しました。正しい${ext}ファイルか確認してください(パスワード保護されている場合は解除してから再度お試しください)。`,
    });
  }

  const { records, chunks, columnFindings = [] } = extracted;
  if (records.length === 0) {
    return res.json({
      fileName: req.file.originalname,
      model,
      isClean: false,
      extractionFailed: true,
      findings: [],
      warnings: [
        'ファイルからテキストを抽出できなかったため、個人情報の有無を判定できませんでした' +
          '(空のファイル、またはスキャン画像のみのPDF等の可能性があります)。' +
          '画像のみのPDFは現時点では非対応です。目視で確認してください。',
      ],
      categories: PII_CATEGORIES,
    });
  }

  const rawFindings = [];
  for (const record of records) {
    for (const f of scanTextWithPatterns(record.text)) {
      rawFindings.push({ ...f, location: record.location, source: 'pattern' });
    }
    for (const f of scanLabeledFields(record.text)) {
      rawFindings.push({ ...f, location: record.location, source: 'label' });
    }
  }
  for (const f of columnFindings) {
    rawFindings.push({ ...f, source: 'column' });
  }

  const warnings = [];
  const chunksToScan = chunks.slice(0, MAX_CHUNKS);
  if (chunks.length > MAX_CHUNKS) {
    warnings.push(
      `ファイルが大きいため、AIによる確認は先頭の${MAX_CHUNKS}箇所のみ実施しました(正規表現による機械的なチェックは全体に実施済みです)。`
    );
  }

  let ollamaUnavailable = false;
  for (const chunk of chunksToScan) {
    if (ollamaUnavailable) break;
    try {
      const raw = await callOllamaJson(model, buildLlmMessages(chunk.text));
      for (const f of parseLlmFindings(raw)) {
        rawFindings.push({ ...f, location: chunk.location, source: 'llm' });
      }
    } catch (err) {
      if (err.isConnectionError) {
        ollamaUnavailable = true;
        warnings.push(
          `Ollamaに接続できなかったため、AIによる確認は実施していません (${OLLAMA_HOST})。正規表現による機械的なチェックの結果のみ表示しています。詳細: ${err.message}`
        );
      } else if (err.isTimeout) {
        ollamaUnavailable = true;
        warnings.push(`${err.message} 以降のAIによる確認は中止し、正規表現による機械的なチェックの結果のみ表示しています。`);
      } else {
        warnings.push(`「${chunk.location}」のAI解析に失敗しました: ${err.message}`);
      }
    }
  }

  const categoryOrder = new Map(PII_CATEGORIES.map((c, i) => [c.key, i]));
  const findings = mergeFindings(rawFindings).sort(
    (a, b) => categoryOrder.get(a.category) - categoryOrder.get(b.category)
  );

  res.json({
    fileName: req.file.originalname,
    model,
    isClean: findings.length === 0,
    findings,
    warnings,
    categories: PII_CATEGORIES,
  });
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: `ファイルサイズが大きすぎます(上限 ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB)。` });
  }
  if (err) {
    return res.status(400).json({ error: err.message || 'リクエストの処理に失敗しました。' });
  }
  res.status(500).json({ error: '不明なエラーが発生しました。' });
});

app.listen(PORT, () => {
  console.log(`Personal information check app listening on http://localhost:${PORT}`);
  console.log(`Using Ollama model "${MODEL_NAME}" at ${OLLAMA_HOST}`);
});
