import { Client } from '@langchain/langgraph-sdk';
// [TODO]: 使用界面进行接入，而不是写死
import type { ChatModel } from '@/lib/ai/models';
// import type { RequestHints } from '@/lib/ai/prompts';
// import { systemPrompt } from '@/lib/ai/prompts';

export async function graphStream(params: {
  graphId: string;
  threadId: string;
  model: string;
  systemPrompt: string;
  input: any;
}): Promise<AsyncIterable<any>> {
  const { graphId, threadId, model, systemPrompt, input } = params;
  const client = new Client({
    apiUrl: process.env.LANGGRAPH_API_URL || 'http://localhost:8000/api',
  });
  console.log('[Graph] LangGraph 客户端已创建，API URL:', process.env.LANGGRAPH_API_URL || 'http://localhost:8000/api');

  const thread = await client.threads.create({
    threadId,
    metadata: { tags: [{ graphId }] },
    ifExists: 'do_nothing',
  });
  console.log('[Graph] Thread 就绪:', { thread_id: thread.thread_id });

  // 3) 幂等创建/获取 Assistant
  const assistant = await client.assistants.create({
    graphId: graphId,
    config: {
      tags: [graphId],
    },
    ifExists: 'do_nothing',
  });

  console.log('[Graph] Assistant 就绪:', {
    assistant_id: assistant.assistant_id,
    config: assistant.config,
  });

  const stream = await client.runs.stream(
    thread.thread_id,
    assistant.assistant_id,
    {
      config: {
        "configurable": {
          "model": model,
          "system_prompt": systemPrompt,
        }
      },
      // config: assistant.config || {},
      streamMode: ['messages'],
      // input: {"messages": [input]},
      input: input,
    },
  );

  return stream as AsyncIterable<any>;
}
