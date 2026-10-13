import { html, nothing, render, type TemplateResult } from "lit";
import { keyed } from "lit/directives/keyed.js";
import type { ControlUiHost, ControlUiView } from "openclaw/plugin-sdk/control-ui";
import { icons } from "../../components/icons.ts";
import { workboardLocale } from "../../host.ts";
import { t } from "../../i18n/index.ts";
import type { FeedStore } from "../../lib/feed/feed-store.ts";
import { feedGreeting, type FeedItem } from "../../lib/feed/feed-view.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { WorkboardComment, WorkboardFeedAction } from "../../lib/workboard/types.ts";
import { renderFeedMarkdown } from "./feed-markdown.ts";

export const FEED_PAGE_ID = "feed";

/** How long a decided card shows its checked state before it folds into the handled list. */
const FEED_CONFIRM_MS = 900;
const FEED_COLLAPSE_MS = 320;
const FEED_TOAST_MS = 6000;
const FEED_THREAD_PREVIEW = 2;
const FEED_HANDLED_PREVIEW = 5;
const FEED_BODY_FOLD_CHARS = 280;

type CardPhase = "idle" | "pending" | "confirmed" | "collapsing";

type CardUi = {
  phase: CardPhase;
  pendingAction?: string;
  confirmedLabel?: string;
  editing: boolean;
  draftText: string;
  commentOpen: boolean;
  commentText: string;
  bodyExpanded: boolean;
  threadExpanded: boolean;
  error?: string;
};

type Toast = { text: string; undo?: () => void; timer: ReturnType<typeof setTimeout> };

function newCardUi(): CardUi {
  return {
    phase: "idle",
    editing: false,
    draftText: "",
    commentOpen: false,
    commentText: "",
    bodyExpanded: false,
    threadExpanded: false,
  };
}

function formatTime(at: number, now: number): string {
  const locale = workboardLocale();
  const date = new Date(at);
  const today = new Date(now);
  const sameDay = date.toDateString() === today.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  }
  const yesterday = new Date(now);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return t("feed.yesterday");
  }
  return date.toLocaleDateString(locale, { month: "short", day: "numeric" });
}

function agentIdFromSession(sessionKey: string | undefined): string | undefined {
  const match = /^agent:([^:]+):/.exec(sessionKey ?? "");
  return match?.[1];
}

function agentName(host: ControlUiHost, agentId: string | undefined): string {
  if (!agentId) {
    return t("feed.agentFallback");
  }
  const agent = host.agents.rows.find((row) => row.id === agentId);
  return agent?.identity?.name ?? agent?.name ?? agentId;
}

function notifyAgentId(item: FeedItem): string {
  return agentIdFromSession(item.feed.notify) ?? item.card.agentId ?? "main";
}

function autosize(event: Event) {
  const area = event.target as HTMLTextAreaElement;
  area.style.height = "auto";
  area.style.height = `${area.scrollHeight}px`;
}

