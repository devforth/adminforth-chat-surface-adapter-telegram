import {
  AdminForthFilterOperators,
  type AdminUser,
  type ChatSurfaceAdapter,
  type ChatSurfaceEventSink,
  type ChatSurfaceIncomingMessage,
  type ChatSurfaceRequestContext,
  type IAdminForth,
} from "adminforth";
import { AdapterOptions } from "./types.js";
import { randomInt } from "node:crypto";
export type { AdapterOptions, TelegramStreamingMode } from "./types.js";
export type {
  ChatSurfaceAdapter,
  ChatSurfaceCapabilities,
  ChatSurfaceEvent,
  ChatSurfaceEventSink,
  ChatSurfaceIncomingMessage,
  ChatSurfaceRequestContext,
} from "adminforth";

type TelegramUpdate = {
  message?: {
    text?: string;
    chat?: {
      id?: number | string;
    };
    from?: {
      id?: number | string;
      username?: string;
      first_name?: string;
      last_name?: string;
      language_code?: string;
    };
  };
};

const TELEGRAM_API_BASE_URL = "https://api.telegram.org";
const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";
const TELEGRAM_MESSAGE_MAX_LENGTH = 4096;
const TELEGRAM_DRAFT_MAX_LENGTH = 4096;
const DEFAULT_DRAFT_UPDATE_INTERVAL_MS = 650;
const DEFAULT_TYPING_INTERVAL_MS = 4000;
const DEFAULT_ADMIN_USER_RESOURCE_ID = "adminuser";
const DEFAULT_ADMIN_USER_TELEGRAM_ID_FIELD = "telegramId";

function createTelegramDraftId() {
  return randomInt(1, 2147483647);
}

function truncateTelegramDraft(text: string) {
  if (text.length <= TELEGRAM_DRAFT_MAX_LENGTH) {
    return text;
  }

  return `${text.slice(0, TELEGRAM_DRAFT_MAX_LENGTH - 1)}…`;
}

function isPrivateChatId(chatId: string) {
  const numericChatId = Number(chatId);

  return Number.isInteger(numericChatId) && numericChatId > 0;
}

function getHeaderValue(
  headers: ChatSurfaceRequestContext["headers"],
  name: string,
) {
  const value = headers[name.toLowerCase()];

  if (Array.isArray(value)) {
    return String(value[0]);
  }

  return typeof value === "undefined" ? undefined : String(value);
}

function splitTelegramMessage(text: string) {
  const chunks: string[] = [];

  for (let index = 0; index < text.length; index += TELEGRAM_MESSAGE_MAX_LENGTH) {
    chunks.push(text.slice(index, index + TELEGRAM_MESSAGE_MAX_LENGTH));
  }

  return chunks;
}

export class TelegramChatSurfaceAdapter implements ChatSurfaceAdapter {
  name = "telegram";

  constructor(private options: AdapterOptions) {}

  validate() {
    if (!this.options.botToken) {
      throw new Error("Telegram botToken is required");
    }
  }

  async parseIncomingMessage(ctx: ChatSurfaceRequestContext) {
    if (
      this.options.webhookSecret
      && getHeaderValue(ctx.headers, TELEGRAM_SECRET_HEADER) !== this.options.webhookSecret
    ) {
      return null;
    }

    const update = ctx.body as TelegramUpdate;
    const text = update.message?.text;
    const chatId = update.message?.chat?.id;
    const userId = update.message?.from?.id;

    if (!text || chatId === undefined || userId === undefined) {
      return null;
    }

    return {
      surface: this.name,
      prompt: text,
      externalConversationId: String(chatId),
      externalUserId: String(userId),
      userTimeZone: "UTC",
      metadata: {
        telegramUpdate: update,
      },
    };
  }

