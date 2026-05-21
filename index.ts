import {
  type ChatSurfaceAdapter,
  type ChatSurfaceEvent,
  type ChatSurfaceEventSink,
  type ChatSurfaceIncomingMessage,
  type ChatSurfaceRequestContext,
} from "adminforth";
import { AdapterOptions } from "./types.js";
import { getFinalMessageStreamPreview, renderFinalMessageImages } from "./renderers.js";
import { randomInt } from "node:crypto";
export type { AdapterOptions, TelegramStreamingMode } from "./types.js";
export {
  getFinalMessageStreamPreview,
  renderFinalMessageImages,
  renderHtmlBlockToPng,
  renderTablePng,
  renderVegaLitePng,
  type RenderedMessage,
  type RenderedMessageImage,
  type RenderTableColumn,
  type RenderTablePngInput,
  type VegaLiteSpec,
} from "./renderers.js";

type TelegramUpdate = {
  message?: {
    text?: string;
    caption?: string;
    voice?: {
      file_id?: string;
      mime_type?: string;
    };
    audio?: {
      file_id?: string;
      file_name?: string;
      mime_type?: string;
    };
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

type TelegramGetFileResponse = {
  ok: boolean;
  result?: {
    file_path?: string;
  };
  description?: string;
};

type ChatSurfaceConnectAction = {
  type: "url";
  label: string;
  url: string;
};

type TelegramChatSurfaceEvent =
  | ChatSurfaceEvent
  | {
      type: "audio";
      audio: Buffer;
      filename: string;
      mimeType: string;
    };

const TELEGRAM_API_BASE_URL = "https://api.telegram.org";
const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";
const TELEGRAM_MESSAGE_MAX_LENGTH = 4096;
const TELEGRAM_DRAFT_MAX_LENGTH = 4096;
const DEFAULT_DRAFT_UPDATE_INTERVAL_MS = 650;
const DEFAULT_TYPING_INTERVAL_MS = 4000;
const TELEGRAM_START_COMMAND_PREFIX = "/start";
const TELEGRAM_COMMAND_PARTS_RE = /\s+/;

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

function parseTelegramStartCommand(text: string) {
  const [command, ...payloadParts] = text.trim().split(TELEGRAM_COMMAND_PARTS_RE);
  const isStartCommand =
    command === TELEGRAM_START_COMMAND_PREFIX ||
    command.startsWith(`${TELEGRAM_START_COMMAND_PREFIX}@`);

  return {
    isStartCommand,
    payload: isStartCommand ? payloadParts.join(" ") || null : null,
  };
}

export class TelegramChatSurfaceAdapter implements ChatSurfaceAdapter {
  name = "telegram";
  createConnectAction?: (input: { token: string }) => ChatSurfaceConnectAction;

  constructor(private options: AdapterOptions) {
    if (options.botUsername) {
      this.createConnectAction = ({ token }) => ({
        type: "url",
        label: "Connect Telegram",
        url: `https://t.me/${options.botUsername}?start=${encodeURIComponent(token)}`,
      });
    }
  }

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
    const message = update.message;
    const text = message?.text;
    const chatId = message?.chat?.id;
    const userId = message?.from?.id;

    if (chatId === undefined || userId === undefined) {
      return null;
    }

    const startCommand = text
      ? parseTelegramStartCommand(text)
      : { isStartCommand: false, payload: null };

    if (text) {
      return {
        surface: this.name,
        prompt: text,
        externalConversationId: String(chatId),
        externalUserId: String(userId),
        userTimeZone: "UTC",
        metadata: {
          isStartCommand: startCommand.isStartCommand,
          startPayload: startCommand.payload,
          telegramUpdate: update,
        },
      };
    }

    const voiceFileId = message?.voice?.file_id;
    const audioFileId = message?.audio?.file_id;
    const fileId = voiceFileId ?? audioFileId;

    if (!fileId) {
      return null;
    }

    const audio = await this.downloadTelegramFile({
      fileId,
      filename: message?.audio?.file_name ?? (voiceFileId ? "telegram-voice.ogg" : "telegram-audio"),
      mimeType: message?.voice?.mime_type ?? message?.audio?.mime_type ?? "application/octet-stream",
      abortSignal: ctx.abortSignal,
    });

    return {
      surface: this.name,
      prompt: message?.caption ?? "",
      audio,
      externalConversationId: String(chatId),
      externalUserId: String(userId),
      userTimeZone: "UTC",
      metadata: {
        isStartCommand: startCommand.isStartCommand,
        startPayload: startCommand.payload,
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
      const draftPreviewText = getFinalMessageStreamPreview(text);

      if (
        closed ||
        done ||
        streamingMode !== "draft" ||
        !draftPreviewText
      ) {
        return;
      }

      const draftText = truncateTelegramDraft(draftPreviewText);

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
      emit: async (event: TelegramChatSurfaceEvent) => {
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

          await this.sendFinalMessage(chatId, text || event.text);
          return;
        }

        if (event.type === "audio") {
          await this.sendAudioFile(
            chatId,
            event.audio,
            event.filename,
            event.mimeType,
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

  private async sendMessage(chatId: string, text: string) {
    if (!text) {
      return;
    }

    for (const chunk of splitTelegramMessage(text)) {
      await this.telegramJson("sendMessage", {
        chat_id: chatId,
        text: chunk,
        parse_mode: "Markdown",
      });
    }
  }

  private async sendFinalMessage(chatId: string, text: string) {
    const renderedMessage = await renderFinalMessageImages(text);

    await this.sendMessage(chatId, renderedMessage.text);

    for (const image of renderedMessage.images) {
      await this.sendPhoto(chatId, image.buffer, image.filename);
    }
  }

  private async sendPhoto(chatId: string, png: Buffer, filename: string) {
    const photoBytes = new Uint8Array(png);
    const formData = new FormData();
    formData.append("chat_id", chatId);
    formData.append("photo", new Blob([photoBytes], {
      type: "image/png",
    }), filename);

    await this.telegramMultipart("sendPhoto", formData);
  }

  private async sendChatAction(chatId: string, action: "typing" | "upload_voice" | "upload_audio") {
    await this.telegramJson("sendChatAction", {
      chat_id: chatId,
      action,
    });
  }

  private async downloadTelegramFile(input: {
    fileId: string;
    filename: string;
    mimeType: string;
    abortSignal: AbortSignal;
  }) {
    const fileResponse = await fetch(
      `${TELEGRAM_API_BASE_URL}/bot${this.options.botToken}/getFile?file_id=${encodeURIComponent(input.fileId)}`,
      { signal: input.abortSignal },
    );

    if (!fileResponse.ok) {
      throw new Error(`Telegram getFile failed: ${fileResponse.status} ${await fileResponse.text()}`);
    }

    const fileData = await fileResponse.json() as TelegramGetFileResponse;
    const filePath = fileData.result?.file_path;

    if (!fileData.ok || !filePath) {
      throw new Error(`Telegram getFile failed: ${fileData.description ?? "file_path is missing"}`);
    }

    const downloadResponse = await fetch(
      `${TELEGRAM_API_BASE_URL}/file/bot${this.options.botToken}/${filePath}`,
      { signal: input.abortSignal },
    );

    if (!downloadResponse.ok) {
      throw new Error(`Telegram file download failed: ${downloadResponse.status} ${await downloadResponse.text()}`);
    }

    return {
      buffer: Buffer.from(await downloadResponse.arrayBuffer()),
      filename: input.filename,
      mimeType: input.mimeType,
    };
  }

  private async sendAudioFile(
    chatId: string,
    audio: Buffer,
    filename: string,
    mimeType: string,
  ) {
    const sendAsVoice = ["audio/ogg", "audio/opus"].includes(mimeType) || filename.endsWith(".ogg") || filename.endsWith(".opus");
    const method = sendAsVoice ? "sendVoice" : "sendAudio";
    const fieldName = sendAsVoice ? "voice" : "audio";
    const audioBytes = new Uint8Array(audio);
    const formData = new FormData();
    formData.append("chat_id", chatId);
    formData.append(fieldName, new Blob([audioBytes], {
      type: mimeType,
    }), filename);

    await this.telegramMultipart(method, formData);
  }

  private async telegramMultipart(method: string, formData: FormData) {
    const response = await fetch(`${TELEGRAM_API_BASE_URL}/bot${this.options.botToken}/${method}`, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Telegram ${method} failed: ${response.status} ${await response.text()}`);
    }
  }

  private async telegramJson(method: string, body: unknown) {
    const response = await fetch(`${TELEGRAM_API_BASE_URL}/bot${this.options.botToken}/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Telegram ${method} failed: ${response.status} ${await response.text()}`);
    }
  }

  private async sendMessageDraft(input: {
    chatId: string;
    draftId: number;
    text: string;
    parseMode?: "Markdown" | "MarkdownV2" | "HTML";
  }) {
    await this.telegramJson("sendMessageDraft", {
      chat_id: Number(input.chatId),
      draft_id: input.draftId,
      text: input.text,
      parse_mode: input.parseMode,
    });
  }
}

export default TelegramChatSurfaceAdapter;
