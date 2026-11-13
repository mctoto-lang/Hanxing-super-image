-- 0099：奖励礼物通知（企业套餐开通/续约/周期发放、超管充值、管理员分配积分时全员/定向弹礼物卡）
--   reward_notice：事件表（target_user_id 为空 = 企业全员可见；payload 为展示就绪字段）。
--   user.reward_last_seen_at：每用户已读游标（弹卡被收下/关闭时推进到所展示事件的 created_at）。
CREATE TABLE IF NOT EXISTS reward_notice (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_id uuid NOT NULL REFERENCES enterprise(id) ON DELETE CASCADE,
  -- NULL = 企业全员可见；member_allocation 时 = 被分配成员
  target_user_id uuid REFERENCES "user"(id) ON DELETE CASCADE,
  -- plan_assigned | plan_renewed | plan_grant | recharge | member_allocation
  type varchar(32) NOT NULL,
  -- 展示就绪字段：planName/planIconKey/planColor/credits/amount/expiresAt/operatorName/remark 等
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gt_reward_notice_ent_created ON reward_notice (enterprise_id, created_at DESC);
CREATE INDEX IF NOT EXISTS gt_reward_notice_target ON reward_notice (target_user_id) WHERE target_user_id IS NOT NULL;

ALTER TABLE "user" ADD COLUMN IF NOT EXISTS reward_last_seen_at timestamptz;
