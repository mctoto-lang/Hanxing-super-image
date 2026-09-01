import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  calcMessageCostCenticredits,
  estimateTokens,
  formatCenticredits,
  mergeConsecutiveMessages,
  resolveClaudeEndpoint,
  resolveGeminiStreamEndpoint,
  resolveOpenAiChatEndpoint,
} from "@/lib/ai/chat/chat-model-config"
import { buildOpenAiChatRequestBody, streamOpenAiCompatibleChat } from "@/lib/ai/chat/openai-chat"
import { buildClaudeRequestBody, clampClaudeThinkingBudget } from "@/lib/ai/chat/claude-chat"
import { buildGeminiRequestBody } from "@/lib/ai/chat/gemini-chat"
import { readSseStream } from "@/lib/ai/chat/sse"
import type { StreamChatAdapterOptions } from "@/lib/ai/chat/chat-model-config"

/**
 * 对话计费公式 + 四种格式适配器单测（纯函数 + mock fetch SSE）。
 */

// ═══════════════ 计费公式（厘 = 0.01 积分） ═══════════════

describe("calcMessageCostCenticredits", () => {
  const price = { inputPriceCenticredits: 250, outputPriceCenticredits: 1000 } // 2.50 / 10.00 积分每百万

  it("整数成本：1M 输入按定价精确计算", () => {
    expect(
      calcMessageCostCenticredits({ inputTokens: 1_000_000, outputTokens: 0, ...price }),
    ).toBe(250)
  })

  it("混合成本向上取整到最小单位 1 厘", () => {
    // 3500*250/1e6 + 800*1000/1e6 = 0.875 + 0.8 = 1.675 厘 → 2
    expect(
      calcMessageCostCenticredits({ inputTokens: 3500, outputTokens: 800, ...price }),
    ).toBe(2)
  })

  it("有价但成本极小时最低收 1 厘", () => {
    expect(
      calcMessageCostCenticredits({ inputTokens: 1, outputTokens: 1, ...price }),
    ).toBe(1)
  })

  it("零 token 不产生账单", () => {
    expect(
      calcMessageCostCenticredits({ inputTokens: 0, outputTokens: 0, ...price }),
    ).toBe(0)
  })

  it("双零价模型免费", () => {
    expect(
      calcMessageCostCenticredits({
        inputTokens: 999_999,
        outputTokens: 999_999,
        inputPriceCenticredits: 0,
        outputPriceCenticredits: 0,
      }),
    ).toBe(0)
  })

  it("仅输出计价（输入免费模型）", () => {
    expect(
      calcMessageCostCenticredits({
        inputTokens: 500_000,
        outputTokens: 250_000,
        inputPriceCenticredits: 0,
        outputPriceCenticredits: 200, // 2.00/百万
      }),
    ).toBe(50) // 0.5 积分 = 50 厘（精确）
  })

  it("厘显示：3 → 0.03", () => {
    expect(formatCenticredits(3)).toBe("0.03")
    expect(formatCenticredits(250)).toBe("2.50")
  })
})

// ═══════════════ token 估算兜底 ═══════════════

describe("estimateTokens", () => {
  it("空文本为 0", () => {
    expect(estimateTokens("")).toBe(0)
  })

  it("中文按 0.8 token/字向上取整", () => {
    expect(estimateTokens("你好世界")).toBe(Math.ceil(4 * 0.8)) // 4
  })

  it("英文按 1 token / 3.5 字符", () => {
    expect(estimateTokens("abcdefghij")).toBe(Math.ceil(10 / 3.5))
  })

  it("中英混合分别累计", () => {
    expect(estimateTokens("你好abc")).toBe(Math.ceil(2 * 0.8 + 3 / 3.5))
  })
})

// ═══════════════ 端点归一化 ═══════════════

