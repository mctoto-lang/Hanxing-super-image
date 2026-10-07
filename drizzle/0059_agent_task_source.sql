-- AI Agent 工坊生图入库：task_source 枚举新增 'agent'
-- （卡面/周边资产/AI 融合三路生图统一写入 generation_task，资产管理画廊
--   与 /admin/logs 生图日志按现有查询自动可见，无需改查询）
ALTER TYPE "task_source" ADD VALUE IF NOT EXISTS 'agent';