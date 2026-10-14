"use client";

/**
 * BuildPipeline 3D 车间风格流水线图形（纯展示组件）
 *
 * 基于部署流水线模板改造为工作台 Agent 四阶段进度视图：
 * - 3D 等距「站点」图（阶段按执行顺序蛇形连线，屋顶按状态着色）与列表视图切换；
 * - 顶部统计卡（运行状态 / 已通过阶段 / 日志条数）与上下文条（调用方传入片段）；
 * - 阶段日志面板：按「警告与错误」过滤、下载 .log；
 * - 不含时长展示（服务端未记录阶段耗时）与重跑/取消动作（进度为只读快照）。
 *
 * 纯 Tailwind + lucide 内联 <style> 实现，无新增依赖；prefers-reduced-motion
 * 与暗色（.dark + light-dark()）自适应。
 */
import * as React from "react";
import {
  Box,
  Check,
  ChevronDown,
  Circle,
  Clock3,
  Download,
  GitBranch,
  List,
  Loader2,
  X,
  type LucideIcon,
} from "lucide-react";

export type StageStatus =
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "skipped"
  | "canceled";

export interface PipelineLog {
  time: string;
  message: string;
  level?: "info" | "warning" | "error";
}

export interface PipelineStage {
  id: string;
  name: string;
  /** 阶段语义图标（站点/列表行展示） */
  icon: LucideIcon;
  status: StageStatus;
  logs: PipelineLog[];
}

export interface BuildPipelineProps {
  stages: readonly PipelineStage[];
  title?: string;
  subtitle?: string;
  /** 上下文条片段（依次以 · 分隔，如 任务标题 / 模板名 / #工作流ID） */
  context?: readonly (string | null | undefined)[];
  /** 工作流开始时间（ISO）；页脚展示 */
  startedAt?: string | null;
  defaultView?: "pipeline" | "list";
  theme?: "auto" | "light" | "dark";
  className?: string;
  style?: React.CSSProperties;
}

const statusLabel: Record<StageStatus, string> = {
  queued: "排队中",
  running: "运行中",
  passed: "已通过",
  failed: "失败",
  skipped: "已跳过",
  canceled: "已取消",
};

const statusIcon = (status: StageStatus) =>
  status === "passed"
    ? Check
    : status === "failed" || status === "canceled"
      ? X
      : status === "running"
        ? Loader2
        : Circle;

/** 整体状态：失败 > 取消 > 运行中 > 排队中 > 全跳过 > 已通过 */
const runStatus = (stages: readonly PipelineStage[]): StageStatus =>
  stages.some((stage) => stage.status === "failed")
    ? "failed"
    : stages.some((stage) => stage.status === "canceled")
      ? "canceled"
      : stages.some((stage) => stage.status === "running")
        ? "running"
        : stages.some((stage) => stage.status === "queued") || !stages.length
          ? "queued"
          : stages.every((stage) => stage.status === "skipped")
            ? "skipped"
            : "passed";

const points = (vertices: number[][]) =>
  vertices.map((point) => point.map((value) => value.toFixed(2)).join(",")).join(" ");

/** 3D 等距站点布局：按宽度分列（每列 ≥120px），蛇形排列 */
function stations(count: number, width: number) {
  const columns = Math.max(1, Math.min(count, Math.floor((width - 16) / 120)));
  const rows = Math.ceil(count / columns);
  return {
    height: Math.max(142, rows * 128 + 14),
    nodes: Array.from({ length: count }, (_, index) => {
      const row = Math.floor(index / columns);
      const column = row % 2 ? columns - 1 - (index % columns) : index % columns;
      const x = ((column + 0.5) * width) / columns;
      const y = 72 + row * 128;
      const base = [
        [x, y - 18],
        [x + 28, y - 4],
        [x, y + 10],
        [x - 28, y - 4],
      ];
      const roof = base.map(([px, py]) => [px, py - 24]);
      return { x, y, base, roof };
    }),
  };
}

