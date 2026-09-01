/**
 * 种子：穿戴图片主数据（服装组图方向池 + 模特穿戴预置场景 + 提示词模板）
 *
 * 幂等写入：已存在的 key/scene 跳过（不覆盖超管后续修改）。
 * 用法：pnpm seed:weartry
 */
try {
  process.loadEnvFile()
} catch {
  // ignore
}

void (async () => {
  const { db } = await import("@/db/client")
  const {
    productDirections,
    productPromptTemplates,
    weartryScenes,
  } = await import("@/db/schema")
  const {
    WEARTRY_DEFAULT_PROMPT_TEMPLATES,
    WEARTRY_PROMPT_SCENE_LABELS,
    WEARTRY_PROMPT_SCENE_NOTES,
    WEARTRY_PROMPT_SCENES,
  } = await import("@/lib/weartry/prompt-defaults")
  const { and, eq } = await import("drizzle-orm")

  // ── 服装组图方向池（appliesTo=["weartry"]，超管可在穿戴图片管理-图片方向调整）──
  const directions = [
    {
      key: "model_front_full",
      name: "模特正面全身图",
      description: "正面全身展示，突出版型与整体效果",
      promptTemplate:
        "服装正面全身展示图：参考图中的服装穿在模特身上，正面站姿，全身入镜。" +
        "服装版型、颜色、面料与参考图严格一致；自然站姿，干净浅色背景，柔和布光。{{topSellingPoint}}" +
        " {{sellingPoints}}",
      supportsCount: true,
      maxCount: 2,
      sortOrder: 1,
    },
    {
      key: "model_back_full",
      name: "模特背面全身图",
      description: "背面全身展示，呈现后背版型与细节",
      promptTemplate:
        "服装背面全身展示图：参考图中的服装穿在模特身上，背面站姿，全身入镜。" +
        "后背版型、剪裁线条、拼接与做工细节清晰，服装与参考图严格一致；干净浅色背景，柔和布光。{{sellingPoints}}",
      supportsCount: false,
      maxCount: 1,
      sortOrder: 2,
    },
    {
      key: "detail_closeup",
      name: "细节特写图",
      description: "领口/袖口/口袋等细节特写",
      promptTemplate:
        "服装细节特写图：微距特写参考图服装的工艺细节（领口、袖口、门襟、口袋、缝线、辅料等），" +
        "面料纹理与质感清晰可见，浅景深，专业服装摄影布光。{{sellingPoints}}",
      supportsCount: true,
      maxCount: 4,
      sortOrder: 3,
    },
    {
      key: "scene_match",
      name: "场景搭配图",
      description: "真实场景中的搭配展示",
      promptTemplate:
        "服装场景搭配图：参考图中的服装穿在模特身上，置身与服装风格匹配的真实场景，" +
        "自然互动姿态，环境光自然，整体氛围协调。{{targetAudience}} {{sellingPoints}}",
      supportsCount: true,
      maxCount: 2,
      sortOrder: 4,
    },
    {
      key: "fabric_texture",
      name: "面料细节图",
      description: "面料纹理与垂坠质感",
      promptTemplate:
        "服装面料细节图：聚焦参考图服装的面料质感——纹理织法、垂坠感、光泽度，" +
        "可用局部平铺或悬挂特写呈现，侧逆光突出质感层次。{{sellingPoints}}",
      supportsCount: false,
      maxCount: 1,
      sortOrder: 5,
    },
  ] as const

  for (const d of directions) {
    await db
      .insert(productDirections)
      .values({
        key: d.key,
        name: d.name,
        description: d.description,
        promptTemplate: d.promptTemplate,
        appliesTo: ["weartry"],
        supportsCount: d.supportsCount,
        maxCount: d.maxCount,
        sortOrder: d.sortOrder,
        isActive: true,
      })
      .onConflictDoNothing({ target: productDirections.key })
  }
  console.log(`✓ 服装组图方向种子完成（${directions.length} 条，已存在则跳过）`)

  // ── 模特穿戴预置场景（weartry_scene，超管可在穿戴图片管理-场景预设调整）──
  const scenes = [
    {
      key: "studio_plain",
      name: "纯色棚拍",
      description: "干净纯色背景，突出服装本体",
      promptTemplate:
        "纯浅灰影棚背景，专业柔和布光，模特居中站立，画面干净无杂物，突出服装本体。",
    },
    {
      key: "street_snap",
      name: "城市街拍",
      description: "街头自然光，行走抓拍氛围",
      promptTemplate:
        "城市街头场景：街景背景带浅景深虚化，午后自然光，模特行走或回眸抓拍姿态，时尚街拍氛围。",
    },
    {
      key: "coffee_shop",
      name: "咖啡馆",
      description: "温暖室内光线，休闲氛围",
      promptTemplate:
        "咖啡馆室内场景：温暖木质色调背景，窗边自然散射光，休闲放松的坐姿或倚靠姿态，生活化氛围。",
    },
    {
      key: "office",
      name: "办公室",
      description: "现代办公场景，通勤感",
      promptTemplate:
        "现代办公室场景：简洁明亮的办公环境背景，冷白灯光与自然光混合，干练站姿或行走姿态，职场通勤感。",
    },
    {
      key: "home_cozy",
      name: "居家",
      description: "温馨居家环境，松弛感",
      promptTemplate:
        "温馨居家场景：柔和暖光室内环境（客厅/卧室），松弛自然的坐卧姿态，舒适生活化氛围。",
    },
    {
      key: "beach",
      name: "海滩外景",
      description: "海边度假感，阳光直射",
      promptTemplate:
        "海滩外景场景：阳光直射的沙滩海岸背景，蓝天与海浪，度假感姿态（漫步/迎风），画面明快通透。",
    },
  ] as const

  for (const [i, s] of scenes.entries()) {
    await db
      .insert(weartryScenes)
      .values({
        key: s.key,
        name: s.name,
        description: s.description,
        promptTemplate: s.promptTemplate,
        sortOrder: i + 1,
        isActive: true,
      })
      .onConflictDoNothing({ target: weartryScenes.key })
  }
  console.log(`✓ 预置场景种子完成（${scenes.length} 条，已存在则跳过）`)

  // ── 提示词模板（weartry.* 场景，缺行回退内置默认；此处写入初始数据）──
  for (const [i, scene] of WEARTRY_PROMPT_SCENES.entries()) {
    await db
      .insert(productPromptTemplates)
      .values({
        scene,
        name: WEARTRY_PROMPT_SCENE_LABELS[scene] ?? scene,
        template: WEARTRY_DEFAULT_PROMPT_TEMPLATES[scene]!,
        note: WEARTRY_PROMPT_SCENE_NOTES[scene] ?? null,
        sortOrder: i + 1,
        isActive: true,
      })
      .onConflictDoNothing({ target: productPromptTemplates.scene })
  }
  console.log(
    `✓ 提示词模板种子完成（${WEARTRY_PROMPT_SCENES.length} 条，已存在则跳过）`,
  )

  // ── 守护式升级：换色模板由 CMYK 改 HSB 输入模式的历史快照同步 ──
  // 仅当 DB 行仍等于旧默认（未被超管改过）时更新为新默认，自定义行不动
  const legacyColorTemplate = [
    `服装局部换色：将图中「{{part}}」的颜色更换为 {{colorName}}（HEX {{colorHex}}，CMYK {{colorCmyk}}，RGB {{colorRgb}}）。要求：`,
    `- 仅更改「{{part}}」的颜色，其他区域保持原样不变`,
    `- 保留原面料质感、褶皱、印花位置、缝线与光影阴影，颜色过渡自然`,
    `- 新颜色明暗层次随原图光影变化，不得出现纯色块涂抹感`,
    `{{additionalPrompt}}`,
    `Photorealistic, high resolution.`,
  ].join("\n")
  const upgraded = await db
    .update(productPromptTemplates)
    .set({
      template: WEARTRY_DEFAULT_PROMPT_TEMPLATES["weartry.color"]!,
      note: WEARTRY_PROMPT_SCENE_NOTES["weartry.color"] ?? null,
    })
    .where(
      and(
        eq(productPromptTemplates.scene, "weartry.color"),
        eq(productPromptTemplates.template, legacyColorTemplate),
      ),
    )
    .returning({ id: productPromptTemplates.id })
  if (upgraded.length > 0) {
    console.log(`✓ 换色模板已守护式升级为 HSB 版（${upgraded.length} 条）`)
  }

  // ── 守护式升级：模特形象模板措辞软化（「不穿任何服装」易触发上游内容安全拦截）──
  const legacyModelImage = [
    `生成一张专业模特全身参考图（studio portrait, full body）：`,
    `- 一位 {{race}} {{age}} {{gender}} 模特，体型 {{bodyType}}，面容自然、姿态舒展站立`,
    `- 纯浅灰影棚背景，柔和均匀布光，无阴影杂物；模特不穿任何服装（贴身基础打底衣裤，便于后期换装），赤足或素色平底鞋`,
    `- 构图：全身入镜、头顶脚底留白均衡，人物居中占画面 85% 以上`,
    `- 画面干净无文字、无水印`,
    `{{details}}`,
    `Photorealistic, high resolution, fashion model reference sheet.`,
  ].join("\n")
  const upgradedModelImage = await db
    .update(productPromptTemplates)
    .set({ template: WEARTRY_DEFAULT_PROMPT_TEMPLATES["weartry.model_image"]! })
    .where(
      and(
        eq(productPromptTemplates.scene, "weartry.model_image"),
        eq(productPromptTemplates.template, legacyModelImage),
      ),
    )
    .returning({ id: productPromptTemplates.id })
  if (upgradedModelImage.length > 0) {
    console.log(
      `✓ 模特形象模板已守护式升级（措辞软化，${upgradedModelImage.length} 条）`,
    )
  }

  process.exit(0)
})().catch((err) => {
  console.error("种子失败:", err)
  process.exit(1)
})
