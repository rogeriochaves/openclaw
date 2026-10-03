import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { sendSessionObserverVisibility } from "./chat-observer.ts";
import { ChatPaneBase } from "./chat-pane-base.ts";
import {
  ChatSessionCompanionThreads,
  type ChatSessionCompanionAsk,
  type ChatSessionCompanionMode,
  type ChatSessionCompanionTurn,
  formatSideChatContext,
  requestSessionCompanionAnswer,
  requestSessionCompanionState,
} from "./chat-session-companion.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatAgentId } from "./chat-state-route.ts";
import { getChatComposerState } from "./components/chat-composer-state.ts";
import { createSideChatAttachment } from "./components/chat-selection-attachment.ts";
import type { SidebarLayout } from "./sidebar-layout-types.ts";
import {
  closeSlot,
  isSidebarSlotVisible,
  openSlot,
  promoteSidebarPanel,
  setSidebarExpanded,
  setSidebarOpen,
  sidebarMainPanel,
} from "./sidebar-layout.ts";

export abstract class ChatPaneSidePanels extends ChatPaneBase {
  protected sessionCompanionHydrationKey = "";
  protected sessionCompanionFocusGeneration = 0;
  private sessionCompanionPresented = false;
  protected sessionCompanionFocusRequest?: () => boolean;
  protected readonly sessionCompanionThreads = new ChatSessionCompanionThreads(() => {
    this.requestUpdate();
  });
  protected readonly setSessionObserverVisibility = (visible: boolean) => {
    const state = this.state;
    if (state?.connected && state.client) {
      void sendSessionObserverVisibility(state.client, visible).catch(() => undefined);
    }
    this.requestUpdate();
  };

  protected selectedSessionRailMode(sessionKey: string): "expanded" | "hidden" {
    const state = this.state;
    const visible =
      state?.sessionKey === sessionKey && isSidebarSlotVisible(state.sidebarLayout, "companion");
    return visible ? "expanded" : "hidden";
  }

  protected restorePaneSidebarLayout(layout: SidebarLayout): SidebarLayout {
    if (!this.compact) {
      return layout;
    }
    // Home's visibility consumers share the restored Chat-first layout;
    // the saved full-page task layout stays intact.
    const conversation = layout.columns[0]?.panels.find((panel) => panel.slot === "conversation");
    const restored = conversation ? promoteSidebarPanel(layout, conversation.id) : layout;
    return { ...restored, open: false, expanded: false };
  }

  protected setChatSidePanelOpen(open: boolean, layout?: SidebarLayout): void {
    const state = this.state;
    if (!state) {
      return;
    }
    const renderedLayout = layout ?? state.sidebarLayout;
    const nextLayout = setSidebarOpen(renderedLayout, open);
    if (renderedLayout.columns[0]?.panels.some((panel) => panel.slot === "companion")) {
      this.setSessionObserverVisibility(isSidebarSlotVisible(nextLayout, "companion"));
    }
    this.commitSidebarLayout(
      nextLayout,
      sidebarMainPanel(renderedLayout)?.slot === "dashboard"
        ? { dashboardPresentation: "personal" }
        : undefined,
    );
  }

  protected requestSessionRail(intent: "open" | "toggle"): void {
    const state = this.state;
    if (!state) {
      return;
    }
    const visible = this.selectedSessionRailMode(state.sessionKey) === "expanded";
    if (intent === "toggle" && visible) {
      this.commitSidebarLayout(closeSlot(state.sidebarLayout, "companion"));
      this.setSessionObserverVisibility(false);
      return;
    }
    this.commitSidebarLayout(openSlot(state.sidebarLayout, "companion"));
    this.setSessionObserverVisibility(true);
  }

  protected syncSessionCompanionPresentation(presented: boolean): void {
    if (
      this.sessionCompanionPresented === presented &&
      (presented || this.sessionCompanionFocusRequest === undefined)
    ) {
      return;
    }
    this.sessionCompanionPresented = presented;
    if (presented && this.state) {
      this.sessionCompanionFocusRequest ??= this.captureSessionCompanionFocus(
        this.state,
      ).requestFocus;
    } else {
      this.sessionCompanionFocusGeneration += 1;
      this.sessionCompanionFocusRequest = undefined;
    }
  }

  private captureSessionCompanionFocus(pageState: ChatPageHost) {
    const sessionKey = pageState.sessionKey;
    const agentId = resolveChatAgentId(pageState);
    const generation = this.connectionGeneration;
    const focusGeneration = this.sessionCompanionFocusGeneration;
    const composer = getChatComposerState(this.presentationId);
    const editRevision = composer.editRevision;
    const draft = pageState.chatMessage;
    const ownsFocus = () =>
      this.state === pageState &&
      pageState.sessionKey === sessionKey &&
      resolveChatAgentId(pageState) === agentId &&
      this.connectionGeneration === generation &&
      this.sessionCompanionFocusGeneration === focusGeneration &&
      composer.editRevision === editRevision &&
      pageState.chatMessage === draft &&
      this.sessionCompanionPresented &&
      (this.ownerDocument.activeElement === this.ownerDocument.body ||
        this.contains(this.ownerDocument.activeElement)) &&
      this.isConnected &&
      this.active &&
      this.visuallyPresented &&
      this.presented;
    const requestFocus = () => {
      if (this.sessionCompanionFocusRequest === requestFocus) {
        this.sessionCompanionFocusRequest = undefined;
        this.requestUpdate();
      }
      return ownsFocus();
    };
    return { ownsFocus, requestFocus };
  }

