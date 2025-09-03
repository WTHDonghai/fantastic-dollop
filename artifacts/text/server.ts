import { smoothStream } from 'ai';
import { Client } from '@langchain/langgraph-sdk';
import { createDocumentHandler } from '@/lib/artifacts/server';
import { updateDocumentPrompt } from '@/lib/ai/prompts';

export const textDocumentHandler = createDocumentHandler<'text'>({
  kind: 'text',
  onCreateDocument: async ({ title, dataStream }) => {
    let draftContent = '';

    // 创建 LangGraph 客户端
    const client = new Client({
      apiUrl: process.env.LANGGRAPH_API_URL || 'http://localhost:8000/api',
    });

    try {
      // 创建 assistant
      const assistant = await client.assistants.create({
        graphId: "text-artifact-agent",
        config: { 
          "tags": ["text", "artifact"], 
          "model": "openai/glm-4.5",
          "system_prompt": "Write about the given topic. Markdown is supported. Use headings wherever appropriate."
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
              const text = lastMessage.content;
              draftContent = text;
              
              dataStream.write({
                type: 'data-textDelta',
                data: text,
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
      console.error('[Text Artifact] 错误:', error);
      throw error;
    }

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
        graphId: "text-artifact-agent",
        config: { 
          "tags": ["text", "artifact", "update"], 
          "model": "openai/glm-4.5",
          "system_prompt": updateDocumentPrompt(document.content, 'text')
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
              const text = lastMessage.content;
              draftContent = text;
              
              dataStream.write({
                type: 'data-textDelta',
                data: text,
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
      console.error('[Text Artifact Update] 错误:', error);
      throw error;
    }

    return draftContent;
  },
});
