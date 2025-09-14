import { smoothStream, streamText } from 'ai';
import { myProvider } from '@/lib/ai/providers';
import { createDocumentHandler } from '@/lib/artifacts/server';
import { updateDocumentPrompt } from '@/lib/ai/prompts';
import { graphStream } from '@/lib/langgraph/graph';

export const textDocumentHandler = createDocumentHandler<'text'>({
  kind: 'text',
  onCreateDocument: async ({ id, title, dataStream }) => {
    // id： 文档Id； title: 文档标题
    console.log(`== textDocumentHandler onCreateDocument == #id: ${id},#title: ${title}`)
    let draftContent = '';

    const fullStream = await graphStream({
      graphId: 'document-writer',
      threadId: id,
      model: 'openai/qwen-plus',
      systemPrompt: 'Write about the given topic. Markdown is supported. Use headings wherever appropriate.',
      input: {'messages': [{ role: 'user', content: title }]},
    })

    let eventCount = 0;
    for await (const chunk of fullStream as AsyncIterable<any>) {
      eventCount++;

      // if (eventCount === 1) {
      //   // 标准步骤开始事件
      //   dataStream.write({ type: 'start-step' });
      //   dataStream.write({ id: outMessageId, type: 'text-start' });
      // }

      if (chunk.data) {
        const data = chunk.data as any;
        const event = chunk.event;

        if (event === "messages") {
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
              if (text?.length) {
                draftContent += text;
                dataStream.write({
                  type: 'data-textDelta',
                  data: text,
                  transient: true,
                });
              }

            } // end of msg_type === AIMessageChunk

          } // end of data is array instance
        } // end of "messages" === event
      } // end of if (chunk.data)
    }// end of fullStream ieteration

    return draftContent;
  },
  onUpdateDocument: async ({ document, description, dataStream }) => {
    console.log(`== textDocumentHandler onUpdateDocument == #title: ${document.title}`)
    let draftContent = '';

    const { fullStream } = streamText({
      model: myProvider.languageModel('artifact-model'),
      system: updateDocumentPrompt(document.content, 'text'),
      experimental_transform: smoothStream({ chunking: 'word' }),
      prompt: description,
      providerOptions: {
        openai: {
          prediction: {
            type: 'content',
            content: document.content,
          },
        },
      },
    });

    for await (const delta of fullStream) {
      const { type } = delta;

      if (type === 'text') {
        const { text } = delta;

        draftContent += text;

        dataStream.write({
          type: 'data-textDelta',
          data: text,
          transient: true,
        });
      }
    }

    return draftContent;
  },
});
