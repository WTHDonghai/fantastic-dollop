import { Client } from '@langchain/langgraph-sdk';
import { createDocumentHandler } from '@/lib/artifacts/server';

export const imageDocumentHandler = createDocumentHandler<'image'>({
  kind: 'image',
  onCreateDocument: async ({ title, dataStream }) => {
    let draftContent = '';

    // 创建 LangGraph 客户端
    const client = new Client({
      apiUrl: process.env.LANGGRAPH_API_URL || 'http://localhost:8000/api',
    });

    try {
      // 创建 assistant
      const assistant = await client.assistants.create({
        graphId: "image-artifact-agent",
        config: { 
          "tags": ["image", "artifact"], 
          "model": "openai/dall-e-3",
          "system_prompt": "You are an AI assistant that generates images based on user prompts. Generate high-quality images that match the user's description."
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
              // 假设返回的是 base64 编码的图片数据
              const imageBase64 = lastMessage.content;
              draftContent = imageBase64;
              
              dataStream.write({
                type: 'data-imageDelta',
                data: imageBase64,
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
      console.error('[Image Artifact] 错误:', error);
      throw error;
    }

    return draftContent;
  },
  onUpdateDocument: async ({ description, dataStream }) => {
    let draftContent = '';

    // 创建 LangGraph 客户端
    const client = new Client({
      apiUrl: process.env.LANGGRAPH_API_URL || 'http://localhost:8000/api',
    });

    try {
      // 创建 assistant
      const assistant = await client.assistants.create({
        graphId: "image-artifact-agent",
        config: { 
          "tags": ["image", "artifact", "update"], 
          "model": "openai/dall-e-3",
          "system_prompt": "You are an AI assistant that generates images based on user prompts. Generate high-quality images that match the user's description."
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
              // 假设返回的是 base64 编码的图片数据
              const imageBase64 = lastMessage.content;
              draftContent = imageBase64;
              
              dataStream.write({
                type: 'data-imageDelta',
                data: imageBase64,
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
      console.error('[Image Artifact Update] 错误:', error);
      throw error;
    }

    return draftContent;
  },
});
