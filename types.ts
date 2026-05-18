export type TelegramStreamingMode = "draft" | "typing" | "off";

export type AdapterOptions = {
  /**
   * Telegram bot token from BotFather.
   */
  botToken: string;

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

  /**
   * AdminForth admin user field that stores Telegram user id.
   * Default is `telegramId`.
   */
  adminUserTelegramIdField?: string;

  /**
   * AdminForth admin users resource id.
   * Default is `adminuser`.
   */
  adminUserResourceId?: string;
};
