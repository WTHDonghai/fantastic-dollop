import { z } from 'zod';
import type { Session } from 'next-auth';
import { tool, type UIMessageStreamWriter } from 'ai';
import { Client } from '@langchain/langgraph-sdk';
import { getDocumentById, saveSuggestions } from '@/lib/db/queries';
import type { Suggestion } from '@/lib/db/schema';
import { generateUUID } from '@/lib/utils';
import type { ChatMessage } from '@/lib/types';

interface RequestSuggestionsProps {
  session: Session;
  dataStream: UIMessageStreamWriter<ChatMessage>;
}

export const requestSuggestions = ({
  session,
  dataStream,
}: RequestSuggestionsProps) =>
  tool({
    description: 'Request suggestions for a document',
    inputSchema: z.object({
      documentId: z
        .string()
        .describe('The ID of the document to request edits'),
    }),
    execute: async ({ documentId }) => {
      const document = await getDocumentById({ id: documentId });

      if (!document || !document.content) {
        return {
          error: 'Document not found',
        };
      }

      const suggestions: Array<
        Omit<Suggestion, 'userId' | 'createdAt' | 'documentCreatedAt'>
      > = [];

      // 创建 LangGraph 客户端
      const client = new Client({
        apiUrl: process.env.LANGGRAPH_API_URL || 'http://localhost:8000/api',
      });

      try {
        // 创建 assistant
        const assistant = await client.assistants.create({
          graphId: "suggestions-agent",
          config: { 
            "tags": ["suggestions", "writing"], 
            "model": "openai/qwen-plus",
            "system_prompt": "You are a help writing assistant. Given a piece of writing, please offer suggestions to improve the piece of writing and describe the change. It is very important for the edits to contain full sentences instead of just words. Max 5 suggestions. Return your response as a JSON array with objects containing originalSentence, suggestedSentence, and description fields."
          },
          ifExists: "do_nothing",
        });

        // 创建线程
        const thread = await client.threads.create();

        // 开始流式处理
        const stream = await client.runs.stream(
          thread.thread_id,
          assistant.assistant_id,
          {
            config: assistant.config || {},
            streamMode: ["values", "messages"],
            input: {
              messages: [{
                role: 'user',
                content: document.content
              }],
            },
          }
        );

        // 处理流式响应
        for await (const chunk of stream) {
          if (chunk.event === "values" && chunk.data) {
            const data = chunk.data as any;
            
            if (data.messages && Array.isArray(data.messages)) {
              const lastMessage = data.messages[data.messages.length - 1];
              if (lastMessage && lastMessage.role === 'assistant' && lastMessage.content) {
                try {
                  // 尝试解析 JSON 响应
                  const suggestionsData = JSON.parse(lastMessage.content);
                  
                  if (Array.isArray(suggestionsData)) {
                    for (const element of suggestionsData) {
                      const suggestion: Suggestion = {
                        originalText: element.originalSentence || '',
                        suggestedText: element.suggestedSentence || '',
                        description: element.description || '',
                        id: generateUUID(),
                        documentId: documentId,
                        isResolved: false,
                      };

                      dataStream.write({
                        type: 'data-suggestion',
                        data: suggestion,
                        transient: true,
                      });

                      suggestions.push(suggestion);
                    }
                  }
                } catch (parseError) {
                  console.error('[Suggestions] JSON 解析错误:', parseError);
                }
              }
            }
          }
          
          if (chunk.event === "end") {
            break;
          }
        }
      } catch (error) {
        console.error('[Suggestions] 错误:', error);
        throw error;
      }

      if (session.user?.id) {
        const userId = session.user.id;

        await saveSuggestions({
          suggestions: suggestions.map((suggestion) => ({
            ...suggestion,
            userId,
            createdAt: new Date(),
            documentCreatedAt: document.createdAt,
          })),
        });
      }

      return {
        id: documentId,
        title: document.title,
        kind: document.kind,
        message: 'Suggestions have been added to the document',
      };
    },
  });
