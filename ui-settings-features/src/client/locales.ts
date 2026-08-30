/** Feature configuration (功能配置) settings copy, zh primary and en fallback. */

export const zh = {
  'nav': '功能配置',
  'title': '功能配置',
  'intro': '为图片、音频、视频分别配置专属理解模型。发送对应媒体时，会自动转交给这些模型理解，再将结果交给当前会话模型回答。',
  'image.title': '图片理解',
  'audio.title': '音频理解',
  'video.title': '视频理解',
  'primary': '专属模型',
  'backup': '备用模型',
  'backupHint': '专属模型调用失败时自动切换',
  'provider': '服务商',
  'model': '模型',
  'unset': '未设置',
  'loadFailed': '配置加载失败',
  'retry': '重试',
  'readonly': '当前部署的设置文档为只读，无法修改',
  'noModels': '该服务商没有可用模型',
  'noCapableModels': '当前没有服务商声明支持{media}输入，请配置支持该媒体的模型后再使用。',
  'incapableRoute': '已选模型不支持{media}输入，理解将无法执行，请更换为支持该媒体的模型。',
  'error': '保存失败：{message}',
} as const

/** Dictionary namespace keys owned by this plugin. */
export type FeaturesKey = keyof typeof zh

export const en: Record<FeaturesKey, string> = {
  'nav': 'Features',
  'title': 'Features',
  'intro': 'Configure a dedicated understanding model for images, audio, and video. When you send such media, it is routed to these models for understanding, and the result is passed to the conversation model.',
  'image.title': 'Image understanding',
  'audio.title': 'Audio understanding',
  'video.title': 'Video understanding',
  'primary': 'Dedicated model',
  'backup': 'Backup model',
  'backupHint': 'Used automatically when the dedicated model fails',
  'provider': 'Provider',
  'model': 'Model',
  'unset': 'Not set',
  'loadFailed': 'Failed to load feature configuration',
  'retry': 'Retry',
  'readonly': 'Settings are read-only in this deployment',
  'noModels': 'This provider has no available models',
  'noCapableModels': 'No provider declares support for {media} input yet — configure a model that accepts that media before using it.',
  'incapableRoute': 'The selected model does not accept {media} input; understanding will not run. Pick a model that supports that media.',
  'error': 'Save failed: {message}',
}
