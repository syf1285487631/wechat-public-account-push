// ==================== 环境变量加载 ====================
// 加载 .env 文件（如果存在）
try {
  require('dotenv').config()
  console.log('✅ 环境变量加载成功')
} catch (error) {
  console.log('⚠️  dotenv 未安装或加载失败，将使用系统环境变量')
}

// ==================== 配置变量读取 ====================
// 从环境变量读取所有配置，声明在脚本最前方
const ALL_CONFIG = (() => {
  let config = {}
  if (!process.env.ALL_CONFIG) {
    console.error('❌ 致命错误：未配置 ALL_CONFIG 环境变量，必须配置才能运行')
    process.exit(1)
  }
  try {
    config = JSON.parse(process.env.ALL_CONFIG)
    if (!config.TEMPLATE_CONFIG || config.TEMPLATE_CONFIG.length === 0) {
      console.error('❌ 致命错误：ALL_CONFIG 中的 TEMPLATE_CONFIG 不能为空')
      process.exit(1)
    }
    console.log(`✅ 已加载 ${config.TEMPLATE_CONFIG.length} 个自定义模板 (从 ALL_CONFIG 读取)`)

    // 强制设置默认值和类型转换，以兼容旧逻辑
    config.FESTIVALS_LIMIT = config.FESTIVALS_LIMIT === undefined ? 0 : parseInt(config.FESTIVALS_LIMIT)
    config.MAX_PUSH_ONE_MINUTE = config.MAX_PUSH_ONE_MINUTE === undefined ? 5 : parseInt(config.MAX_PUSH_ONE_MINUTE)
    config.SLEEP_TIME = config.SLEEP_TIME === undefined ? 65000 : parseInt(config.SLEEP_TIME)
    config.API_TIMEOUT = config.API_TIMEOUT === undefined ? 10000 : parseInt(config.API_TIMEOUT)
    config.MAX_RETRIES = config.MAX_RETRIES === undefined ? 3 : parseInt(config.MAX_RETRIES)
    config.RETRY_DELAY = config.RETRY_DELAY === undefined ? 2000 : parseInt(config.RETRY_DELAY)

  } catch (error) {
    console.error(`❌ 致命错误：ALL_CONFIG 解析失败: ${error.message}`)
    process.exit(1)
  }
  return config
})()

// ==================== 基础依赖 ====================

const axios = require('axios')
const dayjs = require('dayjs')

// ==================== 运行时存储 ====================

const RUN_TIME_STORAGE = {
  pushNum: 0,
  stats: {
    totalRequests: 0,
    errors: 0
  }
}

// ==================== 日志系统 ====================

const LOG_LEVELS = { INFO: 0, WARN: 1, ERROR: 2, SUCCESS: 3 }

const log = (message, level = 'INFO', extra = {}) => {
  const timestamp = new Date().toLocaleString()
  const prefix = level === 'SUCCESS' ? '✅' : (level === 'ERROR' ? '❌' : (level === 'WARN' ? '⚠️' : 'ℹ️'))
  let logMessage = `${prefix} [${timestamp}] [${level}] ${message}`
  if (Object.keys(extra).length > 0) logMessage += ` | ${JSON.stringify(extra)}`
  console.log(logMessage)
  if (level === 'ERROR') RUN_TIME_STORAGE.stats.errors++
}

const logInfo = (message, extra) => log(message, 'INFO', extra)
const logSuccess = (message, extra) => log(message, 'SUCCESS', extra)
const logWarning = (message, extra) => log(message, 'WARN', extra)
const logError = (message, extra) => log(message, 'ERROR', extra)

// ==================== 配置管理 ====================


/**
 * 初始化并验证配置
 * @param {object} rawConfig 从环境变量解析的原始配置
 * @returns {object} 经过验证和处理的最终配置
 */
const initializeAndValidateConfig = (rawConfig) => {
  const issues = []

  // 创建最终配置，同时处理向后兼容和默认值
  const config = {
    APP_ID: rawConfig.APP_ID || '',
    APP_SECRET: rawConfig.APP_SECRET || '',
    MAX_PUSH_ONE_MINUTE: rawConfig.MAX_PUSH_ONE_MINUTE,
    SLEEP_TIME: rawConfig.SLEEP_TIME,
    USERS: rawConfig.USER_INFO || [],
    TIAN_API_KEY: rawConfig.TIAN_API_KEY || '',
    FESTIVALS_LIMIT: rawConfig.FESTIVALS_LIMIT,
    API_TIMEOUT: rawConfig.API_TIMEOUT,
    MAX_RETRIES: rawConfig.MAX_RETRIES,
    RETRY_DELAY: rawConfig.RETRY_DELAY
  }

  // 验证微信配置
  if (!config.APP_ID && !config.APP_SECRET) {
    issues.push('未配置微信APP_ID或APP_SECRET，将无法使用微信推送')
  }

  // 验证用户配置
  if (!config.USERS || config.USERS.length === 0) {
    logWarning('未配置用户信息，将使用默认用户')
    config.USERS = createDefaultUser()
  } else {
    // 验证每个用户配置
    config.USERS = config.USERS.map((user, index) => validateUserConfig(user, index))
  }

  // 输出配置摘要
  logInfo(`配置加载完成 - 用户数: ${config.USERS.length}, 微信推送: ${!!config.APP_ID}`)
  logInfo(`天行API: ${!!config.TIAN_API_KEY}, 节日限制: ${config.FESTIVALS_LIMIT}`)

  if (issues.length > 0) {
    logWarning('配置问题：' + issues.join('; '))
  }

  return config
}