describe("chat endpoint resolvers", () => {
  it("openai：/v1 结尾拼接 /chat/completions", () => {
    expect(resolveOpenAiChatEndpoint("https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1/chat/completions",
    )
  })

  it("openai：裸域名补 /v1/chat/completions", () => {
    expect(resolveOpenAiChatEndpoint("https://api.openai.com")).toBe(
      "https://api.openai.com/v1/chat/completions",
    )
  })

  it("openai：已含路径原样保留（容错尾斜杠）", () => {
    expect(
      resolveOpenAiChatEndpoint("https://gw.example.com/v1/chat/completions/"),
    ).toBe("https://gw.example.com/v1/chat/completions")
  })

  it("claude：裸域名 → /v1/messages", () => {
    expect(resolveClaudeEndpoint("https://api.anthropic.com")).toBe(
      "https://api.anthropic.com/v1/messages",
    )
  })

  it("gemini：拼接 v1beta 模型流式端点", () => {
    expect(
      resolveGeminiStreamEndpoint(
        "https://generativelanguage.googleapis.com",
        "gemini-2.5-flash",
      ),
    ).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
    )
  })

  it("gemini：已是完整方法 URL 时复用并强制 alt=sse", () => {
    expect(
      resolveGeminiStreamEndpoint(
        "https://gw.example.com/v1beta/models/m:streamGenerateContent",
        "m",
      ),
    ).toBe("https://gw.example.com/v1beta/models/m:streamGenerateContent?alt=sse")
  })
})

// ═══════════════ 消息预处理 ═══════════════

describe("mergeConsecutiveMessages", () => {
  it("合并连续同角色消息（claude 交替要求）", () => {
    const merged = mergeConsecutiveMessages([
      { role: "user" as const, content: "你好" },
      { role: "user" as const, content: "再问一句" },
      { role: "assistant" as const, content: "回答" },
      { role: "assistant" as const, content: "补充" },
    ])
    expect(merged).toEqual([
      { role: "user", content: "你好\n\n再问一句" },
      { role: "assistant", content: "回答\n\n补充" },
    ])
  })

  it("正常交替不动", () => {
    const input = [
      { role: "user" as const, content: "a" },
      { role: "assistant" as const, content: "b" },
    ]
    expect(mergeConsecutiveMessages(input)).toEqual(input)
  })
})

// ═══════════════ 请求体构造 ═══════════════

function makeAdapterOpts(
  overrides?: Partial<StreamChatAdapterOptions>,
): StreamChatAdapterOptions {
  return {
    apiKey: "sk-test",
    modelName: "test-model",
    apiEndpoint: "https://api.example.com/v1",
    apiTimeout: 30,
    maxOutputTokens: 4096,
    supportsThinking: true,
    temperature: null,
    messages: [
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好，有什么可以帮你？" },
      { role: "user", content: "讲个笑话" },
    ],
    systemPrompt: null,
    thinkingLevel: "off",
    ...overrides,
  }
}

describe("buildOpenAiChatRequestBody", () => {
  it("基础字段 + include_usage", () => {
    const body = buildOpenAiChatRequestBody(makeAdapterOpts())
    expect(body.model).toBe("test-model")
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
    expect(body.max_tokens).toBe(4096)
    expect((body.messages as unknown[]).length).toBe(3)
    expect("reasoning_effort" in body).toBe(false)
  })

  it("system 前置 + 思考档位映射 reasoning_effort", () => {
    const body = buildOpenAiChatRequestBody(
      makeAdapterOpts({
        systemPrompt: "你是一个助手",
        thinkingLevel: "high",
      }),
    )
    const messages = body.messages as Array<{ role: string }>
    expect(messages[0].role).toBe("system")
    expect(body.reasoning_effort).toBe("high")
  })

  it("不支持思考的模型不发送 reasoning_effort", () => {
    const body = buildOpenAiChatRequestBody(
      makeAdapterOpts({ supportsThinking: false, thinkingLevel: "high" }),
    )
    expect("reasoning_effort" in body).toBe(false)
  })
})

describe("buildClaudeRequestBody", () => {
  it("system 独立字段 + 消息交替", () => {
    const body = buildClaudeRequestBody(
      makeAdapterOpts({
        apiEndpoint: "https://api.anthropic.com",
        systemPrompt: "你是一个助手",
      }),
    )
    expect(body.system).toBe("你是一个助手")
    expect(body.max_tokens).toBe(4096)
    expect((body.messages as unknown[]).length).toBe(3)
    expect("thinking" in body).toBe(false)
  })

  it("思考档位映射 budget_tokens 且开启时不发 temperature", () => {
    const body = buildClaudeRequestBody(
      makeAdapterOpts({ thinkingLevel: "medium", temperature: 0.7, maxOutputTokens: 32768 }),
    )
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 8192 })
    expect("temperature" in body).toBe(false)
  })

  it("budget 超过 max_tokens 时钳制到 max_tokens - 1", () => {
    const body = buildClaudeRequestBody(
      makeAdapterOpts({ thinkingLevel: "medium", maxOutputTokens: 4096 }),
    )
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 4095 })
  })

  it("低输出上限时钳制 budget < max_tokens", () => {
    expect(clampClaudeThinkingBudget(8192, 4096)).toBe(4095)
    expect(clampClaudeThinkingBudget(2048, 1024)).toBe(1023)
  })
})

