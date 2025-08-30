# 实时流 SSE 处理流程文档

## 概述

本项目采用 Server-Sent Events (SSE) 技术实现实时流式聊天功能，结合 AI SDK 的 UIMessageStream 和可恢复流机制，提供稳定的实时交互体验。

## 整体架构

```
用户输入 → 前端 useChat → /api/chat → AI 模型 → SSE 流 → 前端渲染
                ↓                                    ↑
        DataStreamProvider ← DataStreamHandler ← SSE 数据分片
```

## 服务端流处理流程

### 1. 请求入口 (`/api/chat` POST)

**文件位置**: `app/(chat)/api/chat/route.ts`

#### 1.1 请求预处理

```typescript
// 解析和验证请求体
const requestBody = postRequestBodySchema.parse(json);

// 用户认证和权限检查
const session = await auth();
if (!session?.user) {
  return new ChatSDKError("unauthorized:chat").toResponse();
}

// 检查消息配额
const messageCount = await getMessageCountByUserId({
  id: session.user.id,
  differenceInHours: 24,
});
```

#### 1.2 聊天会话管理

```typescript
// 获取或创建聊天会话
const chat = await getChatById({ id });
if (!chat) {
  // 新会话：生成标题并保存
  const { title, threadId } = await generateTitleFromUserMessage({ message });
  await saveChat({
    id: threadId,
    userId: session.user.id,
    title,
    visibility: selectedVisibilityType,
  });
}
```

#### 1.3 消息上下文组装

```typescript
// 获取历史消息并组装上下文
const messagesFromDb = await getMessagesByChatId({ id });
const uiMessages = [...convertToUIMessages(messagesFromDb), message];

// 添加地理位置信息作为系统提示
const { longitude, latitude, city, country } = geolocation(request);
const requestHints: RequestHints = { longitude, latitude, city, country };
```

### 2. 流式生成核心逻辑

#### 2.1 创建 UIMessageStream

```typescript
// 生成流 ID 用于可恢复流
const streamId = generateUUID();
await createStreamId({ streamId, chatId: id });

// 创建 UI 消息流
const stream = createUIMessageStream({
  execute: ({ writer: dataStream }) => {
    // 核心流式处理逻辑
  },
  generateId: generateUUID,
  onFinish: async ({ messages }) => {
    // 保存生成的消息到数据库
  },
  onError: () => {
    return "Oops, an error occurred!";
  },
});
```

#### 2.2 AI 模型流式生成

```typescript
const result = streamText({
  model: myProvider.languageModel(selectedChatModel),
  system: systemPrompt({ selectedChatModel, requestHints }),
  messages: convertToModelMessages(uiMessages),
  stopWhen: stepCountIs(5), // 限制推理步数
  experimental_activeTools: [
    "getWeather",
    "createDocument",
    "updateDocument",
    "requestSuggestions",
  ],
  experimental_transform: smoothStream({ chunking: "word" }), // 分词级别的流控制
  tools: {
    getWeather,
    createDocument: createDocument({ session, dataStream }),
    updateDocument: updateDocument({ session, dataStream }),
    requestSuggestions: requestSuggestions({ session, dataStream }),
  },
});

// 启动流式生成
result.consumeStream();

// 合并文本流和推理可视化
dataStream.merge(
  result.toUIMessageStream({
    sendReasoning: true, // 启用推理过程可视化
  })
);
```

#### 2.3 SSE 输出与可恢复流

```typescript
const streamContext = getStreamContext();

if (streamContext) {
  // 支持可恢复流（需要 Redis）
  return new Response(
    await streamContext.resumableStream(streamId, () =>
      stream.pipeThrough(new JsonToSseTransformStream())
    )
  );
} else {
  // 普通 SSE 流
  return new Response(stream.pipeThrough(new JsonToSseTransformStream()));
}
```

### 3. 可恢复流机制

**文件位置**: `app/(chat)/api/chat/[id]/stream/route.ts`

#### 3.1 流恢复端点 (GET)

