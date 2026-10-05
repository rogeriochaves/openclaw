import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type {
  ChatBackgroundWorkGetResult,
  ChatBackgroundWorkItem,
} from "../../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { applicationContext, type ApplicationContext } from "../../../app/context.ts";
import { gatewayPresentationScope } from "../../../app/gateway-presentation-scope.ts";
import "../../../components/elapsed-time.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatCliBackgroundWorkEnglish } from "../../../i18n/locales/en-chat-cli-background-work.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import { PollController } from "../../../lit/poll-controller.ts";
import { SubscriptionsController } from "../../../lit/subscriptions-controller.ts";

registerChatCliBackgroundWorkEnglish();

// Running work refreshes on this cadence; the Gateway samples processes at most every 2s.
export const CLI_BACKGROUND_WORK_REFRESH_MS = 5_000;
// With nothing running, look again now and then for work started outside a turn.
const IDLE_REFRESH_MS = 30_000;
// While a turn runs, its own Bash calls already show as tool cards.
const FOREGROUND_COMMAND_GRACE_MS = 60_000;

/** Items worth showing now: a running turn's fresh Bash calls are its tool cards, not background work. */
export function visibleCliBackgroundItems(
  items: readonly ChatBackgroundWorkItem[],
  options: { runWorking: boolean; now: number },
): ChatBackgroundWorkItem[] {
  return items.filter(
    (item) =>
      !options.runWorking ||
      item.kind !== "command" ||
      options.now - (item.startedAt ?? options.now) >= FOREGROUND_COMMAND_GRACE_MS,
  );
}

export function summarizeCliBackgroundItems(items: readonly ChatBackgroundWorkItem[]) {
  const running = items.filter((item) => item.status === "running");
  return {
    running: running.length,
    stale: running.filter((item) => item.stale).length,
    finished: items.length - running.length,
    lastActivityAt: running.reduce<number | undefined>(
      (latest, item) =>
        item.lastActivityAt === undefined ? latest : Math.max(latest ?? 0, item.lastActivityAt),
      undefined,
    ),
  };
}

function ago(at: number | undefined) {
  return at === undefined
    ? nothing
    : html`<openclaw-elapsed-time .startMs=${at} singleUnit></openclaw-elapsed-time>
        ${t("chat.backgroundTasks.cliWork.ago")}`;
}

const KIND_LABEL = {
  subagent: "chat.backgroundTasks.cliWork.kindSubagent",
  command: "chat.backgroundTasks.cliWork.kindCommand",
  detached: "chat.backgroundTasks.cliWork.kindDetached",
} as const;

const STATUS_LABEL = {
  running: "chat.backgroundTasks.cliWork.statusRunning",
  done: "chat.backgroundTasks.cliWork.statusDone",
  failed: "chat.backgroundTasks.cliWork.statusFailed",
  stopped: "chat.backgroundTasks.cliWork.statusStopped",
} as const;

/**
 * Status row for the work a claude-cli session keeps running outside its turns:
 * background subagents, long commands and detached jobs, with what each is doing
 * now and how long it has been quiet.
 */
