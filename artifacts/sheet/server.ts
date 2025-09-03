import { Client } from '@langchain/langgraph-sdk';
import { sheetPrompt, updateDocumentPrompt } from '@/lib/ai/prompts';
import { createDocumentHandler } from '@/lib/artifacts/server';
import { z } from 'zod';

export const sheetDocumentHandler = createDocumentHandler<'sheet'>({
  kind: 'sheet',
  onCreateDocument: async ({ title, dataStream }) => {
    let draftContent = '';

    // 创建 LangGraph 客户端
    const client = new Client({
      apiUrl: process.env.LANGGRAPH_API_URL || 'http://localhost:8000/api',
    });

    try {
      // 创建 assistant
      const assistant = await client.assistants.create({
        graphId: "sheet-artifact-agent",
        config: { 
          "tags": ["sheet", "artifact"], 
          "model": "openai/glm-4.5",
          "system_prompt": sheetPrompt
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
              content: title
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
              const csv = lastMessage.content;
              draftContent = csv;
              
              dataStream.write({
                type: 'data-sheetDelta',
                data: csv,
                transient: true,
              });
            }
          }
        }
        
        if (chunk.event === "end") {
          break;
        }
      }
    } catch (error) {
      console.error('[Sheet Artifact] 错误:', error);
      throw error;
    }

    dataStream.write({
      type: 'data-sheetDelta',
      data: draftContent,
      transient: true,
    });

    return draftContent;
  },
  onUpdateDocument: async ({ document, description, dataStream }) => {
    let draftContent = '';

    // 创建 LangGraph 客户端
    const client = new Client({
      apiUrl: process.env.LANGGRAPH_API_URL || 'http://localhost:8000/api',
    });

    try {
      // 创建 assistant
      const assistant = await client.assistants.create({
        graphId: "sheet-artifact-agent",
        config: { 
          "tags": ["sheet", "artifact", "update"], 
          "model": "openai/glm-4.5",
          "system_prompt": updateDocumentPrompt(document.content, 'sheet')
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
              content: description
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
              const csv = lastMessage.content;
              draftContent = csv;
              
              dataStream.write({
                type: 'data-sheetDelta',
                data: csv,
                transient: true,
              });
            }
          }
        }
        
        if (chunk.event === "end") {
          break;
        }
      }
    } catch (error) {
      console.error('[Sheet Artifact Update] 错误:', error);
      throw error;
    }

    return draftContent;
  },
});
