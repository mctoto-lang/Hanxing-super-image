/**
 * 存量用户回填 users.last_login_at（「最近登录」列数据源）。
 *
 * 背景：lastLoginAt 此前从未写入（登录链路只写 login_log 审计表），
 * loginAction 现已补回写；本脚本为存量用户从 login_log 取最近一次
 * 成功登录时间补齐（生产上线步骤之一）。
 *
 * - 只处理 last_login_at IS NULL 的用户；
 * - 无成功登录记录的用户保持 NULL（下次真实登录后自然回写）；
 * - 幂等：已回写的用户不会重复处理。
 *
 * 用法：
 *   npx tsx scripts/backfill-last-login.ts          # dry-run：只统计
 *   npx tsx scripts/backfill-last-login.ts --apply  # 实际写入
 */

// 先加载本地 .env（开发），生产靠容器注入 env；必须在动态 import 之前执行
try {
  process.loadEnvFile()
} catch {}

async function main() {
  const apply = process.argv.includes("--apply")

  const { db } = await import("../src/db/client")
  const { sql } = await import("drizzle-orm")

  // postgres-js 驱动：db.execute 直接返回行数组（无 .rows 包装）
  const stats = (await db.execute(sql`
    select
      count(*)::text as total,
      count(*) filter (
        where exists (
          select 1 from login_log l
          where l.user_id = u.id and l.success = true
        )
      )::text as hit
    from "user" u
    where u.last_login_at is null
  `)) as unknown as Array<{ total: string; hit: string }>
  const row = stats[0]
  const total = Number(row?.total ?? 0)
  const hit = Number(row?.hit ?? 0)
  console.log(
    `${apply ? "【APPLY】" : "【DRY-RUN】"}last_login_at 为空用户 ${total} 个，其中 ${hit} 个可从 login_log 回填`,
  )
  if (!apply || hit === 0) return

  const res = (await db.execute(sql`
    update "user" u set last_login_at = (
      select max(l.created_at) from login_log l
      where l.user_id = u.id and l.success = true
    )
    where u.last_login_at is null
      and exists (
        select 1 from login_log l
        where l.user_id = u.id and l.success = true
      )
  `)) as unknown as { count: number }
  console.log(`已回填 ${res?.count ?? hit} 个用户`)
}

main()
  .then(() => {
    // postgres 连接池持有事件循环引用，跑完显式退出
    process.exit(0)
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
