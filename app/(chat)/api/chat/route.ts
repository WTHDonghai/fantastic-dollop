import {
  convertToModelMessages,
  createUIMessageStream,
  JsonToSseTransformStream,
  smoothStream,
  stepCountIs,
} from 'ai';
import { auth, type UserType } from '@/app/(auth)/auth';
import { type RequestHints } from '@/lib/ai/prompts';
import {
  createStreamId,
  deleteChatById,
  getChatById,
  getMessageCountByUserId,
  getMessagesByChatId,
  saveChat,
  saveMessages,
} from '@/lib/db/queries';
import { convertToUIMessages, generateUUID } from '@/lib/utils';
import { generateTitleFromUserMessage } from '../../actions';
import { createDocument } from '@/lib/ai/tools/create-document';
import { updateDocument } from '@/lib/ai/tools/update-document';
import { requestSuggestions } from '@/lib/ai/tools/request-suggestions';
import { getWeather } from '@/lib/ai/tools/get-weather';
import { isProductionEnvironment, isTestEnvironment } from '@/lib/constants';

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
import { getLangGraphMessageStream } from '@/lib/langgraph/chat';

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

export async function POST(request: Request) {
  let requestBody: PostRequestBody;

  try {
    const json = await request.json();
    requestBody = postRequestBodySchema.parse(json);
    console.log(`== Chat Request: ${json} ==`)
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
          let lgStream: AsyncIterable<any> | null = null;
          try {
            lgStream = await getLangGraphMessageStream({
              threadId: id,
              selectedChatModel,
              requestHints,
              simpleMessages,
              title: chat?.title,
            });
          } catch (e: any) {
            console.error('[Chat Agent] getLangGraphMessageStream 调用失败', { message: e?.message, stack: e?.stack, error: e });
            throw e;
          }

          let eventCount = 0;
          // 同一条助手消息使用稳定的 ID，避免 UIMessageStream 关联失败
          const outMessageId = generateUUID();

          // 处理流式响应
          try {
            for await (const chunk of lgStream as AsyncIterable<any>) {
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

                    const msg_type: string = messageChunk?.type;
                    const content = messageChunk?.content;
                    const additional_kwargs = messageChunk?.additional_kwargs

                    // 兼容多种可能的 content 结构，提取字符串文本
                    let text: string | undefined;
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

                    if (msg_type === "AIMessageChunk") {
                      if (text && text.length) {
                        // console.log(`[Chat Agent] 输出文本增量, text-delta: "${text}"`);
                        dataStream.write({ id: outMessageId, type: 'text-delta', delta: text });
                      }

                      // 工具开始调用
                      if (additional_kwargs) {
                        if ("tool_calls" in additional_kwargs) {
                          const tool_calls: [any] = additional_kwargs?.tool_calls;

                          for (const tool_call of tool_calls) {
                            const tool_fun = tool_call?.function
                            const toolCallId = tool_call.id;

                            if (tool_fun) {
                              const toolName = tool_fun?.name;
                              const toolInput = tool_fun?.arguments;

                              console.log(`[Chat Agent] 调用工具: ${toolName}, toolInput: ${toolInput}`);
                              // dataStream.write({
                              //   id: outMessageId,
                              //   type: `tool-${toolName}`,
                              //   delta: {
                              //     toolCallId: toolCallId,
                              //   },
                              //   state: 'input-available',
                              // });

                            }
                          }
                        } // end of tool_calls
                      } // end of 'msg_type === AIMessageChunk and additional_kwargs'
                    } // end of msg_type === AIMessageChunk

                    // 工具执行完成，返回
                    if (msg_type == "tool") {
                      const toolName = messageChunk?.name;
                      const toolResult = messageChunk?.content;
                      const toolCallId = messageChunk?.id;
                      console.log(`[Chat Agent] Tool "${toolName}" 调用完成, 结果: ${toolResult}, toolCallId: ${toolCallId}`);
                      let parsedOutput;
                      if (typeof toolResult === 'string') {
                        try {
                          parsedOutput = JSON.parse(toolResult);
                        } catch (e) {
                          console.warn(e)
                        }
                      } else {
                        parsedOutput = toolResult;
                      }
                      console.log(`parsedOutput: ${JSON.stringify(parsedOutput)}`)
                      if (parsedOutput !== undefined) {
                        // 发送工具输出可用事件
                        // dataStream.write({
                        //   id: outMessageId,
                        //   type: 'tool-getWeather',
                        //   delta: {
                        //     toolCallId: toolCallId,
                        //     output: parsedOutput,
                        //   },
                        //   state: 'output-available',
                        // });
                        console.log(`[Caht Agent] Tool call end: ${JSON.stringify(messageChunk, null, 4)}`)
                      }
                    } // end of msg_type === "tool"
                  } // end of data is array instance
                }

                if ("end" === event) {
                  dataStream.write({ id: outMessageId, type: 'text-end' });
                  console.log(`text-end`)
                  dataStream.write({ type: 'finish-step' });
                  console.log(`finish-step`)
                  dataStream.write({ type: 'finish' });
                  console.log(`finish`)
                }
              }
            }
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
