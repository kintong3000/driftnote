// Workers AI 封装：文本生成（要求 JSON 输出）和语音转录

export async function chatJSON(env, system, user) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await env.AI.run(env.LLM_MODEL, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      // 模型默认开启思考（最高档），整理和摘要用不上，关掉省时间和额度
      chat_template_kwargs: { enable_thinking: false },
      response_format: { type: "json_object" },
      max_tokens: 4096,
      temperature: 0.3,
    });
    const parsed = parseJSON(extractText(out));
    if (parsed) return parsed;
  }
  throw new Error("AI 输出无法解析为 JSON");
}

// 不同模型的返回格式不一样：{ response } 或 OpenAI 风格的 { choices }
function extractText(out) {
  if (typeof out === "string") return out;
  if (typeof out?.response === "string") return out.response;
  if (out?.response && typeof out.response === "object") return JSON.stringify(out.response);
  return out?.choices?.[0]?.message?.content ?? "";
}

function parseJSON(text) {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function transcribe(env, audio) {
  const out = await env.AI.run(env.STT_MODEL, {
    audio: toBase64(audio),
    language: "zh",
    initial_prompt: "以下是普通话的句子，使用简体中文。",
  });
  return (out?.text || "").trim();
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