/**
 * 验证单个用户配置
 */
const validateUserConfig = (user, index) => {
  if (!user.name) {
    logWarning(`用户 ${index} 缺少名称，使用默认值`)
    user.name = `用户${index + 1}`
  }

  // 检查是否有至少一种推送方式
  const hasPushMethod = !!(user.id || user.pushDeerKey)
  if (!hasPushMethod) {
    logWarning(`用户 ${user.name} 未配置任何推送方式`)
  }

  // 设置默认值
  user.city = user.city || '北京'
  user.festivals = user.festivals || []
  user.customizedDateList = user.customizedDateList || []
  user.courseSchedule = user.courseSchedule || null

  // 如果未配置 weatherCityCode，仅做提示，不中断（基础天气接口可选）
  if (!user.weatherCityCode) {
    logInfo(`用户 ${user.name} 未配置 weatherCityCode（基础天气接口 t.weather.itboy.net 需要，天行API天气功能不需要）`)
  }

  // 处理模板ID：微信用户使用 wechatTemplateId，PushDeer用户使用 useTemplateId
  if (user.id && !user.wechatTemplateId && user.useTemplateId) {
    // 向后兼容：微信用户使用旧的 useTemplateId
    logWarning(`用户 ${user.name} 使用旧配置，建议迁移到 wechatTemplateId 字段`)
    user.wechatTemplateId = user.useTemplateId
  }

  // 为 PushDeer 用户设置默认本地模板ID
  if (user.pushDeerKey && !user.useTemplateId) {
    user.useTemplateId = '0001'
  }

  // 设置用户级 TIAN_API 配置（如果不存在则不启用相关功能）
  if (user.tianApi) {
    // 验证和设置 tianApi 配置
    user.tianApi.morning = user.tianApi.morning === true
    user.tianApi.evening = user.tianApi.evening === true
    user.tianApi.weatherDays = user.tianApi.weatherDays === true
    user.tianApi.hotCount = Math.max(0, parseInt(user.tianApi.hotCount, 10) || 0)
    user.tianApi.hotType = user.tianApi.hotType === 'title' ? 'title' : 'default'

    logInfo(`用户 ${user.name} 已配置 TIAN_API 功能：早安心语=${user.tianApi.morning}, 晚安心语=${user.tianApi.evening}, 天行天气=${user.tianApi.weatherDays}, 热搜条数=${user.tianApi.hotCount}`)
  } else {
    logInfo(`用户 ${user.name} 未配置 TIAN_API 功能，相关功能将不启用`)
  }

  // 设置用户级显示颜色配置（默认启用）
  user.showColor = user.showColor !== false // 默认 true，除非显式设置为 false

  return user
}

/**
 * 创建默认用户配置
 */
const createDefaultUser = () => {
  return [{
    name: '测试用户',
    id: '',
    pushDeerKey: '',
    wechatTemplateId: '',  // 新增：微信模板ID
    useTemplateId: '0001',  // 保留：本地模板ID（PushDeer使用）
    festivals: [],
    customizedDateList: [],
    city: '北京'
  }]
}

// 初始化配置
let CONFIG = initializeAndValidateConfig(ALL_CONFIG)

// ==================== 错误处理系统 ====================

/**
 * 自定义错误类
 */
class PushError extends Error {
  constructor(message, code = 'PUSH_ERROR', context = {}) {
    super(message)
    this.name = 'PushError'
    this.code = code
    this.context = context
  }
}

/**
 * 统一错误处理
 */
const handleError = (error, context, level = 'ERROR') => {
  const errorInfo = {
    message: error.message || error,
    stack: error.stack,
    context,
    timestamp: new Date().toISOString()
  }

  if (error instanceof PushError) {
    logError(`PushError [${error.code}] ${error.message}`, error.context)
  } else {
    logError(`未知错误发生在 ${context}: ${error.message}`, {
      type: error.constructor.name,
      stack: error.stack
    })
  }

  // HTTP错误特殊处理
  if (error.response) {
    logError(`HTTP错误 - 状态码: ${error.response.status}, 数据: ${JSON.stringify(error.response.data)}`)
  }

  return errorInfo
}

