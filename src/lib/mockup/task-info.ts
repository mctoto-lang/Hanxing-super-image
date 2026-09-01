/**
 * 样机渲染任务上下文（generationTasks.templateInfo 约定结构）
 *
 * mockup 任务不走 Redis 图像队列：提交时同步调用外部 createRenderJob 记录
 * externalJobId，后续由 syncMockupJobs（worker/cron）与状态轮询 action
 * 双通道驱动到终态；计费/退款复用 refundFailedTask（costPerImage=渲染单价）。
 */
export interface MockupTaskInfo {
  kind: "mockup"
  /** 所属渲染卡片（mockup_card.id） */
  cardId: string
  /** 套组成员（mockup_group_item.id） */
  groupItemId: string
  groupId: string
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
