/**
 * 样机渲染任务上下文（generationTasks.templateInfo 约定结构）
 *
 * mockup 任务不走 Redis 图像队列：提交时同步调用外部 createRenderJob 记录
 * externalJobId，后续由 syncMockupJobs（worker/cron）与状态轮询 action
 * 双通道驱动到终态；计费/退款复用 refundFailedTask（costPerImage=渲染单价）。
 *
 * 卡片渲染任务（cardId/groupItemId 必填）与批量替换任务（batchId/batchIndex
 * 必填）共用此结构。
 */
export interface MockupTaskInfo {
  kind: "mockup"
  /** 所属渲染卡片（mockup_card.id）；批量替换任务无卡片 */
  cardId?: string
  /** 套组成员（mockup_group_item.id）；批量替换任务无成员 */
  groupItemId?: string
  groupId?: string
  /** 批量替换批次（mockup_batch.id）；卡片渲染任务为空 */
  batchId?: string
  /** 批量替换任务序号（1 起，第几张） */
  batchIndex?: number
  /** 批量替换任务标签（来源图片文件名等，展示用） */
  batchLabel?: string
  /** 外部渲染任务 ID（job_xxx；提交成功后回填） */
  externalJobId?: string
  /** 钉住的模板版本（tpv_xxx） */
  templateVersionId: string
  templateName: string
  /** 批次号（一次渲染调用一个；卡片历史按此聚合） */
  batchTag: string
  /** 提交时实际使用的绑定值快照（渲染与排障用） */
  input: Record<string, { assetId?: string; text?: string }>
  outputFormat: "png" | "jpeg" | "psd"
  /** 轮询到的外部进度（展示用，终态以任务 status 为准） */
  stage?: string
  progress?: number
  errorCode?: string
}

export function parseMockupInfo(
  templateInfo: unknown,
): MockupTaskInfo | null {
  if (!templateInfo || typeof templateInfo !== "object") return null
  const info = templateInfo as Partial<MockupTaskInfo>
  if (info.kind !== "mockup") return null
  return info as MockupTaskInfo
}

/**
 * 样机 AI 生图任务上下文（taskType=normal、source=mockup 的生图任务）
 *
 * AI背景：worker 生成完成后由 applyMockupAiBackgroundAction 落地
 * （填入卡片背景绑定 + 重渲染），appliedAt 为落地时间（空=未落地，
 * 页面加载时兜底续做）。
 */
export interface MockupAiTaskInfo {
  kind: "mockup-ai"
  aiKind: "background" | "render"
  /** 关联渲染卡片（mockup_card.id） */
  cardId: string
  /** 关联套组成员（mockup_group_item.id） */
  groupItemId: string
  /** 提交时渲染原图快照（对比视图左图基准） */
  refImageUrl: string
  /** AI背景落地时间（ISO；空=未落地） */
  appliedAt?: string
}

export function parseMockupAiInfo(
  templateInfo: unknown,
): MockupAiTaskInfo | null {
  if (!templateInfo || typeof templateInfo !== "object") return null
  const info = templateInfo as Partial<MockupAiTaskInfo>
  if (info.kind !== "mockup-ai") return null
  return info as MockupAiTaskInfo
}
