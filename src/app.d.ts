declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		interface Platform {
			env: {
				SECRET_TELEGRAM_API_TOKEN: string;
				AI: Ai;
				R2: R2Bucket;
				CONVERSATION_HISTORY: KVNamespace;
				GITHUB_TOKEN?: string;
			};
			context: ExecutionContext;
			caches: CacheStorage & { default: Cache };
		}
	}

	interface TelegramWebApp {
		initData: string;
		initDataUnsafe: {
			user?: {
				id: number;
				first_name: string;
				last_name?: string;
				username?: string;
				language_code?: string;
			};
		};
		ready(): void;
		expand(): void;
		close(): void;
		MainButton: {
			text: string;
			color: string;
			textColor: string;
			isVisible: boolean;
			isActive: boolean;
			show(): void;
			hide(): void;
			enable(): void;
			disable(): void;
			onClick(callback: () => void): void;
		};
	}

	interface Window {
		Telegram?: {
			WebApp: TelegramWebApp;
		};
	}
}

export {};
