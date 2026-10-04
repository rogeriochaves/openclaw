import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { ChatNativeSubagentGetResult } from "../../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { applicationContext, type ApplicationContext } from "../../../app/context.ts";
import { gatewayPresentationScope } from "../../../app/gateway-presentation-scope.ts";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatNativeSubagentEnglish } from "../../../i18n/locales/en-chat-native-subagent.ts";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import { extractToolCardsCached } from "../../../lib/chat/tool-cards.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../../lit/subscriptions-controller.ts";
import { renderToolCard } from "./chat-tool-cards.ts";

registerChatNativeSubagentEnglish();

// Claude Code appends to the subagent transcript as it works; read new rows on this cadence.
export const NATIVE_SUBAGENT_REFRESH_MS = 2_000;
// A transcript this quiet belongs to a subagent that stopped without a final reply.
const STALE_AFTER_MS = 30 * 60_000;
// The spawning call can render before Claude Code creates the transcript files.
const MAX_MISSING_RETRIES = 15;
const MAX_PAGES_PER_REFRESH = 8;
const MAX_MESSAGES = 400;

type SubagentItem =
  | { kind: "text"; key: string; text: string }
  | { kind: "tool"; key: string; card: ToolCard };

function readAssistantTexts(message: unknown): string[] {
  const content = (message as { role?: unknown; content?: unknown }).content;
  if ((message as { role?: unknown }).role !== "assistant" || !Array.isArray(content)) {
    return [];
  }
  return content.flatMap((block) =>
    block && typeof block === "object" && block.type === "text" && typeof block.text === "string"
      ? block.text.trim() || []
      : [],
  );
}

/** One row per text block and per tool call, with each later result merged into its call. */
export function buildNativeSubagentItems(messages: readonly unknown[]): SubagentItem[] {
  const items: SubagentItem[] = [];
  const toolIndexByCallId = new Map<string, number>();
  for (const [messageIndex, message] of messages.entries()) {
    for (const [textIndex, text] of readAssistantTexts(message).entries()) {
      items.push({ kind: "text", key: `${messageIndex}:text:${textIndex}`, text });
    }
    for (const [cardIndex, card] of extractToolCardsCached(message).entries()) {
      const prior = card.callId ? toolIndexByCallId.get(card.callId) : undefined;
      const priorItem = prior === undefined ? undefined : items[prior];
      if (priorItem?.kind === "tool") {
        if (card.completed) {
          priorItem.card = {
            ...priorItem.card,
            outputText: card.outputText,
            outputTruncated: card.outputTruncated,
            details: card.details,
            isError: card.isError,
            exitCode: card.exitCode,
            completed: true,
          };
        }
        continue;
      }
      if (card.callId) {
        toolIndexByCallId.set(card.callId, items.length);
      }
      items.push({ kind: "tool", key: card.callId ?? `${messageIndex}:tool:${cardIndex}`, card });
    }
  }
  return items;
}

