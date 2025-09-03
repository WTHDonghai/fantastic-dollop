import { Client } from '@langchain/langgraph-sdk';
import type { ChatModel } from '@/lib/ai/models';
import type { RequestHints } from '@/lib/ai/prompts';
import { systemPrompt } from '@/lib/ai/prompts';

/**
 * 获取 LangGraph 运行时的消息流
 *
 * 封装了以下流程：
 * 1) 创建 LangGraph Client（基于 LANGGRAPH_API_URL，默认为 http://localhost:8000/api）
 * 2) 创建（或幂等获取）Thread
 * 3) 创建（或幂等获取）Assistant，并生成系统提示与工具配置
 * 4) 调用 runs.stream 返回可迭代的消息流（event/data 结构）
 *
 * 注意：本方法不做 UI 层的数据拼装，仅返回 LangGraph 的原始流，
 *       由上层调用者按需解析为 UIMessageStream 所需事件。
 */
export async function getLangGraphMessageStream(params: {
  /** 线程 ID，建议与 chatId 保持一致 */
  threadId: string;
  /** 选中的聊天模型 ID */
  selectedChatModel: ChatModel['id'];
  /** 请求上下文提示（地理位置等） */
  requestHints: RequestHints;
  /** 用户输入的极简消息结构（仅文本） */
  simpleMessages: any[];
  /** 可选：首次创建 Thread 时用于写入的标题元数据 */
  title?: string;
}): Promise<AsyncIterable<any>> {
  const { threadId, selectedChatModel, requestHints, simpleMessages, title } = params;

  // 1) 创建 LangGraph 客户端
  const client = new Client({
    apiUrl: process.env.LANGGRAPH_API_URL || 'http://localhost:8000/api',
  });
  console.log('[Chat Agent] LangGraph 客户端已创建，API URL:', process.env.LANGGRAPH_API_URL || 'http://localhost:8000/api');

  // 2) 幂等创建/获取 Thread
  const thread = await client.threads.create({
    threadId,
    metadata: title ? { tags: [{ title }] } : undefined,
    ifExists: 'do_nothing',
  });
  console.log('[Chat Agent] Thread 就绪:', { thread_id: thread.thread_id });

  // 3) 幂等创建/获取 Assistant
  const assistant = await client.assistants.create({
    graphId: 'agent',
    config: {
      tags: ['chat'],
      model: selectedChatModel === 'chat-model-reasoning' ? 'openai/glm-4.5' : 'openai/glm-4.5',
      system_prompt: systemPrompt({ selectedChatModel, requestHints }),
      tools: selectedChatModel === 'chat-model-reasoning' ? [] : [
        'getWeather',
        'createDocument',
        'updateDocument',
        'requestSuggestions',
      ],
    },
    ifExists: 'do_nothing',
  });
  console.log('[Chat Agent] Assistant 就绪:', {
    assistant_id: assistant.assistant_id,
    config: assistant.config,
  });

  // 4) 发起流式运行
  const stream = await client.runs.stream(
    thread.thread_id,
    assistant.assistant_id,
    {
      config: assistant.config || {},
      streamMode: ['messages'],
      input: { messages: simpleMessages },
    },
  );

  console.log('[Chat Agent] runs.stream 已返回（封装层）');
  return stream as AsyncIterable<any>;
}