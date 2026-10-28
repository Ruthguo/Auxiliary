/**
 * 龙湖APP自动签到脚本 - 优化版
 *
 * 功能：
 * 1. 自动完成龙湖APP每日签到，获取积分
 * 2. 自动完成龙湖小程序签到，分别通知结果
 * 兼容：Shadowrocket, Surge, Quantumult X, Loon
 * 
 * 优化内容：
 * - 配置管理系统
 * - 改进错误处理和重试机制
 * - 优化日志系统
 * - 代码结构重构
 */

// 配置常量
const CONFIG = {
    SCRIPT_NAME: '龙湖签到',
    TOKEN_KEY: 'longfor_token',
    MINI_KEY: 'longfor_mini_signin_v1',
    DEBUG_MODE: false,
    RETRY_DELAY: 2000,
    REQUEST_TIMEOUT: 10000,
    
    // API 配置
    API: {
        SIGN_IN: "https://gw2c-hw-open.longfor.com/lmarketing-task-api-mvc-prod/openapi/task/v1/signature/clock"
    },
    
    // 活动配置（易于更新）
    ACTIVITY: {
        SIGN_IN_NO: "11111111111736501868255956070000"
    },
    
    // 通用请求头
    COMMON_HEADERS: {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'zh-CN,zh-Hans;q=0.9',
        'Content-Type': 'application/json',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 &MAIAWebKit_iOS_com.longfor.supera_1.14.0_202506052233_Default_3.2.4.8'
    }
}

// 工具函数
function log(message, level = 'INFO') {
    const timestamp = new Date().toLocaleTimeString()
    const prefix = CONFIG.DEBUG_MODE ? `[${timestamp}][${level}] ` : ''
    console.log(`${prefix}██ ${message}`)
}

function logError(message, error) {
    log(`${message}: ${error}`, 'ERROR')
}

function logDebug(message) {
    if (CONFIG.DEBUG_MODE) {
        log(message, 'DEBUG')
    }
}

function isEmpty(obj) {
    return typeof obj === "undefined" || obj === null || obj === "" || obj.length === 0
}

function getVal(key, defaultValue = '') {
    try {
        let value
        if (typeof $persistentStore !== 'undefined') {
            value = $persistentStore.read(key)
        } else if (typeof $prefs !== 'undefined') {
            value = $prefs.valueForKey(key)
        }
        return value || defaultValue
    } catch (e) {
        logError('获取存储值失败', e)
        return defaultValue
    }
}

function setVal(key, val) {
    try {
        if (typeof $persistentStore !== 'undefined') {
            return $persistentStore.write(val, key)
        } else if (typeof $prefs !== 'undefined') {
            return $prefs.setValueForKey(val, key)
        }
        return false
    } catch (e) {
        logError('设置存储值失败', e)
        return false
    }
}

function notify(subtitle, message, sound = '', project = CONFIG.SCRIPT_NAME) {
    try {
        if (typeof $notification !== 'undefined') {
            $notification.post(project, subtitle, message, sound)
        } else if (typeof $notify !== 'undefined') {
            $notify(project, subtitle, message)
        } else {
            log(`通知: ${project} - ${subtitle} - ${message}`)
        }
    } catch (e) {
        logError('发送通知失败', e)
    }
}

function notifyApp(status, message) {
    notify(`龙湖 APP｜${status}`, message, '', '龙湖 APP 签到')
}

function notifyMini(status, message) {
    notify(`龙湖小程序｜${status}`, message, '', '龙湖小程序签到')
}

function validateToken(token) {
    return !isEmpty(token) && token.length > 10
}

// POST 不自动重试：超时并不意味着服务端未执行签到。
async function httpPost(options, retryCount = 1, method = 'POST') {
    return new Promise((resolve, reject) => {
        const attemptRequest = (attempt) => {
            logDebug(`HTTP请求尝试 ${attempt}/${retryCount}: ${options.url}`)
            
            const requestOptions = {
                ...options,
                timeout: CONFIG.REQUEST_TIMEOUT
            }
            
            const handleResponse = (error, response, data) => {
                if (error) {
                    logError(`请求失败 (尝试 ${attempt})`, error)
                    if (attempt < retryCount) {
                        log(`等待 ${CONFIG.RETRY_DELAY}ms 后重试...`)
                        setTimeout(() => attemptRequest(attempt + 1), CONFIG.RETRY_DELAY)
                    } else {
                        reject(new Error(`请求失败，已重试 ${retryCount} 次: ${error}`))
                    }
                } else {
                    const status = Number(response && (response.statusCode || response.status))
                    if (status >= 400) reject(new Error(`HTTP ${status}`))
                    else resolve({ response, data })
                }
            }
            
            if (typeof $httpClient !== 'undefined') {
                $httpClient[method.toLowerCase()](requestOptions, handleResponse)
            } else if (typeof $task !== 'undefined') {
                requestOptions.method = method
                $task.fetch(requestOptions).then(response => {
                    handleResponse(null, response, response.body)
                }, reason => handleResponse(reason.error, null, null))
            } else {
                reject(new Error("HTTP client not available"))
            }
        }
        
        attemptRequest(1)
    })
}

