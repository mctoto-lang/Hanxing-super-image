/**
 * 测试 setup（手册 §10.6）
 *
 * 加载 .env.test（如有）或 .env，让测试连到本地 PG/Redis。
 * 集成测试用一个独立测试库，避免污染开发数据。
 */
try {
  process.loadEnvFile(".env.test")
} catch {
  try {
    process.loadEnvFile(".env")
  } catch {
    // ignore
  }
}
