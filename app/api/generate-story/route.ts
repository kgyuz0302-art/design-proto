import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type StoryCandidate = {
  date: string;
  title: string;
  topics: string[];
  body: string;
};

type GenerateStoryRequest = {
  talkText?: unknown;
};

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

function jsonResponse(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: corsHeaders,
  });
}

function toText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function sanitizeTalkText(text: string) {
  return text
    .replace(/https?:\/\/[^\s]+/gi, "リンク")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "メール")
    .replace(/\b\d{2,4}[-\s]?\d{2,4}[-\s]?\d{3,4}\b/g, "電話番号")
    .replace(/(?:PayPay|LINE Pay|支払い|送金)[^\n\r]*/gi, "決済リンク")
    .slice(0, 6000);
}

function extractGeminiText(data: any) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) {
    return "";
  }

  return parts
    .map((part) => toText(part?.text))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function summarizeGeminiResponse(data: any) {
  return JSON.stringify({
    promptFeedback: data?.promptFeedback,
    candidates: Array.isArray(data?.candidates)
      ? data.candidates.map((candidate: any) => ({
          finishReason: candidate.finishReason,
          safetyRatings: candidate.safetyRatings,
          partTypes: Array.isArray(candidate?.content?.parts)
            ? candidate.content.parts.map((part: any) => Object.keys(part || {}))
            : [],
          textPreview: extractGeminiText({ candidates: [candidate] }).slice(0, 240),
        }))
      : [],
  });
}

function parseOutput(text: string): StoryCandidate[] {
  const trimmed = text.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Gemini response did not include JSON: ${trimmed.slice(0, 320)}`);
  }

  const parsed = JSON.parse(trimmed.slice(start, end + 1)) as { candidates?: StoryCandidate[] };

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

function buildPrompt(talkText: string) {
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

async function callGemini(talkText: string) {
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
        maxOutputTokens: 4096,
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
    } catch {
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

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders,
  });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as GenerateStoryRequest;
    const talkText = sanitizeTalkText(toText(body.talkText));

    if (!talkText) {
      return jsonResponse({ error: "talkText is required" }, 400);
    }

    const candidates = await callGemini(talkText);

    if (candidates.length === 0) {
      throw new Error("Gemini response candidates were empty");
    }

    return jsonResponse({ candidates });
  } catch (error) {
    console.error("Gemini story generation failed", error);
    return jsonResponse(
      {
        error: "Gemini story generation failed",
        detail: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
}
