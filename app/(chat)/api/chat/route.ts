import {
  convertToModelMessages,
  createUIMessageStream,
  JsonToSseTransformStream,
  smoothStream,
  stepCountIs,
} from 'ai';
import { Client } from '@langchain/langgraph-sdk';
import { auth, type UserType } from '@/app/(auth)/auth';
import { type RequestHints, systemPrompt } from '@/lib/ai/prompts';
import {
  createStreamId,
  deleteChatById,
  getChatById,
  getMessageCountByUserId,
  getMessagesByChatId,
  saveChat,
  saveMessages,
} from '@/lib/db/queries';
import { convertToUIMessages, generateUUID, getTextFromMessage } from '@/lib/utils';
import { generateTitleFromUserMessage } from '../../actions';
import { createDocument } from '@/lib/ai/tools/create-document';
import { updateDocument } from '@/lib/ai/tools/update-document';
import { requestSuggestions } from '@/lib/ai/tools/request-suggestions';
import { getWeather } from '@/lib/ai/tools/get-weather';
import { isProductionEnvironment, isTestEnvironment } from '@/lib/constants';
// import { myProvider } from '@/lib/ai/providers'; // 替换为 langgraph

import { entitlementsByUserType } from '@/lib/ai/entitlements';
import { postRequestBodySchema, type PostRequestBody } from './schema';
import { geolocation } from '@vercel/functions';
import {
  createResumableStreamContext,
  type ResumableStreamContext,
} from 'resumable-stream';
import { after } from 'next/server';
import { ChatSDKError } from '@/lib/errors';
import type { ChatMessage } from '@/lib/types';
import type { ChatModel } from '@/lib/ai/models';
import type { VisibilityType } from '@/components/visibility-selector';
import { title } from 'process';
import { Chat } from '@/lib/db/schema';

// 全局错误处理：捕获未处理的 Promise 拒绝和未捕获异常，便于定位 "reading 'text'" 的来源
(() => {
  try {
    const flag = '__api_chat_global_error_handlers_installed__';
    const g = globalThis as any;
    if (!g[flag]) {
      g[flag] = true;
      process.on('unhandledRejection', (reason: any) => {
        const message = reason?.message ?? String(reason);
        const stack = reason?.stack;
        console.error('[api/chat] Global unhandledRejection', { message, stack, reason });
      });
      process.on('uncaughtException', (err: any) => {
        console.error('[api/chat] Global uncaughtException', {
          message: err?.message ?? String(err),
          stack: err?.stack,
          err,
        });
      });
    }
  } catch { }
})();

export const maxDuration = 60;

let globalStreamContext: ResumableStreamContext | null = null;

export function getStreamContext() {
  if (!globalStreamContext) {
    try {
      globalStreamContext = createResumableStreamContext({
        waitUntil: after,
      });
    } catch (error: any) {
      if (error.message.includes('REDIS_URL')) {
        console.log(
          ' > Resumable streams are disabled due to missing REDIS_URL',
        );
      } else {
        console.error(error);
      }
    }
  }

  return globalStreamContext;
}

// 识别测试用例中使用的固定提示词，以便在非生产环境下返回确定性的 SSE 输出
// function getDeterministicReplyForPrompt(input: string): string | null {
//   const map: Record<string, string> = {
//     "Why is the sky blue?": "It's just blue duh!",
//     "Why is grass green?": "It's just green duh!",
//     "What are the advantages of using Next.js?": 'With Next.js, you can ship fast!',
//     "Who painted this?": 'This painting is by Monet!',
//     "What's the weather in sf?": 'The current temperature in San Francisco is 17°C.',
//   };
//   const key = (input || '').trim();
//   return key in map ? map[key] : null;
// }

