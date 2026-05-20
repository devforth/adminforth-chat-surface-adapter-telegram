export type TelegramStreamingMode = "draft" | "typing" | "off";

export type AdapterOptions = {
  /**
   * Telegram bot token from BotFather.
   */
  botToken: string;

  /**
   * Telegram bot username used to build the AdminForth account-link URL.
   */
  botUsername?: string;

  /**
   * Optional secret token configured in Telegram setWebhook.
   */
  webhookSecret?: string;

  /**
   * Streaming behavior for Telegram responses.
   * Default is `draft`.
   */
  streamingMode?: TelegramStreamingMode;

  /**
   * Draft preview update throttle interval.
   * Default is 650ms.
   */
  draftUpdateIntervalMs?: number;
};
