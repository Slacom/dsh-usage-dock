/**
 * GLM Coding Plan 国际版（Z.AI）渠道：`https://api.z.ai/api/monitor/usage/quota/limit`。
 * 复用 v0.2 的 `glmEnabled` / `glmApiKey` 遗留键：v0.2 只有单个 GLM 入口且实测
 * 为国际版 Z.AI 的 Key，直接归到本渠道。
 */
import { createGlmPlan } from './glm.js'

export default createGlmPlan({
  id: 'glm-zai',
  name: 'GLM Z.AI',
  enabledField: 'glmEnabled',
  apiKeyField: 'glmApiKey',
  endpoint: 'https://api.z.ai/api/monitor/usage/quota/limit',
  refs: ['ZAI_API_KEY', 'Z_AI_API_KEY', 'GLM_ZAI_API_KEY'],
})
