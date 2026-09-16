import { Collection } from "discord.js";
import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord.js";
import type { SlashCommand } from "../types";
import ask from "./ask";
import btw from "./btw";
import compact from "./compact";
import context from "./context";
import create from "./create";
import edit from "./edit";
import feature from "./feature";
import help from "./help";
import refine from "./refine";
import repo from "./repo";
import reset from "./reset";
import session from "./session";
import start from "./start";

/** All slash commands, indexed by command name for O(1) routing. */
export const commands: Collection<string, SlashCommand> = new Collection();
for (const cmd of [
  create,
  edit,
  ask,
  btw,
  feature,
  refine,
  reset,
  session,
  help,
  repo,
  start,
  compact,
  context,
]) {
  commands.set(cmd.data.name, cmd);
}

/** JSON payloads for the REST registration script. */
export const commandData: RESTPostAPIChatInputApplicationCommandsJSONBody[] = commands.map((c) =>
  c.data.toJSON(),
);
