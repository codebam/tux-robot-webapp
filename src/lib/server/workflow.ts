import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workflows';
import { TelegramBot, TelegramExecutionContext } from '@codebam/cf-workers-telegram-bot';
import {
	type Environment,
	type Task,
	HistoryManager,
	SYSTEM_PROMPTS,
	AI_MODELS,
	streamAiResponseGemma
} from './chatUtils';

export class AIWorkflow extends WorkflowEntrypoint<Environment, Task> {
	async run(event: WorkflowEvent<Task>, step: WorkflowStep) {
		const task = event.payload;
		const env = this.env;

		const bot = new TelegramBot(env.SECRET_TELEGRAM_API_TOKEN);
		const dummyUpdate = {
			update_id: 0,
			message: {
				message_id: 0,
				from: { id: task.userId || 0, is_bot: false, first_name: 'User' },
				chat: { id: task.userId || 0, type: 'private' },
				date: Date.now() / 1000,
				text: task.prompt
			}
		};
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const tctx = new TelegramExecutionContext(bot, dummyUpdate as any);

		const historyManager = new HistoryManager(env.CONVERSATION_HISTORY);

		// Step 1: Process Task
		await step.do('process-ai-task', async () => {
			try {
				switch (task.type) {
					case 'message':
					case 'tool_call': {
						const modelId = task.modelId || AI_MODELS.GEMMA;
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						const messages: any[] = [
							{ role: 'system', content: task.systemPrompt || SYSTEM_PROMPTS.TUX_ROBOT },
							...(task.history || []),
							{ role: 'user', content: task.prompt }
						];

						if (task.type === 'tool_call') {
							const tools = task.tools || [];
							for (let i = 0; i < 5; i++) {
								const response = (await env.AI.run(
									// eslint-disable-next-line @typescript-eslint/no-explicit-any
									modelId as any,
									{
										messages,
										tools: tools.map((t) => ({
											type: 'function',
											function: {
												name: t.name,
												description: t.description,
												parameters: t.parameters
											}
										}))
									},
									{ gateway: { id: 'default' } }
									// eslint-disable-next-line @typescript-eslint/no-explicit-any
								)) as any;

								const toolCalls = response.tool_calls || response.choices?.[0]?.message?.tool_calls;

								if (toolCalls && toolCalls.length > 0) {
									messages.push({
										role: 'assistant',
										content: response.choices?.[0]?.message?.content || null,
										tool_calls: toolCalls
									});

									for (const toolCall of toolCalls) {
										const name = toolCall.name || toolCall.function?.name;
										let args = toolCall.arguments || toolCall.function?.arguments;
										if (typeof args === 'string') {
											try {
												args = JSON.parse(args);
											} catch {
												/* ignore */
											}
										}

										const toolDef = tools.find((t) => t.name === name);
										if (toolDef && toolDef.run) {
											try {
												const result = await toolDef.run(args);
												messages.push({
													role: 'tool',
													name: name,
													tool_call_id: toolCall.id,
													content: typeof result === 'string' ? result : JSON.stringify(result)
												});
											} catch (e) {
												messages.push({
													role: 'tool',
													name: name,
													tool_call_id: toolCall.id,
													content: `Error executing tool: ${String(e)}`
												});
											}
										}
									}
								} else {
									// Final summary
									const finalContent = await streamAiResponseGemma(
										tctx,
										env,
										modelId,
										messages,
										50000
									);
									if (finalContent && task.userId) {
										await historyManager.addMessage(
											task.userId,
											task.prompt,
											finalContent,
											task.threadId
										);
									}
									return;
								}
							}
						} else {
							// Simple message (non-tool)
							const finalContent = await streamAiResponseGemma(tctx, env, modelId, messages, 50000);
							if (finalContent && task.userId) {
								await historyManager.addMessage(
									task.userId,
									task.prompt,
									finalContent,
									task.threadId
								);
							}
						}
						break;
					}
				}
			} catch (e) {
				console.error('Error in workflow process-ai-task:', e);
				await tctx.reply(`Error: ${String(e)}`);
				throw e;
			}
		});
	}
}
