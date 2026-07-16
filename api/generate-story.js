const OpenAI = require("openai").default;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const storySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    candidates: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          date: { type: "string" },
          title: { type: "string" },
          topics: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            items: { type: "string" },
          },
          body: { type: "string" },
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

function parseOutput(text) {
  const trimmed = text.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  const parsed = JSON.parse(trimmed);

  if (!Array.isArray(parsed.candidates)) {
    throw new Error("OpenAI response did not include candidates");
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
    if (!process.env.OPENAI_API_KEY) {
      sendJson(response, 500, { error: "OPENAI_API_KEY is not configured" });
      return;
    }

    const talkText = sanitizeTalkText(toText(request.body && request.body.talkText));

    if (!talkText) {
      sendJson(response, 400, { error: "talkText is required" });
      return;
    }

    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    const result = await client.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      temperature: 0.45,
      text: {
        format: {
          type: "json_schema",
          name: "chat_diary_story_candidates",
          schema: storySchema,
          strict: true,
        },
      },
      input: [
        {
          role: "developer",
          content:
            "あなたは大学生向けサービス「CHATDIARY」の物語編集AIです。必ず入力されたLINE風トーク履歴だけを根拠にして、小さな出来事、空気感、関係性、感情の変化、物語になりそうな話題のまとまりを読み取り、短編小説シール候補を3件作ります。会話に出てこない予定、場所、持ち物、イベント、人物関係、感情、行動を新しく作らないでください。話題が1つしかない場合は、同じ会話を別の角度から3候補に分けてください。候補のtitleとtopicsは、入力会話から自然に分かる内容だけにしてください。実名、学校名、住所、電話番号、URL、支払い情報は出さないでください。LINEの文を大量に引用せず、ただし会話に存在する事実から離れずに、やさしく余韻のある短編小説として再構成してください。本文は各候補200〜350字程度。大学生が読んで自然な日本語にしてください。必ず指定JSONだけを返してください。",
        },
        {
          role: "user",
          content: `次のLINEトーク履歴だけを根拠にしてください。ここに書かれていない出来事は入れないでください。\n\nLINEトーク履歴:\n${talkText}`,
        },
      ],
    });

    const candidates = parseOutput(result.output_text || "");

    if (candidates.length === 0) {
      throw new Error("OpenAI response candidates were empty");
    }

    sendJson(response, 200, { candidates });
  } catch (error) {
    console.error("OpenAI story generation failed", error);
    sendJson(response, 500, {
      error: "OpenAI story generation failed",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};
