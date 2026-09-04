import ExcelJS from 'exceljs';
import { PDFParse } from 'pdf-parse';

export const PII_CATEGORIES = [
  { key: 'person_name', label: '人物名', method: 'llm' },
  { key: 'furigana', label: 'フリガナ', method: 'llm' },
  { key: 'address', label: '住所・地名', method: 'llm' },
  { key: 'organization', label: '企業名・組織名', method: 'llm' },
  { key: 'date', label: '日付', method: 'pattern+llm' },
  { key: 'time', label: '時刻', method: 'pattern+llm' },
  { key: 'amount', label: '金額', method: 'pattern+llm' },
  { key: 'quantity', label: '数量', method: 'pattern+llm' },
  { key: 'phone', label: '電話番号', method: 'pattern+llm' },
  { key: 'email', label: 'メールアドレス', method: 'pattern' },
  { key: 'my_number', label: 'マイナンバー', method: 'pattern+llm' },
  { key: 'postal_code', label: '郵便番号', method: 'pattern' },
  { key: 'credit_card', label: 'クレジットカード番号', method: 'pattern' },
  { key: 'bank_account', label: '銀行口座番号', method: 'pattern+llm' },
  { key: 'passport', label: 'パスポート番号', method: 'pattern' },
];

const CATEGORY_KEYS = new Set(PII_CATEGORIES.map((c) => c.key));

const CHUNK_CHAR_LIMIT = 3000;
export const MAX_CHUNKS = 40;

// xlsxの1行目が見出し(ヘッダー)である典型的な名簿・台帳形式のファイル向けに、
// 列見出しの文言からその列全体のカテゴリを機械的に推定するためのキーワード。
// 正規表現では検出できない人物名・フリガナ・住所などを、Ollama未接続時でも
// 一定精度で検出できるようにするための補助的な仕組み。
const COLUMN_HEADER_KEYWORDS = {
  person_name: ['氏名', 'お名前', '名前', 'フルネーム', 'full name', 'name'],
  furigana: ['フリガナ', 'ふりがな', 'かな', 'カナ', 'kana'],
  address: ['住所', '所在地', 'address'],
  organization: ['会社名', '勤務先', '組織名', '企業名', '部署', 'company', 'organization'],
  date: ['生年月日', '日付', 'date'],
  amount: ['金額', '価格', '単価', 'amount', 'price'],
  quantity: ['数量', '個数', 'quantity'],
  phone: ['電話番号', '電話', 'tel', 'phone'],
  email: ['メールアドレス', 'メール', 'email', 'mail'],
  my_number: ['マイナンバー', '個人番号'],
  postal_code: ['郵便番号', '〒'],
  credit_card: ['カード番号', 'クレジットカード'],
  bank_account: ['口座番号', '口座'],
  passport: ['パスポート番号', 'パスポート'],
};

// "name"や"tel"のような短い英単語は他の単語(filename, hotel等)に部分一致してしまうため
// 完全一致のみで判定し、日本語のキーワードは(複合語で誤検出しにくいため)部分一致で判定する。
const ASCII_KEYWORD_RE = /^[a-z0-9 ]+$/;

function matchColumnCategory(header) {
  const normalized = header.trim().toLowerCase();
  if (!normalized) return null;
  for (const [category, keywords] of Object.entries(COLUMN_HEADER_KEYWORDS)) {
    for (const keyword of keywords) {
      const kw = keyword.toLowerCase();
      const isMatch = ASCII_KEYWORD_RE.test(kw) ? normalized === kw : normalized.includes(kw);
      if (isMatch) return category;
    }
  }
  return null;
}

// 「氏名: 山田太郎」「住所　東京都…」のようなラベル付きの1行から、
// ラベル部分をカテゴリに変換し、値部分を検出結果として取り出す。
// xlsxの列見出し検出と同じキーワードを使い、PDFなどの自由記述の文書でも
// Ollama未接続時にAI判定なしで検出できるようにする。
const LABELED_LINE_RE = /^[\s　]*([^\s　:：]{1,12})[\s　]*[:：][\s　]*(.+?)[\s　]*$/;

