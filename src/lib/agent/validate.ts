/**
 * Agent 工作流图结构校验与执行画像（纯函数，无 DB 依赖）
 *
 * 被 startRun（运行前校验）、编排引擎（遍历顺序）与前端（保存前提示）共用。
 * 结构契约见 graph.ts 头注释：恰好一个 start/end；普通边构成 DAG；
 * 仅 supervisor 可发 retry 边回到上游 agent/image_gen 节点。
 */
import type {
  AgentEdgeSourceHandle,
  AgentGraph,
  AgentGraphEdge,
  AgentGraphNode,
  AgentNodeType,
} from "./graph"

export type GraphValidation =
  | { ok: true }
  | { ok: false; error: string }

/** 普通边（排除 retry 打回边）——DAG 校验与拓扑排序只用普通边 */
export function mainEdges(graph: AgentGraph): AgentGraphEdge[] {
  return graph.edges.filter((e) => (e.sourceHandle ?? "main") === "main")
}

export function retryEdges(graph: AgentGraph): AgentGraphEdge[] {
  return graph.edges.filter((e) => e.sourceHandle === "retry")
}

export function nodesById(graph: AgentGraph): Map<string, AgentGraphNode> {
  return new Map(graph.nodes.map((n) => [n.id, n]))
}

/** 节点的主出口边（可能多条：并行分支；supervisor 一条 main + 一条 retry） */
export function mainOutEdges(graph: AgentGraph, nodeId: string): AgentGraphEdge[] {
  return mainEdges(graph).filter((e) => e.source === nodeId)
}

export function mainInEdges(graph: AgentGraph, nodeId: string): AgentGraphEdge[] {
  return mainEdges(graph).filter((e) => e.target === nodeId)
}

/**
 * 全量结构校验（保存与运行前调用；错误信息直接展示给用户）
 */
export function validateAgentGraph(graph: AgentGraph): GraphValidation {
  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    return { ok: false, error: "画布为空：至少需要开始与结束节点" }
  }
  const nodes = graph.nodes
  const byId = nodesById(graph)
  const ids = new Set<string>()

  for (const n of nodes) {
    if (!n.id) return { ok: false, error: "存在缺少 id 的节点" }
    if (ids.has(n.id)) return { ok: false, error: `节点 id 重复：${n.id}` }
    ids.add(n.id)
    if (!n.config?.title) return { ok: false, error: "存在缺少标题的节点" }
  }

  const startNodes = nodes.filter((n) => n.type === "start")
  const endNodes = nodes.filter((n) => n.type === "end")
  if (startNodes.length !== 1) return { ok: false, error: "必须恰好有一个「开始」节点" }
  if (endNodes.length !== 1) return { ok: false, error: "必须恰好有一个「结束」节点" }

  // 边引用与重复检查
  const edgeKeys = new Set<string>()
  for (const e of graph.edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) {
      return { ok: false, error: "存在连接到不存在节点的连线（请删除悬空连线）" }
    }
    if (e.source === e.target) {
      return { ok: false, error: "不允许节点连接自己" }
    }
    const handle: AgentEdgeSourceHandle = e.sourceHandle ?? "main"
    const key = `${e.source}:${handle}:${e.target}`
    if (edgeKeys.has(key)) return { ok: false, error: "存在重复连线" }
    edgeKeys.add(key)
  }

  // retry 边约束：仅 supervisor 可发出，目标必须是上游 agent/image_gen
  for (const e of retryEdges(graph)) {
    const source = byId.get(e.source)
    const target = byId.get(e.target)
    if (source?.type !== "supervisor") {
      return { ok: false, error: "只有「主管裁决」节点可以创建打回连线" }
    }
    if (target?.type !== "agent" && target?.type !== "image_gen") {
      return { ok: false, error: "打回连线只能回到「智能体」或「生图」节点" }
    }
  }

  // 每个非开始节点必须有主入边；每个非结束节点必须有主出边
  for (const n of nodes) {
    if (n.type !== "start" && mainInEdges(graph, n.id).length === 0) {
      return { ok: false, error: `节点「${n.config.title}」没有输入连线` }
    }
    if (n.type !== "end" && mainOutEdges(graph, n.id).length === 0) {
      return { ok: false, error: `节点「${n.config.title}」没有输出连线` }
    }
  }

  // start 恰好一条出边；end 无出边
  if (mainOutEdges(graph, startNodes[0]!.id).length !== 1) {
    return { ok: false, error: "「开始」节点必须恰好有一条输出连线" }
  }
  if (graph.edges.some((e) => e.source === endNodes[0]!.id)) {
    return { ok: false, error: "「结束」节点不能有输出连线" }
  }

  // main 边 DAG + 可达性（Kahn 拓扑）
  const order = topoOrder(graph)
  if (!order) {
    return { ok: false, error: "普通连线构成了循环（只有主管裁决的打回连线可以成环）" }
  }
  if (order.length !== nodes.length) {
    return { ok: false, error: "存在从「开始」节点到达不了的节点" }
  }

  // 每个非 end 节点沿主边可达 end（防死路）
  const reachEnd = computeReachableTo(graph, endNodes[0]!.id)
  for (const n of nodes) {
    if (n.type !== "end" && !reachEnd.has(n.id)) {
      return { ok: false, error: `节点「${n.config.title}」沿连线走不到「结束」节点` }
    }
  }

  return { ok: true }
}