class ChatCliBackgroundWork extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true }) context?: ApplicationContext;
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) agentId?: string;
  @property({ attribute: false }) runWorking = false;
  @state() private result?: ChatBackgroundWorkGetResult;
  @state() private expanded = false;
  private identity = "";
  private generation = 0;
  private inFlight = false;
  private lastFetchAt = 0;
  private wasRunWorking = false;

  private readonly subscriptions = new SubscriptionsController(this);
  private readonly polling = new PollController(
    this,
    CLI_BACKGROUND_WORK_REFRESH_MS,
    () => this.tick(),
    false,
    "visible",
  );

  constructor() {
    super();
    this.subscriptions.watch(
      () => this.context?.gateway,
      (gateway, notify) => gateway.subscribe(notify),
    );
  }

  override connectedCallback() {
    super.connectedCallback();
    this.polling.start();
  }

  private key() {
    return JSON.stringify([
      this.sessionKey,
      this.agentId,
      this.context ? gatewayPresentationScope(this.context.gateway).key : -1,
    ]);
  }

  protected override willUpdate() {
    const identity = this.key();
    const turnEnded = this.wasRunWorking && !this.runWorking;
    this.wasRunWorking = this.runWorking;
    if (identity !== this.identity) {
      this.identity = identity;
      this.generation += 1;
      this.inFlight = false;
      this.result = undefined;
      this.expanded = false;
      this.lastFetchAt = 0;
      queueMicrotask(() => void this.refresh());
    } else if (turnEnded) {
      // A turn often ends by starting background work; show it right away.
      queueMicrotask(() => void this.refresh());
    }
  }

  private tick() {
    const idle = !this.result?.available || this.result.items.length === 0;
    if (!idle || Date.now() - this.lastFetchAt >= IDLE_REFRESH_MS) {
      void this.refresh();
    }
  }

  private readonly refresh = async () => {
    const context = this.context;
    const client = context?.gateway.snapshot.client;
    if (
      this.inFlight ||
      !this.isConnected ||
      !context ||
      context.gateway.snapshot.phase !== "connected" ||
      !client ||
      !this.sessionKey
    ) {
      return;
    }
    const generation = this.generation;
    this.inFlight = true;
    this.lastFetchAt = Date.now();
    try {
      const result = await client.request<ChatBackgroundWorkGetResult>("chat.backgroundWork.get", {
        sessionKey: this.sessionKey,
        ...(this.agentId ? { agentId: this.agentId } : {}),
      });
      if (generation === this.generation && context.gateway.snapshot.client === client) {
        this.result = result;
      }
    } catch {
      // Keep the last good list; the next poll tries again.
    } finally {
      if (generation === this.generation) {
        this.inFlight = false;
      }
    }
  };

  private renderItem(item: ChatBackgroundWorkItem, staleMinutes: number) {
    const stale = item.status === "running" && item.stale;
    const activityLabel =
      item.kind === "subagent"
        ? t("chat.backgroundTasks.cliWork.latest")
        : t("chat.backgroundTasks.cliWork.waitingOn");
    return html`<li
      class="chat-cli-work__item"
      data-status=${item.status}
      data-stale=${stale ? "true" : "false"}
    >
      <div class="chat-cli-work__item-head">
        <span class="chat-cli-work__kind">${t(KIND_LABEL[item.kind])}</span>
        <span class="chat-cli-work__title" title=${item.title}>${item.title}</span>
        ${item.agentType ? html`<span class="chat-cli-work__type">${item.agentType}</span>` : nothing}
        <span class="chat-cli-work__chip" data-status=${item.status}
          >${t(STATUS_LABEL[item.status])}</span
        >
      </div>
      <div class="chat-cli-work__meta">
        ${
          item.startedAt !== undefined
            ? html`<span>${t("chat.backgroundTasks.cliWork.started")} ${ago(item.startedAt)}</span>`
            : nothing
        }
        ${
          item.lastActivityAt !== undefined
            ? html`<span
                >${t("chat.backgroundTasks.cliWork.lastActivity")} ${ago(item.lastActivityAt)}</span
              >`
            : nothing
        }
        ${
          item.status === "running" && item.cpuPercent !== undefined
            ? html`<span
                >${t("chat.backgroundTasks.cliWork.cpu", { percent: String(item.cpuPercent) })}</span
              >`
            : nothing
        }
        ${
          item.processCount !== undefined && item.processCount > 1
            ? html`<span
                >${t("chat.backgroundTasks.cliWork.processes", {
                  count: String(item.processCount),
                })}</span
              >`
            : nothing
        }
        ${item.pid !== undefined ? html`<span>${t("chat.backgroundTasks.cliWork.pid", { pid: String(item.pid) })}</span>` : nothing}
      </div>
      ${
        item.activity
          ? html`<div class="chat-cli-work__now">
              <span class="chat-cli-work__now-label">${activityLabel}</span>
              <code title=${item.activity}>${item.activity}</code>
              ${
                item.activityAt !== undefined && item.status === "running"
                  ? html`<span class="chat-cli-work__now-time">${ago(item.activityAt)}</span>`
                  : nothing
              }
            </div>`
          : nothing
      }
      ${(item.nested ?? []).map(
        (nested) =>
          html`<div class="chat-cli-work__nested">
            <span class="chat-cli-work__now-label"
              >${t("chat.backgroundTasks.cliWork.nested")}</span
            >
            <code title=${nested.label}>${nested.label}</code>
            <span class="chat-cli-work__now-time">${ago(nested.startedAt)}</span>
          </div>`,
      )}
      ${
        stale
          ? html`<div class="chat-cli-work__stale" role="note">
              ${t("chat.backgroundTasks.cliWork.stale", { minutes: String(staleMinutes) })}
            </div>`
          : nothing
      }
    </li>`;
  }

  override render() {
    const result = this.result;
    if (!result?.available) {
      return nothing;
    }
    const items = visibleCliBackgroundItems(result.items, {
      runWorking: this.runWorking,
      now: Date.now(),
    });
    if (items.length === 0) {
      return nothing;
    }
    const summary = summarizeCliBackgroundItems(items);
    const staleMinutes = Math.round(result.staleAfterMs / 60_000);
    const label =
      summary.running > 0
        ? summary.running === 1
          ? t("chat.backgroundTasks.cliWork.runningOne")
          : t("chat.backgroundTasks.cliWork.runningMany", { count: String(summary.running) })
        : summary.finished === 1
          ? t("chat.backgroundTasks.cliWork.finishedOne")
          : t("chat.backgroundTasks.cliWork.finishedMany", { count: String(summary.finished) });
    const quiet =
      summary.stale === 0
        ? undefined
        : summary.stale === 1
          ? t("chat.backgroundTasks.cliWork.quietOne", { minutes: String(staleMinutes) })
          : t("chat.backgroundTasks.cliWork.quietMany", {
              count: String(summary.stale),
              minutes: String(staleMinutes),
            });
    const tone = summary.running === 0 ? "ended" : summary.stale > 0 ? "stale" : "running";
    return html`<section class="chat-cli-work" data-tone=${tone}>
      <button
        class="chat-cli-work__bar"
        type="button"
        aria-expanded=${this.expanded ? "true" : "false"}
        title=${
          this.expanded
            ? t("chat.backgroundTasks.cliWork.hide")
            : t("chat.backgroundTasks.cliWork.show")
        }
        @click=${() => {
          this.expanded = !this.expanded;
        }}
      >
        <span class="chat-cli-work__dot" aria-hidden="true"></span>
        <span class="chat-cli-work__label" role="status">${label}</span>
        ${
          summary.lastActivityAt !== undefined
            ? html`<span class="chat-cli-work__sep" aria-hidden="true">·</span>
                <span class="chat-cli-work__time"
                  >${t("chat.backgroundTasks.cliWork.lastActivity")}
                  ${ago(summary.lastActivityAt)}</span
                >`
            : nothing
        }
        ${
          quiet
            ? html`<span class="chat-cli-work__sep" aria-hidden="true">·</span>
                <span class="chat-cli-work__quiet">${quiet}</span>`
            : nothing
        }
        <span class="chat-cli-work__chevron" aria-hidden="true">${this.expanded ? "▾" : "▸"}</span>
      </button>
      ${
        this.expanded
          ? html`${
                result.processScan && !result.processAlive && summary.running === 0
                  ? html`<p class="chat-cli-work__note">
                      ${t("chat.backgroundTasks.cliWork.processGone")}
                    </p>`
                  : nothing
              }
              <ul class="chat-cli-work__list">
                ${items.map((item) => this.renderItem(item, staleMinutes))}
              </ul>`
          : nothing
      }
    </section>`;
  }
}

if (!customElements.get("openclaw-chat-cli-background-work")) {
  customElements.define("openclaw-chat-cli-background-work", ChatCliBackgroundWork);
}
