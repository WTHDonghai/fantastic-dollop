/*
 * 尝试向 Document 表插入一条记录，用于验证给定 id 是否可被数据库接受。
 * - 使用 postgres 原生客户端执行 SQL，输出最真实的数据库错误信息（UUID 语法、外键约束等）。
 * - 通过 dotenv 加载数据库连接字符串。
 */
import { config } from 'dotenv';
import postgres from 'postgres';

// 加载环境变量（优先 .env.local）
config({ path: '.env.local' });
config({ path: '.env' });

async function main() {
  const POSTGRES_URL = process.env.POSTGRES_URL;
  if (!POSTGRES_URL) {
    console.error('[try-insert] 缺少环境变量 POSTGRES_URL');
    process.exit(2);
  }

  const sql = postgres(POSTGRES_URL, { max: 1 });

  const id = 'eda4990d9a764f96bd1fd7db';
  const title = 'Silicon Valley: The Epicenter of Technological Innovation';
  const kind = 'text'; // 对应列名为 "text"
  const userId = '09195c6c-4699-45ea-aec4-1c3ae3507975';
  const createdAt = new Date();
  const content = '';

  try {
    const rows = await sql/* sql */`
      INSERT INTO "Document" ("id", "createdAt", "title", "content", "text", "userId")
      VALUES (${id}::uuid, ${createdAt}, ${title}, ${content}, ${kind}, ${userId}::uuid)
      RETURNING *;
    `;

    console.log('[try-insert] 插入成功，返回行：');
    console.log(rows);
  } catch (error: any) {
    console.error('[try-insert] 插入失败：');
    console.error('message:', error?.message);
    if (error?.code) console.error('code:', error.code);
    if (error?.detail) console.error('detail:', error.detail);
    if (error?.schema) console.error('schema:', error.schema);
    if (error?.table) console.error('table:', error.table);
    if (error?.constraint) console.error('constraint:', error.constraint);
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error('[try-insert] 未捕获异常:', e);
  process.exit(1);
});