function isRequest() {
    return typeof $request !== "undefined"
}

function isMatch(reg) {
    return !!($request && $request.method !== 'OPTIONS' && $request.url.match(reg))
}

function done(value = {}) {
    if (typeof $done !== 'undefined') {
        $done(value)
    }
}

// 创建请求头
function createHeaders(token, extraHeaders = {}) {
    return {
        ...CONFIG.COMMON_HEADERS,
        ...extraHeaders,
        'authtoken': token,
        'X-LF-UserToken': token,
        'token': token
    }
}

// 仅保存执行所需字段，凭据只写入手机本地存储，不输出到日志。
const CAPTURE_HEADERS = [
    'user-agent', 'origin', 'referer', 'content-type', 'cookie',
    'token', 'x-lf-usertoken', 'x-gaia-api-key',
    'x-lf-channel', 'x-lf-bu-code',
    'x-lf-dxrisk-source', 'x-lf-dxrisk-token', 'x-lf-dxrisk-captcha-token'
]

function readJSON(key, fallback = null) {
    try { return JSON.parse(getVal(key)) || fallback }
    catch (_) { return fallback }
}

function saveJSON(key, value, label) {
    const text = JSON.stringify(value)
    if (getVal(key) === text) return
    if (!setVal(key, text)) throw new Error(`${label}保存失败，请检查脚本存储权限`)
    notifyMini(`${label}已保存`, '认证信息仅保存在本机')
    log(`${label}已保存`)
}

function pickHeaders(input) {
    const headers = {}
    for (const key of Object.keys(input || {})) {
        const lower = key.toLowerCase()
        if (CAPTURE_HEADERS.indexOf(lower) >= 0) headers[lower] = input[key]
    }
    return headers
}

