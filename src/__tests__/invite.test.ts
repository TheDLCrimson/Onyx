import { describe, expect, it } from "vitest";
import { PermissionFlagsBits } from "discord.js";
import { buildInviteUrl } from "../utils/invite";

describe("buildInviteUrl()", () => {
  const url = new URL(buildInviteUrl("123456789012345678"));

  it("targets Discord's OAuth2 authorize endpoint with the client id", () => {
    expect(url.origin + url.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("123456789012345678");
  });

  it("requests bot + slash-command scopes", () => {
    expect(url.searchParams.get("scope")).toBe("bot applications.commands");
  });

  it("includes the channel permissions Onyx needs", () => {
    const perms = BigInt(url.searchParams.get("permissions") ?? "0");
    for (const flag of [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.EmbedLinks,
    ]) {
      expect(perms & flag).toBe(flag);
    }
    expect(perms & PermissionFlagsBits.Administrator).toBe(0n);
  });
});
