DROP INDEX "ari_run_idx";--> statement-breakpoint
ALTER TABLE "agent_run" ALTER COLUMN "frame_mode" SET DEFAULT 'ai';--> statement-breakpoint
-- 防御性去重：开发库若已因并发双击产生重复 (run_id,index) 行，先保留每
-- 组最早一行（子记录经 FK 级联清理），否则下面的唯一索引会创建失败
DELETE FROM "agent_run_item" a USING "agent_run_item" b
  WHERE a.run_id = b.run_id AND a.index = b.index AND a.ctid > b.ctid;--> statement-breakpoint
CREATE UNIQUE INDEX "ari_run_index_unique" ON "agent_run_item" USING btree ("run_id","index");