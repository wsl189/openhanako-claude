/**
 * Baidu Cloud (百度智能云 / 千帆 / 文心) provider plugin
 *
 * 文档：https://cloud.baidu.com/doc/WENXINWORKSHOP/s/jlil56u11
 */

/** @type {import('../../core/provider-registry.js').ProviderPlugin} */
export const baiduCloudPlugin = {
  id: "baidu-cloud",
  displayName: "百度智能云 (文心)",
  authType: "api-key",
  defaultBaseUrl: "https://qianfan.baidubce.com/v2",
  defaultApi: "openai-completions",
  builtinModels: [
    "ernie-4.5-turbo-vl-32k", "ernie-4.0-turbo-128k",
  ],
  capabilities: {
    vision: true,
    functionCall: true,
    streaming: true,
    reasoning: false,
    quirks: [],
  },
};
