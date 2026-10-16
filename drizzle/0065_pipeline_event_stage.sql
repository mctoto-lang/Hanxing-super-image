-- 工作台 Agent 四阶段流水线日志按模块区分：事件表补所属模块列。
-- 取值 style_confirm / theme / imagination / direction / prompt_writing / art；
-- 存量行与系统级事件（取消/手动重开/积分不足等）保持 NULL，前端按旧
-- nodeKey 白名单回退展示，不丢日志。
ALTER TABLE "workspace_agent_event" ADD COLUMN "stage" varchar(16);