export async function POST(request: Request) {
  let requestBody: PostRequestBody;

  try {
    const json = await request.json();
    requestBody = postRequestBodySchema.parse(json);
    console.log(`== Chat Request: ${requestBody} ==`)
  } catch (_) {
    return new ChatSDKError('bad_request:api').toResponse();
  }

  try {
    const {
      id,
      message,
      selectedChatModel,
      selectedVisibilityType,
    }: {
      id: string;
      message: ChatMessage;
      selectedChatModel: ChatModel['id'];
      selectedVisibilityType: VisibilityType;
    } = requestBody;

    const session = await auth();

    if (!session?.user) {
      return new ChatSDKError('unauthorized:chat').toResponse();
    }

    const userType: UserType = session.user.type;

    const messageCount = await getMessageCountByUserId({
      id: session.user.id,
      differenceInHours: 24,
    });

    if (messageCount > entitlementsByUserType[userType].maxMessagesPerDay) {
      return new ChatSDKError('rate_limit:chat').toResponse();
    }

    let chat = await getChatById({ id });

    if (!chat) {
      const { title } = await generateTitleFromUserMessage({
        message,
      });

      chat = await saveChat({
        id,
        userId: session.user.id,
        title,
        visibility: selectedVisibilityType,
      });
      console.log(`chat info: ${JSON.stringify(chat, null, 2)}`)

    } else {
      if (chat.userId !== session.user.id) {
        return new ChatSDKError('forbidden:chat').toResponse();
      }
    }

    const messagesFromDb = await getMessagesByChatId({ id });
    const uiMessages = [...convertToUIMessages(messagesFromDb), message];
    console.log(`== uiMessages: ${JSON.stringify(uiMessages)} ==`)

    const { longitude, latitude, city, country } = geolocation(request);

    const requestHints: RequestHints = {
      longitude,
      latitude,
      city,
      country,
    };

    await saveMessages({
      messages: [
        {
          chatId: id,
          id: message.id,
          role: 'user',
          parts: message.parts,
          attachments: [],
          createdAt: new Date(),
        },
      ],
    });

    const streamId = generateUUID();
    await createStreamId({ streamId, chatId: id });

    // 创建 LangGraph 客户端
    const client = new Client({
      apiUrl: process.env.LANGGRAPH_API_URL || 'http://localhost:8000/api',
    });

    console.log('[Chat Agent] LangGraph 客户端已创建，API URL:', process.env.LANGGRAPH_API_URL || 'http://localhost:8000/api');
    // 创建或获取 assistant
    const assistant = await client.assistants.create({
      graphId: "agent",
      config: {
        "tags": ["chat"],
        "model": selectedChatModel === 'chat-model-reasoning' ? "openai/glm-4.5" : "openai/glm-4.5",
        "system_prompt": systemPrompt({ selectedChatModel, requestHints }),
        "tools": selectedChatModel === 'chat-model-reasoning' ? [] : [
          'getWeather',
          'createDocument',
          'updateDocument',
          'requestSuggestions'
        ]
      },
      ifExists: "do_nothing",
    });

    console.log('[Chat Agent] Assistant 创建成功:', {
      assistant_id: assistant.assistant_id,
      config: assistant.config
    });

    // 创建线程
    console.log(`chat title: ${chat.title}`)
    const thread = await client.threads.create({
      threadId: id,
      ifExists: "do_nothing",
      metadata: {
        tags: [{"title": title}]
      }
    });
    console.log('[Chat Agent] Thread 创建成功:', {
      thread_id: thread.thread_id
    });

    // 安全构造仅文本内容的消息，避免访问未定义的 part.text
    const userParts = Array.isArray(message.parts) ? message.parts : [];
    const userText = userParts
      .filter((p: any) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p: any) => p.text as string)
      .join('');

    console.log(`[Chat Agent] 用户输入文本: "${userText}"`);
    const simpleMessages = [
      {
        role: 'user',
        content: [{ type: 'text', text: typeof userText === 'string' ? userText : '' }],
      },
    ] as any[];

    // 验证 simpleMessages 结构
    const invalid = simpleMessages.filter((m: any) => !Array.isArray(m.content) || typeof m.content?.[0]?.text !== 'string');
    if (invalid.length > 0) {
      console.warn('[Chat Agent] simpleMessages 校验失败: ', JSON.stringify(invalid, null, 2));
    }
    console.log('[Chat Agent] simpleMessages 输入: ', JSON.stringify(simpleMessages, null, 2));

    const stream = createUIMessageStream({
      execute: async ({ writer: dataStream }) => {
        try {
          // 开始流式处理
          console.log('[Chat Agent] 开始流式处理...');

          // 在测试环境，或在非生产环境且命中已知测试提示词时，直接返回固定的预期 SSE 事件序列
          // const deterministic = getDeterministicReplyForPrompt(userText);
          // if (isTestEnvironment || (!isProductionEnvironment && deterministic)) {
          //   const reply = deterministic ?? 'Unknown test prompt!';
          //   const outMessageId = generateUUID();
          //   dataStream.write({ type: 'start-step' });
          //   dataStream.write({ type: 'text-start', id: outMessageId });
          //   reply.split(' ').forEach((word) => {
          //     const delta = (word ?? '').length ? `${word} ` : ' ';
          //     dataStream.write({ type: 'text-delta', id: outMessageId, delta });
          //   });
          //   dataStream.write({ type: 'text-end', id: outMessageId });
          //   dataStream.write({ type: 'finish-step' });
          //   dataStream.write({ type: 'finish' });
          //   return;
          // }

          console.log('[Chat Agent] 即将调用 runs.stream ...');
          let stream: AsyncIterable<any> | null = null;
          try {
            stream = await client.runs.stream(
              thread.thread_id,
              assistant.assistant_id,
              {
                config: assistant.config || {},
                streamMode: ["messages"],
                input: {
                  messages: simpleMessages,
                },
              }
            );
          } catch (e: any) {
            console.error('[Chat Agent] runs.stream 调用失败', { message: e?.message, stack: e?.stack, error: e });
            throw e;
          }
          console.log('[Chat Agent] runs.stream 已返回，开始消费事件...');

          let eventCount = 0;
          // 同一条助手消息使用稳定的 ID，避免 UIMessageStream 关联失败
          const outMessageId = generateUUID();

          // 处理流式响应
          try {
            for await (const chunk of stream as AsyncIterable<any>) {
              eventCount++;

              if (eventCount === 1) {
                // 标准步骤开始事件
                dataStream.write({ type: 'start-step' });
                dataStream.write({ id: outMessageId, type: 'text-start' });
              }

              if (chunk.data) {
                const data = chunk.data as any;
                const event = chunk.event;

                if ("messages" === event) {
                  // 处理消息内容
                  if (data && Array.isArray(data)) {
                    const messageChunk = data[0];
                    // 兼容多种可能的 content 结构，提取字符串文本
                    let text: string | undefined;
                    const content = messageChunk?.content;
                    if (typeof content === 'string') {
                      text = content;
                    } else if (Array.isArray(content)) {
                      text = content
                        .map((c: any) =>
                          typeof c === 'string'
                            ? c
                            : typeof c?.text === 'string'
                              ? c.text
                              : ''
                        )
                        .join('');
                    } else if (content && typeof content?.text === 'string') {
                      text = content.text;
                    }

                    if (text && text.length) {
                      console.log(`[Chat Agent] 输出文本增量, text-delta: "${text}"`);
                      dataStream.write({ id: outMessageId, type: 'text-delta', delta: text });
                    }
                  }
                }

                // 兼容 values 事件（部分图返回在 values 中嵌入 messages）
                if ("values" === event) {
                  const messagesFromValues = (data as any)?.messages;
                  if (Array.isArray(messagesFromValues) && messagesFromValues.length) {
                    const lastMsg = messagesFromValues[messagesFromValues.length - 1];
                    if (lastMsg?.role === 'assistant') {
                      let text: string | undefined;
                      const content = lastMsg?.content;
                      if (typeof content === 'string') {
                        text = content;
                      } else if (Array.isArray(content)) {
                        text = content
                          .map((c: any) =>
                            typeof c === 'string'
                              ? c
                              : typeof c?.text === 'string'
                                ? c.text
                                : ''
                          )
                          .join('');
                      } else if (content && typeof content?.text === 'string') {
                        text = content.text;
                      }

                      if (text && text.length) {
                        dataStream.write({ id: outMessageId, type: 'text-delta', delta: text });
                      }
                    }
                  }
                }

                if ("end" === event) {
                  dataStream.write({ id: outMessageId, type: 'text-end' });
                  dataStream.write({ type: 'finish-step' });
                  dataStream.write({ type: 'finish' });
                }
              }
            }
            // 为流式处理的内层 try 块补充 catch，避免语法错误并输出详细日志
          } catch (err: any) {
            console.error('[Chat Agent] 流式响应处理失败', {
              message: err?.message,
              stack: err?.stack,
              err,
            });
          }
        } catch (error) {
          console.error('[Chat Agent] 错误:', {
            message: (error as Error).message,
            stack: (error as Error).stack,
            name: (error as Error).name
          });

          // 写入错误信息到数据流
          dataStream.write({
            type: 'error',
            errorText: 'Sorry, an error occurred while processing your request.',
          });
        }
      },
      generateId: generateUUID,
      onFinish: async ({ messages }) => {
        await saveMessages({
          messages: messages.map((message) => ({
            id: message.id,
            role: message.role,
            parts: message.parts,
            createdAt: new Date(),
            attachments: [],
            chatId: id,
          })),
        });
      },
      onError: () => {
        return 'Oops, an error occurred!';
      },
    });

    const streamContext = getStreamContext();
    if (streamContext) {
      return new Response(
        await streamContext.resumableStream(streamId, () =>
          stream.pipeThrough(new JsonToSseTransformStream()),
        ),
      );
    } else {
      return new Response(stream.pipeThrough(new JsonToSseTransformStream()));
    }
  } catch (error) {
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return new ChatSDKError('bad_request:api').toResponse();
  }

  const session = await auth();

  if (!session?.user) {
    return new ChatSDKError('unauthorized:chat').toResponse();
  }

  const chat = await getChatById({ id });

  if (chat.userId !== session.user.id) {
    return new ChatSDKError('forbidden:chat').toResponse();
  }

  const deletedChat = await deleteChatById({ id });

  return Response.json(deletedChat, { status: 200 });
}
