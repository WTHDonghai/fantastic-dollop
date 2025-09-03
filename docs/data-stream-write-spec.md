# dataStream.write 事件写法规范（含示例）

本文面向本项目的数据流（Server -> UI）约定，说明 dataStream.write 中 data 与 delta 字段的使用场景、顶层字段（type/id/state/transient）的语义，以及工具类事件（tool-*）的合并规则与典型示例。

## 适用范围
- 服务器路由/工具在推送流式事件到前端 UI 时的统一格式
- 文本增量、工具调用、Artifact/自定义数据（data-*）等所有场景

## 核心术语
- type：事件类型（如 text-delta、tool-getWeather、data-title 等）
- data：承载“非合并型/瞬态 UI 数据”的负载，通常由 DataStreamHandler 直接消费
- delta：承载“增量/可合并到 message.part 顶层”的负载（如文本增量、工具 input/output 等）
- id：事件归属的“消息 part”标识（通常是当前助手消息的 outMessageId）
- state：工具调用阶段（input-available / output-available 等），用于 UI 判定渲染分支
- transient：是否“瞬态显示”（不落库、仅临时 UI 呈现），常用于建议/预览类事件

## 使用规则（速览）
1) data 字段：用于 data-* 类事件（如 data-id、data-title、data-kind、data-clear、data-finish、data-suggestion）。这些事件的数据放在 data 中，由前端的 DataStreamHandler 直接消费并更新 UI 状态。

2) delta 字段：用于“增量/合并”类事件，包括：
- 文本增量：type='text-delta'，delta 为追加的字符串片段
- 工具事件：type='tool-<name>'，将可合并字段（如 toolCallId、input、output）放入 delta；state 放在顶层；SDK 会把 delta 内字段合并到 message.parts 的顶层供 UI 渲染

3) 顶层字段：
- id 顶层：标识归属的 message part
- state 顶层：仅在工具事件里使用，用于区分 input-available 与 output-available 阶段
- transient 顶层：仅用于 data-* 之类的瞬态 UI 事件（如 data-suggestion）

## 典型事件类型
- 文本：text-delta（delta: string）
- 工具：tool-<name>（state 顶层；toolCallId/input/output 放在 delta）
- 自定义 UI/Artifact：data-id、data-title、data-kind、data-clear、data-finish、data-suggestion（payload 放在 data）

---

## 端到端示例

### 1) 仅文本增量
```ts
// 连续推送文本片段到同一助手消息 part
dataStream.write({
  type: 'text-delta',
  id: outMessageId,
  delta: '今天天气',
});

dataStream.write({
  type: 'text-delta',
  id: outMessageId,
  delta: '很好。',
});
```

### 2) 工具调用（以 getWeather 为例）
```ts
// 工具输入阶段（可选地回显入参）
dataStream.write({
  type: 'tool-getWeather',
  id: outMessageId,
  state: 'input-available',
  delta: {
    toolCallId,
    input: { latitude: 48.85, longitude: 2.35 },
  },
});

// 工具输出阶段（用于 UI 渲染 Weather 组件，output 结构需符合 WeatherAtLocation）
dataStream.write({
  type: 'tool-getWeather',
  id: outMessageId,
  state: 'output-available',
  delta: {
    toolCallId,
    output: weatherAtLocation,
  },
});
```
要点：
- type 必须与工具名一致（如 tool-getWeather）
- id 顶层为本次助手消息的 outMessageId
- state 顶层（input-available / output-available）
- toolCallId/input/output 位于 delta 中，SDK 会把它们合并进 message.part，UI 读取 part.input / part.output

### 3) Artifact / 自定义数据流（data-*）
```ts
// 清空当前 Artifact 面板
dataStream.write({ type: 'data-clear', data: true });

// 指定 Artifact 的种类（例如 document）
dataStream.write({ type: 'data-kind', data: 'document' });

// 设置一个临时文档 ID 与标题
dataStream.write({ type: 'data-id', data: 'doc_123' });
dataStream.write({ type: 'data-title', data: '旅行攻略草稿' });

// 结束一次文档推送
dataStream.write({ type: 'data-finish', data: true });
```
要点：
- data-* 类事件的负载放在 data 字段中
- 这些事件由 DataStreamHandler 直接消费，驱动 Artifact/UI 的即时更新

### 4) 建议流（瞬态展示）
```ts
// 从 LangGraph 等来源推送建议（瞬态，不落库）
dataStream.write({
  type: 'data-suggestion',
  data: { title: '改写为更口语化', body: '可以将第一句换成“嗨，我们来看看…”' },
  transient: true,
});
```
要点：
- 使用 transient: true 表明仅临时展示

---

## 常见易错点清单
- 把工具的 input/output 放在 data 而不是 delta（错误）。正确：input/output 均应在 delta 中，并由 SDK 合并到 part 顶层
- 遗漏 state 顶层字段，导致 UI 不知道处于 input-available 还是 output-available 阶段
- toolCallId 不一致，导致前后阶段无法关联为同一次工具调用
- type 拼写不一致（如 tool-getweather vs tool-getWeather）
- Weather 工具输出不满足 WeatherAtLocation 接口，导致 Weather 组件渲染失败
- 把 data-* 事件的负载误放入 delta（错误）。正确：data-* 使用 data 字段

## 相关位置（便于对照）
- 服务器路由与事件写法：app/(chat)/api/chat/route.ts
- Weather 组件与数据结构：components/weather.tsx（接口 WeatherAtLocation）
- UI 渲染逻辑（工具/消息）：components/message.tsx
- DataStreamHandler（消费 data-*）：components/data-stream-handler.tsx
- 工具实现样例：lib/ai/tools/get-weather.ts
- 其他 data-* 使用示例：lib/ai/tools/create-document.ts、update-document.ts、request-suggestions.ts