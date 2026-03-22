import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "../core/provider-registry.js";

describe("ProviderRegistry minimax migration", () => {
  it("registers minimax api-key provider", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hana-provider-registry-"));
    const reg = new ProviderRegistry(tmp);
    const minimax = reg.get("minimax");

    expect(minimax).toBeTruthy();
    expect(minimax.id).toBe("minimax");
    expect(minimax.authType).toBe("api-key");
    expect(minimax.baseUrl).toContain("minimaxi.com");

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("resolves oauth authJsonKey alias to registry entry", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hana-provider-registry-"));
    const reg = new ProviderRegistry(tmp);
    const codex = reg.get("openai-codex");

    expect(codex).toBeTruthy();
    expect(codex.id).toBe("openai-codex-oauth");
    expect(codex.authJsonKey).toBe("openai-codex");

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
