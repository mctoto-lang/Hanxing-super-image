"use client"

/**
 * 工作台 server actions 注入层。
 *
 * 真实页面（/agent/run/[id]）不挂 Provider，直接落到 realWorkspaceActions，
 * 与此前各组件逐个 import server action 的行为完全一致；/agent/preview
 * 预览页挂 Provider 注入 mock 实现（写操作 no-op + toast、读操作喂 mock
 * 数据），让整套工作台 UI 可以脱离真实项目走查。
 */
import { createContext, useContext, type ReactNode } from "react"
import {
  appendTemplateMessageAction,
  confirmAiFrameBatchAction,
  confirmSampleBatchAction,
  getTarotDeckScoresAction,
  getTarotDeliverablesAction,
  getTemplateWorkspaceAction,
  regenerateDirectionsAction,
  requestAiFramePreviewAction,
  requestBriefAction,
  retryAiFrameItemAction,
  retryTemplateActionAction,
  saveTemplateBriefAction,
  selectTemplateDirectionAction,
} from "@/server/actions/agent-template"
import { confirmTarotCardPlanAction, updateTarotCardPlanItemAction } from "@/server/actions/agent-cards"
import { confirmItemAction, getRunItemDetailAction, regenItemAction } from "@/server/actions/agent"
import { confirmTarotAssetAction, getTarotAssetPromptsAction, saveTarotAssetAction } from "@/server/actions/agent-assets"

export interface AgentWorkspaceActions {
  getTemplateWorkspace: typeof getTemplateWorkspaceAction
  retryTemplateAction: typeof retryTemplateActionAction
  appendTemplateMessage: typeof appendTemplateMessageAction
  requestBrief: typeof requestBriefAction
  saveTemplateBrief: typeof saveTemplateBriefAction
  regenerateDirections: typeof regenerateDirectionsAction
  selectTemplateDirection: typeof selectTemplateDirectionAction
  confirmSampleBatch: typeof confirmSampleBatchAction
  getTarotDeckScores: typeof getTarotDeckScoresAction
  getTarotDeliverables: typeof getTarotDeliverablesAction
  requestAiFramePreview: typeof requestAiFramePreviewAction
  confirmAiFrameBatch: typeof confirmAiFrameBatchAction
  retryAiFrameItem: typeof retryAiFrameItemAction
  updateTarotCardPlanItem: typeof updateTarotCardPlanItemAction
  confirmTarotCardPlan: typeof confirmTarotCardPlanAction
  confirmItem: typeof confirmItemAction
  regenItem: typeof regenItemAction
  getRunItemDetail: typeof getRunItemDetailAction
  getTarotAssetPrompts: typeof getTarotAssetPromptsAction
  saveTarotAsset: typeof saveTarotAssetAction
  confirmTarotAsset: typeof confirmTarotAssetAction
}

export const realWorkspaceActions: AgentWorkspaceActions = {
  getTemplateWorkspace: getTemplateWorkspaceAction,
  retryTemplateAction: retryTemplateActionAction,
  appendTemplateMessage: appendTemplateMessageAction,
  requestBrief: requestBriefAction,
  saveTemplateBrief: saveTemplateBriefAction,
  regenerateDirections: regenerateDirectionsAction,
  selectTemplateDirection: selectTemplateDirectionAction,
  confirmSampleBatch: confirmSampleBatchAction,
  getTarotDeckScores: getTarotDeckScoresAction,
  getTarotDeliverables: getTarotDeliverablesAction,
  requestAiFramePreview: requestAiFramePreviewAction,
  confirmAiFrameBatch: confirmAiFrameBatchAction,
  retryAiFrameItem: retryAiFrameItemAction,
  updateTarotCardPlanItem: updateTarotCardPlanItemAction,
  confirmTarotCardPlan: confirmTarotCardPlanAction,
  confirmItem: confirmItemAction,
  regenItem: regenItemAction,
  getRunItemDetail: getRunItemDetailAction,
  getTarotAssetPrompts: getTarotAssetPromptsAction,
  saveTarotAsset: saveTarotAssetAction,
  confirmTarotAsset: confirmTarotAssetAction,
}

const AgentWorkspaceActionsContext = createContext<AgentWorkspaceActions>(realWorkspaceActions)

export function AgentWorkspaceActionsProvider({
  actions,
  children,
}: {
  actions: AgentWorkspaceActions
  children: ReactNode
}) {
  return <AgentWorkspaceActionsContext.Provider value={actions}>{children}</AgentWorkspaceActionsContext.Provider>
}

export function useWorkspaceActions(): AgentWorkspaceActions {
  return useContext(AgentWorkspaceActionsContext)
}
