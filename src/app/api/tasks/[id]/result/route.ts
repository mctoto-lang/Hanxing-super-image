import { NextResponse } from "next/server"
import { auth } from "@/lib/auth/config"
import { and, eq } from "drizzle-orm"
import { db } from "@/db/client"
import { generationTasks } from "@/db/schema"

/**
 * 任务结果轮询端点（手册 §5.4）
 *
 * 前端通过此端点轮询任务状态，完成时返回结果图 URL。
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth()
  if (!session?.user?.id) {
    return new NextResponse("unauthorized", { status: 401 })
  }

  const { id: taskId } = await params
  const [task] = await db
    .select({
      id: generationTasks.id,
      status: generationTasks.status,
      resultImages: generationTasks.resultImages,
      errorMessage: generationTasks.errorMessage,
      userId: generationTasks.userId,
      enterpriseId: generationTasks.enterpriseId,
    })
    .from(generationTasks)
    .where(
      and(
        eq(generationTasks.id, taskId),
        eq(generationTasks.userId, session.user.id),
      ),
    )
    .limit(1)

  if (!task) {
    return new NextResponse("not found", { status: 404 })
  }

  return NextResponse.json({
    id: task.id,
    status: task.status,
    resultImages: task.resultImages,
    errorMessage: task.errorMessage,
  })
}