/**
 * 主边拓扑排序（Kahn）；存在环（不含 retry 边）返回 null
 */
export function topoOrder(graph: AgentGraph): string[] | null {
  const indeg = new Map<string, number>()
  const out = new Map<string, string[]>()
  for (const n of graph.nodes) {
    indeg.set(n.id, 0)
    out.set(n.id, [])
  }
  for (const e of mainEdges(graph)) {
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1)
    out.get(e.source)?.push(e.target)
  }
  const queue = graph.nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id)
  const order: string[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    order.push(id)
    for (const next of out.get(id) ?? []) {
      const d = (indeg.get(next) ?? 0) - 1
      indeg.set(next, d)
      if (d === 0) queue.push(next)
    }
  }
  return order.length === graph.nodes.length ? order : null
}

/** 沿主边反向可达 end 的节点集合 */
function computeReachableTo(graph: AgentGraph, endId: string): Set<string> {
  const reversed = new Map<string, string[]>()
  for (const n of graph.nodes) reversed.set(n.id, [])
  for (const e of mainEdges(graph)) {
    reversed.get(e.target)?.push(e.source)
  }
  const seen = new Set<string>([endId])
  const stack = [endId]
  while (stack.length > 0) {
    const cur = stack.pop()!
    for (const prev of reversed.get(cur) ?? []) {
      if (!seen.has(prev)) {
        seen.add(prev)
        stack.push(prev)
      }
    }
  }
  return seen
}

/** 图执行画像（成本预估与引擎概览用） */
export interface GraphExecutionProfile {
  agentNodes: AgentGraphNode[]
  imageGenNodes: AgentGraphNode[]
  reviewNodes: AgentGraphNode[]
  supervisorNode: AgentGraphNode | null
  hasHuman: boolean
  /** 主线最多轮数 = 1 + 各 supervisor 打回上限（多 supervisor 取最小保守值） */
  maxRounds: number
  nodeTypes: AgentNodeType[]
}

export function graphExecutionProfile(graph: AgentGraph): GraphExecutionProfile {
  const agentNodes = graph.nodes.filter((n) => n.type === "agent")
  const imageGenNodes = graph.nodes.filter((n) => n.type === "image_gen")
  const reviewNodes = graph.nodes.filter((n) => n.type === "review")
  const supervisors = graph.nodes.filter((n) => n.type === "supervisor")
  const maxRetries = supervisors.length
    ? Math.min(...supervisors.map((n) => (n.config as { maxRetries?: number }).maxRetries ?? 0))
    : 0
  return {
    agentNodes,
    imageGenNodes,
    reviewNodes,
    supervisorNode: supervisors[0] ?? null,
    hasHuman: graph.nodes.some((n) => n.type === "human"),
    maxRounds: 1 + Math.max(0, maxRetries),
    nodeTypes: graph.nodes.map((n) => n.type),
  }
}
