import type { AiSummary, PreviewContent, CalendarEventInput, RssItem, AiEvent } from "../types.js";
import { htmlToText } from "./html.js";

export interface AiEnv {
  OLLAMA_HOST: string;
  OLLAMA_CONTENT_MODEL: string;
  OLLAMA_VISION_MODEL?: string;
}

interface OllamaResponse {
  message: {
    content: string;
  };
}

const JSON_FALLBACK: AiSummary = {
  summary: "요약 정보를 생성하지 못했습니다.",
  highlights: [],
  actionItems: [],
  links: [],
};


async function callOllamaChat(
  env: AiEnv,
  params: {
    model: string;
    messages: Array<{ role: string; content: string; images?: string[] }>;
    schema: Record<string, unknown>;
  },
): Promise<string> {
  let base = env.OLLAMA_HOST;
  while (base.endsWith("/")) base = base.slice(0, -1);
  const endpoint = `${base}/api/chat`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: params.model,
      messages: params.messages,
      format: params.schema,
      stream: false,
      options: { temperature: 0 },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama request failed (${response.status}): ${errorText.slice(0, 500)}`);
  }

  const data = (await response.json()) as OllamaResponse;
  return data.message.content;
}

async function parseJson(content: string | undefined): Promise<AiSummary> {
  if (!content) return JSON_FALLBACK;
  try {
    const data = JSON.parse(content);
    return {
      summary: data.summary ?? JSON_FALLBACK.summary,
      highlights: Array.isArray(data.highlights) ? data.highlights : [],
      actionItems: Array.isArray(data.actionItems) ? data.actionItems : [],
      links: Array.isArray(data.links) ? data.links : [],
      extractedText: typeof data.extractedText === "string" ? data.extractedText : undefined,
    } satisfies AiSummary;
  } catch (error) {
    console.error("Failed to parse AI JSON", error, content);
    return JSON_FALLBACK;
  }
}

export async function extractTextFromImage(
  env: AiEnv,
  preview: PreviewContent,
): Promise<string | undefined> {
  if (preview.sourceType !== "image" || !preview.imageBase64) return undefined;
  const visionModel = env.OLLAMA_VISION_MODEL ?? env.OLLAMA_CONTENT_MODEL;

  const schema = {
    type: "object",
    properties: {
      extractedText: { type: "string" },
    },
    required: ["extractedText"],
    additionalProperties: false,
  };

  try {
    const content = await callOllamaChat(env, {
      model: visionModel,
      messages: [
        {
          role: "system",
          content: "이미지에서 읽을 수 있는 모든 한국어 텍스트를 추출하는 OCR 어시스턴트입니다.",
        },
        {
          role: "user",
          content: "이미지에서 보이는 텍스트를 원문 그대로 추출해서 JSON 으로 반환해 주세요.",
          images: [preview.imageBase64],
        },
      ],
      schema,
    });

    const parsed = JSON.parse(content);
    return typeof parsed.extractedText === "string" ? parsed.extractedText : undefined;
  } catch (error) {
    console.error("Vision OCR failed", error);
    return undefined;
  }
}

export async function generateSummary(
  env: AiEnv,
  params: {
    title: string;
    description: string;
    previewText?: string;
    attachmentText?: string;
    link: string;
    pubDate: string;
  },
): Promise<AiSummary> {
  const { title, description, previewText, attachmentText, link, pubDate } = params;
  const prompt = [
    "다음 공지사항을 캘린더 설명용으로 간결하게 요약해 주세요. 본문을 옮기지 말고, 훑어볼 수 있는 수준으로 축약하세요.",
    "",
    `제목: ${title}`,
    `게시일: ${pubDate}`,
    `본문:\n${description}`,
    "",
    `첨부/미리보기:\n${previewText ?? "(없음)"}`,
    "",
    `첨부 메타:\n${attachmentText ?? "(없음)"}`,
    "",
    `원문 링크: ${link}`,
  ].join("\n");

  const schema = {
    type: "object",
    properties: {
      summary: { type: "string" },
      highlights: { type: "array", items: { type: "string" } },
      actionItems: { type: "array", items: { type: "string" } },
      links: { type: "array", items: { type: "string" } },
    },
    required: ["summary", "highlights", "actionItems", "links"],
    additionalProperties: false,
  };

  try {
    const content = await callOllamaChat(env, {
      model: env.OLLAMA_CONTENT_MODEL,
      messages: [
        {
          role: "system",
          content:
            `한국교원대학교 공지사항을 구글 캘린더 설명용으로 요약하는 어시스턴트입니다.

규칙:
- summary: 1~2문장. 핵심만 (누가, 무엇을, 왜). 본문을 그대로 옮기지 말 것.
- highlights: 최대 4개. 캘린더에서 빠르게 확인할 정보만 (대상, 장소, 신청방법 등).
  - 캘린더 이벤트 자체의 시작/종료 날짜와 중복되는 정보는 제외.
  - 각 항목은 "라벨: 값" 형식, 간결하게.
- actionItems: 최대 2개. 사용자가 반드시 해야 할 행동만 (신청, 제출 등). 단순 안내는 제외.
  - 동사로 시작, 한 줄로.
- links: 본문 내 외부 URL만. 원문 링크(${link})와 동일한 URL만 제외.
- 한국어로만 작성하세요.`,
        },
        { role: "user", content: prompt },
      ],
      schema,
    });
    return parseJson(content);
  } catch (error) {
    console.error("generateSummary failed", error);
    return JSON_FALLBACK;
  }
}

const EVENT_JSON_FALLBACK: CalendarEventInput = {
  title: "제목 없음",
  description: "설명 없음",
  startDate: new Date().toISOString().slice(0, 10),
  endDate: new Date().toISOString().slice(0, 10),
  startTime: undefined,
  endTime: undefined,
};

function buildEventInput(event: AiEvent, pubDate: string): CalendarEventInput {
  return {
    title: event.title ?? EVENT_JSON_FALLBACK.title,
    description: event.description ?? EVENT_JSON_FALLBACK.description,
    startDate: event.startDate ?? pubDate,
    endDate: event.endDate ?? (event.startDate ?? pubDate),
    startTime: typeof event.startTime === "string" ? event.startTime : undefined,
    endTime: typeof event.endTime === "string" ? event.endTime : undefined,
  };
}

async function parseEventJsonArray(content: string | undefined, pubDate: string): Promise<CalendarEventInput[]> {
  if (!content) return [];
  try {
    const data = JSON.parse(content);
    if (Array.isArray(data.events)) {
      const events = data.events as AiEvent[];
      return events
        .map((event) => buildEventInput(event, pubDate))
        .filter((event) => event.title && event.description);
    } else {
      console.warn("Unexpected response format: missing events array", content);
      return [];
    }
  } catch (error) {
    console.error("Failed to parse event JSON", error, content);
    return [];
  }
}

export async function generateEventInfos(
  env: AiEnv,
  item: RssItem,
  previewText?: string,
): Promise<CalendarEventInput[]> {
  const bodyText = htmlToText(item.descriptionHtml);
  const prompt = [
    "공지사항 정보를 분석하여 캘린더 이벤트를 JSON으로 추출해 주세요.",
    "",
    `제목: ${item.title}`,
    `게시일: ${item.pubDate}`,
    `본문:\n${bodyText}`,
    ...(previewText ? ["", `첨부 이미지 텍스트 (본문과 충돌 시 본문 우선):\n${previewText}`] : []),
    "",
    `RSS 링크: ${item.link}`,
  ].join("\n");

  const schema = {
    type: "object",
    properties: {
      events: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "행사 제목" },
            description: { type: "string", description: "행사 한 줄 요약 (최대 80자)" },
            startDate: { type: "string", description: "행사 시작일 YYYY-MM-DD" },
            endDate: { type: "string", description: "행사 종료일 YYYY-MM-DD" },
            startTime: { type: ["string", "null"], description: "시작 시각 HH:MM (24시간제) 또는 null" },
            endTime: { type: ["string", "null"], description: "종료 시각 HH:MM (24시간제) 또는 null" },
          },
          required: ["title", "description", "startDate", "endDate", "startTime", "endTime"],
          additionalProperties: false,
        },
      },
    },
    required: ["events"],
    additionalProperties: false,
  };

  try {
    const content = await callOllamaChat(env, {
      model: env.OLLAMA_CONTENT_MODEL,
      messages: [
        {
          role: "system",
          content: `한국교원대학교 공지사항에서 캘린더 일정 정보를 추출하는 어시스턴트입니다.

추출 규칙:
- 본문에 다수의 행사가 있으면 각각 개별 이벤트로 분리합니다.

■ 빈 events 배열 반환 조건:
- 구체적인 날짜(YYYY-MM-DD 또는 M월 D일 등)가 없는 일반 공지
- 인사 발령, 조직 변경, 시설 안내, 규정 변경 등 일정이 아닌 공지
- "추후 공지", "별도 안내" 등 날짜가 미정인 경우

■ 신청/접수 마감일만 있는 경우:
- 마감일을 startDate와 endDate로 사용하고, title에 "(마감)"을 포함합니다.

■ 날짜 처리:
- 연도가 명시된 경우: 해당 연도를 그대로 사용합니다.
- 연도가 없는 경우: 게시일의 연도를 기준으로 하되, 행사일이 게시일 이전이면 연도를 +1 조정합니다 (최대 +1년까지만 허용).
- 모든 행사일은 게시일 이후여야 합니다.

■ 시간 처리 (Asia/Seoul KST):
- 종일 행사 또는 시간 미명시: startTime, endTime 모두 null
- 시작 시간만 있는 경우: endTime을 null
- 형식: HH:MM (24시간제)

■ title 작성:
- 제목 맨 앞에 행사 성격을 나타내는 이모지를 1개 붙입니다.
  예시: 세미나·강연 🎓, 채용·모집 📢, 신청·접수 마감 📝, 시험·평가 📋,
        회의·간담회 🤝, 문화·축제 🎉, 시설·공간 🏢, 장학·지원 💰, 기타 📌

■ description 작성:
- 행사의 한 줄 요약, 최대 80자, 본문을 그대로 옮기지 말 것, 빈 문자열 불가

한국어로만 작성하세요.`,
        },
        { role: "user", content: prompt },
      ],
      schema,
    });
    return parseEventJsonArray(content, item.pubDate);
  } catch (error) {
    console.error("generateEventInfos failed", error);
    throw error;
  }
}
