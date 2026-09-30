-- 0057: 清空经典全流程（template IS NULL）的历史运行数据
-- 经典全流程已下线（用户端仅保留塔罗模板五阶段）；本迁移一次性删除
-- 全部经典 run 及其子记录（item/round/review/event/message/asset 经
-- agent_run 外键 ON DELETE CASCADE 级联清理）。存储图片文件不物理删除，
-- 由既有 cleanup 策略按保留天数清理。
-- 执行顺序要求：先停掉/下线旧版 worker（不再创建 template IS NULL 的
-- run），再执行本迁移——顺序颠倒会让后到的经典 run 漏清残留。
-- 新模板 run（template = 'tarot'）不受影响：新代码插入时 template 恒非空。
--> statement-breakpoint
DELETE FROM agent_run WHERE template IS NULL;