export function createFeedPage(feed: FeedStore): ControlUiView {
  return (container, initialContext) => {
    const host = initialContext.host;
    let context = initialContext;
    let disposed = false;
    let queued = false;
    let handledExpanded = false;
    let toast: Toast | null = null;
    const ui = new Map<string, CardUi>();
    // Decided cards stay in place, checked, until their fold animation ends.
    const held = new Map<string, { item: FeedItem; index: number }>();

    const cardUi = (id: string): CardUi => {
      let entry = ui.get(id);
      if (!entry) {
        entry = newCardUi();
        ui.set(id, entry);
      }
      return entry;
    };

    const requestUpdate = () => {
      if (disposed || queued) {
        return;
      }
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (!disposed) {
          update();
        }
      });
    };

    const showToast = (text: string, undo?: () => void) => {
      if (toast) {
        clearTimeout(toast.timer);
      }
      toast = {
        text,
        ...(undo ? { undo } : {}),
        timer: setTimeout(() => {
          toast = null;
          requestUpdate();
        }, FEED_TOAST_MS),
      };
      requestUpdate();
    };

    const cardElement = (id: string) =>
      container.querySelector<HTMLElement>(`[data-feed-card="${CSS.escape(id)}"]`);

    // Fold the card shut, then let the refreshed view place it in the handled list.
    const collapse = (item: FeedItem, index: number) => {
      held.set(item.card.id, { item, index });
      const state = cardUi(item.card.id);
      state.phase = "confirmed";
      requestUpdate();
      setTimeout(() => {
        if (disposed) {
          return;
        }
        state.phase = "collapsing";
        const element = cardElement(item.card.id);
        const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        if (element && !reduceMotion) {
          const height = element.getBoundingClientRect().height;
          element.animate(
            [
              { height: `${height}px`, opacity: 1, transform: "scale(1)" },
              { height: "0px", opacity: 0, transform: "scale(0.98)", marginBottom: "-12px" },
            ],
            { duration: FEED_COLLAPSE_MS, easing: "cubic-bezier(0.2, 0, 0, 1)", fill: "forwards" },
          );
        }
        setTimeout(
          () => {
            held.delete(item.card.id);
            ui.delete(item.card.id);
            requestUpdate();
          },
          reduceMotion ? 0 : FEED_COLLAPSE_MS,
        );
      }, FEED_CONFIRM_MS);
    };

    const runAction = async (item: FeedItem, index: number, action: WorkboardFeedAction) => {
      const state = cardUi(item.card.id);
      if (state.phase !== "idle") {
        return;
      }
      state.phase = "pending";
      state.pendingAction = action.id;
      state.error = undefined;
      requestUpdate();
      // Hold first so the acked card keeps its place while the store republishes.
      held.set(item.card.id, { item, index });
      try {
        await feed.act(item.card.id, action.id, state.editing ? state.draftText : undefined);
        state.confirmedLabel = action.doneLabel ?? action.label;
        state.editing = false;
        collapse(item, index);
        showToast(t("feed.sentTo", { agent: agentName(host, notifyAgentId(item)) }));
      } catch (error) {
        held.delete(item.card.id);
        state.phase = "idle";
        state.pendingAction = undefined;
        state.error = formatUiError(error);
        requestUpdate();
      }
    };

    const runAck = async (item: FeedItem, index: number) => {
      const state = cardUi(item.card.id);
      if (state.phase !== "idle") {
        return;
      }
      state.phase = "pending";
      state.pendingAction = "__ack";
      requestUpdate();
      // Hold first so the acked card keeps its place while the store republishes.
      held.set(item.card.id, { item, index });
      try {
        await feed.ack(item.card.id, true);
        state.confirmedLabel = t("feed.done");
        collapse(item, index);
        showToast(t("feed.movedToHandled"), () => void feed.ack(item.card.id, false));
      } catch (error) {
        held.delete(item.card.id);
        state.phase = "idle";
        state.error = formatUiError(error);
        requestUpdate();
      }
    };

    const runComment = async (item: FeedItem, index: number) => {
      const state = cardUi(item.card.id);
      const body = state.commentText.trim();
      if (!body || state.phase !== "idle") {
        return;
      }
      state.phase = "pending";
      state.pendingAction = "__comment";
      state.error = undefined;
      requestUpdate();
      // Hold first so the acked card keeps its place while the store republishes.
      held.set(item.card.id, { item, index });
      try {
        await feed.comment(item.card.id, body, state.editing ? state.draftText : undefined);
        state.editing = false;
        state.commentText = "";
        state.commentOpen = false;
        state.confirmedLabel = t("feed.replied");
        collapse(item, index);
        showToast(t("feed.sentTo", { agent: agentName(host, notifyAgentId(item)) }));
      } catch (error) {
        held.delete(item.card.id);
        state.phase = "idle";
        state.error = formatUiError(error);
        requestUpdate();
      }
    };

    const saveDraft = async (item: FeedItem) => {
      const state = cardUi(item.card.id);
      state.error = undefined;
      try {
        await feed.saveDraft(item.card.id, state.draftText);
        state.editing = false;
      } catch (error) {
        state.error = formatUiError(error);
      }
      requestUpdate();
    };

    const renderDraft = (item: FeedItem, state: CardUi, locked: boolean) => {
      const draft = item.feed.draft;
      if (draft === undefined && !state.editing) {
        return nothing;
      }
      return html`<div class="wb-feed-draft ${state.editing ? "wb-feed-draft--editing" : ""}">
        ${
          item.feed.draftHeader
            ? html`<div class="wb-feed-draft__header">
                ${item.feed.draftHeader.split("\n").map((line) => {
                  const split = /^([^:]{1,16}):\s*(.*)$/.exec(line);
                  return split
                    ? html`<div>
                        <span class="wb-feed-draft__key">${split[1]}</span
                        ><span class="wb-feed-draft__value">${split[2]}</span>
                      </div>`
                    : html`<div class="wb-feed-draft__value">${line}</div>`;
                })}
              </div>`
            : nothing
        }
        ${
          state.editing
            ? html`<textarea
                  class="wb-feed-draft__input"
                  aria-label=${t("feed.editDraft")}
                  .value=${state.draftText}
                  @input=${(event: Event) => {
                    state.draftText = (event.target as HTMLTextAreaElement).value;
                    autosize(event);
                  }}
                  @focus=${autosize}
                ></textarea>
                <div class="wb-feed-draft__edit-actions">
                  <button
                    type="button"
                    class="wb-feed-btn wb-feed-btn--quiet"
                    @click=${() => {
                      state.editing = false;
                      requestUpdate();
                    }}
                  >
                    ${t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    class="wb-feed-btn wb-feed-btn--secondary"
                    ?disabled=${locked || !state.draftText.trim()}
                    @click=${() => void saveDraft(item)}
                  >
                    ${t("feed.saveDraft")}
                  </button>
                </div>`
            : html`<div class="wb-feed-draft__body">${draft}</div>
                ${
                  locked
                    ? nothing
                    : html`<button
                        type="button"
                        class="wb-feed-draft__edit"
                        aria-label=${t("feed.editDraft")}
                        title=${t("feed.editDraft")}
                        @click=${async () => {
                          state.editing = true;
                          state.draftText = draft ?? "";
                          requestUpdate();
                          await Promise.resolve();
                          cardElement(item.card.id)
                            ?.querySelector<HTMLTextAreaElement>(".wb-feed-draft__input")
                            ?.focus();
                        }}
                      >
                        ${icons.penLine}<span>${t("feed.edit")}</span>
                      </button>`
                }`
        }
      </div>`;
    };

    const renderMetric = (item: FeedItem) => {
      const metric = item.feed.metric;
      if (!metric) {
        return nothing;
      }
      const bars = metric.bars ?? [];
      const max = Math.max(1, ...bars.map((bar) => Math.abs(bar.value)));
      return html`<div class="wb-feed-metric">
        <div class="wb-feed-metric__numbers">
          <div class="wb-feed-metric__value">${metric.value}</div>
          ${metric.delta ? html`<div class="wb-feed-metric__delta">${metric.delta}</div>` : nothing}
          ${
            metric.caption
              ? html`<div class="wb-feed-metric__caption">${metric.caption}</div>`
              : nothing
          }
        </div>
        ${
          bars.length > 0
            ? html`<div class="wb-feed-metric__bars" aria-hidden="true">
                ${bars.map(
                  (bar, index) => html`<div class="wb-feed-metric__bar-col">
                    <div
                      class="wb-feed-metric__bar ${index === bars.length - 1 ? "wb-feed-metric__bar--current" : ""}"
                      style=${`height:${Math.max(6, (Math.abs(bar.value) / max) * 100)}%`}
                    ></div>
                    <span>${bar.label}</span>
                  </div>`,
                )}
              </div>`
            : nothing
        }
      </div>`;
    };

    const renderBody = (item: FeedItem, state: CardUi) => {
      const body = item.body;
      if (!body) {
        return nothing;
      }
      const long = body.length > FEED_BODY_FOLD_CHARS || body.split("\n").length > 5;
      const folded = long && !state.bodyExpanded;
      return html`<div class="wb-feed-body">
        <div class="wb-feed-md ${folded ? "wb-feed-md--folded" : ""}">
          ${renderFeedMarkdown(body)}
        </div>
        ${
          long
            ? html`<button
                type="button"
                class="wb-feed-link-button"
                aria-expanded=${state.bodyExpanded ? "true" : "false"}
                @click=${() => {
                  state.bodyExpanded = !state.bodyExpanded;
                  requestUpdate();
                }}
              >
                ${state.bodyExpanded ? t("feed.less") : t("feed.more")}
              </button>`
            : nothing
        }
      </div>`;
    };

    const commentAuthor = (comment: WorkboardComment) => {
      if (comment.author?.kind === "owner") {
        return t("feed.you");
      }
      if (comment.author?.kind === "agent") {
        return agentName(host, comment.author.id);
      }
      return t("feed.note");
    };

    const renderThread = (item: FeedItem, state: CardUi, now: number) => {
      const comments = item.comments;
      if (comments.length === 0) {
        return nothing;
      }
      const hidden = state.threadExpanded ? 0 : Math.max(0, comments.length - FEED_THREAD_PREVIEW);
      return html`<div class="wb-feed-thread">
        ${
          hidden > 0
            ? html`<button
                type="button"
                class="wb-feed-link-button"
                @click=${() => {
                  state.threadExpanded = true;
                  requestUpdate();
                }}
              >
                ${t("feed.earlierComments", { count: String(hidden) })}
              </button>`
            : nothing
        }
        ${comments.slice(hidden).map(
          (comment) => html`<div
            class="wb-feed-comment ${comment.author?.kind === "owner" ? "wb-feed-comment--owner" : ""}"
          >
            <div class="wb-feed-comment__meta">
              <span class="wb-feed-comment__author">${commentAuthor(comment)}</span>
              <span>${formatTime(comment.createdAt, now)}</span>
            </div>
            <div class="wb-feed-md">${renderFeedMarkdown(comment.body)}</div>
          </div>`,
        )}
      </div>`;
    };

    const renderComposer = (item: FeedItem, index: number, state: CardUi, locked: boolean) => {
      if (!state.commentOpen) {
        return nothing;
      }
      const agent = agentName(host, notifyAgentId(item));
      return html`<div class="wb-feed-composer">
        <textarea
          class="wb-feed-composer__input"
          rows="2"
          placeholder=${t("feed.replyPlaceholder", { agent })}
          aria-label=${t("feed.replyPlaceholder", { agent })}
          .value=${state.commentText}
          @input=${(event: Event) => {
            const wasEmpty = !state.commentText.trim();
            state.commentText = (event.target as HTMLTextAreaElement).value;
            autosize(event);
            // Send is enabled only with text; re-render when that flips.
            if (wasEmpty !== !state.commentText.trim()) {
              requestUpdate();
            }
          }}
          @keydown=${(event: KeyboardEvent) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void runComment(item, index);
            } else if (event.key === "Escape") {
              state.commentOpen = false;
              requestUpdate();
            }
          }}
        ></textarea>
        <div class="wb-feed-composer__actions">
          <span class="wb-feed-composer__hint">${t("feed.replyHint", { agent })}</span>
          <button
            type="button"
            class="wb-feed-btn wb-feed-btn--quiet"
            @click=${() => {
              state.commentOpen = false;
              requestUpdate();
            }}
          >
            ${t("common.cancel")}
          </button>
          <button
            type="button"
            class="wb-feed-btn wb-feed-btn--primary"
            ?disabled=${locked || !state.commentText.trim()}
            @click=${() => void runComment(item, index)}
          >
            ${
              state.pendingAction === "__comment"
                ? html`<span class="wb-feed-spinner" aria-hidden="true"></span>`
                : icons.send
            }
            <span>${t("feed.sendReply")}</span>
          </button>
        </div>
      </div>`;
    };

    const renderActionButton = (
      item: FeedItem,
      index: number,
      state: CardUi,
      action: WorkboardFeedAction,
      position: number,
    ) => {
      const primary = action.style ? action.style === "primary" : position === 0;
      const pending = state.phase === "pending" && state.pendingAction === action.id;
      const confirmed =
        (state.phase === "confirmed" || state.phase === "collapsing") &&
        state.pendingAction === action.id;
      return html`<button
        type="button"
        class="wb-feed-btn ${primary ? "wb-feed-btn--primary" : "wb-feed-btn--secondary"} ${
          confirmed ? "wb-feed-btn--confirmed" : ""
        }"
        ?disabled=${state.phase !== "idle"}
        aria-busy=${pending ? "true" : "false"}
        @click=${() => void runAction(item, index, action)}
      >
        ${
          pending
            ? html`<span class="wb-feed-spinner" aria-hidden="true"></span>`
            : confirmed
              ? icons.check
              : nothing
        }
        <span>${confirmed ? (state.confirmedLabel ?? action.label) : action.label}</span>
      </button>`;
    };

    const renderCard = (item: FeedItem, index: number, now: number): TemplateResult => {
      const state = cardUi(item.card.id);
      const locked = state.phase !== "idle";
      const decided = state.phase === "confirmed" || state.phase === "collapsing";
      const sourceIcon = icons[item.icon];
      return html`<article
        class="wb-feed-card ${item.unread ? "wb-feed-card--unread" : ""} ${
          decided ? "wb-feed-card--decided" : ""
        } wb-feed-card--${item.card.priority}"
        data-feed-card=${item.card.id}
        aria-label=${item.title}
      >
        <header class="wb-feed-card__top">
          <span class="wb-feed-card__source ${decided ? "wb-feed-card__source--done" : ""}"
            >${decided ? icons.check : sourceIcon}</span
          >
          <span class="wb-feed-card__tag">${item.tag || t("feed.needsYou")}</span>
          ${item.unread ? html`<span class="wb-feed-card__unread">${t("feed.newReply")}</span>` : nothing}
          ${
            item.card.priority === "urgent"
              ? html`<span class="wb-feed-card__urgent">${t("feed.urgent")}</span>`
              : nothing
          }
          <time class="wb-feed-card__time" datetime=${new Date(item.sortAt).toISOString()}
            >${formatTime(item.sortAt, now)}</time
          >
        </header>
        <h2 class="wb-feed-card__title">${item.title}</h2>
        ${
          item.summary
            ? html`<p class="wb-feed-card__summary">
                <span class="wb-feed-card__summary-icon" aria-hidden="true">${icons.lightbulb}</span
                ><span>${item.summary}</span>
              </p>`
            : nothing
        }
        ${renderMetric(item)} ${renderDraft(item, state, locked)} ${renderBody(item, state)}
        ${
          item.feed.links?.length
            ? html`<div class="wb-feed-links">
                ${item.feed.links.map(
                  (link) => html`<a
                    class="wb-feed-chip"
                    href=${link.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    >${icons.externalLink}<span>${link.label}</span></a
                  >`,
                )}
              </div>`
            : nothing
        }
        ${renderThread(item, state, now)} ${renderComposer(item, index, state, locked)}
        ${state.error ? html`<p class="wb-feed-card__error" role="alert">${state.error}</p>` : nothing}
        <footer class="wb-feed-card__actions">
          <div class="wb-feed-card__decisions">
            ${item.actions.map((action, position) =>
              renderActionButton(item, index, state, action, position),
            )}
          </div>
          <div class="wb-feed-card__tools">
            <button
              type="button"
              class="wb-feed-icon-btn ${state.commentOpen ? "wb-feed-icon-btn--active" : ""}"
              aria-label=${t("feed.comment")}
              title=${t("feed.comment")}
              ?disabled=${locked}
              @click=${async () => {
                state.commentOpen = !state.commentOpen;
                requestUpdate();
                await Promise.resolve();
                cardElement(item.card.id)
                  ?.querySelector<HTMLTextAreaElement>(".wb-feed-composer__input")
                  ?.focus();
              }}
            >
              ${icons.messageSquare}
            </button>
            <button
              type="button"
              class="wb-feed-icon-btn wb-feed-icon-btn--labeled ${
                decided && state.pendingAction === "__ack" ? "wb-feed-icon-btn--done" : ""
              }"
              aria-label=${t("feed.doneHint")}
              title=${t("feed.doneHint")}
              ?disabled=${locked}
              @click=${() => void runAck(item, index)}
            >
              ${
                state.phase === "pending" && state.pendingAction === "__ack"
                  ? html`<span class="wb-feed-spinner" aria-hidden="true"></span>`
                  : icons.check
              }
              <span>${t("feed.done")}</span>
            </button>
          </div>
        </footer>
      </article>`;
    };

    const renderHandledRow = (item: FeedItem, now: number) => html`<li class="wb-feed-handled__row">
      <span class="wb-feed-handled__check" aria-hidden="true">${icons.check}</span>
      <span class="wb-feed-handled__label">${item.doneLabel}</span>
      <span class="wb-feed-handled__time">${formatTime(item.handledAt ?? now, now)}</span>
      ${
        item.card.status === "done"
          ? nothing
          : html`<button
              type="button"
              class="wb-feed-icon-btn wb-feed-handled__reopen"
              aria-label=${t("feed.reopen")}
              title=${t("feed.reopen")}
              @click=${() => void feed.ack(item.card.id, false)}
            >
              ${icons.undo}
            </button>`
      }
    </li>`;

    const update = () => {
      const now = Date.now();
      const view = feed.view(now);
      const open = view.open.filter((item) => !held.has(item.card.id));
      for (const [, entry] of [...held.entries()].toSorted((a, b) => a[1].index - b[1].index)) {
        open.splice(Math.min(entry.index, open.length), 0, entry.item);
      }
      const handled = view.handled.filter((item) => !held.has(item.card.id));
      const openCount = view.open.filter((item) => !held.has(item.card.id)).length;
      const name = feed.ownerName;
      const greeting = t(`feed.greeting.${feedGreeting(now)}`);
      const shownHandled = handledExpanded ? handled : handled.slice(0, FEED_HANDLED_PREVIEW);
      render(
        html`<div class="wb-feed" role="region" aria-label=${t("feed.title")}>
          <div class="wb-feed__inner">
            <header class="wb-feed__header">
              <div class="wb-feed__date">
                ${new Date(now).toLocaleDateString(workboardLocale(), {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                })}
              </div>
              <h1 class="wb-feed__greeting">${name ? `${greeting}, ${name}` : greeting}</h1>
              <p class="wb-feed__subline">
                ${
                  !feed.loaded
                    ? t("feed.loading")
                    : openCount === 0
                      ? t("feed.nothingNeedsYou")
                      : openCount === 1
                        ? t("feed.oneNeedsYou")
                        : t("feed.manyNeedYou", { count: String(openCount) })
                }
              </p>
            </header>
            ${
              feed.error
                ? html`<div class="wb-feed__error" role="alert">
                    <span>${feed.error}</span>
                    <button
                      type="button"
                      class="wb-feed-btn wb-feed-btn--secondary"
                      @click=${() => void feed.refresh()}
                    >
                      ${t("common.retry")}
                    </button>
                  </div>`
                : nothing
            }
            <div class="wb-feed__list">
              ${open.map((item, index) => keyed(item.card.id, renderCard(item, index, now)))}
            </div>
            ${
              feed.loaded && open.length === 0
                ? html`<div class="wb-feed__empty">
                    <span class="wb-feed__empty-icon" aria-hidden="true">${icons.check}</span>
                    <p>${t("feed.allCaughtUp")}</p>
                  </div>`
                : nothing
            }
            ${
              handled.length > 0
                ? html`<section class="wb-feed-handled" aria-label=${t("feed.handledToday")}>
                    <h2 class="wb-feed-handled__title">
                      ${t("feed.handledToday")}<span>${handled.length}</span>
                    </h2>
                    <ul class="wb-feed-handled__list">
                      ${shownHandled.map((item) => keyed(item.card.id, renderHandledRow(item, now)))}
                    </ul>
                    ${
                      handled.length > FEED_HANDLED_PREVIEW
                        ? html`<button
                            type="button"
                            class="wb-feed-link-button"
                            @click=${() => {
                              handledExpanded = !handledExpanded;
                              requestUpdate();
                            }}
                          >
                            ${
                              handledExpanded
                                ? t("feed.less")
                                : t("feed.showAll", { count: String(handled.length) })
                            }
                          </button>`
                        : nothing
                    }
                  </section>`
                : nothing
            }
          </div>
          ${
            toast
              ? html`<div class="wb-feed-toast" role="status">
                  <span>${toast.text}</span>
                  ${
                    toast.undo
                      ? html`<button
                          type="button"
                          @click=${() => {
                            const undo = toast?.undo;
                            if (toast) {
                              clearTimeout(toast.timer);
                            }
                            toast = null;
                            undo?.();
                            requestUpdate();
                          }}
                        >
                          ${t("feed.undo")}
                        </button>`
                      : nothing
                  }
                </div>`
              : nothing
          }
        </div>`,
        container,
      );
    };

    const unsubscribe = feed.subscribe(requestUpdate);
    const unsubscribeHost = host.subscribe(requestUpdate);
    if (context.presented) {
      void feed.refresh();
    }
    update();
    return {
      update(next) {
        const wasPresented = context.presented;
        context = next;
        if (!wasPresented && context.presented) {
          void feed.refresh();
        }
        requestUpdate();
      },
      dispose() {
        disposed = true;
        if (toast) {
          clearTimeout(toast.timer);
        }
        unsubscribe();
        unsubscribeHost();
        render(nothing, container);
      },
    };
  };
}