```typescript
export async function GET(_, { params }: { params: Promise<{ id: string }> }) {
  const { id: chatId } = await params;
  const streamContext = getStreamContext();

  if (!streamContext) {
    return new Response(null, { status: 204 });
  }

  // 获取最近的流 ID
  const streamIds = await getStreamIdsByChatId({ chatId });
  const recentStreamId = streamIds.at(-1);

  // 尝试恢复流
  const stream = await streamContext.resumableStream(recentStreamId, () =>
    emptyDataStream.pipeThrough(new JsonToSseTransformStream())
  );

  // 如果流已结束但在15秒内，补发最后一条消息
  if (!stream) {
    const messages = await getMessagesByChatId({ id: chatId });
    const mostRecentMessage = messages.at(-1);

    if (
      mostRecentMessage?.role === "assistant" &&
      differenceInSeconds(resumeRequestedAt, messageCreatedAt) <= 15
    ) {
      // 创建补发流
      const restoredStream = createUIMessageStream({
        execute: ({ writer }) => {
          writer.write({
            type: "data-appendMessage",
            data: JSON.stringify(mostRecentMessage),
            transient: true,
          });
        },
      });
      return new Response(
        restoredStream.pipeThrough(new JsonToSseTransformStream())
      );
    }
  }

  return new Response(stream, { status: 200 });
}
```

## 前端流消费流程

### 1. 聊天组件初始化

**文件位置**: `components/chat.tsx`

```typescript
const {
  messages,
  setMessages,
  sendMessage,
  status,
  stop,
  regenerate,
  resumeStream,
} = useChat<ChatMessage>({
  id,
  messages: initialMessages,
  experimental_throttle: 100, // 节流控制
  generateId: generateUUID,
  transport: new DefaultChatTransport({
    api: "/api/chat",
    fetch: fetchWithErrorHandlers,
    prepareSendMessagesRequest({ messages, id, body }) {
      return {
        body: {
          id,
          message: messages.at(-1),
          selectedChatModel: initialChatModel,
          selectedVisibilityType: visibilityType,
          ...body,
        },
      };
    },
  }),
  onData: (dataPart) => {
    // 将数据分片写入全局数据流上下文
    setDataStream((ds) => (ds ? [...ds, dataPart] : []));
  },
  onFinish: () => {
    // 刷新聊天历史
    mutate(unstable_serialize(getChatHistoryPaginationKey));
  },
});
```

### 2. 数据流上下文管理

**文件位置**: `components/data-stream-provider.tsx`

```typescript
interface DataStreamContextValue {
  dataStream: DataUIPart<CustomUIDataTypes>[];
  setDataStream: React.Dispatch<
    React.SetStateAction<DataUIPart<CustomUIDataTypes>[]>
  >;
}

export function DataStreamProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [dataStream, setDataStream] = useState<DataUIPart<CustomUIDataTypes>[]>(
    []
  );
  const value = useMemo(() => ({ dataStream, setDataStream }), [dataStream]);

  return (
    <DataStreamContext.Provider value={value}>
      {children}
    </DataStreamContext.Provider>
  );
}
```

### 3. 数据流处理器

**文件位置**: `components/data-stream-handler.tsx`

```typescript
export function DataStreamHandler() {
  const { dataStream } = useDataStream();
  const { artifact, setArtifact, setMetadata } = useArtifact();
  const lastProcessedIndex = useRef(-1);

  useEffect(() => {
    if (!dataStream?.length) return;

    // 处理新的数据分片
    const newDeltas = dataStream.slice(lastProcessedIndex.current + 1);
    lastProcessedIndex.current = dataStream.length - 1;

    newDeltas.forEach((delta) => {
      // 查找对应的 Artifact 定义
      const artifactDefinition = artifactDefinitions.find(
        (def) => def.kind === artifact.kind
      );

      // 调用特定类型的流处理器
      if (artifactDefinition?.onStreamPart) {
        artifactDefinition.onStreamPart({
          streamPart: delta,
          setArtifact,
          setMetadata,
        });
      }

      // 处理通用数据类型
      setArtifact((draftArtifact) => {
        switch (delta.type) {
          case "data-id":
            return {
              ...draftArtifact,
              documentId: delta.data,
              status: "streaming",
            };
          case "data-title":
            return { ...draftArtifact, title: delta.data, status: "streaming" };
          case "data-kind":
            return { ...draftArtifact, kind: delta.data, status: "streaming" };
          case "data-clear":
            return { ...draftArtifact, content: "", status: "streaming" };
          case "data-finish":
            return { ...draftArtifact, status: "idle" };
          default:
            return draftArtifact;
        }
      });
    });
  }, [dataStream, setArtifact, setMetadata, artifact]);

  return null;
}
```

### 4. 自动恢复机制

**文件位置**: `hooks/use-auto-resume.ts`

