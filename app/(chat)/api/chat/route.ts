import {
  createUIMessageStream,
  JsonToSseTransformStream,
} from 'ai';
import { auth, type UserType } from '@/app/(auth)/auth';
import type { RequestHints } from '@/lib/ai/prompts';
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
import { artifactKinds } from '@/lib/artifacts/server';

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
    console.log(`== city: ${city}, country: ${country} ==`);

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
          // 跟踪是否已开始步骤与文本块，确保工具组件与文本顺序正确
          let stepStarted = false;
          let textOpen = false;
          class ToolCallInfo {
            id = '';
            name = '';
            documentId?: string;
            args?: any;
            data?: any;
            status: 'pending' | 'completed' | 'error' = 'pending';
          }
          const toolCallMappings: Map<string, ToolCallInfo> = new Map<string, ToolCallInfo>(); // toolCallId: obj

          // 处理流式响应
          try {
            for await (const chunk of lgStream as AsyncIterable<any>) {
              eventCount++;

              if (!stepStarted) {
                // 标准步骤开始事件（仅一次）
                dataStream.write({ type: 'start-step' });
                stepStarted = true;
              }

              if (chunk.data) {
                const data = chunk.data as any;
                const event = chunk.event;

                switch (event) {
                  case "values":
                    if (data.messages) {
                      const lastValueMessage = data.messages.at(-1)
                      console.log(`== > lastValuemessage: ${JSON.stringify(data.messages.at(-1), null, 4)} ==`)

                      // 有时带上 run作为前缀,只有在tool调用的过程才出现
                      // [TODO]: 考虑作为document id?
                      const lastValueId = lastValueMessage.id

                      // 只有tpye === 'tool'的时候才有值，表示工具的返回
                      const lastValueToolCallId = lastValueMessage.tool_call_id
                      // type === 'tool'的时候, 值为tool name
                      const lastValueName = lastValueMessage.name
                      const lastValueToolCalls: [] = lastValueMessage.tool_calls ? lastValueMessage.tool_calls : []
                      const lastValueContent = lastValueMessage.content
                      const lastValueArtifact = lastValueMessage.artifact

                      if (lastValueMessage.type === "ai") {
                        // [TODO]: 工具调用开始
                        lastValueToolCalls.forEach((tool_call: any) => {
                          console.log(`[Chat Agent]: ${tool_call.name}工具调用开始`)
                          console.log(`[Chat Agent]: ${tool_call.name}Args:${tool_call?.args}`)

                          // 在插入工具组件前结束当前文本块，保证后续文本出现在组件之后
                          if (textOpen) {
                            dataStream.write({ id: outMessageId, type: 'text-end' });
                            textOpen = false;
                          }

                          // 换成工具调用
                          toolCallMappings.set(tool_call.id, {
                            id: tool_call.id,
                            name: tool_call.name,
                            documentId: '',
                            args: tool_call?.args,
                            status: 'pending'
                          }); // end of toolCallMappings

                          dataStream.write({
                            type: 'tool-input-available',
                            // toolCallId: lastValueToolCallId,
                            toolCallId: tool_call.id,
                            toolName: tool_call.name,
                            input: tool_call?.args
                          })
                        });

                      } // end of values.type.ai

                      else if (lastValueMessage.type === "tool") {
                        // [TODO]: 工具调用结束
                        console.log(`[Chat Agent]: ${lastValueName}工具调用结束`)
                        console.log(`[Chat Agent]: ${lastValueName}工具调用结果:${lastValueContent}`)
                        console.log(`[Chat Agent]: ${lastValueName}工具调用ID:${lastValueId}`)
                        console.log(`[Chat Agent]: ${lastValueName}工具调用Tool Casll ID:${lastValueToolCallId}`)
                        console.log(`[Chat Agent]: ${lastValueName}工具调用Artifact:${lastValueArtifact}`)

                        if (toolCallMappings.has(lastValueToolCallId)) {
                          const toolCallInfo: ToolCallInfo = toolCallMappings.get(lastValueToolCallId)
                          if (lastValueContent) {
                            // [TODO]: 调用前端工具，写入流
                            let toolCallData: any = null
                            try {
                              toolCallData = typeof lastValueContent === 'string' ? JSON.parse(lastValueContent) : lastValueContent
                            } catch (parseErr: any) {
                              console.warn('[Chat Agent] 工具输出 JSON 解析失败，按原样透传', {
                                contentSample: String(lastValueContent).slice(0, 200),
                                message: parseErr?.message,
                              })
                              toolCallData = { status: 'failed', message: 'Invalid tool output format', data: {}, providerExecuted: true }
                            }
                            const toolCallStatus = toolCallData?.status

                            // 如果 providerExecuted 为 false，表示 LangGraph 侧仅完成了入参校验，需在此执行本地工具
                            if (
                              toolCallStatus === 'success' &&
                              toolCallData?.providerExecuted === false
                            ) {
                              try {
                                if (lastValueName === 'createDocument') {
                                  const documentId = String(toolCallData?.data?.document_id || '')
                                  const title = String(toolCallData?.data?.title || '')
                                  const kind = String(toolCallData?.data?.kind || '') as any

                                  if (!documentId || !title || !kind || !artifactKinds.includes(kind)) {
                                    dataStream.write({
                                      type: 'tool-output-error',
                                      toolCallId: lastValueToolCallId,
                                      providerExecuted: true,
                                      errorText: `Invalid createDocument args: title=${title ? 'ok' : 'missing'}, kind=${kind || 'missing'}`,
                                    })
                                  } else {
                                    console.log(`== documentId: ${documentId} ==`)
                                    const toolImpl = createDocument({ id: documentId, session, dataStream })
                                    const output = await toolImpl.execute({ title, kind })

                                    dataStream.write({
                                      type: 'tool-output-available',
                                      toolCallId: lastValueToolCallId,
                                      providerExecuted: true,
                                      output: {
                                        ...output,
                                        // id: lastValueId,
                                        id: documentId,
                                      },
                                    })
                                  }
                                } else if (lastValueName === 'updateDocument') {
                                  const idArg = String(toolCallData?.data?.document_id || '')
                                  const description = String(toolCallData?.data?.description || '')
                                  let modeRaw = toolCallData?.data?.mode
                                  let modeArg = modeRaw === 'version' ? 'version' : (modeRaw === 'update' ? 'update' : undefined)

                                  // 如果工具未显式指定 mode，尝试从 Cookie 读取用户偏好
                                  if (!modeArg) {
                                    const cookieHeader = (request.headers.get('cookie') || '').toString();
                                    const cookieMap = Object.fromEntries(cookieHeader.split(';').map(kv => {
                                      const [k, ...rest] = kv.trim().split('=');
                                      return [k, rest.join('=')];
                                    }));
                                    const cookieMode = cookieMap['artifact_update_mode'];
                                    if (cookieMode === 'version' || cookieMode === 'update') {
                                      modeArg = cookieMode;
                                    }
                                  }

                                  if (!idArg || !description) {
                                    dataStream.write({
                                      type: 'tool-output-error',
                                      toolCallId: lastValueToolCallId,
                                      providerExecuted: true,
                                      errorText: `Invalid updateDocument args: id=${idArg ? 'ok' : 'missing'}, description=${description ? 'ok' : 'missing'}`,
                                    })
                                  } else {
                                    const toolImpl = updateDocument({ session, dataStream })
                                    const payload: any = { id: idArg, description }
                                    if (modeArg) payload.mode = modeArg
                                    const output = await toolImpl.execute(payload)

                                    if ((output as any)?.error) {
                                      dataStream.write({
                                        type: 'tool-output-error',
                                        toolCallId: lastValueToolCallId,
                                        providerExecuted: true,
                                        errorText: (output as any).error,
                                      })
                                    } else {
                                      dataStream.write({
                                        type: 'tool-output-available',
                                        toolCallId: lastValueToolCallId,
                                        providerExecuted: true,
                                        output: {
                                          ...output,
                                          id: idArg, 
                                        },
                                      })
                                    }
                                  }
                                } else {
                                  // 其它工具，按原样透传（未来可在此扩展更多本地工具）
                                  dataStream.write({
                                    type: 'tool-output-available',
                                    toolCallId: lastValueToolCallId,
                                    providerExecuted: toolCallData.providerExecuted ?? true,
                                    output: {
                                      ...toolCallData.data,
                                    },
                                  })
                                }
                              } catch (toolErr: any) {
                                console.error('[Chat Agent] 本地工具执行失败', {
                                  message: toolErr?.message,
                                  stack: toolErr?.stack,
                                  tool: lastValueName,
                                })
                                dataStream.write({
                                  type: 'tool-output-error',
                                  toolCallId: lastValueToolCallId,
                                  providerExecuted: true,
                                  errorText: toolErr?.message || 'Tool execution failed',
                                })
                              }
                            } else if (toolCallStatus === 'success') {
                              // 已在 LangGraph 侧执行或无需本地执行，原样返回
                              dataStream.write({
                                type: 'tool-output-available',
                                toolCallId: lastValueToolCallId,
                                providerExecuted: toolCallData.providerExecuted ?? true,
                                output: {
                                  ...toolCallData.data,
                                  // id: lastValueId,
                                },
                              })
                            } else {
                              dataStream.write({
                                type: 'tool-output-error',
                                toolCallId: lastValueToolCallId,
                                providerExecuted: toolCallData.providerExecuted ?? true,
                                errorText: toolCallData.message,
                              })
                            }

                          }
                        } // end of toolCallMappings.has(lastValueToolCallId)

                      } // end of values.type.tool

                    }// end of data.messages

                    break;

                  case "messages": {
                    const messageChunk = data[0];
                    const contentChunk = messageChunk?.content;
                    const typeChunk = messageChunk?.type;

                    console.log(`== > message: ${JSON.stringify(messageChunk, null, 4)} ==`)
                    if (typeChunk === 'AIMessageChunk') {
                      // 兼容多种可能的 content 结构，提取字符串文本
                      let text: string | undefined;
                      if (typeof contentChunk === 'string') {
                        text = contentChunk;
                      } else if (Array.isArray(contentChunk)) {
                        text = contentChunk.map((c: any) =>
                          typeof c === 'string'
                            ? c
                            : typeof c?.text === 'string'
                              ? c.text
                              : ''
                        ).join('');
                      } else if (contentChunk && typeof (contentChunk as any)?.text === 'string') {
                        text = (contentChunk as any).text;
                      }
                      if (text?.length) {
                        // 若尚未开始文本块（例如工具组件之后），先开始新的文本块
                        if (!textOpen) {
                          dataStream.write({ id: outMessageId, type: 'text-start' });
                          textOpen = true;
                        }
                        dataStream.write({ id: outMessageId, type: 'text-delta', delta: text });
                      }

                    } //  end of typeChunk === 'AIMessageChunk'

                    break;
                  }

                  case "end":
                    if (textOpen) {
                      dataStream.write({ id: outMessageId, type: 'text-end' });
                      textOpen = false;
                    }
                    dataStream.write({ type: 'finish-step' });
                    dataStream.write({ type: 'finish' });
                    break;

                } // end of switch event
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