export function BuildPipeline({
  stages,
  title = "执行流水线",
  subtitle,
  context,
  startedAt,
  defaultView = "pipeline",
  theme = "auto",
  className = "",
  style,
}: BuildPipelineProps) {
  const [selectedStage, setSelectedStage] = React.useState<string | null>(null);
  const [view, setView] = React.useState(defaultView);
  const [width, setWidth] = React.useState(640);
  const [logFilter, setLogFilter] = React.useState("all");
  const plotRef = React.useRef<HTMLDivElement>(null);
  const id = React.useId();

  const stageList = stages ?? [];
  const selected =
    stageList.find((stage) => stage.id === selectedStage) ??
    stageList.find((stage) => stage.status === "failed" || stage.status === "running") ??
    stageList.at(-1);
  const status = runStatus(stageList);
  const passed = stageList.filter((stage) => stage.status === "passed").length;
  const totalLogs = stageList.reduce((sum, stage) => sum + stage.logs.length, 0);
  const scene = React.useMemo(
    () => stations(stageList.length, width),
    [stageList.length, width],
  );
  const logs =
    selected?.logs.filter(
      (log) => logFilter === "all" || log.level === "error" || log.level === "warning",
    ) ?? [];

  React.useEffect(() => {
    const element = plotRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setWidth(Math.max(240, element.getBoundingClientRect().width)),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [view, stageList.length]);

  const chooseStage = (stage: PipelineStage) => {
    setSelectedStage(stage.id);
    setLogFilter("all");
  };

  const exportLog = () => {
    if (!selected) return;
    const blob = new Blob(
      [
        selected.logs
          .map((log) => `[${log.time}] ${(log.level ?? "info").toUpperCase()} ${log.message}`)
          .join("\n"),
      ],
      { type: "text/plain;charset=utf-8" },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `agent-${selected.id}.log`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const contextItems = (context ?? []).filter(
    (value): value is string => Boolean(value && value.trim()),
  );
  const startedText =
    startedAt && !Number.isNaN(new Date(startedAt).getTime())
      ? new Date(startedAt).toLocaleString("zh-CN", {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        })
      : null;

  return (
    <section
      className={`build-pipeline ${className}`}
      data-theme={theme}
      style={style}
      aria-label={title}
    >
      <style>{styles}</style>
      <header className="bp-header">
        <div className="bp-heading">
          <span className="bp-emblem">
            <GitBranch size={17} strokeWidth={1.7} aria-hidden="true" />
          </span>
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
        </div>
        <div className="bp-header-tools">
          <div className="bp-switch" role="group" aria-label="流水线视图">
            <button type="button" aria-pressed={view === "pipeline"} onClick={() => setView("pipeline")}>
              <Box size={14} aria-hidden="true" />
              <span>3D</span>
            </button>
            <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")}>
              <List size={14} aria-hidden="true" />
              <span>列表</span>
            </button>
          </div>
        </div>
      </header>
      {!stageList.length ? (
        <div className="bp-empty">
          <GitBranch size={26} strokeWidth={1.4} aria-hidden="true" />
          <strong>暂无阶段数据</strong>
          <p>阶段进度就绪后将在此展示。</p>
        </div>
      ) : (
        <>
          <div className="bp-stats">
            <div>
              <span>运行状态</span>
              <strong className="bp-status-value" data-status={status} aria-live="polite">
                {statusLabel[status]}
              </strong>
              <small>随进度轮询自动更新</small>
            </div>
            <div>
              <span>已通过阶段</span>
              <strong>
                {passed}
                <em> / {stageList.length}</em>
              </strong>
              <small>全部阶段按序执行</small>
            </div>
            <div>
              <span>阶段日志</span>
              <strong>
                {totalLogs}
                <em> 条</em>
              </strong>
              <small>点击站点查看对应日志</small>
            </div>
          </div>
          {contextItems.length > 0 && (
            <div className="bp-context">
              <span>
                {contextItems.map((item, index) => (
                  <React.Fragment key={`${item}-${index}`}>
                    {index > 0 && <span className="bp-dot">·</span>}
                    <span>{item}</span>
                  </React.Fragment>
                ))}
              </span>
            </div>
          )}
          {view === "pipeline" ? (
            <div className="bp-plot" ref={plotRef} style={{ height: scene.height }}>
              <svg
                className="bp-chart"
                width="100%"
                height={scene.height}
                viewBox={`0 0 ${width} ${scene.height}`}
                role="img"
                aria-labelledby={`${id}-title ${id}-desc`}
              >
                <title id={`${id}-title`}>按执行顺序排列的阶段站点</title>
                <desc id={`${id}-desc`}>
                  {stageList
                    .map((stage) => `${stage.name}：${statusLabel[stage.status]}`)
                    .join("；")}
                  。点击站点按钮查看日志。
                </desc>
                <defs>
                  <marker id={`${id}-arrow`} markerWidth={5} markerHeight={5} refX={4} refY={2.5} orient="auto">
                    <path d="M0,0 L5,2.5 L0,5 Z" fill="var(--bp-line)" />
                  </marker>
                </defs>
                {scene.nodes.slice(0, -1).map((node, index) => {
                  const next = scene.nodes[index + 1];
                  const direction = next.x > node.x ? 1 : -1;
                  const d =
                    next.y === node.y
                      ? `M${node.x + direction * 34},${node.y - 28} L${next.x - direction * 35},${next.y - 28}`
                      : `M${node.x + (node.x > width / 2 ? 34 : -34)},${node.y - 28} H${node.x + (node.x > width / 2 ? 53 : -53)} V${next.y - 28} H${next.x + (node.x > width / 2 ? 35 : -35)}`;
                  return (
                    <path
                      key={index}
                      d={d}
                      fill="none"
                      stroke="var(--bp-line)"
                      strokeWidth={1.2}
                      strokeDasharray={stageList[index]?.status === "passed" ? undefined : "3 4"}
                      markerEnd={`url(#${id}-arrow)`}
                    />
                  );
                })}
                {scene.nodes.map((node, index) => (
                  <g
                    key={stageList[index]?.id ?? index}
                    className="bp-station-block"
                    data-selected={
                      selected?.id === stageList[index]?.id ? "true" : undefined
                    }
                    style={{
                      transform: selected?.id === stageList[index]?.id ? "translateY(-5px)" : "none",
                      transition: "transform 0.2s ease, filter 0.2s ease",
                      filter:
                        selected?.id === stageList[index]?.id
                          ? "brightness(1.15) drop-shadow(0px 8px 10px rgba(0,0,0,0.2))"
                          : "none",
                    }}
                    data-status={stageList[index]?.status}
                  >
                    <polygon points={points(node.base.map(([x, y]) => [x, y + 5]))} fill="var(--bp-ground)" />
                    <polygon className="bp-left" points={points([node.roof[3], node.roof[2], node.base[2], node.base[3]])} />
                    <polygon className="bp-right" points={points([node.roof[1], node.roof[2], node.base[2], node.base[1]])} />
                    <polygon className="bp-roof" points={points(node.roof)} />
                  </g>
                ))}
              </svg>
              {scene.nodes.map((node, index) => {
                const stage = stageList[index];
                if (!stage) return null;
                const Icon = stage.icon;
                const StatusIcon = statusIcon(stage.status);
                return (
                  <button
                    type="button"
                    className="bp-station-button"
                    key={stage.id}
                    data-stage={stage.id}
                    data-status={stage.status}
                    aria-pressed={selected?.id === stage.id}
                    aria-label={`${stage.name}，${statusLabel[stage.status]}，点击查看日志`}
                    style={{ left: node.x - 54, top: node.y - 46 }}
                    onClick={() => chooseStage(stage)}
                  >
                    <span className="bp-station-icon">
                      <Icon size={17} strokeWidth={1.6} aria-hidden="true" />
                    </span>
                    <strong>{stage.name}</strong>
                    <span className="bp-station-state">
                      <StatusIcon size={10} aria-hidden="true" />
                      {statusLabel[stage.status]}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="bp-list">
              {stageList.map((stage) => {
                const Icon = stage.icon;
                const StatusIcon = statusIcon(stage.status);
                return (
                  <button
                    className="bp-list-row"
                    type="button"
                    key={stage.id}
                    data-stage={stage.id}
                    data-status={stage.status}
                    aria-pressed={selected?.id === stage.id}
                    onClick={() => chooseStage(stage)}
                  >
                    <Icon size={16} aria-hidden="true" />
                    <span>
                      <strong>{stage.name}</strong>
                      <small>{stage.logs.length} 条日志</small>
                    </span>
                    <span className="bp-list-status">
                      <StatusIcon size={12} aria-hidden="true" />
                      {statusLabel[stage.status]}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {selected && (
            <div className="bp-log-panel">
              <div className="bp-log-header">
                <div>
                  <strong>{selected.name}</strong>
                  <span className="bp-stage-badge" data-status={selected.status}>
                    {statusLabel[selected.status]}
                  </span>
                </div>
                <div>
                  <label className="bp-log-filter">
                    <span className="bp-sr-only">过滤阶段日志</span>
                    <select value={logFilter} onChange={(event) => setLogFilter(event.target.value)}>
                      <option value="all">全部日志</option>
                      <option value="issues">警告与错误</option>
                    </select>
                    <ChevronDown size={11} aria-hidden="true" />
                  </label>
                  <button
                    type="button"
                    className="bp-export"
                    onClick={exportLog}
                    aria-label="下载该阶段日志"
                    disabled={!selected.logs.length}
                  >
                    <Download size={13} aria-hidden="true" />
                  </button>
                </div>
              </div>
              <div className="bp-log-lines" aria-label={`${selected.name}日志`}>
                {logs.length ? (
                  logs.slice(-4).map((log, index) => (
                    <div className="bp-log-line" key={`${log.time}-${index}`} data-level={log.level ?? "info"}>
                      <time>{log.time}</time>
                      <code>{log.message}</code>
                    </div>
                  ))
                ) : (
                  <p className="bp-no-logs">
                    {logFilter === "issues"
                      ? "该阶段暂无警告或错误。"
                      : selected.status === "queued"
                        ? "等待前一阶段完成。"
                        : "暂无日志。"}
                  </p>
                )}
              </div>
              {logs.length > 4 && (
                <details className="bp-full-logs" key={`${selected.id}-${logFilter}`}>
                  <summary>
                    更早日志（{logs.length - 4} 条）
                    <ChevronDown size={12} aria-hidden="true" />
                  </summary>
                  {logs.slice(0, -4).map((log, index) => (
                    <div className="bp-log-line" key={index} data-level={log.level ?? "info"}>
                      <time>{log.time}</time>
                      <code>{log.message}</code>
                    </div>
                  ))}
                </details>
              )}
            </div>
          )}
          <footer className="bp-footer">
            <span>
              <Clock3 size={12} aria-hidden="true" />
              {startedText ? `开始于 ${startedText}` : "开始时间未知"}
            </span>
            <span>{stageList.length} 个阶段</span>
          </footer>
        </>
      )}
    </section>
  );
}

export default BuildPipeline;

const styles = `
.build-pipeline{--bp-surface:light-dark(#fff,#111);--bp-ink:light-dark(#171717,#ededed);--bp-muted:light-dark(#686868,#aaa);--bp-border:light-dark(#e8e8e8,#2a2a2a);--bp-hover:light-dark(#f4f4f4,#242424);--bp-subtle:light-dark(#fafafa,#181818);--bp-selected:light-dark(#171717,#ededed);--bp-on-selected:light-dark(#fff,#151515);--bp-ground:light-dark(#f1f4f2,#1b231e);--bp-line:light-dark(#c7cec9,#45544a);--bp-green:light-dark(#377a53,#8cd4a7);--bp-green-fill:light-dark(#cee7d7,#365d44);--bp-blue:light-dark(#426c9c,#9ac2ec);--bp-blue-fill:light-dark(#d7e5f5,#334d6e);--bp-red:light-dark(#b33f3f,#eca3a3);--bp-red-fill:light-dark(#f0d6d6,#633939);--bp-gray-fill:light-dark(#e5e8e6,#343a37);--bp-shadow:light-dark(#00000008,#00000030);color:var(--bp-ink);background:var(--bp-surface);border:1px solid var(--bp-border);border-radius:14px;box-shadow:0 3px 16px var(--bp-shadow);width:100%;max-width:720px;margin-inline:auto;overflow:hidden;font-family:Inter,Geist,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;line-height:1.5;text-align:left;box-sizing:border-box;isolation:isolate}
.build-pipeline[data-theme=light]{color-scheme:light}.build-pipeline[data-theme=dark],.dark .build-pipeline[data-theme=auto]{color-scheme:dark}.build-pipeline *{box-sizing:border-box}.build-pipeline button,.build-pipeline select{font:inherit;color:inherit}.build-pipeline button{cursor:pointer;transition:background .16s ease,color .16s ease,transform .16s ease}.build-pipeline button:active:not(:disabled){transform:translateY(1px)}.build-pipeline button:disabled{opacity:.45;cursor:default}.build-pipeline svg:not(.bp-chart){flex:none}.bp-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.bp-header{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:23px 24px 0}.bp-heading{display:flex;gap:11px;align-items:center;min-width:0}.bp-emblem{width:34px;height:34px;border:1px solid var(--bp-border);border-radius:9px;display:grid;place-items:center;background:var(--bp-subtle);flex:none}.bp-heading h2{font-size:15px;font-weight:500;letter-spacing:-.3px;line-height:1.3;margin:0}.bp-heading p{font-size:12px;line-height:1.4;color:var(--bp-muted);margin:4px 0 0}.bp-header-tools{display:flex;align-items:center;gap:8px;min-width:0}.bp-switch{display:flex;padding:3px;background:var(--bp-subtle);border:1px solid var(--bp-border);border-radius:8px;gap:2px;flex:none}.bp-switch button{display:flex;align-items:center;justify-content:center;gap:5px;border:0;background:transparent;border-radius:5px;height:25px;padding:0 8px;font-size:12px;color:var(--bp-muted)}.bp-switch button:hover{background:var(--bp-hover);color:var(--bp-ink)}.bp-switch button[aria-pressed=true],.bp-switch button[aria-pressed=true]:hover{background:var(--bp-selected);color:var(--bp-on-selected)}
.bp-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:26px 24px 20px}.bp-stats>div{display:flex;flex-direction:column}.bp-stats>div+div{padding-left:22px;border-left:1px solid var(--bp-border)}.bp-stats span{color:var(--bp-muted);font-size:12px}.bp-stats strong{font-size:23px;line-height:1.35;font-weight:500;letter-spacing:-.7px;margin:3px 0 2px;font-variant-numeric:tabular-nums;white-space:nowrap}.bp-stats em{font-size:14px;font-style:normal;font-weight:400;letter-spacing:0;color:var(--bp-muted)}.bp-stats small{font-size:11px;color:var(--bp-muted)}.bp-status-value[data-status=passed]{color:var(--bp-green)}.bp-status-value[data-status=running]{color:var(--bp-blue)}.bp-status-value[data-status=failed],.bp-status-value[data-status=canceled]{color:var(--bp-red)}
.bp-context{display:flex;justify-content:space-between;align-items:center;gap:8px;margin:0 24px 0;padding-top:14px;border-top:1px solid var(--bp-border);font-size:11px;color:var(--bp-muted)}.bp-context>span{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap}.bp-dot{padding:0 2px}
.bp-plot{position:relative;margin:0 12px 0}.bp-chart{display:block}.bp-station-block{--bp-top:var(--bp-gray-fill)}.bp-station-block[data-status=passed]{--bp-top:var(--bp-green-fill)}.bp-station-block[data-status=running]{--bp-top:var(--bp-blue-fill)}.bp-station-block[data-status=failed],.bp-station-block[data-status=canceled]{--bp-top:var(--bp-red-fill)}.bp-station-block[data-selected=true]{--bp-top:var(--bp-blue-fill)}.bp-roof{fill:var(--bp-top)}.bp-left{fill:color-mix(in srgb,var(--bp-top) 89%,var(--bp-ink) 11%)}.bp-right{fill:color-mix(in srgb,var(--bp-top) 75%,var(--bp-ink) 25%)}.bp-station-block polygon{transition:fill .3s ease}.bp-station-button{position:absolute;width:108px;height:104px;border:0;padding:0;background:transparent;text-align:center;display:flex;align-items:center;flex-direction:column;border-radius:7px}.bp-station-icon{height:40px;display:flex;align-items:center;justify-content:center;transition:transform .18s ease;color:var(--bp-muted)}.bp-station-button[data-status=passed] .bp-station-icon{color:var(--bp-green)}.bp-station-button[data-status=running] .bp-station-icon{color:var(--bp-blue)}.bp-station-button[data-status=failed] .bp-station-icon{color:var(--bp-red)}.bp-station-button:hover .bp-station-icon{transform:translateY(-2px)}.bp-station-button>strong{font-size:12px;font-weight:500;margin-top:23px;line-height:18px;max-width:104px;overflow-wrap:anywhere}.bp-station-state{display:flex;align-items:center;justify-content:center;gap:4px;color:var(--bp-muted);font-size:11px;line-height:18px;flex-wrap:wrap}.bp-station-state>svg{color:inherit}.bp-station-button[data-status=passed] .bp-station-state>svg{color:var(--bp-green)}.bp-station-button[data-status=failed] .bp-station-state>svg{color:var(--bp-red)}.bp-station-button[data-status=running] .bp-station-state>svg,.bp-list-row[data-status=running] .bp-list-status>svg{animation:bp-spin 1s linear infinite}
@keyframes bp-spin{to{transform:rotate(360deg)}}
.bp-list{padding:10px 24px 18px}.bp-list-row{display:flex;align-items:center;gap:10px;min-height:53px;padding:8px 7px;width:100%;text-align:left;background:transparent;border:0;border-radius:6px;min-width:0}.bp-list-row+.bp-list-row{border-top:1px solid var(--bp-border)}.bp-list-row[aria-pressed=true]{background:var(--bp-subtle)}.bp-list-row:hover{background:var(--bp-hover)}.bp-list-row>svg{color:var(--bp-muted)}.bp-list-row>span:nth-child(2){flex:1;min-width:0}.bp-list-row strong{display:block;font-size:12px;font-weight:500;overflow-wrap:anywhere}.bp-list-row small{display:block;color:var(--bp-muted);font-size:11px}.bp-list-status{display:flex;align-items:center;gap:5px;font-size:11px;white-space:nowrap}.bp-list-row[data-status=passed] .bp-list-status{color:var(--bp-green)}.bp-list-row[data-status=running] .bp-list-status{color:var(--bp-blue)}.bp-list-row[data-status=failed] .bp-list-status{color:var(--bp-red)}
.bp-log-panel{margin:0 24px;border:1px solid var(--bp-border);border-radius:8px;background:var(--bp-subtle);overflow:hidden}.bp-log-header{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:9px 11px;border-bottom:1px solid var(--bp-border);flex-wrap:wrap}.bp-log-header>div{display:flex;align-items:center;gap:7px;min-width:0}.bp-log-header strong{font-weight:500;font-size:12px;overflow-wrap:anywhere}.bp-stage-badge{font-size:11px;color:var(--bp-muted)}.bp-stage-badge[data-status=passed]{color:var(--bp-green)}.bp-stage-badge[data-status=running]{color:var(--bp-blue)}.bp-stage-badge[data-status=failed]{color:var(--bp-red)}.bp-log-filter{display:flex;align-items:center;position:relative}.bp-log-filter select{appearance:none;background:var(--bp-surface);border:1px solid var(--bp-border);border-radius:5px;font-size:11px;height:26px;padding:0 22px 0 7px}.bp-log-filter>svg{position:absolute;right:7px;pointer-events:none;color:var(--bp-muted)}.bp-export{display:grid;place-items:center;width:28px;height:28px;padding:0;border:0;background:transparent;border-radius:5px}.bp-export:hover:not(:disabled){background:var(--bp-hover)}.bp-log-lines{padding:10px 11px}.bp-log-line{display:flex;gap:10px;padding:3px 0;font-size:11px;line-height:1.6}.bp-log-line time{color:var(--bp-muted);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-variant-numeric:tabular-nums;flex:none}.bp-log-line code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;overflow-wrap:anywhere;white-space:pre-wrap;min-width:0}.bp-log-line[data-level=error] code{color:var(--bp-red)}.bp-no-logs{margin:2px 0;color:var(--bp-muted);font-size:11px}.bp-full-logs{padding:0 11px 10px}.bp-full-logs summary{display:flex;align-items:center;justify-content:space-between;list-style:none;min-height:30px;color:var(--bp-muted);font-size:11px;cursor:pointer}.bp-full-logs summary::-webkit-details-marker{display:none}.bp-full-logs summary:hover{color:var(--bp-ink)}.bp-full-logs[open] summary>svg{transform:rotate(180deg)}.bp-footer{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;margin:14px 24px 19px;font-size:11px;color:var(--bp-muted)}.bp-footer>span:first-child{display:flex;align-items:center;gap:5px}.bp-empty{display:flex;align-items:center;justify-content:center;flex-direction:column;gap:9px;min-height:190px;color:var(--bp-muted);padding:24px 18px}.bp-empty strong{font-size:13px;font-weight:500;color:var(--bp-ink)}.bp-empty p{font-size:12px;margin:0}
@media(max-width:560px){.bp-header{padding:19px 18px 0;flex-wrap:wrap;gap:14px}.bp-header-tools{width:100%;justify-content:space-between}.bp-stats{margin:22px 18px 18px;gap:8px}.bp-stats>div+div{padding-left:12px}.bp-stats span{font-size:11px}.bp-stats strong{font-size:21px}.bp-context{margin-inline:18px;flex-wrap:wrap}.bp-list{padding-inline:18px}.bp-log-panel{margin-inline:18px}.bp-footer{margin-inline:18px}.bp-log-line{gap:7px}}
@media(max-width:380px){.bp-stats strong{font-size:19px}.bp-stats em{font-size:12px}.bp-list-row{gap:7px}.bp-log-header>div:last-child{width:100%;justify-content:space-between}.bp-context>span{margin-left:auto}.bp-log-line{flex-wrap:wrap}.bp-log-line code{width:100%}}
@media(pointer:coarse){.bp-switch button{height:38px;min-width:44px}.bp-log-filter select{height:44px;font-size:16px;max-width:230px}.bp-export{height:44px;width:44px}.bp-full-logs summary{min-height:44px}}
@media(prefers-reduced-motion:reduce){.build-pipeline *{transition:none!important;animation:none!important}}
`;