function captureMiniRequest() {
    if ($request.method === 'OPTIONS') return
    const url = $request.url || ''
    if (!/^https:\/\/gw2c-hw-open\.longfor\.com\//.test(url)) return
    const headers = pickHeaders($request.headers)
    if (url.split('?')[0] === CONFIG.API.SIGN_IN && $request.method === 'POST') {
        // APP 与小程序共用接口，必须按来源区分，不能覆盖 APP 的 lmToken。
        const mini = headers['x-lf-channel'] === 'C2' ||
            (headers['x-lf-dxrisk-source'] === '5' && /MicroMessenger|MiniProgram/i.test(headers['user-agent'] || ''))
        if (!mini) return
        const body = typeof $request.body === 'string' ? JSON.parse($request.body) : $request.body
        if (!body || typeof body.activity_no !== 'string' || !body.activity_no.trim()) {
            throw new Error('小程序签到请求缺少 activity_no；请确认请求正文捕获已开启')
        }
        if (!validateToken(headers.token) || !validateToken(headers['x-lf-usertoken'])) {
            throw new Error('小程序请求缺少 token 或 X-LF-UserToken，未保存')
        }
        saveJSON(CONFIG.MINI_KEY, { headers, activity_no: body.activity_no }, '小程序签到配置')
    }
}

function apiMessage(result) {
    // 只记录业务状态，不输出响应正文或请求头中的认证信息。
    const message = String(result.message || result.msg || '未知错误')
    return `返回码: ${result.code}, 消息: ${message}`
}

function isSuccess(result) {
    return result.code === 200 || result.code === '200' || result.code === '0000'
}

async function doMiniSignIn() {
    const profile = readJSON(CONFIG.MINI_KEY)
    if (!profile || !profile.headers || !profile.activity_no) {
        notifyMini('签到未配置', '请先打开小程序，手动签到一次以捕获请求')
        log('小程序签到跳过：尚未捕获独立凭据和活动编号')
        return
    }
    try {
        const result = await httpPost({
            url: CONFIG.API.SIGN_IN,
            headers: profile.headers,
            body: JSON.stringify({ activity_no: profile.activity_no })
        })
        const data = JSON.parse(result.data)
        if (!isSuccess(data)) throw new Error(apiMessage(data))
        const details = data.data || {}
        const rewards = Array.isArray(details.reward_info) ? details.reward_info : []
        const amount = rewards.map(item => item.reward_num).filter(n => n !== undefined).join('、')
        if (Number(details.is_popup) === 1) {
            notifyMini('签到成功', amount ? `获得积分: ${amount}` : '接口返回签到成功')
            log('小程序签到成功')
        } else {
            notifyMini('签到响应成功', data.message || '请在小程序核对今日签到状态和积分')
            log('小程序签到响应成功；未返回奖励弹窗，不推断为今日已签到')
        }
    } catch (error) {
        notifyMini('签到失败', error.message)
        logError('小程序签到失败', error)
    }
}

function getToken() {
    // 页面接口版本会随龙湖 APP 升级（例如 v1_14_0、v1_30_0），
    // 不要写死版本号，否则 APP 升级后将无法捕获 lmToken。
    if (isMatch(/\/supera\/member\/api\/bff\/pages\/v[^/]+\/v1\/user-info/)) {
        log('开始获取token')
        
        try {
            const headers = $request.headers || {}
            const tokenKey = Object.keys(headers).find(key => key.toLowerCase() === 'lmtoken')
            const token = tokenKey ? headers[tokenKey] : ''

            if (!token) {
                notifyApp("Token 获取失败", "请检查请求header中是否包含lmToken")
                log("获取token失败：请求中没有 lmToken")
                return
            }

            const currentToken = getVal(CONFIG.TOKEN_KEY)
            if (!currentToken) {
                if (!setVal(CONFIG.TOKEN_KEY, token)) throw new Error('Token 保存失败')
                notifyApp("Token 首次获取成功", '认证信息仅保存在本机')
                log('首次获取token成功')
            } else if (currentToken !== token) {
                if (!setVal(CONFIG.TOKEN_KEY, token)) throw new Error('Token 保存失败')
                notifyApp("Token 已更新", '认证信息仅保存在本机')
                log('token已更新')
            } else {
                logDebug('token未变化')
            }
        } catch (error) {
            notifyApp("Token 获取失败", `处理token时出错: ${error.message}`)
            logError("获取token失败", error)
        }
    }
}

async function doSignIn() {
    const token = getVal(CONFIG.TOKEN_KEY)
    if (!validateToken(token)) {
        notifyApp("签到失败", "请先打开龙湖APP登录获取token")
        log("签到失败: token无效")
        return false
    }

    log('开始执行 APP 签到')

    try {
        const headers = createHeaders(token, {
            'Content-Type': 'application/json;charset=UTF-8',
            'Cookie': 'acw_tc=ac11000117515948134458251e007763cde29cc35ff7b19c704ac2843e03fa',
            'Origin': 'https://longzhu.longfor.com',
            'Referer': 'https://longzhu.longfor.com/',
            'X-GAIA-API-KEY': 'c06753f1-3e68-437d-b592-b94656ea5517',
            'X-LF-Bu-Code': 'L00602',
            'X-LF-Channel': 'L0',
            'X-LF-DXRisk-Captcha-Token': 'undefined',
            'X-LF-DXRisk-Source': '2',
            'X-LF-DXRisk-Token': '68673780TZSEnm6nueRfRAziVGwXc5NyaH5z5vo1'
        })

        const options = {
            url: CONFIG.API.SIGN_IN,
            headers: headers,
            body: JSON.stringify({"activity_no": CONFIG.ACTIVITY.SIGN_IN_NO})
        }

        const result = await httpPost(options)
        const data = JSON.parse(result.data)
        
        if (isSuccess(data)) {
            notifyApp("签到成功", `签到完成: ${data.message || '获得积分'}`)
            log('APP 签到成功')
            return true
        } else {
            notifyApp("签到异常", `返回码: ${data.code}, 消息: ${data.message || '未知错误'}`)
            log(`APP 签到异常：${apiMessage(data)}`)
            return false
        }
    } catch (error) {
        notifyApp("签到失败", `请求失败: ${error.message}`)
        logError("签到失败", error)
        return false
    }
}

// 主执行逻辑：每个任务独立失败，所有异步任务结束后只调用一次 $done。
if (isRequest()) {
    try {
        getToken()
        captureMiniRequest()
    } catch (error) {
        notifyMini('请求捕获失败', error.message)
        logError('请求捕获失败', error)
    } finally {
        done()
    }
} else {
    (async () => {
        let currentProject = 'APP'
        try {
            log('开始执行龙湖 APP 签到和小程序签到')
            if (validateToken(getVal(CONFIG.TOKEN_KEY))) await doSignIn()
            else {
                notifyApp('签到未配置', '请在龙湖 APP 的“我的”页面获取 Token')
                log('APP 签到跳过：请在 APP 的“我的”页面获取 Token')
            }
            currentProject = '小程序'
            await doMiniSignIn()
        } catch (error) {
            if (currentProject === 'APP') notifyApp('执行失败', error.message)
            else notifyMini('执行失败', error.message)
            logError('脚本执行失败', error)
        } finally {
            done()
        }
    })()
}