/** Read-only live view of a Claude Code subagent, rendered under its spawning tool call. */
class ChatNativeSubagent extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true }) context?: ApplicationContext;
  @property({ attribute: false }) toolCallId = "";
  /** Render options of the spawning tool card; nested calls render with the same options. */
  @property({ attribute: false }) toolOptions?: Parameters<typeof renderToolCard>[1];
  @state() private result?: ChatNativeSubagentGetResult;
  @state() private messages: unknown[] = [];
  @state() private loadState: "idle" | "loading" | "ready" | "missing" | "error" = "idle";
  @state() private expandedCards: ReadonlySet<string> = new Set();
  private omittedEarlier = false;
  private missingRetries = 0;
  private generation = 0;
  private identity = "";
  private inFlight = false;
  private timer?: ReturnType<typeof setTimeout>;
  private items: SubagentItem[] = [];
  private itemsSource?: unknown[];
  private wasRunActive = false;

  private get sessionKey() {
    return this.toolOptions?.sessionKey ?? "";
  }

  private get agentId() {
    return this.toolOptions?.agentId;
  }

  private get runActive() {
    return this.toolOptions?.runActive === true;
  }

  constructor() {
    super();
    new SubscriptionsController(this).watchStore(() => this.context?.gateway);
  }

  private key() {
    return JSON.stringify([
      this.sessionKey,
      this.agentId,
      this.toolCallId,
      this.context ? gatewayPresentationScope(this.context.gateway).key : -1,
    ]);
  }

  override connectedCallback() {
    super.connectedCallback();
    if (this.hasUpdated) {
      this.schedule(0);
    }
  }

  override disconnectedCallback() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.generation += 1;
    this.inFlight = false;
    super.disconnectedCallback();
  }

  protected override willUpdate() {
    const runStarted = this.runActive && !this.wasRunActive;
    this.wasRunActive = this.runActive;
    const identity = this.key();
    if (identity !== this.identity) {
      this.identity = identity;
      this.generation += 1;
      this.inFlight = false;
      clearTimeout(this.timer);
      this.result = undefined;
      this.messages = [];
      this.omittedEarlier = false;
      this.missingRetries = 0;
      this.loadState = "idle";
      this.expandedCards = new Set();
      this.schedule(0);
    } else if (runStarted && this.loadState === "missing") {
      this.missingRetries = 0;
      this.schedule(0);
    } else if (this.loadState === "idle" && !this.inFlight && !this.timer) {
      // The first read waits for a connected gateway; retry once it renders us again.
      this.schedule(0);
    }
    if (this.itemsSource !== this.messages) {
      this.itemsSource = this.messages;
      this.items = buildNativeSubagentItems(this.messages);
    }
  }

  private schedule(delay: number) {
    clearTimeout(this.timer);
    this.timer = this.isConnected ? setTimeout(() => void this.refresh(), delay) : undefined;
  }

  private shouldKeepReading(): boolean {
    if (this.loadState === "missing") {
      return this.runActive && this.missingRetries < MAX_MISSING_RETRIES;
    }
    const result = this.result;
    return (
      this.loadState === "ready" &&
      (result?.more === true ||
        (result?.status === "running" &&
          (result.updatedAt === undefined || Date.now() - result.updatedAt < STALE_AFTER_MS)))
    );
  }

  private readonly refresh = async () => {
    this.timer = undefined;
    const context = this.context;
    const client = context?.gateway.snapshot.client;
    if (
      this.inFlight ||
      !this.isConnected ||
      !context ||
      context.gateway.snapshot.phase !== "connected" ||
      !client ||
      !this.sessionKey ||
      !this.toolCallId
    ) {
      return;
    }
    const generation = this.generation;
    const current = () =>
      this.isConnected &&
      generation === this.generation &&
      context.gateway.snapshot.client === client;
    this.inFlight = true;
    if (this.loadState === "idle") {
      this.loadState = "loading";
    }
    try {
      for (let page = 0; page < MAX_PAGES_PER_REFRESH; page += 1) {
        const result = await client.request<ChatNativeSubagentGetResult>(
          "chat.nativeSubagent.get",
          {
            sessionKey: this.sessionKey,
            ...(this.agentId ? { agentId: this.agentId } : {}),
            toolCallId: this.toolCallId,
            ...(this.result?.cursor !== undefined ? { cursor: this.result.cursor } : {}),
          },
        );
        if (!current()) {
          return;
        }
        if (!result.ok) {
          this.missingRetries += 1;
          this.loadState = "missing";
          break;
        }
        this.apply(result);
        if (!result.more) {
          break;
        }
      }
    } catch {
      if (!current()) {
        return;
      }
      this.loadState = "error";
    } finally {
      if (generation === this.generation) {
        this.inFlight = false;
      }
    }
    if (current() && this.shouldKeepReading()) {
      this.schedule(NATIVE_SUBAGENT_REFRESH_MS);
    }
  };

  private apply(result: ChatNativeSubagentGetResult) {
    const incoming = result.messages ?? [];
    const base = result.reset ? [] : this.messages;
    let messages = incoming.length > 0 || result.reset ? [...base, ...incoming] : base;
    this.omittedEarlier =
      (result.reset ? false : this.omittedEarlier) || result.omittedEarlier === true;
    if (messages.length > MAX_MESSAGES) {
      messages = messages.slice(-MAX_MESSAGES);
      this.omittedEarlier = true;
    }
    this.messages = messages;
    this.result = result;
    this.loadState = "ready";
  }

  private toggleCard(key: string) {
    const next = new Set(this.expandedCards);
    if (!next.delete(key)) {
      next.add(key);
    }
    this.expandedCards = next;
  }

  private renderStatus(result: ChatNativeSubagentGetResult) {
    const stale =
      result.status === "running" &&
      result.updatedAt !== undefined &&
      Date.now() - result.updatedAt >= STALE_AFTER_MS;
    return html`
      <span class="chat-native-subagent__chip" data-status=${result.status ?? "running"}
        >${result.status === "done" ? t("chat.toolCards.nativeSubagent.done") : t("chat.toolCards.nativeSubagent.running")}</span
      >
      ${
        result.background
          ? html`<span class="chat-native-subagent__chip"
              >${t("chat.toolCards.nativeSubagent.background")}</span
            >`
          : nothing
      }
      ${
        stale
          ? html`<span class="chat-native-subagent__note"
              >${t("chat.toolCards.nativeSubagent.stale", {
                time: new Date(result.updatedAt!).toLocaleTimeString(),
              })}</span
            >`
          : nothing
      }
    `;
  }

  private renderItems(running: boolean) {
    if (this.items.length === 0) {
      return html`<p class="chat-native-subagent__note">
        ${t("chat.toolCards.nativeSubagent.empty")}
      </p>`;
    }
    return html`<div class="chat-native-subagent__items">
      ${this.items.map((item) =>
        item.kind === "text"
          ? html`<div class="chat-native-subagent__text chat-text">
              ${unsafeHTML(toSanitizedMarkdownHtml(item.text))}
            </div>`
          : this.toolOptions
            ? renderToolCard(item.card, {
                ...this.toolOptions,
                // The spawning card's activity group is not the nested call's.
                activityCards: undefined,
                messageKey: `${this.toolOptions.messageKey}:subagent:${this.toolCallId}`,
                runActive: running,
                expanded: this.expandedCards.has(item.key),
                onToggleExpanded: () => this.toggleCard(item.key),
              })
            : nothing,
      )}
    </div>`;
  }

  override render() {
    const result = this.result;
    if (this.loadState === "missing" && !this.shouldKeepReading()) {
      return nothing;
    }
    const busy = this.loadState === "idle" || this.loadState === "loading";
    return html`<section class="chat-native-subagent" aria-busy=${busy}>
      <div class="chat-native-subagent__header">
        <span class="chat-native-subagent__label">${t("chat.toolCards.nativeSubagent.title")}</span>
        ${
          result?.description
            ? html`<span class="chat-native-subagent__description">${result.description}</span>`
            : nothing
        }
        ${
          result?.agentType
            ? html`<span class="chat-native-subagent__type">${result.agentType}</span>`
            : nothing
        }
        ${result ? this.renderStatus(result) : nothing}
      </div>
      ${
        this.omittedEarlier
          ? html`<p class="chat-native-subagent__note">
              ${t("chat.toolCards.nativeSubagent.earlierOmitted")}
            </p>`
          : nothing
      }
      ${busy ? html`<p class="chat-native-subagent__note" role="status">${t("common.loading")}</p>` : nothing}
      ${
        this.loadState === "missing"
          ? html`<p class="chat-native-subagent__note" role="status">
              ${t("chat.toolCards.nativeSubagent.waiting")}
            </p>`
          : nothing
      }
      ${
        this.loadState === "error"
          ? html`<p class="chat-native-subagent__note" role="alert">
              ${t("chat.toolCards.nativeSubagent.loadFailed")}
              <button
                class="btn btn--sm"
                type="button"
                @click=${() => {
                  this.loadState = result ? "ready" : "idle";
                  void this.refresh();
                }}
              >
                ${t("common.retry")}
              </button>
            </p>`
          : nothing
      }
      ${result ? this.renderItems(result.status === "running") : nothing}
    </section>`;
  }
}

if (!customElements.get("openclaw-chat-native-subagent")) {
  customElements.define("openclaw-chat-native-subagent", ChatNativeSubagent);
}
