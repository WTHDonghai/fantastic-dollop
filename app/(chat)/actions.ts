"use server";

import type { UIMessage } from 'ai';
import { cookies } from 'next/headers';
import {
  deleteMessagesByChatIdAfterTimestamp,
  getMessageById,
  updateChatVisiblityById,
} from '@/lib/db/queries';
import type { VisibilityType } from '@/components/visibility-selector';
import { Client } from '@langchain/langgraph-sdk';
import { getTextFromMessage } from '@/lib/utils';

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
      config: { "tags": ["title"], "model": "openai/glm-4.5" },
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

    // 安全提取用户文本，构造符合 LangGraph SDK 的标准消息结构
    const userText = getTextFromMessage(message as any) || '';
    const inputMessages = [
      {
        role: 'user',
        content: [{ type: 'text', text: userText }],
      },
    ] as any[];
    console.log('[Title Agent] 标题生成输入 messages:', JSON.stringify(inputMessages, null, 2));

    // console.log('[Title Agent] 开始流式处理...');
    const stream = await client.runs.stream(
      thread.thread_id,
      assistant.assistant_id,
      {
        config: assistant.config || {},
        streamMode: ["values"],
        input: {
          messages: inputMessages,
        },
      }
    );

    let title = '';
    let completed = false;
    let eventCount = 0;
    
    for await (const chunk of stream) {
      eventCount++;
      // console.log(`[Title Agent] 事件 #${eventCount}:`, {
      //   event: (chunk as any).event,
      //   data_type: typeof (chunk as any).data,
      //   data_preview: (chunk as any).data ? `${JSON.stringify((chunk as any).data).substring(0, 200)}...` : null
      // });
      
      // 处理 values 事件获取 title
      if ((chunk as any).event === "values" && (chunk as any).data) {
        const data = (chunk as any).data as any;
        if (data.title) {
          title = data.title;
          // console.log('[Title Agent] 从 values 事件获取到标题:', title);
        }
      }
      if ((chunk as any).event === "end") {
        completed = true;
        console.log('[Title Agent] 流处理完成，事件类型:', (chunk as any).event);
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
      message: (error as Error).message,
      stack: (error as Error).stack,
      name: (error as Error).name
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
