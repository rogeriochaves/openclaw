import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { icons } from "../../components/icons.ts";
import { workboardLocale } from "../../host.ts";
import { t } from "../../i18n/index.ts";
import { feedSnoozeOptions, type FeedItem } from "../../lib/feed/feed-view.ts";

function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString(workboardLocale(), { hour: "numeric", minute: "2-digit" });
}

/** A wake time: "15:30", "Tomorrow 9:00", "Mon 9:00", or "Nov 3, 9:00". */
export function formatWakeTime(at: number, now: number): string {
  const date = new Date(at);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) {
    return formatClock(at);
  }
  const tomorrow = new Date(now);
  tomorrow.setDate(today.getDate() + 1);
  if (date.toDateString() === tomorrow.toDateString()) {
    return t("feed.tomorrowAt", { time: formatClock(at) });
  }
  const options: Intl.DateTimeFormatOptions =
    at - now < 6 * 24 * 60 * 60 * 1000
      ? { weekday: "short", hour: "numeric", minute: "2-digit" }
      : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  return date.toLocaleString(workboardLocale(), options);
}

/** The value a datetime-local input expects, in local time. */
function toLocalInputValue(at: number): string {
  const date = new Date(at - new Date(at).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}

/** The in-card snooze choices. The card clips overflow for its fold animation, so no popover. */
export function renderSnoozePanel(params: {
  now: number;
  locked: boolean;
  custom: string;
  onCustom: (value: string) => void;
  onPick: (until: number) => void;
  onClose: () => void;
}) {
  const { now, locked } = params;
  const custom = params.custom ? new Date(params.custom).getTime() : Number.NaN;
  return html`<div
    class="wb-feed-snooze"
    role="group"
    aria-label=${t("feed.snoozeTitle")}
    @keydown=${(event: KeyboardEvent) => {
      if (event.key === "Escape") {
        params.onClose();
      }
    }}
  >
    <div class="wb-feed-snooze__head">
      <span>${t("feed.snoozeTitle")}</span>
      <button
        type="button"
        class="wb-feed-icon-btn"
        aria-label=${t("common.cancel")}
        title=${t("common.cancel")}
        @click=${params.onClose}
      >
        ${icons.x}
      </button>
    </div>
    <div class="wb-feed-snooze__options">
      ${feedSnoozeOptions(now).map(
        (option) => html`<button
          type="button"
          class="wb-feed-snooze__option"
          ?disabled=${locked}
          @click=${() => params.onPick(option.until)}
        >
          <span>${t(`feed.snoozeOption.${option.id}`)}</span>
          <span class="wb-feed-snooze__when">${formatWakeTime(option.until, now)}</span>
        </button>`,
      )}
    </div>
    <div class="wb-feed-snooze__custom">
      <input
        type="datetime-local"
        class="wb-feed-snooze__input"
        aria-label=${t("feed.snoozePick")}
        min=${toLocalInputValue(now)}
        .value=${params.custom}
        @input=${(event: Event) => params.onCustom((event.target as HTMLInputElement).value)}
      />
      <button
        type="button"
        class="wb-feed-btn wb-feed-btn--secondary"
        ?disabled=${locked || !(custom > now)}
        @click=${() => params.onPick(custom)}
      >
        ${t("feed.snooze")}
      </button>
    </div>
  </div>`;
}

/** The folded "Snoozed" list under the open cards, with each wake time and Unsnooze. */
export function renderSnoozedSection(params: {
  items: readonly FeedItem[];
  now: number;
  expanded: boolean;
  onToggle: () => void;
  onUnsnooze: (item: FeedItem) => void;
}) {
  const { items, now, expanded } = params;
  if (items.length === 0) {
    return nothing;
  }
  return html`<section class="wb-feed-handled wb-feed-snoozed" aria-label=${t("feed.snoozed")}>
    <h2 class="wb-feed-handled__title">
      <button
        type="button"
        class="wb-feed-snoozed__toggle"
        aria-expanded=${expanded ? "true" : "false"}
        @click=${params.onToggle}
      >
        ${expanded ? icons.chevronDown : icons.chevronRight} ${t("feed.snoozed")}<span
          >${items.length}</span
        >
      </button>
    </h2>
    ${
      expanded
        ? html`<ul class="wb-feed-handled__list">
            ${items.map((item) =>
              keyed(
                item.card.id,
                html`<li class="wb-feed-handled__row">
                  <span class="wb-feed-snoozed__icon" aria-hidden="true">${icons.clock}</span>
                  <span class="wb-feed-handled__label">${item.title}</span>
                  <span class="wb-feed-handled__time"
                    >${t("feed.until", {
                      time: formatWakeTime(item.snoozedUntil ?? now, now),
                    })}</span
                  >
                  <button
                    type="button"
                    class="wb-feed-btn wb-feed-btn--quiet wb-feed-snoozed__wake"
                    @click=${() => params.onUnsnooze(item)}
                  >
                    ${t("feed.unsnooze")}
                  </button>
                </li>`,
              ),
            )}
          </ul>`
        : nothing
    }
  </section>`;
}