/**
 * 重试机制
 */
const withRetry = async (fn, context, maxRetries = CONFIG.MAX_RETRIES) => {
  let lastError = null

  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error

      if (i === maxRetries) {
        handleError(error, `${context} (最终重试失败)`)
        throw error
      }

      logWarning(`${context} 失败，第${i + 1}次重试...`)
      await sleep(CONFIG.RETRY_DELAY * (i + 1))
    }
  }

  throw lastError
}

// ==================== 工具函数 ====================

/**
 * 延迟函数
 */
const sleep = (time) => new Promise(resolve => setTimeout(resolve, time))

// 这里原本有内置城市列表（WEATHER_CITY），现已移除，城市编码改由用户配置提供

// ==================== HTTP客户端 ====================

const httpClient = {
  async get(url, options = {}) {
    RUN_TIME_STORAGE.stats.totalRequests++

    try {
      const response = await axios.get(url, {
        timeout: options.timeout || CONFIG.API_TIMEOUT,
        ...options
      })
      return response.data
    } catch (error) {
      throw new PushError(`HTTP GET请求失败: ${error.message}`, 'HTTP_ERROR', {
        url,
        status: error.response?.status,
        statusText: error.response?.statusText
      })
    }
  },

  async post(url, data, options = {}) {
    RUN_TIME_STORAGE.stats.totalRequests++

    try {
      const response = await axios.post(url, data, {
        timeout: options.timeout || CONFIG.API_TIMEOUT,
        ...options
      })
      return response.data
    } catch (error) {
      throw new PushError(`HTTP POST请求失败: ${error.message}`, 'HTTP_ERROR', {
        url,
        status: error.response?.status,
        statusText: error.response?.statusText
      })
    }
  }
}

// ==================== 模板验证 ====================

/**
 * 验证模板配置
 */