  protected async openSessionCompanion(
    pageState: ChatPageHost,
    question: string,
    mode?: ChatSessionCompanionMode,
    refresh = false,
  ): Promise<void> {
    const { ownsFocus, requestFocus } = this.captureSessionCompanionFocus(pageState);
    // The first lazy mount and the completed answer share the same input intent.
    this.sessionCompanionFocusRequest = requestFocus;
    this.requestUpdate();
    await this.submitSessionCompanionQuestion(question, mode, refresh);
    if (ownsFocus()) {
      this.sessionCompanionFocusRequest = requestFocus;
      this.requestUpdate();
    }
  }

  protected readonly submitSessionCompanionQuestion = async (
    question: string | ChatSessionCompanionTurn,
    mode?: ChatSessionCompanionMode,
    refresh = false,
  ) => {
    const state = this.state;
    if (!state || !state.sessionKey) {
      return;
    }
    const { sessionKey, client, connected } = state;
    const agentId = resolveChatAgentId(state);
    this.requestSessionRail("open");
    const catchup = (typeof question === "string" ? mode : question.mode) === "catchup";
    const text = typeof question === "string" ? question : question.question;
    if (!catchup && !text.trim()) {
      return;
    }
    if (!connected || !client) {
      if (!catchup) {
        this.sessionCompanionThreads.setDraft(sessionKey, text, agentId);
      }
      return;
    }
    const ask: ChatSessionCompanionAsk = (key, value, askMode, askOptions) =>
      requestSessionCompanionAnswer(client, key, value, agentId, askMode, askOptions);
    await this.sessionCompanionThreads.submit(sessionKey, question, ask, agentId, mode, {
      refresh,
    });
  };

  /** Side exchanges of the selected session as a text attachment for the main agent. */
  protected buildSideChatAttachment(pageState: ChatPageHost): ChatAttachment | null {
    const sessionKey = pageState.sessionKey;
    if (!sessionKey) {
      return null;
    }
    const thread = this.sessionCompanionThreads.view(sessionKey, resolveChatAgentId(pageState));
    const text = formatSideChatContext(thread.turns);
    return text ? createSideChatAttachment(text, pageState.hello?.policy?.attachments) : null;
  }

  /**
   * A focused side panel covers the conversation; restore the split so the main
   * chat is in view. Narrow panes already stack the side chat under the chat.
   */
  protected revealMainChatBesideCompanion(): void {
    const layout = this.state?.sidebarLayout;
    if (layout?.expanded && layout.expandedSide) {
      this.commitSidebarLayout(setSidebarExpanded(layout, false));
    }
  }

  /** Sends a follow-up to the main chat with the side thread attached; the thread stays. */
  protected readonly sendSessionCompanionToMain = async (text: string): Promise<void> => {
    const state = this.state;
    const message = text.trim();
    if (!state?.sessionKey || !message) {
      return;
    }
    const sessionKey = state.sessionKey;
    const agentId = resolveChatAgentId(state);
    const attachment = this.buildSideChatAttachment(state);
    this.revealMainChatBesideCompanion();
    const accepted = await state.handleSendChat(message, {
      attachmentsOverride: attachment ? [attachment] : [],
    });
    const thread = this.sessionCompanionThreads.view(sessionKey, agentId);
    if (accepted === true && thread.draft.trim() === message) {
      this.sessionCompanionThreads.setDraft(sessionKey, "", agentId);
    }
  };

  protected readonly prefillSessionCompanionQuestion = (question: string) => {
    const state = this.state;
    const sessionKey = state?.sessionKey;
    if (!sessionKey) {
      return;
    }
    this.sessionCompanionThreads.setDraft(sessionKey, question, resolveChatAgentId(state));
    this.requestSessionRail("open");
  };

  protected hydrateSessionCompanion(sessionKey: string): void {
    const state = this.state;
    if (!state?.connected || !state.client || !sessionKey || parseCatalogSessionKey(sessionKey)) {
      return;
    }
    const agentId = resolveChatAgentId(state);
    const hydrationKey = `${this.connectionGeneration}\0${agentId}\0${sessionKey}`;
    if (this.sessionCompanionHydrationKey === hydrationKey) {
      return;
    }
    this.sessionCompanionHydrationKey = hydrationKey;
    void this.sessionCompanionThreads.hydrate(
      sessionKey,
      (key) => requestSessionCompanionState(state.client!, key, agentId),
      agentId,
    );
  }
}
