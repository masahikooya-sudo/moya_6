import fs from 'node:fs';
import path from 'node:path';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

// アップロードされたファイルの内容や、検出された個人情報そのもの(氏名・電話番号等)は
// 記録しない。ログファイル自体が機密情報の保管場所になってしまうのを避けるため、
// 「いつ・誰が・何のファイルを・どんな結果だったか(件数とカテゴリ名のみ)」という
// 監査用メタデータだけを記録する。
const LOG_DIR = process.env.PII_LOG_DIR || path.join(process.cwd(), 'logs');
const LOG_RETENTION_DAYS = Number(process.env.PII_LOG_RETENTION_DAYS) || 90;

fs.mkdirSync(LOG_DIR, { recursive: true });

// datePattern はサーバーのローカル時刻(TZ環境変数)を基準に日付が変わるタイミングで
// ファイルを分割する。maxFiles で指定日数より古いログファイルは自動的に削除される。
const transport = new DailyRotateFile({
  dirname: LOG_DIR,
  filename: 'pii-check-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  utc: false,
  maxFiles: `${LOG_RETENTION_DAYS}d`,
});

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [transport],
});

/**
 * 個人情報チェックの監査ログを1件記録する。
 * @param {object} entry
 * @param {string} entry.user - ログインユーザー名/メールアドレス(不明な場合は'unknown')
 * @param {string} entry.fileName - アップロードされたファイル名
 * @param {string} entry.fileType - 拡張子(例: '.xlsx')
 * @param {'checked'|'extraction_failed'|'parse_error'} entry.status - チェックの結果区分
 * @param {boolean} [entry.isClean] - 個人情報が検出されなかったか('checked'の場合のみ)
 * @param {number} [entry.findingsCount] - 検出件数('checked'の場合のみ)
 * @param {string[]} [entry.categories] - 検出されたカテゴリ名の一覧('checked'の場合のみ)
 */
export function logPiiCheck({ user, fileName, fileType, status, isClean, findingsCount, categories }) {
  logger.info('pii-check', {
    uploadedAt: new Date().toISOString(),
    user: user || 'unknown',
    fileName,
    fileType,
    status,
    isClean: isClean ?? null,
    findingsCount: findingsCount ?? null,
    categories: categories ?? [],
  });
}
