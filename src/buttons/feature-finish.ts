import { MessageFlags } from "discord.js";
import { runVerification } from "../runtime/featureRunner";
import { clearRunningAgent, getOrCreateSession, isBusy } from "../services/sessions";
import type { ButtonHandler } from "./index";

const featureFinish: ButtonHandler = {
  namespace: "feature",
  action: "finish",
  /** ✅ Finish here — accept what's been done so far; PR stays open on GitHub. */
  async execute(i) {
    const session = getOrCreateSession(i.channelId);
    if (!isBusy(session)) {
      await i.reply({
        content: "ℹ️ No active run to finish.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // Capture before clearRunningAgent wipes runningAgent.
    const planText = session.runningAgent?.planText;
    const active = session.active;
    clearRunningAgent(session);
    await i.update({ components: [] });
    await i.followUp({
      content: "✅ Stopped here. PR is still open — use `/refine` to continue this feature later.",
    });
    // Run verification against the full PR diff so the comment reflects
    // everything that landed, not just the current loop.
    if (planText && active?.prNumber) {
      await runVerification({
        planText,
        active,
        prNumber: active.prNumber,
        channelId: i.channelId,
      });
    }
  },
};

export default featureFinish;