const validateTemplateConfig = () => {
  // 检查模板ID唯一性（非空检查已在 ALL_CONFIG 初始化时完成）
  const idSet = new Set()
  for (let i = 0; i < ALL_CONFIG.TEMPLATE_CONFIG.length; i++) {
    const template = ALL_CONFIG.TEMPLATE_CONFIG[i]

    if (!template.id) {
      console.error(`❌ 模板 ${i + 1} 缺少 id 字段`)
      process.exit(1)
    }

    if (idSet.has(template.id)) {
      console.error(`❌ 模板ID重复: ${template.id}`)
      process.exit(1)
    }
    idSet.add(template.id)

    if (!template.title) {
      console.error(`❌ 模板 ${i + 1} 缺少 title 字段`)
      process.exit(1)
    }

    if (!template.desc) {
      console.error(`❌ 模板 ${i + 1} 缺少 desc 字段`)
      process.exit(1)
    }

    // 模板内容长度检查
    if (template.title.length > 64) {
      console.warn(`⚠️  模板 ${template.id} 标题过长（超过64字符），可能影响微信显示`)
    }
    if (template.desc.length > 2000) {
      console.warn(`⚠️  模板 ${template.id} 描述过长（超过2000字符），可能被微信截断`)
    }

    // 模板变量预检查
    const validVariables = ['date', 'city', 'weather', 'max_temperature', 'min_temperature',
      'wind_direction', 'wind_scale', 'love_day', 'birthday_message', 'moment_copyrighting',
      'morning_greeting', 'evening_greeting', 'tian_weather', 'network_hot', 'today_courses',
      'chinese_note', 'english_note']

    const templateVars = template.desc.match(/\{\{([^}]+)\.DATA\}\}/g) || []
    templateVars.forEach(varMatch => {
      const varName = varMatch.replace(/^\{\{|\..*$/g, '')
      if (!validVariables.includes(varName)) {
        console.warn(`⚠️  模板 ${template.id} 使用了未知变量: ${varName}`)
      }
    })
  }

  console.log('✅ 模板配置验证通过')
}

// 验证模板配置
validateTemplateConfig()

// ==================== 数据服务 ====================

/**
 * 城市信息服务
 */

/**
 * 天气服务
 */
const weatherService = {
  /**
   * 获取基础天气信息（t.weather.itboy.net 接口）
   * 注意：此接口需要城市编码，仅提供基础天气功能
   * 如需使用天行API天气功能，请使用 tianApiService.getTianWeather()
   *
   * @param {string} city      配置中的城市名，仅用于日志展示
   * @param {string} cityCode  城市编码，如 101010100（从用户配置中读取）
   */
  async getWeather(city, cityCode) {
    try {
      const codeToUse = cityCode

      if (!codeToUse) {
        return { error: '获取天气信息失败：未配置城市编码（请在 USER_INFO 中添加 weatherCityCode）' }
      }

      logInfo(`使用城市编码获取天气: ${city || '未知城市'} -> ${codeToUse}`)

      const data = await withRetry(async () => {
        return httpClient.get(`http://t.weather.itboy.net/api/weather/city/${codeToUse}`)
      }, '获取天气数据')

      if (data.status === 200 && data.data) {
        const weatherData = data.data
        if (!data.cityInfo || !weatherData.forecast || !weatherData.forecast[0]) {
          return { error: '获取天气信息失败：数据结构异常' }
        }

        const forecast = weatherData.forecast[0]
        return {
          city: data.cityInfo.city,
          weather: forecast.type,
          max_temperature: forecast.high.replace(/高温/, '').replace('℃', '').trim(),
          min_temperature: forecast.low.replace(/低温/, '').replace('℃', '').trim(),
          wind_direction: forecast.fx,
          wind_scale: forecast.fl.replace(/级.*/, ''),
          ganmao: weatherData.ganmao || ''
        }
      } else {
        return { error: '获取天气信息失败：API返回异常' }
      }
    } catch (error) {
      return { error: `获取天气信息失败：${error.message}` }
    }
  }
}

/**
 * 每日一句服务
 */
const cibaService = {
  async getCIBA() {
    try {
      const data = await withRetry(async () => {
        return httpClient.get('http://open.iciba.com/dsapi/')
      }, '获取每日一句')

      if (data && data.content) {
        return {
          content: data.content,
          note: data.note || '',
          picture: data.picture || ''
        }
      } else {
        return { error: '获取每日一句失败' }
      }
    } catch (error) {
      return { error: `获取每日一句失败：${error.message}` }
    }
  }
}

/**
 * 每日一言服务
 */
const hitokotoService = {
  async getHitokoto(type = '') {
    try {
      const data = await withRetry(async () => {
        return httpClient.get(`https://v1.hitokoto.cn/?c=${type}&encode=json`)
      }, '获取每日一言')

      if (data && data.hitokoto) {
        return {
          content: data.hitokoto,
          from: data.from || '未知',
          from_who: data.from_who || '未知'
        }
      } else {
        return { error: '获取每日一言失败' }
      }
    } catch (error) {
      return { error: `获取每日一言失败：${error.message}` }
    }
  }
}



/**
 * 天行API服务
 */
const tianApiService = {
  /**
   * 获取早安心语
   */
  async getMorningGreeting(userTianApi) {
    if (!CONFIG.TIAN_API_KEY || !userTianApi || !userTianApi.morning) {
      return { error: '天行API未配置或早安心语未启用' }
    }

    try {
      const data = await withRetry(async () => {
        return httpClient.get(`https://apis.tianapi.com/zaoan/index?key=${CONFIG.TIAN_API_KEY}`)
      }, '获取早安心语')

      if (data && data.code === 200 && data.result && data.result.content) {
        return {
          content: data.result.content
        }
      } else {
        return { error: '获取早安心语失败' }
      }
    } catch (error) {
      return { error: `获取早安心语失败：${error.message}` }
    }
  },

  /**
   * 获取晚安心语
   */
  async getEveningGreeting(userTianApi) {
    if (!CONFIG.TIAN_API_KEY || !userTianApi || !userTianApi.evening) {
      return { error: '天行API未配置或晚安心语未启用' }
    }

    try {
      const data = await withRetry(async () => {
        return httpClient.get(`https://apis.tianapi.com/wanan/index?key=${CONFIG.TIAN_API_KEY}`)
      }, '获取晚安心语')

      if (data && data.code === 200 && data.result && data.result.content) {
        return {
          content: data.result.content
        }
      } else {
        return { error: '获取晚安心语失败' }
      }
    } catch (error) {
      return { error: `获取晚安心语失败：${error.message}` }
    }
  },

  /**
   * 获取天行天气
   */
  async getTianWeather(city, userTianApi) {
    if (!CONFIG.TIAN_API_KEY || !userTianApi || !userTianApi.weatherDays) {
      return { error: '天行API未配置或天气功能未启用' }
    }

    try {
      const data = await withRetry(async () => {
        return httpClient.get(`https://apis.tianapi.com/tianqi/index?key=${CONFIG.TIAN_API_KEY}&city=${encodeURIComponent(city)}&type=1`)
      }, '获取天行天气')

      if (data && data.code === 200 && data.result) {
        // 处理不同的数据结构
        let weatherList = data.result

        // 如果 result 是对象且包含 list 属性，使用 list
        if (weatherList && typeof weatherList === 'object' && Array.isArray(weatherList.list)) {
          weatherList = weatherList.list
        }
        // 如果 result 是单个对象，包装成数组
        else if (weatherList && typeof weatherList === 'object' && !Array.isArray(weatherList)) {
          weatherList = [weatherList]
        }
        // 如果 result 不是数组，返回错误
        else if (!Array.isArray(weatherList)) {
          return { error: '获取天行天气失败：数据格式异常' }
        }

        return {
          list: weatherList.map(item => ({
            area: item.area,
            date: item.date,
            week: item.week,
            weather: item.weather,
            temp: `${item.lowest}~${item.highest}`,
            tips: item.tips || ''
          }))
        }
      } else {
        return { error: '获取天行天气失败' }
      }
    } catch (error) {
      return { error: `获取天行天气失败：${error.message}` }
    }
  },

  /**
   * 获取全网热搜榜
   */
  async getNetworkHot(userTianApi) {
    if (!CONFIG.TIAN_API_KEY || !userTianApi || !userTianApi.hotCount || userTianApi.hotCount <= 0) {
      return { error: '天行API未配置或热搜榜功能未启用' }
    }

    try {
      const data = await withRetry(async () => {
        return httpClient.get(`https://apis.tianapi.com/networkhot/index?key=${CONFIG.TIAN_API_KEY}&num=${Math.min(userTianApi.hotCount, 30)}`)
      }, '获取全网热搜榜')

      if (data && data.code === 200 && data.result && data.result.list) {
        const hotList = data.result.list.slice(0, Math.min(userTianApi.hotCount, 30))
        return {
          list: hotList.map((item, index) => ({
            index: index + 1,
            title: item.title,
            desc: item.desc || '',
            hot: item.hot || '',
            url: item.url || ''
          }))
        }
      } else {
        return { error: '获取全网热搜榜失败' }
      }
    } catch (error) {
      return { error: `获取全网热搜榜失败：${error.message}` }
    }
  }
}

/**
 * 日期工具服务
 */
const dateUtils = {
  sortBirthdayTime(list) {
    list = JSON.parse(JSON.stringify(list))
    list.forEach((item) => {
      const { type } = item
      item.useLunar = /^\*/.test(type)
      item.type = (type || '').replace(/^\*/, '')

      const diffDay = Math.ceil(dayjs(`${dayjs().format('YYYY')}-${item.date}`).diff(dayjs(), 'day', true))
      if (diffDay >= 0) {
        item.diffDay = diffDay
      } else {
        item.diffDay = Math.ceil(dayjs(`${dayjs().add(1, 'year').format('YYYY')}-${item.date}`).diff(dayjs(), 'day', true))
      }
    })
    return list.sort((a, b) => (a.diffDay > b.diffDay ? 1 : -1))
  },

  calculateSpecialDays(customizedDateList) {
    const result = {}
    if (!customizedDateList) return result

    customizedDateList.forEach(item => {
      if (item.date && item.keyword) {
        const days = dayjs().diff(dayjs(item.date), 'day')
        result[item.keyword] = days
      }
    })
    return result
  }
}

/**
 * 课程表服务
 */
const courseScheduleService = {
  /**
   * 获取今日课程
   */
  getTodayCourses(courseSchedule) {
    if (!courseSchedule) return null

    const today = dayjs()
    const weekday = today.day() // 0=周日, 1=周一, ..., 6=周六

    // 如果是简单数组格式（不区分单双周）
    if (Array.isArray(courseSchedule)) {
      // weekday: 0=周日, 1=周一, ..., 6=周六
      // 数组索引: 0=周一, 1=周二, ..., 6=周日
      // 所以需要将 weekday 转换为正确的数组索引
      const arrayIndex = weekday === 0 ? 6 : weekday - 1
      return courseSchedule[arrayIndex] || []
    }

    // 如果是对象格式（区分单双周）
    if (courseSchedule.benchmark && courseSchedule.courses) {
      const { benchmark, courses } = courseSchedule
      const benchmarkDate = dayjs(benchmark.date)
      const weeksDiff = today.diff(benchmarkDate, 'week')

      // 判断当前是单周还是双周
      const isOddWeek = benchmark.isOdd ? (weeksDiff % 2 === 0) : (weeksDiff % 2 !== 0)

      const coursesData = isOddWeek ? courses.odd : courses.even
      // weekday: 0=周日, 1=周一, ..., 6=周六
      // 数组索引: 0=周一, 1=周二, ..., 6=周日
      // 所以需要将 weekday 转换为正确的数组索引
      const arrayIndex = weekday === 0 ? 6 : weekday - 1
      return coursesData[arrayIndex] || []
    }

    return []
  },

  /**
   * 格式化课程信息
   */
  formatCourses(courses) {
    if (!courses || courses.length === 0) {
      return '今日无课程安排'
    }

    return courses.map((course, index) => `${index + 1}. ${course}`).join('\n')
  }
}

// ==================== 推送服务 ====================

/**
 * 推送服务管理器
 */
const pushService = {
  async sendWeChatTemplate(user, templateData, accessToken) {
    // 优先使用 wechatTemplateId，向后兼容 useTemplateId
    const templateId = user.wechatTemplateId || user.useTemplateId

    if (!user.id || !templateId) {
      throw new PushError('用户ID或模板ID缺失', 'MISSING_REQUIRED_FIELDS', { user: user.name })
    }

    const data = {
      touser: user.id,
      template_id: templateId,
      url: '',
      topcolor: '#FF0000',
      data: templateData
    }

    const result = await httpClient.post(
      `https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=${accessToken}`,
      data
    )

    if (result.errcode === 0) {
      return { success: true, message: '发送成功' }
    } else {
      throw new PushError(result.errmsg || '发送失败', 'WECHAT_SEND_ERROR', result)
    }
  },

  async sendPushDeer(user, content) {
    if (!user.pushDeerKey) {
      throw new PushError('PushDeer Key未配置', 'MISSING_PUSHDEER_KEY', { user: user.name })
    }

    // 解析多个key（支持逗号分隔）
    const keys = user.pushDeerKey.split(',').map(k => k.trim()).filter(k => k)
    logInfo(`用户 ${user.name} 配置了 ${keys.length} 个 PushDeer Key`)

    let successCount = 0
    let failCount = 0

    // 遍历所有key发送
    for (const key of keys) {
      try {
        const data = {
          pushkey: key,
          text: user.name,
          desp: content,
          type: 'markdown'
        }

        const result = await httpClient.post('https://api2.pushdeer.com/message/push', data)

        if (result.code === 0) {
          successCount++
          logInfo(`PushDeer发送成功 (Key: ${key.substring(0, 8)}...)`)
        } else {
          failCount++
          logWarning(`PushDeer发送失败 (Key: ${key.substring(0, 8)}...): ${result.content}`)
        }
      } catch (error) {
        failCount++
        logWarning(`PushDeer发送异常 (Key: ${key.substring(0, 8)}...): ${error.message}`)
      }
    }

    if (successCount > 0) {
      return { success: true, message: `PushDeer发送完成 (成功: ${successCount}, 失败: ${failCount})` }
    } else {
      throw new PushError(`PushDeer全部发送失败 (失败: ${failCount})`, 'PUSHDEER_ERROR')
    }
  },


  /**
   * 智能选择推送方式
   */
  async sendToUser(user, content, templateData, accessToken) {
    const methods = [
      { name: '微信', condition: accessToken && user.id, fn: () => this.sendWeChatTemplate(user, templateData, accessToken) },
      { name: 'PushDeer', condition: user.pushDeerKey, fn: () => this.sendPushDeer(user, content) }
    ]

    const availableMethods = methods.filter(m => m.condition)

    if (availableMethods.length === 0) {
      throw new PushError('未配置任何可用的推送方式', 'NO_PUSH_METHOD', { user: user.name })
    }

    // 并行推送到所有配置的渠道
    const results = []
    let successCount = 0
    let failCount = 0

    for (const method of availableMethods) {
      try {
        logInfo(`使用${method.name}推送用户 ${user.name}`)
        const result = await method.fn()
        results.push({ method: method.name, success: true, result })
        successCount++
        logSuccess(`${method.name}推送成功`)
      } catch (error) {
        results.push({ method: method.name, success: false, error: error.message })
        failCount++
        handleError(error, `${method.name}推送给用户 ${user.name}`, 'WARN')
      }
    }

    // 只要有一个成功就认为推送成功
    if (successCount > 0) {
      return {
        success: true,
        message: `推送完成 (成功: ${successCount}/${availableMethods.length}个渠道)`,
        results
      }
    } else {
      throw new PushError(
        `所有推送渠道均失败 (${failCount}/${availableMethods.length})`,
        'ALL_PUSH_FAILED',
        { results }
      )
    }
  }
}

/**
 * 模板处理服务
 */
const templateService = {
  /**
   * 处理模板数据
   */
  processTemplate(template, data, isWeChatTest = false, userShowColor = true) {
    if (!template || !data) return { title: '', desc: '' }

    let title = template.title
    let desc = template.desc

    // 替换模板变量
    for (const [key, value] of Object.entries(data)) {
      let content = value.value || ''

      // 颜色支持（仅微信测试号，且用户启用了多彩颜色）
      let color = '#000000'
      if (userShowColor && (value.color || isWeChatTest)) {
        if (value.color) {
          color = value.color
        } else {
          // 自动为特定字段添加颜色
          const colorMap = {
            date: '#2E8B57',
            city: '#4682B4',
            weather: '#FF6347',
            max_temperature: '#FF4500',
            min_temperature: '#4169E1',
            wind_direction: '#32CD32',
            wind_scale: '#FFD700',
            birthday_message: '#FF69B4',
            moment_copyrighting: '#9370DB'
          }

          if (colorMap[key]) {
            color = colorMap[key]
          }
        }
      }

      // 微信测试号格式处理
      if (isWeChatTest) {
        content = encodeURIComponent(content)
        const formattedValue = { value: content, color: color }
        desc = desc.replace(new RegExp(`{{${key}\\.DATA}}`, 'g'), content)
        title = title.replace(new RegExp(`{{${key}\\.DATA}}`, 'g'), content)
      } else {
        desc = desc.replace(new RegExp(`{{${key}\\.DATA}}`, 'g'), content)
        title = title.replace(new RegExp(`{{${key}\\.DATA}}`, 'g'), content)
      }
    }

    return { title, desc }
  }
}

/**
 * 数据聚合服务
 */
const dataAggregationService = {
  /**
   * 获取用户聚合数据
   */
  async getAggregatedData(user) {
    try {
      const data = {}

      // 基础信息
      data.date = { value: dayjs().format('YYYY年MM月DD日') }

      // 获取基础天气信息（仅在配置了 weatherCityCode 时调用）
      if (user.weatherCityCode) {
        const weather = await weatherService.getWeather(user.city, user.weatherCityCode)
        if (!weather.error) {
          data.city = { value: weather.city }
          data.weather = { value: weather.weather }
          data.max_temperature = { value: weather.max_temperature }
          data.min_temperature = { value: weather.min_temperature }
          data.wind_direction = { value: weather.wind_direction }
          data.wind_scale = { value: weather.wind_scale }
        }
      } else {
        // 没有配置 weatherCityCode 时，使用 city 字段作为基础信息
        if (user.city) {
          data.city = { value: user.city }
          logInfo(`用户 ${user.name} 未配置基础天气接口(weatherCityCode)，仅使用 city 字段作为基础信息`)
        }
      }

  
      // 生日和纪念日处理
      let birthdayMessage = ''
      if (user.festivals && user.festivals.length > 0) {
        const sortedFestivals = dateUtils.sortBirthdayTime(user.festivals)
        const festivalsToShow = CONFIG.FESTIVALS_LIMIT > 0
          ? sortedFestivals.slice(0, CONFIG.FESTIVALS_LIMIT)
          : sortedFestivals

        const nextFestival = festivalsToShow[0]
        if (nextFestival && nextFestival.diffDay <= 30) {
          birthdayMessage = `距离${nextFestival.name}${nextFestival.useLunar ? '(农历)' : ''}还有${nextFestival.diffDay}天`
        }
      }
      data.birthday_message = { value: birthdayMessage }

      // 纪念日计算
      const specialDays = dateUtils.calculateSpecialDays(user.customizedDateList)
      for (const [key, days] of Object.entries(specialDays)) {
        data[key] = { value: days.toString() }
      }

      // 获取每日一句
      const ciba = await cibaService.getCIBA()
      if (!ciba.error) {
        data.english_note = { value: ciba.content }
        data.chinese_note = { value: ciba.note }
      }

      // 获取每日一言
      const hitokoto = await hitokotoService.getHitokoto()
      if (!hitokoto.error) {
        data.moment_copyrighting = { value: hitokoto.content }
      }

      // 天行API - 早安心语（用户级配置）
      if (user.tianApi && user.tianApi.morning) {
        const morningGreeting = await tianApiService.getMorningGreeting(user.tianApi)
        if (!morningGreeting.error) {
            data.remark = { 
              value: `今日心语：${morningGreeting.content}`,
              color: "#666"  // 可选设置颜色
            };
            // 原来的字段可以清空或放简短提示
            data.morning_greeting = { value: "💖" };
        }
      }

      // 天行API - 晚安心语（用户级配置）
      if (user.tianApi && user.tianApi.evening) {
        const eveningGreeting = await tianApiService.getEveningGreeting(user.tianApi)
        if (!eveningGreeting.error) {
          data.evening_greeting = { value: eveningGreeting.content }
        }
      }

      // 天行API - 天气（用户级配置）
      if (user.tianApi && user.tianApi.weatherDays === true) {
        const tianWeather = await tianApiService.getTianWeather(user.city, user.tianApi)
        if (!tianWeather.error && tianWeather.list) {
          data.tian_weather = {
            value: tianWeather.list.map(w => `【${w.area} ${w.date} ${w.week}】 ${w.weather} ${w.temp} \n\n ${w.tips ? ' ' + w.tips : ''}`).join('\n')
          }
        }
      }

      // 天行API - 热搜榜（用户级配置）
      if (user.tianApi && user.tianApi.hotCount > 0) {
        const networkHot = await tianApiService.getNetworkHot(user.tianApi)
        if (!networkHot.error && networkHot.list) {
          if (user.tianApi.hotType === 'title') {
            data.network_hot = {
              value: networkHot.list.map(h => `${h.index}. ${h.title}`).join('\n')
            }
          } else {
            data.network_hot = {
              value: networkHot.list.map(h => `${h.index}. ${h.title}\n   ${h.desc || ''}`).join('\n\n')
            }
          }
        }
      }

      // 课程表
      if (user.courseSchedule) {
        const todayCourses = courseScheduleService.getTodayCourses(user.courseSchedule)
        if (todayCourses !== null) {
          data.today_courses = {
            value: courseScheduleService.formatCourses(todayCourses)
          }
        }
      }

      return data
    } catch (error) {
      handleError(error, `获取用户 ${user.name} 的聚合数据`)
      return {}
    }
  }
}

/**
 * 主推送服务
 */
class PushService {
  constructor() {
    this.accessToken = null
  }

  async init() {
    logInfo('推送服务初始化开始')

    // 获取微信AccessToken
    if (CONFIG.APP_ID && CONFIG.APP_SECRET && CONFIG.APP_ID.trim() !== '') {
      this.accessToken = await this.getAccessToken()
      logSuccess('微信AccessToken获取成功')
    } else {
      logInfo('未配置微信APP_ID或APP_SECRET，跳过微信推送功能')
    }

    logInfo('推送服务初始化完成')
  }

  async getAccessToken() {
    return withRetry(async () => {
      const data = await httpClient.get(
        `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${CONFIG.APP_ID}&secret=${CONFIG.APP_SECRET}`
      )

      if (data.access_token) {
        return data.access_token
      } else {
        throw new PushError(data.errmsg || '获取AccessToken失败', 'WECHAT_TOKEN_ERROR', data)
      }
    }, '获取微信AccessToken')
  }

  async run() {
    logInfo('开始执行推送任务')

    let successCount = 0
    let failCount = 0
    const successUsers = []
    const failUsers = []

    await this.init()

    // 遍历用户进行推送
    for (const user of CONFIG.USERS) {
      try {
        logInfo(`正在为用户 ${user.name} 准备推送数据...`)

        // 限流控制
        if (RUN_TIME_STORAGE.pushNum >= CONFIG.MAX_PUSH_ONE_MINUTE) {
          logWarning('达到推送限制，等待重置...')
          await sleep(CONFIG.SLEEP_TIME)
          RUN_TIME_STORAGE.pushNum = 0
        }

        // 获取聚合数据
        const aggregatedData = await dataAggregationService.getAggregatedData(user)

        // 查找模板
        const template = ALL_CONFIG.TEMPLATE_CONFIG.find(t => t.id === user.useTemplateId) || ALL_CONFIG.TEMPLATE_CONFIG[0]

        // 处理模板数据
        const isWeChatTest = !!(this.accessToken && user.id)
        const { desc } = templateService.processTemplate(template, aggregatedData, isWeChatTest, user.showColor)

        // 发送推送
        const sendResult = await pushService.sendToUser(user, desc, aggregatedData, this.accessToken)

        if (sendResult.success) {
          successCount++
          successUsers.push(user.name)
          logSuccess(`用户 ${user.name} 推送成功`)
        } else {
          failCount++
          failUsers.push(user.name)
          logError(`用户 ${user.name} 推送失败: ${sendResult.message}`)
        }

        RUN_TIME_STORAGE.pushNum++

        // 间隔等待
        if (CONFIG.USERS.indexOf(user) < CONFIG.USERS.length - 1) {
          await sleep(2000)
        }

      } catch (error) {
        handleError(error, `处理用户 ${user.name}`)
        failCount++
        failUsers.push(user.name)
      }
    }

    // 发送推送完成通知已移除
    // if (CONFIG.CALLBACK_TEMPLATE_ID && CONFIG.CALLBACK_USERS.length > 0 && this.accessToken) {
    //   await this.sendCompletionNotification(successCount, failCount, successUsers, failUsers)
    // }

    logSuccess(`推送任务完成 - 成功: ${successCount}, 失败: ${failCount}`)

    // 输出统计信息
    this.printStats()

    return { successCount, failCount }
  }


  printStats() {
    const stats = RUN_TIME_STORAGE.stats
    logInfo('=== 运行统计 ===')
    logInfo(`总请求次数: ${stats.totalRequests}`)
    logInfo(`错误次数: ${stats.errors}`)
    logInfo('===============')
  }
}

// ==================== 主入口函数 ====================

async function main() {
  try {
    logSuccess('微信公众号推送脚本启动 (优化版 v2.0.0)')
    logInfo(`配置用户数量: ${CONFIG.USERS.length}`)

    const pushServiceInstance = new PushService()
    const result = await pushServiceInstance.run()

    logSuccess(`脚本执行完成 - 成功: ${result.successCount}, 失败: ${result.failCount}`)

    if (result.failCount > 0) {
      process.exit(1)
    } else {
      process.exit(0)
    }
  } catch (error) {
    handleError(error, '脚本执行')
    process.exit(1)
  }
}

// ==================== 导出函数 ====================

module.exports = {
  main,
  // 导出测试用的函数
  weatherService,
  pushService,
  ALL_CONFIG
}

// 如果直接运行此文件
if (require.main === module) {
  main()
}
