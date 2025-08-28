'use server';

import { generateText, type UIMessage } from 'ai';
import { cookies } from 'next/headers';
import {
  deleteMessagesByChatIdAfterTimestamp,
  getMessageById,
  updateChatVisiblityById,
} from '@/lib/db/queries';
import type { VisibilityType } from '@/components/visibility-selector';
import { myProvider } from '@/lib/ai/providers';
import { Client } from '@langchain/langgraph-sdk';

export async function saveChatModelAsCookie(model: string) {
  const cookieStore = await cookies();
  cookieStore.set('chat-model', model);
}

/**
 * 从用户消息生成标题
 * @param message - 用户输入的消息
 * @returns 包含生成的标题和线程ID的对象
 */
export async function generateTitleFromUserMessage({
  message,
}: {
  message: UIMessage;
}) {
  console.log('[Title Agent] 开始生成标题，输入消息:', JSON.stringify(message, null, 2));
  
  const client = new Client({
    apiUrl: process.env.LANGGRAPH_API_URL || 'http://localhost:8000/api',
  });
  console.log('[Title Agent] LangGraph 客户端已创建，API URL:', process.env.LANGGRAPH_API_URL || 'http://localhost:8000/api');

  try {
    const assistant = await client.assistants.create({
      graphId: "title-agent",
      config: { "tags": ["title", "e2e"], "model": "openai/glm-4.5" },
      ifExists: "do_nothing",
    });
    console.log('[Title Agent] Assistant 创建成功:', {
      assistant_id: assistant.assistant_id,
      config: assistant.config
    });

    const thread = await client.threads.create();
    console.log('[Title Agent] Thread 创建成功:', {
      thread_id: thread.thread_id
    });

    console.log('[Title Agent] 开始流式处理...');
    const stream = await client.runs.stream(
      thread.thread_id,
      assistant.assistant_id,
      {
        config: assistant.config || {},
        streamMode: ["values", "messages"], // 添加 stream mode 配置
        input: {
          messages: [
            {
              role: 'user',
              content: JSON.stringify(message)
            },
          ],
        },
      }
    );

    let title = '';
    let completed = false;
    let eventCount = 0;
    
    for await (const chunk of stream) {
      eventCount++;
      console.log(`[Title Agent] 事件 #${eventCount}:`, {
        event: chunk.event,
        data_type: typeof chunk.data,
        data_preview: chunk.data ? JSON.stringify(chunk.data).substring(0, 200) + '...' : null
      });
      
      // 处理 values 事件获取 title
      if (chunk.event === "values" && chunk.data) {
        const data = chunk.data as any;
        if (data.title) {
          title = data.title;
          console.log('[Title Agent] 从 values 事件获取到标题:', title);
        }
      }
      if (chunk.event === "end") {
          completed = true
        console.log('[Title Agent] 流处理完成，事件类型:', chunk.event);
      }
    }

    if (!completed) {
      console.warn('[Title Agent] 警告: 流处理未正常完成');
    }

    if (!title || title.trim() === '') {
      console.warn('[Title Agent] 警告: 未生成有效标题');
    }

    const result = { title, threadId: thread.thread_id };
    console.log('[Title Agent] 最终结果:', result);
    return result;
    
  } catch (error) {
    console.error('[Title Agent] 错误:', {
      message: error.message,
      stack: error.stack,
      name: error.name
    });
    throw error;
  }
}

export async function deleteTrailingMessages({ id }: { id: string }) {
  const [message] = await getMessageById({ id });

  await deleteMessagesByChatIdAfterTimestamp({
    chatId: message.chatId,
    timestamp: message.createdAt,
  });
}

export async function updateChatVisibility({
  chatId,
  visibility,
}: {
  chatId: string;
  visibility: VisibilityType;
}) {
  await updateChatVisiblityById({ chatId, visibility });
}