export function scanLabeledFields(text) {
  const findings = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(LABELED_LINE_RE);
    if (!match) continue;
    const [, label, value] = match;
    if (!value) continue;
    const category = matchColumnCategory(label);
    if (category) findings.push({ category, text: value });
  }
  return findings;
}

function cellValueToString(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((rt) => rt.text).join('');
    if (value.formula !== undefined) return value.result != null ? String(value.result) : '';
    if (value.text !== undefined) return String(value.text);
    return '';
  }
  return String(value);
}

export async function extractXlsx(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const records = [];
  const chunks = [];
  const columnFindings = [];

  workbook.eachSheet((worksheet) => {
    const lines = [];
    let headerRowNumber = null;
    let columnCategories = null; // Map<colNumber, category>

    worksheet.eachRow({ includeEmpty: false }, (row) => {
      if (headerRowNumber === null) {
        headerRowNumber = row.number;
        columnCategories = new Map();
        row.eachCell({ includeEmpty: false }, (cell) => {
          const category = matchColumnCategory(cellValueToString(cell.value));
          if (category) columnCategories.set(cell.col, category);
        });
      }

      row.eachCell({ includeEmpty: false }, (cell) => {
        const text = cellValueToString(cell.value).trim();
        if (!text) return;
        const location = `${worksheet.name}!${cell.address}`;
        records.push({ location, text });
        lines.push({ address: cell.address, text });

        if (row.number !== headerRowNumber && columnCategories.has(cell.col)) {
          columnFindings.push({ category: columnCategories.get(cell.col), text, location });
        }
      });
    });

    let buf = [];
    let bufLen = 0;
    const flush = () => {
      if (buf.length === 0) return;
      chunks.push({
        location: `シート「${worksheet.name}」`,
        text: buf.map((l) => `[${l.address}] ${l.text}`).join('\n'),
      });
      buf = [];
      bufLen = 0;
    };
    for (const line of lines) {
      const lineLen = line.text.length + line.address.length + 4;
      if (bufLen + lineLen > CHUNK_CHAR_LIMIT && buf.length > 0) flush();
      buf.push(line);
      bufLen += lineLen;
    }
    flush();
  });

  return { records, chunks, columnFindings };
}

export async function extractPdf(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    const records = [];
    const chunks = [];
    for (const page of result.pages || []) {
      const text = (page.text || '').trim();
      if (!text) continue;
      const location = `ページ ${page.num}`;
      records.push({ location, text });
      for (let i = 0; i < text.length; i += CHUNK_CHAR_LIMIT) {
        chunks.push({ location, text: text.slice(i, i + CHUNK_CHAR_LIMIT) });
      }
    }
    return { records, chunks };
  } finally {
    await parser.destroy();
  }
}

function luhnValid(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const SIMPLE_PATTERNS = [
  {
    category: 'email',
    regex: /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/g,
  },
  { category: 'postal_code', regex: /(?<![\d-])(?:〒\s?)?\d{3}-\d{4}(?!-?\d)/g },
  { category: 'passport', regex: /\b[A-Z]{2}\d{7}\b/g },
  { category: 'phone', regex: /(?:\+81[-\s]?|0)\d{1,4}-\d{1,4}-\d{3,4}/g },
  { category: 'phone', regex: /\b0\d{9,10}\b/g },
  { category: 'date', regex: /(?:令和|平成|昭和)\d{1,2}年\d{1,2}月\d{1,2}日/g },
  { category: 'date', regex: /\d{4}年\d{1,2}月\d{1,2}日/g },
  { category: 'date', regex: /\b\d{4}[-\/]\d{1,2}[-\/]\d{1,2}\b/g },
  { category: 'time', regex: /\b\d{1,2}時\d{1,2}分(?:\d{1,2}秒)?\b/g },
  { category: 'time', regex: /\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:AM|PM|am|pm)?\b/g },
  { category: 'amount', regex: /[¥￥$]\s?\d{1,3}(?:,\d{3})*(?:\.\d+)?/g },
  { category: 'amount', regex: /\d{1,3}(?:,\d{3})*(?:\.\d+)?\s?円/g },
  {
    category: 'quantity',
    regex: /\d+(?:\.\d+)?\s?(?:個|台|枚|本|人|件|袋|箱|セット|kg|ｇ|g|km|㎏|ｍ|m)\b/g,
  },
];