describe("buildGeminiRequestBody", () => {
  it("assistant → model 角色 + systemInstruction", () => {
    const body = buildGeminiRequestBody(
      makeAdapterOpts({ systemPrompt: "你是助手" }),
    )
    const contents = body.contents as Array<{ role: string }>
    expect(contents.map((c) => c.role)).toEqual(["user", "model", "user"])
    expect(body.systemInstruction).toEqual({ parts: [{ text: "你是助手" }] })
    expect((body.generationConfig as Record<string, unknown>).maxOutputTokens).toBe(4096)
  })

  it("思考档位映射 thinkingBudget；off 不发送 thinkingConfig", () => {
    const withThinking = buildGeminiRequestBody(makeAdapterOpts({ thinkingLevel: "low" }))
    const gen = withThinking.generationConfig as Record<string, unknown>
    expect((gen.thinkingConfig as Record<string, unknown>).thinkingBudget).toBe(1024)

    const off = buildGeminiRequestBody(makeAdapterOpts({ thinkingLevel: "off" }))
    expect("thinkingConfig" in (off.generationConfig as object)).toBe(false)
  })
})

// ═══════════════ SSE 解析 ═══════════════

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let index = 0
  return new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(chunks[index++]))
    },
  })
}

describe("readSseStream", () => {
  it("跨 chunk 分块 + CRLF 兼容 + 多行 data 拼接", async () => {
    const events: string[] = []
    for await (const evt of readSseStream(
      sseBody(["eve", "nt: a\r\n", "data: 1\r", "\n\r\ndata: 2\n\n"]),
    )) {
      events.push(`${evt.event ?? ""}|${evt.data}`)
    }
    expect(events).toEqual(["a|1", "|2"])
  })

  it("忽略注释与 id 行", async () => {
    const events: string[] = []
    for await (const evt of readSseStream(
      sseBody([": keepalive\nid: 42\nevent: x\ndata: d\n\n"]),
    )) {
      events.push(`${evt.event ?? ""}|${evt.data}`)
    }
    expect(events).toEqual(["x|d"])
  })
})

// ═══════════════ OpenAI 流式解析（mock fetch） ═══════════════

describe("streamOpenAiCompatibleChat", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const chunks = [
          `data: ${JSON.stringify({ choices: [{ delta: { content: "你" } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "思考片段" } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: "好" } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3500, completion_tokens: 800 } })}\n\n`,
          "data: [DONE]\n\n",
        ].join("")
        return new Response(chunks, { status: 200 })
      }),
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  it("归一化输出 text/thinking/usage/done 事件", async () => {
    const events = []
    for await (const evt of streamOpenAiCompatibleChat(makeAdapterOpts())) {
      events.push(evt)
    }
    expect(events).toEqual([
      { type: "text_delta", text: "你" },
      { type: "thinking_delta", text: "思考片段" },
      { type: "text_delta", text: "好" },
      { type: "done", finishReason: "stop" },
      { type: "usage", inputTokens: 3500, outputTokens: 800 },
    ])
  })

  it("鉴权头与请求体正确", async () => {
    for await (const _ of streamOpenAiCompatibleChat(makeAdapterOpts())) {
      void _
    }
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      RequestInit,
    ]
    expect(url).toBe("https://api.example.com/v1/chat/completions")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test")
    expect(JSON.parse(String(init.body)).model).toBe("test-model")
  })

  it("HTTP 错误归一化为 error 事件", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ error: { message: "Invalid API key" } }),
          { status: 401 },
        ),
      ),
    )
    const events = []
    for await (const evt of streamOpenAiCompatibleChat(makeAdapterOpts())) {
      events.push(evt)
    }
    expect(events).toEqual([{ type: "error", message: "Invalid API key" }])
  })
})
