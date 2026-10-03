import { html, nothing, type TemplateResult } from "lit";
import type {
  SessionCompanionCatchup,
  SessionCompanionCatchupItem,
  SessionCompanionCatchupRef,
} from "../../../../../packages/gateway-protocol/src/schema/sessions.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { formatTimeMs } from "../../../lib/format.ts";

const CATCHUP_LIST_SECTIONS = ["facts", "waiting", "blocked", "other"] as const;

type OpenReference = ((entryId: string) => void) | undefined;

function formatCatchupTime(ts: number | undefined): string {
  return formatTimeMs(ts, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }, "");
}

function catchupRefNumber(id: string): string {
  return id.replace(/^m/u, "");
}

function renderRefs(
  ids: readonly string[],
  byRef: Map<string, SessionCompanionCatchupRef>,
  open: OpenReference,
) {
  if (ids.length === 0) {
    return nothing;
  }
  return html`<span class="chat-session-rail__catchup-refs">
    ${ids.map((id) => {
      const cited = byRef.get(id);
      const time = formatCatchupTime(cited?.ts);
      const title = cited
        ? [time, cited.label].filter(Boolean).join(" ") +
          (cited.excerpt ? `: ${cited.excerpt}` : "")
        : "";
      const entryId = cited?.entryId;
      return html`<button
        class="chat-session-rail__catchup-ref"
        type="button"
        title=${title}
        aria-label=${t("chat.rail.catchup.openRef", { ref: catchupRefNumber(id) })}
        ?disabled=${!entryId || !open}
        @click=${() => entryId && open?.(entryId)}
      >
        ${catchupRefNumber(id)}
      </button>`;
    })}
  </span>`;
}

function renderItems(
  items: readonly SessionCompanionCatchupItem[],
  byRef: Map<string, SessionCompanionCatchupRef>,
  open: OpenReference,
) {
  return html`<ul class="chat-session-rail__catchup-list">
    ${items.map(
      (item) => html`<li><span>${item.text}</span>${renderRefs(item.refs, byRef, open)}</li>`,
    )}
  </ul>`;
}

function renderSection(key: string, body: TemplateResult) {
  return html`
    <section class="chat-session-rail__catchup-section" data-section=${key}>
      <h4 class="chat-session-rail__catchup-title">
        ${t(`chat.rail.catchup.sections.${key}` as Parameters<typeof t>[0])}
      </h4>
      ${body}
    </section>
  `;
}

/**
 * Native catch-up view: header, a prominent link to the full report, then the
 * sections in a fixed order. Every cited ref opens its main-chat message.
 */
export function renderSessionRailCatchup(
  catchup: SessionCompanionCatchup,
  open: OpenReference,
): TemplateResult {
  const byRef = new Map(catchup.refs.map((cited) => [cited.ref, cited]));
  const since = formatCatchupTime(catchup.sinceTs);
  const heading =
    catchup.ownerMessageFound && since
      ? t("chat.rail.catchup.headingSince", { time: since })
      : t("chat.rail.catchup.headingRecent");
  const report = catchup.fullReport ? byRef.get(catchup.fullReport) : undefined;
  const reportEntryId = report?.entryId;
  const { asked, status } = catchup;
  return html`
    <div class="chat-session-rail__catchup" data-testid="side-chat-catchup">
      <strong class="chat-session-rail__catchup-heading">${heading}</strong>
      ${
        report
          ? html`<button
              class="chat-session-rail__catchup-report"
              type="button"
              title=${report.excerpt}
              ?disabled=${!reportEntryId || !open}
              @click=${() => reportEntryId && open?.(reportEntryId)}
            >
              ${icons.fileText}<span>${t("chat.rail.catchup.fullReport")}</span>
              ${
                report.ts
                  ? html`<span class="chat-session-rail__catchup-report-time"
                      >${formatCatchupTime(report.ts)}</span
                    >`
                  : nothing
              }
            </button>`
          : nothing
      }
      ${
        asked
          ? renderSection(
              "asked",
              html`<p class="chat-session-rail__catchup-line">
                <span>${asked.text}</span>${renderRefs(asked.refs, byRef, open)}
              </p>`,
            )
          : nothing
      }
      ${
        status
          ? renderSection(
              "status",
              html`<p class="chat-session-rail__catchup-line">
                ${
                  status.state
                    ? html`<span class="chat-session-rail__catchup-state" data-state=${status.state}
                        >${t(`chat.rail.catchup.state.${status.state}` as Parameters<typeof t>[0])}</span
                      >`
                    : nothing
                }
                <span>${status.text}</span>${renderRefs(status.refs, byRef, open)}
              </p>`,
            )
          : nothing
      }
      ${CATCHUP_LIST_SECTIONS.map((key) =>
        catchup[key].length > 0
          ? renderSection(key, renderItems(catchup[key], byRef, open))
          : nothing,
      )}
    </div>
  `;
}