function scanSimplePatterns(text) {
  const findings = [];
  for (const { category, regex } of SIMPLE_PATTERNS) {
    for (const match of text.matchAll(regex)) {
      findings.push({ category, text: match[0].trim() });
    }
  }
  return findings;
}

function scanNumericSequences(text) {
  const findings = [];
  const re = /(?<![\d.])(\d[\d\-\s]{5,24}\d)(?![\d.])/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    const digits = raw.replace(/\D/g, '');

    if (digits.length === 12) {
      findings.push({ category: 'my_number', text: raw.trim() });
    } else if ((digits.length === 13 || digits.length === 15 || digits.length === 16 || digits.length === 19) && luhnValid(digits)) {
      findings.push({ category: 'credit_card', text: raw.trim() });
    } else if (digits.length === 7 || digits.length === 8) {
      const start = Math.max(0, m.index - 15);
      const context = text.slice(start, m.index);
      if (context.includes('口座')) {
        findings.push({ category: 'bank_account', text: raw.trim() });
      }
    }
  }
  return findings;
}

export function scanTextWithPatterns(text) {
  return [...scanSimplePatterns(text), ...scanNumericSequences(text)];
}

const LLM_SYSTEM_PROMPT = `あなたは文書の個人情報マスキング状況を確認するレビュー担当です。
与えられたテキストの中に、次のいずれかの種類の情報がマスキングされずに残っていないか確認してください。

- person_name: 人物名
- furigana: 人物名のフリガナ(カタカナ/ひらがなによる読み仮名)
- address: 住所・地名
- organization: 企業名・組織名
- date: 日付
- time: 時刻
- amount: 金額
- quantity: 数量
- phone: 電話番号
- email: メールアドレス
- my_number: マイナンバー(個人番号)
- postal_code: 郵便番号
- credit_card: クレジットカード番号
- bank_account: 銀行口座番号
- passport: パスポート番号

見つかった項目だけを、以下のJSON形式で厳密に返してください。他の文章は一切含めないでください。
{"findings": [{"category": "person_name", "text": "実際に見つかった文字列"}]}

該当する情報がない場合は {"findings": []} を返してください。`;

export function buildLlmMessages(chunkText) {
  return [
    { role: 'system', content: LLM_SYSTEM_PROMPT },
    { role: 'user', content: chunkText },
  ];
}

export function parseLlmFindings(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || !Array.isArray(parsed.findings)) return [];
  return parsed.findings
    .filter((f) => f && typeof f.text === 'string' && f.text.trim() && CATEGORY_KEYS.has(f.category))
    .map((f) => ({ category: f.category, text: f.text.trim() }));
}

/**
 * Merge raw findings (each { category, text, location, source }) into one
 * entry per distinct (category, normalized text), collecting every location
 * it was seen at and every detection method that flagged it.
 */
export function mergeFindings(rawFindings) {
  const map = new Map();
  const keyOf = (f) => `${f.category}::${f.text.toLowerCase().replace(/\s+/g, '')}`;

  for (const f of rawFindings) {
    const key = keyOf(f);
    if (!map.has(key)) {
      map.set(key, { category: f.category, text: f.text, sources: new Set(), locations: new Set() });
    }
    const entry = map.get(key);
    entry.sources.add(f.source);
    entry.locations.add(f.location);
  }

  return [...map.values()].map((entry) => ({
    category: entry.category,
    text: entry.text,
    sources: [...entry.sources],
    locations: [...entry.locations],
  }));
}
