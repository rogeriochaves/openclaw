import {
  isCliRuntimeAliasForProvider,
  resolveCliRuntimeExecutionProvider,
} from "../agents/model-runtime-aliases.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection-config.js";
import type { AgentSimpleCompletionSelection } from "../agents/simple-completion.types.js";
import { readUtilityModelSetting } from "../agents/utility-model-setting.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export const SESSION_COMPANION_TOOLS = ["read", "sessions_history", "sessions_search"] as const;

/**
 * CLI runtime that answers Side chat for the selected model, if any. The
 * automatic utility model is derived from the agent's primary provider, so it
 * also follows the CLI runtime that serves that primary: subscription-only
 * installs (for example `claude-cli`) have no direct provider credential.
 * An explicit utility model keeps its own route.
 */
export function resolveSessionCompanionCliRuntime(params: {
  cfg: OpenClawConfig;
  agentId: string;
  selection: Pick<AgentSimpleCompletionSelection, "provider" | "modelId" | "profileId">;
}): string | undefined {
  const selected = resolveCliRuntimeExecutionProvider({
    provider: params.selection.provider,
    cfg: params.cfg,
    agentId: params.agentId,
    modelId: params.selection.modelId,
    authProfileId: params.selection.profileId,
  });
  if (selected || readUtilityModelSetting(params.cfg, params.agentId).kind !== "auto") {
    return selected;
  }
  const primary = resolveDefaultModelForAgent({ cfg: params.cfg, agentId: params.agentId });
  const runtime = resolveCliRuntimeExecutionProvider({
    provider: primary.provider,
    cfg: params.cfg,
    agentId: params.agentId,
    modelId: primary.model,
  });
  return runtime &&
    isCliRuntimeAliasForProvider({
      runtime,
      provider: params.selection.provider,
      cfg: params.cfg,
    })
    ? runtime
    : undefined;
}
