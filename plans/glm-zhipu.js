/**
 * GLM Coding Plan 国内版（智谱开放平台）渠道：
 * `https://open.bigmodel.cn/api/monitor/usage/quota/limit`。
 */
import { createGlmPlan } from './glm.js'

export default createGlmPlan({
  id: 'glm-zhipu',
  name: 'GLM 智谱',
  enabledField: 'glmZhipuEnabled',
  apiKeyField: 'glmZhipuApiKey',
  endpoint: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
  refs: ['ZHIPU_API_KEY', 'ZHIPUAI_API_KEY', 'GLM_API_KEY', 'BIGMODEL_API_KEY'],
})
