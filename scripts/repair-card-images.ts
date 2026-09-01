/**
 * 数据修复：card_image 卡在 pending/generating，但关联的 generation_task 已终态。
 *
 * 背景：队列消费者（processor.ts）早期版本任务终态后不回写 card_image，
 * 工作台翻卡因此永久显示加载中。processor 已修复为终态自动回写；本脚本
 * 清理修复上线前的历史脏数据。幂等，可重复执行。
 *
 * 运行：npx tsx scripts/repair-card-images.ts
 */

// 先加载本地 .env（开发），生产靠容器注入 env；必须在动态 import 之前执行
try {
  process.loadEnvFile()
} catch {}

async function main() {
  const { db } = await import("@/db/client")
  const { generationTasks, cardImages } = await import("@/db/schema")
  const { and, eq, inArray } = await import("drizzle-orm")

  const stuck = await db
    .select({
      cardImageId: cardImages.id,
      cardStatus: cardImages.status,
      genStatus: generationTasks.status,
      resultImages: generationTasks.resultImages,
      errorMessage: generationTasks.errorMessage,
    })
    .from(cardImages)
    .innerJoin(
      generationTasks,
      eq(cardImages.generationTaskId, generationTasks.id),
    )
    .where(
      and(
        inArray(cardImages.status, ["pending", "generating"]),
        inArray(generationTasks.status, ["completed", "failed"]),
      ),
    )

  if (stuck.length === 0) {
    console.log("没有需要修复的 card_image 行")
    process.exit(0)
  }

  let completed = 0
  let failed = 0
  for (const row of stuck) {
    if (row.genStatus === "completed" && (row.resultImages?.length ?? 0) > 0) {
      await db
        .update(cardImages)
        .set({
          status: "completed",
          imageUrl: row.resultImages![0]!,
          errorMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(cardImages.id, row.cardImageId))
      completed++
      console.log(
        `[repair] ${row.cardImageId}: ${row.cardStatus} → completed（回填图片 URL）`,
      )
    } else {
      // 生图任务失败，或 completed 却无结果图（异常数据）→ 标记失败
      await db
        .update(cardImages)
        .set({
          status: "failed",
          errorMessage:
            row.errorMessage ?? "历史任务未回写结果（repair-card-images 标记失败）",
          updatedAt: new Date(),
        })
        .where(eq(cardImages.id, row.cardImageId))
      failed++
      console.log(`[repair] ${row.cardImageId}: ${row.cardStatus} → failed`)
    }
  }

  console.log(`共修复 ${stuck.length} 行（completed ${completed}，failed ${failed}）`)
  process.exit(0)
}

main().catch((err) => {
  console.error("[repair] 执行失败:", err)
  process.exit(1)
})
