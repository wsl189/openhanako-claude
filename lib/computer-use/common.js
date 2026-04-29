export const COMPUTER_USE_MCP_SERVER_KEY = "computer_use";
export const COMPUTER_USE_MCP_SERVER_NAME = "computer_use";
export const COMPUTER_USE_SWITCH = "computer_use";

export const CLI_HOST_PLATFORM_BUNDLE_ID = "com.hanako.cli-no-window";

export function isComputerUseSupportedPlatform(platform = process.platform) {
  return platform === "darwin" || platform === "win32";
}

export const CLI_HOST_BUNDLE_ID = CLI_HOST_PLATFORM_BUNDLE_ID;

export function getCliComputerUseCapabilities(platform = process.platform) {
  if (platform === "darwin") {
    return {
      screenshotFiltering: "native",
      platform: "darwin",
    };
  }

  if (platform !== "win32") {
    throw new Error(
      `Computer Use is only supported on macOS and Windows (received ${platform}).`,
    );
  }

  return {
    screenshotFiltering: "none",
    platform: "win32",
  };
}
