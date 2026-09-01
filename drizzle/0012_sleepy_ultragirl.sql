ALTER TABLE "conversation" ADD COLUMN "pinned_at" timestamp with time zone;

--> statement-breakpoint
-- 存量回填：标题仍为默认「新建任务N」的会话，改为截取其首个生图任务提示词（前 20 字）
-- （用户手动重命名过的会话不受影响）
UPDATE "conversation" AS c
SET title = btrim(left(regexp_replace(t.prompt, '\s+', ' ', 'g'), 20))
FROM (
  SELECT DISTINCT ON (conversation_id) conversation_id, prompt
  FROM "generation_task"
  WHERE conversation_id IS NOT NULL
  ORDER BY conversation_id, created_at ASC
) AS t
WHERE c.id = t.conversation_id
  AND c.title ~ '^新建任务[0-9]+$';
