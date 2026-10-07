"use client"

/**
 * 工作台 server actions 汇聚层。
 *
 * 各组件统一经 useWorkspaceActions() 取 action，避免逐个 import
 * server action；后续若需替换实现（测试桩等），只需调整这里的绑定。
 */
import {
  appendTemplateMessageAction,
  confirmAiFrameBatchAction,
  confirmSampleBatchAction,
  getTarotDeliverablesAction,
  getTemplateWorkspaceAction,
  regenerateDirectionsAction,
  regenerateStyleSpecAction,
  requestAiFramePreviewAction,
  requestBriefAction,
  retryAiFrameItemAction,
  retryTemplateActionAction,
  saveTemplateBriefAction,
  selectTemplateDirectionAction,
  switchTemplateStageAction,
} from "@/server/actions/agent-template"
import {
  confirmTarotCardDraftsAction,
  confirmTarotCardFinalsAction,
  regenerateCardPromptsAction,
  updateTarotCardPlanItemAction,
} from "@/server/actions/agent-cards"
import { confirmItemAction, getRunItemDetailAction, regenFailedItemsAction, regenItemAction, updateItemPromptAction } from "@/server/actions/agent"
import { confirmTarotAssetAction, getTarotAssetPromptsAction, requestTarotAssetGenerationAction, saveTarotAssetAction } from "@/server/actions/agent-assets"

export interface AgentWorkspaceActions {
  getTemplateWorkspace: typeof getTemplateWorkspaceAction
  retryTemplateAction: typeof retryTemplateActionAction
  appendTemplateMessage: typeof appendTemplateMessageAction
  requestBrief: typeof requestBriefAction
  saveTemplateBrief: typeof saveTemplateBriefAction
  regenerateDirections: typeof regenerateDirectionsAction
  regenerateStyleSpec: typeof regenerateStyleSpecAction
  selectTemplateDirection: typeof selectTemplateDirectionAction
  confirmSampleBatch: typeof confirmSampleBatchAction
  getTarotDeliverables: typeof getTarotDeliverablesAction
  requestAiFramePreview: typeof requestAiFramePreviewAction
  confirmAiFrameBatch: typeof confirmAiFrameBatchAction
  retryAiFrameItem: typeof retryAiFrameItemAction
  switchTemplateStage: typeof switchTemplateStageAction
  updateTarotCardPlanItem: typeof updateTarotCardPlanItemAction
  confirmTarotCardDrafts: typeof confirmTarotCardDraftsAction
  confirmTarotCardFinals: typeof confirmTarotCardFinalsAction
  regenerateCardPrompts: typeof regenerateCardPromptsAction
  confirmItem: typeof confirmItemAction
  regenItem: typeof regenItemAction
  regenFailedItems: typeof regenFailedItemsAction
  updateItemPrompt: typeof updateItemPromptAction
  getRunItemDetail: typeof getRunItemDetailAction
  getTarotAssetPrompts: typeof getTarotAssetPromptsAction
  saveTarotAsset: typeof saveTarotAssetAction
  confirmTarotAsset: typeof confirmTarotAssetAction
  requestTarotAssetGeneration: typeof requestTarotAssetGenerationAction
}

export const realWorkspaceActions: AgentWorkspaceActions = {
  getTemplateWorkspace: getTemplateWorkspaceAction,
  retryTemplateAction: retryTemplateActionAction,
  appendTemplateMessage: appendTemplateMessageAction,
  requestBrief: requestBriefAction,
  saveTemplateBrief: saveTemplateBriefAction,
  regenerateDirections: regenerateDirectionsAction,
  regenerateStyleSpec: regenerateStyleSpecAction,
  selectTemplateDirection: selectTemplateDirectionAction,
  confirmSampleBatch: confirmSampleBatchAction,
  getTarotDeliverables: getTarotDeliverablesAction,
  requestAiFramePreview: requestAiFramePreviewAction,
  confirmAiFrameBatch: confirmAiFrameBatchAction,
  retryAiFrameItem: retryAiFrameItemAction,
  switchTemplateStage: switchTemplateStageAction,
  updateTarotCardPlanItem: updateTarotCardPlanItemAction,
  confirmTarotCardDrafts: confirmTarotCardDraftsAction,
  confirmTarotCardFinals: confirmTarotCardFinalsAction,
  regenerateCardPrompts: regenerateCardPromptsAction,
  confirmItem: confirmItemAction,
  regenItem: regenItemAction,
  regenFailedItems: regenFailedItemsAction,
  updateItemPrompt: updateItemPromptAction,
  getRunItemDetail: getRunItemDetailAction,
  getTarotAssetPrompts: getTarotAssetPromptsAction,
  saveTarotAsset: saveTarotAssetAction,
  confirmTarotAsset: confirmTarotAssetAction,
  requestTarotAssetGeneration: requestTarotAssetGenerationAction,
}

export function useWorkspaceActions(): AgentWorkspaceActions {
  return realWorkspaceActions
}