```typescript
export function useAutoResume({
  autoResume,
  initialMessages,
  resumeStream,
  setMessages,
}: UseAutoResumeParams) {
  const { dataStream } = useDataStream();

  useEffect(() => {
    if (!autoResume) return;

    const mostRecentMessage = initialMessages.at(-1);

    // 如果最后一条是用户消息，尝试恢复流
    if (mostRecentMessage?.role === "user") {
      resumeStream();
    }
  }, []);

  useEffect(() => {
    if (!dataStream || dataStream.length === 0) return;

    const dataPart = dataStream[0];

    // 处理补发的消息
    if (dataPart.type === "data-appendMessage") {
      const message = JSON.parse(dataPart.data);
      setMessages([...initialMessages, message]);
    }
  }, [dataStream, initialMessages, setMessages]);
}
```

## 数据类型与流控制

### 1. 核心数据类型

```typescript
// 文本增量
type TextDelta = {
  type: "text-delta";
  textDelta: string;
  transient: boolean;
};

// 自定义 UI 数据类型
type CustomUIDataTypes = {
  "data-id": string;
  "data-title": string;
  "data-kind": ArtifactKind;
  "data-clear": null;
  "data-finish": null;
  "data-textDelta": string;
  "data-codeDelta": string;
  "data-sheetDelta": string;
  "data-imageDelta": string;
  "data-appendMessage": string;
};
```

### 2. 工具流式输出

以文本文档为例 (`artifacts/text/server.ts`):

```typescript
export const textDocumentHandler = createDocumentHandler<"text">({
  kind: "text",
  onCreateDocument: async ({ title, dataStream }) => {
    let draftContent = "";

    const { fullStream } = streamText({
      model: myProvider.languageModel("artifact-model"),
      system: "Write about the given topic. Markdown is supported.",
      experimental_transform: smoothStream({ chunking: "word" }),
      prompt: title,
    });

    for await (const delta of fullStream) {
      if (delta.type === "text") {
        const { text } = delta;
        draftContent += text;

        // 实时推送文本增量到前端
        dataStream.write({
          type: "data-textDelta",
          data: text,
          transient: true,
        });
      }
    }

    return draftContent;
  },
});
```

## 流程时序图

### 发起聊天流程

```
用户浏览器     Chat组件(useChat)    /api/chat(POST)         AI模型&工具
    |              |                    |                      |
    | 输入消息       |                    |                      |
    |------------->| 发送请求            |                      |
    |              |-------------------->| 校验&保存用户消息     |
    |              |                    | 生成streamId         |
    |              |                    | 创建UIMessageStream  |
    |              |                    |--------------------->|
    |              |                    |<---------------------| token增量
    |              |<--------------------| SSE数据分片          |
    | 实时UI更新    |                    | 保存助手消息          |
    |<--------------|                    |                      |
```

### 断线恢复流程

```
浏览器刷新    useAutoResume    /api/chat/[id]/stream(GET)    可恢复流上下文
    |             |                        |                      |
    | 页面加载      |                        |                      |
    |------------>| 检查最后消息类型        |                      |
    |             | (用户消息?)             |                      |
    |             |----------------------->| 查找streamId         |
    |             |                        | 尝试恢复流           |
    |             |<-----------------------| 返回SSE/补发消息     |
    | 恢复UI状态   |                        |                      |
    |<------------|                        |                      |
```

## 关键配置与优化

### 1. 流控制参数

- `experimental_throttle: 100`: 前端节流控制，避免过于频繁的 UI 更新
- `smoothStream({ chunking: 'word' })`: 按词分块，提供更平滑的流式体验
- `stopWhen: stepCountIs(5)`: 限制推理步数，防止过长生成

### 2. 可恢复流配置

- 需要配置 `REDIS_URL` 环境变量
- 通过 `createResumableStreamContext({ waitUntil: after })` 启用
- 15 秒内的消息可以通过补发机制恢复

### 3. 错误处理

- 统一的错误响应格式 (`ChatSDKError`)
- 前端 `fetchWithErrorHandlers` 处理网络错误
- 流中断时的优雅降级

## 扩展点

1. **新增工具类型**: 在 `tools` 目录下添加新的工具，通过 `dataStream.write()` 推送自定义数据
2. **新增 Artifact 类型**: 在 `artifacts` 目录下定义新的文档类型处理器
3. **自定义流控制**: 调整 `smoothStream` 参数或实现自定义 transform
4. **扩展可恢复流**: 增加更复杂的恢复策略和状态管理

这套 SSE 实时流处理机制提供了完整的端到端解决方案，支持文本、代码、表格、图片等多种内容类型的实时生成和展示，同时具备断线续传能力，确保用户体验的连续性和稳定性。