  createEventSink(
    ctx: ChatSurfaceRequestContext,
    incoming: ChatSurfaceIncomingMessage,
  ): ChatSurfaceEventSink {
    let text = "";
    let lastDraftText = "";
    let draftTimer: ReturnType<typeof setTimeout> | undefined;
    let typingTimer: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    let done = false;

    const chatId = incoming.externalConversationId;
    const configuredStreamingMode = this.options.streamingMode ?? "draft";
    const streamingMode =
      configuredStreamingMode === "draft" && !isPrivateChatId(chatId)
        ? "typing"
        : configuredStreamingMode;
    const draftUpdateIntervalMs =
      this.options.draftUpdateIntervalMs ?? DEFAULT_DRAFT_UPDATE_INTERVAL_MS;
    const draftId = createTelegramDraftId();

    const stopTyping = () => {
      if (typingTimer) {
        clearInterval(typingTimer);
        typingTimer = undefined;
      }
    };

    const startTyping = () => {
      if (typingTimer || streamingMode === "off") {
        return;
      }

      void this.sendChatAction(chatId, "typing").catch(() => undefined);

      typingTimer = setInterval(() => {
        void this.sendChatAction(chatId, "typing").catch(() => undefined);
      }, DEFAULT_TYPING_INTERVAL_MS);
    };

    const clearDraftTimer = () => {
      if (draftTimer) {
        clearTimeout(draftTimer);
        draftTimer = undefined;
      }
    };

    const flushDraft = async () => {
      if (
        closed ||
        done ||
        streamingMode !== "draft" ||
        !text
      ) {
        return;
      }

      const draftText = truncateTelegramDraft(text);

      if (draftText === lastDraftText) {
        return;
      }

      lastDraftText = draftText;

      await this.sendMessageDraft({
        chatId,
        draftId,
        text: draftText,
        parseMode: "Markdown",
      });
    };

    const scheduleDraftFlush = () => {
      if (streamingMode !== "draft" || draftTimer) {
        return;
      }

      draftTimer = setTimeout(() => {
        draftTimer = undefined;

        void flushDraft().catch(() => undefined);
      }, draftUpdateIntervalMs);
    };

    startTyping();

    return {
      emit: async (event) => {
        if (closed) {
          return;
        }

        if (event.type === "text_delta") {
          text += event.delta;

          if (streamingMode === "draft") {
            scheduleDraftFlush();
          }

          return;
        }

        if (event.type === "done") {
          done = true;
          stopTyping();
          clearDraftTimer();

          await this.sendMessage(
            chatId,
            text || event.text,
          );
          return;
        }

        if (event.type === "error") {
          done = true;
          stopTyping();
          clearDraftTimer();

          await this.sendMessage(
            chatId,
            event.message,
          );
        }
      },

      close: async () => {
        closed = true;
        stopTyping();
        clearDraftTimer();
      },
    };
  }

  async resolveAdminUser(input: {
    adminforth: IAdminForth;
    incoming: ChatSurfaceIncomingMessage;
  }): Promise<AdminUser | null> {
    const adminUserResourceId = this.options.adminUserResourceId ?? DEFAULT_ADMIN_USER_RESOURCE_ID;
    const telegramIdField = this.options.adminUserTelegramIdField ?? DEFAULT_ADMIN_USER_TELEGRAM_ID_FIELD;
    const adminUser = await input.adminforth.resource(adminUserResourceId).get([
      {
        field: telegramIdField,
        operator: AdminForthFilterOperators.EQ,
        value: input.incoming.externalUserId,
      },
    ]);

    if (!adminUser) {
      return null;
    }

    return {
      pk: adminUser.id,
      username: adminUser[input.adminforth.config.auth!.usernameField],
      dbUser: adminUser,
    };
  }

  private async sendMessage(chatId: string, text: string) {
    if (!text) {
      return;
    }

    for (const chunk of splitTelegramMessage(text)) {
      const response = await fetch(`${TELEGRAM_API_BASE_URL}/bot${this.options.botToken}/sendMessage`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          parse_mode: "Markdown",
        }),
      });

      if (!response.ok) {
        throw new Error(`Telegram sendMessage failed: ${response.status} ${await response.text()}`);
      }
    }
  }

  private async sendChatAction(chatId: string, action: "typing") {
    const response = await fetch(`${TELEGRAM_API_BASE_URL}/bot${this.options.botToken}/sendChatAction`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        action,
      }),
    });

    if (!response.ok) {
      throw new Error(`Telegram sendChatAction failed: ${response.status} ${await response.text()}`);
    }
  }

  private async sendMessageDraft(input: {
    chatId: string;
    draftId: number;
    text: string;
    parseMode?: "Markdown" | "MarkdownV2" | "HTML";
  }) {
    const response = await fetch(`${TELEGRAM_API_BASE_URL}/bot${this.options.botToken}/sendMessageDraft`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: Number(input.chatId),
        draft_id: input.draftId,
        text: input.text,
        parse_mode: input.parseMode,
      }),
    });

    if (!response.ok) {
      throw new Error(`Telegram sendMessageDraft failed: ${response.status} ${await response.text()}`);
    }
  }
}

export default TelegramChatSurfaceAdapter;