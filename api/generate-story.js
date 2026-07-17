const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";

const geminiResponseSchema = {
  type: "OBJECT",
  properties: {
    candidates: {
      type: "ARRAY",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "OBJECT",
        properties: {
          date: { type: "STRING" },
          title: { type: "STRING" },
          topics: {
            type: "ARRAY",
            minItems: 1,
            maxItems: 4,
            items: { type: "STRING" },
          },
          body: { type: "STRING" },
        },
        required: ["date", "title", "topics", "body"],
      },
    },
  },
  required: ["candidates"],
};

function sendJson(response, status, body) {
  Object.entries(corsHeaders).forEach(([key, value]) => {
    response.setHeader(key, value);
  });
  response.status(status).json(body);
}

function toText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sanitizeTalkText(text) {
  return text
    .replace(/https?:\/\/[^\s]+/gi, "リンク")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "メール")
    .replace(/\b\d{2,4}[-\s]?\d{2,4}[-\s]?\d{3,4}\b/g, "電話番号")
    .replace(/(?:PayPay|LINE Pay|支払い|送金)[^\n\r]*/gi, "決済リンク")
    .slice(0, 6000);
}

function extractGeminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) {
    return "";
  }

  return parts
    .map((part) => toText(part && part.text))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function summarizeGeminiResponse(data) {
  return JSON.stringify({
    promptFeedback: data?.promptFeedback,
    candidates: Array.isArray(data?.candidates)
      ? data.candidates.map((candidate) => ({
          finishReason: candidate.finishReason,
          safetyRatings: candidate.safetyRatings,
          partTypes: Array.isArray(candidate?.content?.parts)
            ? candidate.content.parts.map((part) => Object.keys(part || {}))
            : [],
          textPreview: extractGeminiText({ candidates: [candidate] }).slice(0, 240),
        }))
      : [],
  });
}

function parseOutput(text) {
  const trimmed = text.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Gemini response did not include JSON: ${trimmed.slice(0, 320)}`);
  }

  const parsed = JSON.parse(trimmed.slice(start, end + 1));

  if (!Array.isArray(parsed.candidates)) {
    throw new Error("Gemini response did not include candidates");
  }

  return parsed.candidates
    .slice(0, 3)
    .map((candidate) => ({
      date: toText(candidate.date) || "日付なし",
      title: toText(candidate.title) || "小さな会話",
      topics: Array.isArray(candidate.topics)
        ? candidate.topics.map(toText).filter(Boolean).slice(0, 4)
        : ["会話"],
      body: toText(candidate.body),
    }))
    .filter((candidate) => candidate.body.length > 0);
}

function buildPrompt(talkText) {
  return `あなたは大学生向けサービス「CHATDIARY」の物語生成AIです。
次のLINE風トーク履歴だけを根拠にして、小説候補を3件作ってください。

重要なルール:
- 入力に書かれていない出来事、場所、人物関係、感情を新しく作らない
- 実名、学校名、住所、電話番号、URL、決済情報は出さない
- LINEの文をそのまま大量に引用しない
- 単なる要約ではなく、会話から見える小さな出来事を短い物語として再構成する
- 候補ごとに、切り取る話題や角度を変える
- 本文は各候補200〜350字程度
- 大学生が読んで自然な、やさしく余韻のある日本語にする
- 必ずJSONだけを返す

返す形式:
{
  "candidates": [
    {
      "date": "2026/06/27(土)",
      "title": "迎え",
      "topics": ["迎え", "待ち合わせ", "安心"],
      "body": "短い物語本文"
    }
  ]
}

LINEトーク履歴:
${talkText}`;
}

async function callGemini(talkText) {
  const apiKey =
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  const rawModel = process.env.GEMINI_MODEL || "gemini-3.5-flash";
  const model = rawModel.replace(/^models\//, "");
  const url = `${GEMINI_ENDPOINT}/models/${encodeURIComponent(model)}:generateContent`;

  const geminiResponse = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: buildPrompt(talkText) }],
        },
      ],
      generationConfig: {
        temperature: 0.55,
        maxOutputTokens: 1800,
        response_mime_type: "application/json",
        response_schema: geminiResponseSchema,
      },
    }),
  });

  const responseText = await geminiResponse.text();

  if (!geminiResponse.ok) {
    let detail = responseText;
    try {
      const errorJson = JSON.parse(responseText);
      detail = errorJson?.error?.message || responseText;
    } catch (_) {
      // Keep the raw response text.
    }
    throw new Error(`Gemini API returned ${geminiResponse.status}: ${detail}`);
  }

  const data = JSON.parse(responseText);
  const outputText = extractGeminiText(data);
  if (!outputText) {
    throw new Error(`Gemini response text was empty: ${summarizeGeminiResponse(data)}`);
  }
  return parseOutput(outputText);
}

module.exports = async function handler(request, response) {
  if (request.method === "OPTIONS") {
    Object.entries(corsHeaders).forEach(([key, value]) => {
      response.setHeader(key, value);
    });
    response.status(204).end();
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const talkText = sanitizeTalkText(toText(request.body && request.body.talkText));

    if (!talkText) {
      sendJson(response, 400, { error: "talkText is required" });
      return;
    }

    const candidates = await callGemini(talkText);

    if (candidates.length === 0) {
      throw new Error("Gemini response candidates were empty");
    }

    sendJson(response, 200, { candidates });
  } catch (error) {
    console.error("Gemini story generation failed", error);
    sendJson(response, 500, {
      error: "Gemini story generation failed",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};
