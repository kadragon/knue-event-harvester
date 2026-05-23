import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractTextFromImage, generateSummary, generateEventInfos, type AiEnv } from '../../src/lib/ai.js';
import type { PreviewContent, RssItem } from '../../src/types.js';

// Mock fetch globally
const fetchMock = vi.fn();
global.fetch = fetchMock;

// Ollama response format: { message: { content: "..." } }
function ollamaOk(content: unknown) {
  return {
    ok: true,
    json: () => Promise.resolve({ message: { content: JSON.stringify(content) } }),
  };
}

function ollamaError(status = 500, body = 'Internal Server Error') {
  return {
    ok: false,
    status,
    text: () => Promise.resolve(body),
  };
}

describe('AI Module', () => {
  let mockEnv: AiEnv;

  beforeEach(() => {
    mockEnv = {
      OLLAMA_HOST: 'http://127.0.0.1:11434',
      OLLAMA_CONTENT_MODEL: 'llama3.1:8b',
      OLLAMA_VISION_MODEL: 'llama3.2-vision',
    };
    vi.clearAllMocks();
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('generateSummary', () => {
    it('should generate summary successfully', async () => {
      fetchMock.mockResolvedValueOnce(ollamaOk({
        summary: '공지사항 요약',
        highlights: ['중요 포인트 1', '중요 포인트 2'],
        actionItems: ['행동 항목 1'],
        links: ['http://example.com'],
      }));

      const result = await generateSummary(mockEnv, {
        title: '테스트 공지',
        description: '공지 내용',
        previewText: '미리보기 텍스트',
        attachmentText: '첨부 텍스트',
        link: 'http://example.com',
        pubDate: '2023-01-01',
      });

      expect(result).toEqual({
        summary: '공지사항 요약',
        highlights: ['중요 포인트 1', '중요 포인트 2'],
        actionItems: ['행동 항목 1'],
        links: ['http://example.com'],
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://127.0.0.1:11434/api/chat');
      const body = JSON.parse(init.body);
      expect(body.model).toBe('llama3.1:8b');
      expect(body.stream).toBe(false);
      expect(body.format).toBeDefined();
    });

    it('should return fallback on Ollama error', async () => {
      fetchMock.mockResolvedValueOnce(ollamaError());

      const result = await generateSummary(mockEnv, {
        title: '테스트',
        description: '내용',
        link: 'http://example.com',
        pubDate: '2023-01-01',
      });

      expect(result).toEqual({
        summary: '요약 정보를 생성하지 못했습니다.',
        highlights: [],
        actionItems: [],
        links: [],
      });
    });

    it('should handle malformed JSON response', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ message: { content: 'invalid json' } }),
      });

      const result = await generateSummary(mockEnv, {
        title: '테스트',
        description: '내용',
        link: 'http://example.com',
        pubDate: '2023-01-01',
      });

      expect(result).toEqual({
        summary: '요약 정보를 생성하지 못했습니다.',
        highlights: [],
        actionItems: [],
        links: [],
      });
    });

    it('should handle partial JSON response', async () => {
      fetchMock.mockResolvedValueOnce(ollamaOk({
        summary: '요약',
        highlights: 'not an array', // Invalid type
        actionItems: ['valid item'],
      }));

      const result = await generateSummary(mockEnv, {
        title: '테스트',
        description: '내용',
        link: 'http://example.com',
        pubDate: '2023-01-01',
      });

      expect(result).toEqual({
        summary: '요약',
        highlights: [],
        actionItems: ['valid item'],
        links: [],
      });
    });
  });

  describe('extractTextFromImage', () => {
    it('should extract text from image successfully', async () => {
      fetchMock.mockResolvedValueOnce(ollamaOk({ extractedText: '추출된 텍스트' }));

      const preview: PreviewContent = {
        sourceType: 'image',
        imageBase64: 'base64-image-data',
        contentType: 'image/png',
      };

      const result = await extractTextFromImage(mockEnv, preview);

      expect(result).toBe('추출된 텍스트');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://127.0.0.1:11434/api/chat');
      const body = JSON.parse(init.body);
      expect(body.model).toBe('llama3.2-vision');
      // Ollama native vision format: images[] on the user message
      const userMessage = body.messages[1];
      expect(userMessage.images).toContain('base64-image-data');
      expect(typeof userMessage.content).toBe('string');
    });

    it('should fall back to OLLAMA_CONTENT_MODEL when OLLAMA_VISION_MODEL is not set', async () => {
      const envWithoutVision: AiEnv = {
        OLLAMA_HOST: 'http://127.0.0.1:11434',
        OLLAMA_CONTENT_MODEL: 'llama3.1:8b',
        // No OLLAMA_VISION_MODEL — should fall back to content model
      };

      fetchMock.mockResolvedValueOnce(ollamaOk({ extractedText: 'fallback text' }));

      const preview: PreviewContent = {
        sourceType: 'image',
        imageBase64: 'data',
      };

      const result = await extractTextFromImage(envWithoutVision, preview);

      expect(result).toBe('fallback text');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0];
      const body = JSON.parse(init.body);
      expect(body.model).toBe('llama3.1:8b'); // Falls back to content model
    });

    it('should return undefined for non-image content', async () => {
      const preview: PreviewContent = {
        sourceType: 'text',
        text: 'some text',
      };

      const result = await extractTextFromImage(mockEnv, preview);
      expect(result).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should return undefined for image without base64 data', async () => {
      const preview: PreviewContent = {
        sourceType: 'image',
      };

      const result = await extractTextFromImage(mockEnv, preview);
      expect(result).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should return undefined on Ollama error', async () => {
      fetchMock.mockResolvedValueOnce(ollamaError(429, 'Rate limited'));

      const preview: PreviewContent = {
        sourceType: 'image',
        imageBase64: 'data',
      };

      const result = await extractTextFromImage(mockEnv, preview);
      expect(result).toBeUndefined();
    });

    it('should handle malformed OCR JSON response', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ message: { content: 'not json' } }),
      });

      const preview: PreviewContent = {
        sourceType: 'image',
        imageBase64: 'data',
      };

      const result = await extractTextFromImage(mockEnv, preview);
      expect(result).toBeUndefined();
    });

    it('should handle OCR response without extractedText', async () => {
      fetchMock.mockResolvedValueOnce(ollamaOk({ otherField: 'value' }));

      const preview: PreviewContent = {
        sourceType: 'image',
        imageBase64: 'data',
      };

      const result = await extractTextFromImage(mockEnv, preview);
      expect(result).toBeUndefined();
    });
  });

  describe('generateEventInfos', () => {
    let mockItem: RssItem;

    beforeEach(() => {
      mockItem = {
        id: '123',
        title: '2025학년도 봄학기 수강신청',
        link: 'https://example.com/notice/123',
        pubDate: '2025-10-28',
        descriptionHtml: '<p>수강신청 일정: 2025-11-01 ~ 2025-11-03</p>',
      };
    });

    it('should generate event infos with single event', async () => {
      fetchMock.mockResolvedValueOnce(ollamaOk({
        events: [
          {
            title: '수강신청',
            description: '봄학기 수강신청',
            startDate: '2025-11-01',
            endDate: '2025-11-03',
            startTime: null,
            endTime: null,
          },
        ],
      }));

      const result = await generateEventInfos(mockEnv, mockItem);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        title: '수강신청',
        description: '봄학기 수강신청',
        startDate: '2025-11-01',
        endDate: '2025-11-03',
        startTime: undefined,
        endTime: undefined,
      });
    });

    it('should generate event infos with multiple events', async () => {
      fetchMock.mockResolvedValueOnce(ollamaOk({
        events: [
          {
            title: '행사 1',
            description: '설명 1',
            startDate: '2025-11-01',
            endDate: '2025-11-01',
            startTime: null,
            endTime: null,
          },
          {
            title: '행사 2',
            description: '설명 2',
            startDate: '2025-11-10',
            endDate: '2025-11-12',
            startTime: '09:00',
            endTime: '17:00',
          },
        ],
      }));

      const result = await generateEventInfos(mockEnv, mockItem);

      expect(result).toHaveLength(2);
      expect(result[1].startTime).toBe('09:00');
      expect(result[1].endTime).toBe('17:00');
    });

    it('should use pubDate as fallback when startDate not provided', async () => {
      fetchMock.mockResolvedValueOnce(ollamaOk({
        events: [{ title: '행사', description: '설명' }],
      }));

      const result = await generateEventInfos(mockEnv, mockItem);

      expect(result[0].startDate).toBe(mockItem.pubDate);
      expect(result[0].endDate).toBe(mockItem.pubDate);
    });

    it('should throw on Ollama error', async () => {
      fetchMock.mockResolvedValueOnce(ollamaError());

      await expect(generateEventInfos(mockEnv, mockItem)).rejects.toThrow('Ollama request failed');
    });

    it('should handle malformed JSON response and return empty array', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ message: { content: 'invalid json' } }),
      });

      const result = await generateEventInfos(mockEnv, mockItem);

      expect(result).toHaveLength(0);
    });

    it('should return empty array when events array is missing from response', async () => {
      fetchMock.mockResolvedValueOnce(ollamaOk({
        title: '단일 행사',
        description: '배열이 아닌 단일 객체',
      }));

      const result = await generateEventInfos(mockEnv, mockItem);
      expect(result).toHaveLength(0);
    });

    it('should return empty array when AI returns empty events array', async () => {
      fetchMock.mockResolvedValueOnce(ollamaOk({ events: [] }));

      const result = await generateEventInfos(mockEnv, mockItem);
      expect(result).toHaveLength(0);
    });

    it('should call Ollama /api/chat with correct structure', async () => {
      fetchMock.mockResolvedValueOnce(ollamaOk({ events: [{ title: 'test', description: 'test' }] }));

      await generateEventInfos(mockEnv, mockItem);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://127.0.0.1:11434/api/chat');
      const body = JSON.parse(init.body);
      expect(body.model).toBe(mockEnv.OLLAMA_CONTENT_MODEL);
      expect(body.stream).toBe(false);
      expect(body.format).toBeDefined();
      expect(body.messages[1].content).toContain(mockItem.title);
      expect(body.messages[1].content).toContain(mockItem.pubDate);
    });

    // Double-escaping prevention tests
    describe('double-escaping prevention in descriptionHtml', () => {
      it('should not double-decode &amp;lt; in description (should stay as &lt;)', async () => {
        const itemWithDoubleEncoded: RssItem = {
          ...mockItem,
          descriptionHtml: '<p>Use &amp;lt;br&amp;gt; for breaks</p>',
        };

        fetchMock.mockResolvedValueOnce(ollamaOk({ events: [{ title: 'test', description: 'test' }] }));

        await generateEventInfos(mockEnv, itemWithDoubleEncoded);

        const [, init] = fetchMock.mock.calls[0];
        const body = JSON.parse(init.body);
        const promptContent = body.messages[1].content;

        expect(promptContent).toContain('&lt;br&gt;');
        expect(promptContent).not.toContain('<br>');
      });

      it('should decode single-level entities correctly', async () => {
        const itemWithSingleEncoded: RssItem = {
          ...mockItem,
          descriptionHtml: '<p>Date: 2025-01-01 &amp; Time: 09:00</p>',
        };

        fetchMock.mockResolvedValueOnce(ollamaOk({ events: [{ title: 'test', description: 'test' }] }));

        await generateEventInfos(mockEnv, itemWithSingleEncoded);

        const [, init] = fetchMock.mock.calls[0];
        const body = JSON.parse(init.body);
        expect(body.messages[1].content).toContain('2025-01-01 & Time: 09:00');
      });

      it('should handle mixed single and double-encoded entities', async () => {
        const itemWithMixed: RssItem = {
          ...mockItem,
          descriptionHtml: '<p>&lt;script&gt; and &amp;amp; and &amp;lt;tag&amp;gt;</p>',
        };

        fetchMock.mockResolvedValueOnce(ollamaOk({ events: [{ title: 'test', description: 'test' }] }));

        await generateEventInfos(mockEnv, itemWithMixed);

        const [, init] = fetchMock.mock.calls[0];
        const body = JSON.parse(init.body);
        const promptContent = body.messages[1].content;

        expect(promptContent).toContain('<script>');
        expect(promptContent).toContain('&amp;');
        expect(promptContent).toContain('&lt;tag&gt;');
      });

      it('should handle numeric entities without double-decoding', async () => {
        const itemWithNumeric: RssItem = {
          ...mockItem,
          descriptionHtml: '<p>Café &#233; and &#x3A9; Omega</p>',
        };

        fetchMock.mockResolvedValueOnce(ollamaOk({ events: [{ title: 'test', description: 'test' }] }));

        await generateEventInfos(mockEnv, itemWithNumeric);

        const [, init] = fetchMock.mock.calls[0];
        const body = JSON.parse(init.body);
        const promptContent = body.messages[1].content;

        expect(promptContent).toContain('Café é');
        expect(promptContent).toContain('Ω Omega');
      });
    });
  });
});
