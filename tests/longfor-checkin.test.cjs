const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { test } = require('node:test')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, '../Script/longfor/longfor-checkin.js'), 'utf8')
const base = 'https://gw2c-hw-open.longfor.com'
const signURL = base + '/lmarketing-task-api-mvc-prod/openapi/task/v1/signature/clock'
const appToken = 'app-token-for-testing-only'
const miniHeaders = { token: 'mini-token-for-testing-only', 'X-LF-UserToken': 'mini-user-token-distinct', 'X-LF-Channel': 'C2' }

async function run({ store = {}, request, response, reply = () => ({ code: '0000' }), qx = false, failWrite = false, status = 200 } = {}) {
    const calls = [], logs = [], notices = []
    let doneCount = 0
    let finish
    const complete = new Promise(resolve => { finish = resolve })
    const perform = async (method, options) => {
        calls.push({ method, ...options })
        return reply(calls.at(-1))
    }
    const context = {
        console: { log: value => logs.push(String(value)) },
        setTimeout, clearTimeout,
        $notification: { post: (...args) => notices.push(args) },
        $done: () => { doneCount++; finish() }
    }
    if (qx) {
        context.$prefs = { valueForKey: key => store[key], setValueForKey: (value, key) => { store[key] = value; return true } }
        context.$task = { fetch: async options => ({ statusCode: status, body: JSON.stringify(await perform(options.method, options)) }) }
    } else {
        context.$persistentStore = { read: key => store[key], write: (value, key) => { if (failWrite) return false; store[key] = value; return true } }
        context.$httpClient = Object.fromEntries(['get', 'post'].map(method => [method, (options, callback) => {
            perform(method.toUpperCase(), options).then(value => callback(null, { status }, JSON.stringify(value)), error => callback(error.message))
        }]))
    }
    if (request) context.$request = request
    if (response) context.$response = response
    vm.runInNewContext(source, context, { timeout: 1000 })
    let timer
    try {
        await Promise.race([complete, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('script did not finish')), 2000) })])
    } finally { clearTimeout(timer) }
    assert.equal(doneCount, 1)
    return { calls, logs, notices, store }
}

test('capture mini credentials separately while raw diagnostics preserve request headers', async () => {
    const store = { longfor_token: appToken }
    const result = await run({ store, request: { method: 'POST', url: signURL, headers: { ...miniHeaders, Authorization: 'must-not-store' }, body: JSON.stringify({ activity_no: 'mini-activity' }) } })
    const captured = JSON.parse(store.longfor_mini_signin_v1)
    assert.equal(captured.headers['x-lf-usertoken'], miniHeaders['X-LF-UserToken'])
    assert.equal(captured.headers.authorization, undefined)
    assert.equal(store.longfor_token, appToken)
    assert.equal(result.calls.length, 0)
    assert.ok(JSON.stringify(result.logs).includes(miniHeaders.token))
    assert.ok(!JSON.stringify(result.notices).includes(miniHeaders.token))
})

test('APP signature request does not overwrite mini profile', async () => {
    const store = { longfor_mini_signin_v1: 'existing' }
    await run({ store, request: { method: 'POST', url: signURL, headers: { ...miniHeaders, 'X-LF-Channel': 'L0' }, body: '{}' } })
    assert.equal(store.longfor_mini_signin_v1, 'existing')
})

test('invalid request body is reported and done is still called', async () => {
    const result = await run({ request: { method: 'POST', url: signURL, headers: miniHeaders, body: 'not json' } })
    assert.equal(result.store.longfor_mini_signin_v1, undefined)
    assert.ok(result.notices.some(n => n[1] === '龙湖小程序｜请求捕获失败'))
})

test('storage failure is not reported as captured successfully', async () => {
    const result = await run({ failWrite: true, request: { method: 'POST', url: signURL, headers: miniHeaders, body: '{"activity_no":"mini"}' } })
    assert.ok(result.notices.some(n => n[1] === '龙湖小程序｜请求捕获失败'))
    assert.ok(!result.notices.some(n => n[1] === '龙湖小程序｜小程序签到配置已保存'))
})



test('APP and mini signin retain distinct tokens and ignore legacy lottery storage', async () => {
    const store = {
        longfor_token: appToken,
        longfor_mini_signin_v1: JSON.stringify({ headers: { token: miniHeaders.token, 'x-lf-usertoken': miniHeaders['X-LF-UserToken'] }, activity_no: 'mini-captured' }),
        longfor_lottery_page_v1: '{"activityNo":"legacy","pageNo":"legacy"}',
        longfor_lottery_headers_v1: '{"authtoken":"legacy-token"}'
    }
    const result = await run({ store, reply: () => ({ code: '0000', data: { is_popup: 1, reward_info: [{ reward_num: 10 }] } }) })
    assert.equal(result.calls.length, 2)
    assert.ok(result.calls.every(c => c.url === signURL && c.method === 'POST'))
    assert.equal(result.calls[0].headers.token, appToken)
    assert.equal(result.calls[1].headers.token, miniHeaders.token)
    assert.equal(JSON.parse(result.calls[1].body).activity_no, 'mini-captured')
    assert.ok(result.notices.some(n => n[0] === '龙湖 APP 签到' && n[1] === '龙湖 APP｜签到成功'))
    assert.ok(result.notices.some(n => n[0] === '龙湖小程序签到' && n[1] === '龙湖小程序｜签到成功'))
})



test('business failure in mini signin is never mislabeled as already signed in', async () => {
    const result = await run({ store: { longfor_mini_signin_v1: JSON.stringify({ headers: miniHeaders, activity_no: 'mini' }) }, reply: () => ({ code: '803012', message: '活动已结束' }) })
    assert.ok(result.notices.some(n => n[1] === '龙湖小程序｜签到失败' && n[2].includes('803012')))
    assert.ok(!JSON.stringify(result.notices).includes('今日已签到'))
})

test('POST transport failure is not retried', async () => {
    const result = await run({ store: { longfor_token: appToken }, reply: call => {
        if (call.url === signURL) throw new Error('timeout')
        return { code: '803012', message: '活动已结束' }
    } })
    assert.equal(result.calls.filter(c => c.url === signURL).length, 1)
})

test('Quantumult X fetch and storage are supported without APP token', async () => {
    const result = await run({ qx: true, store: { longfor_mini_signin_v1: JSON.stringify({ headers: miniHeaders, activity_no: 'mini' }) }, reply: () => ({ code: '0000', data: { is_popup: 1 } }) })
    assert.equal(result.calls.length, 1)
    assert.equal(result.calls[0].method, 'POST')
    assert.ok(result.notices.some(n => n[1] === '龙湖小程序｜签到成功'))
})

test('APP token capture handles arbitrary header casing and keeps raw token in local diagnostic log', async () => {
    const result = await run({ request: { method: 'GET', url: base + '/supera/member/api/bff/pages/v1_30_0/v1/user-info', headers: { LmToKeN: appToken } } })
    assert.equal(result.store.longfor_token, appToken)
    assert.ok(JSON.stringify(result.logs).includes(appToken))
    assert.ok(!JSON.stringify(result.notices).includes(appToken))
})



test('HTTP error status is not treated as business success', async () => {
    const result = await run({ status: 503, store: { longfor_mini_signin_v1: JSON.stringify({ headers: miniHeaders, activity_no: 'mini' }) } })
    assert.equal(result.calls.length, 1)
    assert.ok(result.notices.some(n => n[1] === '龙湖小程序｜签到失败' && n[2].includes('HTTP 503')))
})

test('Quantumult X rejected fetch finishes once and reports failure', async () => {
    const result = await run({ qx: true, store: { longfor_mini_signin_v1: JSON.stringify({ headers: miniHeaders, activity_no: 'mini' }) }, reply: () => { throw { error: 'network failure' } } })
    assert.equal(result.calls.length, 1)
    assert.ok(result.notices.some(n => n[1] === '龙湖小程序｜签到失败'))
})


test('APP business failure and mini success are separately labeled and both execute', async () => {
    const store = { longfor_token: appToken, longfor_mini_signin_v1: JSON.stringify({ headers: miniHeaders, activity_no: 'mini' }) }
    const result = await run({ store, reply: call => call.headers.token === appToken
        ? { code: '801810', message: '活动太火爆了，明日再来试试~' }
        : { code: '0000', data: { is_popup: 1, reward_info: [{ reward_num: 10 }] } } })
    assert.equal(result.calls.length, 2)
    assert.ok(result.notices.some(n => n[0] === '龙湖 APP 签到' && n[1] === '龙湖 APP｜签到异常' && n[2].includes('801810')))
    assert.ok(result.notices.some(n => n[0] === '龙湖小程序签到' && n[1] === '龙湖小程序｜签到成功' && n[2].includes('10')))
})

test('APP accepts string 200 success code', async () => {
    const result = await run({ store: { longfor_token: appToken }, reply: () => ({ code: '200', message: '获得积分' }) })
    assert.ok(result.notices.some(n => n[0] === '龙湖 APP 签到' && n[1] === '龙湖 APP｜签到成功'))
    assert.ok(!result.notices.some(n => n[1] === '龙湖 APP｜签到异常'))
})

test('both missing profiles report project-specific unconfigured notices', async () => {
    const result = await run()
    assert.equal(result.calls.length, 0)
    assert.ok(result.notices.some(n => n[0] === '龙湖 APP 签到' && n[1] === '龙湖 APP｜签到未配置'))
    assert.ok(result.notices.some(n => n[0] === '龙湖小程序签到' && n[1] === '龙湖小程序｜签到未配置'))
})

test('old lottery capture requests have no effect', async () => {
    for (const route of ['page/info?activityNo=old&pageNo=old', 'activity/auth/lottery/sign', 'activity/auth/lottery/click']) {
        const store = { longfor_lottery_page_v1: 'unchanged' }
        const result = await run({ store, request: { method: 'POST', url: base + '/llt-gateway-prod/api/v1/' + route, headers: { authtoken: 'old-token-for-testing' }, body: '{}' } })
        assert.equal(result.calls.length, 0)
        assert.equal(result.notices.length, 0)
        assert.equal(JSON.stringify(store), '{"longfor_lottery_page_v1":"unchanged"}')
    }
})

test('diagnostic module covers all Longfor and verification APIs without phone cron', () => {
    const module = fs.readFileSync(path.join(__dirname, '../Script/longfor/longfor-checkin.sgmodule'), 'utf8')
    const rules = module.split('\n').filter(line => line.includes('script-path='))
    assert.equal(rules.length, 2)
    assert.ok(!module.includes('type=cron'))
    for (const line of rules) {
        assert.ok(line.includes('@v1.3.3/'))
        const pattern = line.match(/pattern=(.*?),requires-body=/)[1]
        const regex = new RegExp(pattern)
        for (const url of [signURL, base + '/supera/member/api/bff/pages/v1_30_0/v1/user-info', base + '/llt-gateway-prod/api/v1/activity/auth/lottery/sign', 'https://devops-prod.longfor.com/v2/api/uv/type?appId=abc', 'https://ly-ver.longhu.net/api/v1']) assert.ok(regex.test(url), url)
        for (const url of ['https://longfor.com.evil.example/api', 'https://not-longfor.com/api', 'https://example.com/longfor.com']) assert.ok(!regex.test(url), url)
    }
})

test('login traffic captures fresh risk token and cookie, then APP uses them without hardcoded values', async () => {
    const store = {}
    const risk = 'fresh-risk-token-from-app'
    const cookie = 'fresh-session-cookie'
    const request = { method: 'GET', url: base + '/supera/member/api/bff/pages/v1_30_0/v1/user-info', headers: {
        LmToken: appToken, 'X-LF-DXRisk-Token': risk, Cookie: cookie,
        'X-LF-DXRisk-Captcha-Token': 'undefined'
    } }
    const captured = await run({ store, request })
    const profile = JSON.parse(store.longfor_app_headers_v1)
    assert.equal(profile.token, appToken)
    assert.equal(profile.headers['x-lf-dxrisk-token'], risk)
    assert.ok(!profile.headers['x-lf-dxrisk-captcha-token'])
    assert.ok(captured.notices.some(n => n[1] === '龙湖 APP｜风控 Token 已更新'))
    for (const secret of [appToken, risk, cookie]) {
        assert.ok(JSON.stringify(captured.logs).includes(secret))
        assert.ok(!JSON.stringify(captured.notices).includes(secret))
    }
    const repeated = await run({ store, request })
    assert.equal(repeated.notices.length, 0)
    const executed = await run({ store })
    assert.equal(executed.calls[0].headers['x-lf-dxrisk-token'], risk)
    assert.equal(executed.calls[0].headers.cookie, cookie)
    assert.ok(!executed.calls[0].headers['x-lf-dxrisk-captcha-token'])
})

test('APP manual signin refreshes real captcha credentials and headers', async () => {
    const store = { longfor_token: appToken }
    await run({ store, request: { method: 'POST', url: signURL, headers: {
        token: appToken, 'X-LF-UserToken': appToken, 'X-LF-Channel': 'L0',
        'X-LF-DXRisk-Token': 'latest-app-risk', 'X-LF-DXRisk-Captcha-Token': 'manual-validation-token',
        Origin: 'https://longzhu.longfor.com', Referer: 'https://longzhu.longfor.com/current'
    }, body: '{}' } })
    const result = await run({ store })
    assert.equal(result.calls[0].headers['x-lf-dxrisk-captcha-token'], 'manual-validation-token')
    assert.equal(result.calls[0].headers['x-lf-dxrisk-token'], 'latest-app-risk')
    assert.equal(result.calls[0].headers.referer, 'https://longzhu.longfor.com/current')
    assert.ok(!('X-LF-DXRisk-Token' in result.calls[0].headers))
})

test('ordinary APP request missing risk fields does not erase saved values or override signin origin', async () => {
    const store = { longfor_token: appToken, longfor_app_headers_v1: JSON.stringify({ token: appToken, headers: {
        'x-lf-dxrisk-token': 'saved-risk', 'x-lf-dxrisk-captcha-token': 'saved-validation', origin: 'https://longzhu.longfor.com'
    } }) }
    await run({ store, request: { method: 'GET', url: base + '/supera/member/api/profile', headers: {
        LmToken: appToken, Origin: 'https://different-origin.example', 'X-LF-DXRisk-Token': '', 'X-LF-DXRisk-Captcha-Token': 'null'
    } } })
    const profile = JSON.parse(store.longfor_app_headers_v1)
    assert.equal(profile.headers['x-lf-dxrisk-token'], 'saved-risk')
    assert.equal(profile.headers['x-lf-dxrisk-captcha-token'], 'saved-validation')
    assert.equal(profile.headers.origin, 'https://longzhu.longfor.com')
})

test('new login token never reuses previous-session risk credentials', async () => {
    const store = { longfor_token: appToken, longfor_app_headers_v1: JSON.stringify({ token: appToken, headers: { 'x-lf-dxrisk-token': 'old-session-risk' } }) }
    await run({ store, request: { method: 'GET', url: base + '/supera/member/api/bff/pages/v1_30_0/v1/user-info', headers: { LmToken: 'new-login-token-for-test' } } })
    const result = await run({ store })
    assert.equal(result.calls[0].headers.token, 'new-login-token-for-test')
    assert.ok(!result.calls[0].headers['x-lf-dxrisk-token'])
    assert.ok(!result.calls[0].headers.cookie)
})

test('mini request cannot overwrite APP risk credentials', async () => {
    const oldProfile = JSON.stringify({ token: appToken, headers: { 'x-lf-dxrisk-token': 'app-only-risk' } })
    const store = { longfor_token: appToken, longfor_app_headers_v1: oldProfile }
    await run({ store, request: { method: 'POST', url: signURL, headers: { ...miniHeaders, 'X-LF-DXRisk-Token': 'mini-only-risk' }, body: '{"activity_no":"mini"}' } })
    assert.equal(store.longfor_app_headers_v1, oldProfile)
    assert.equal(store.longfor_token, appToken)
})

test('APP risk capture storage failure is labeled APP rather than mini', async () => {
    const result = await run({ store: { longfor_token: appToken }, failWrite: true, request: { method: 'POST', url: signURL, headers: {
        token: appToken, 'X-LF-Channel': 'L0', 'X-LF-DXRisk-Token': 'fresh-risk'
    }, body: '{}' } })
    assert.ok(result.notices.some(n => n[1] === '龙湖 APP｜请求捕获失败'))
    assert.ok(!result.notices.some(n => n[1] === '龙湖 APP｜风控 Token 已更新'))
})

test('old captured auth headers cannot overwrite the current APP login token', async () => {
    const newToken = 'new-app-login-token-for-test'
    const store = { longfor_token: appToken }
    await run({ store, request: { method: 'POST', url: signURL, body: '{}', headers: {
        lmToken: newToken, token: appToken, 'X-LF-UserToken': appToken,
        'X-LF-Channel': 'L0', 'X-LF-DXRisk-Token': 'new-risk-token'
    } } })
    const result = await run({ store })
    assert.equal(result.calls[0].headers.token, newToken)
    assert.equal(result.calls[0].headers['x-lf-usertoken'], newToken)
    assert.equal(result.calls[0].headers.authtoken, newToken)
})


test('response diagnostics preserve query, headers, sensitive fields and complete text without mutating traffic', async () => {
    const result = await run({ request: {
        method: 'POST', url: 'https://ly-ver.longhu.net/api/v1?captchaToken=query-original',
        headers: { Cookie: 'request-cookie-original', 'Content-Type': 'application/json' },
        body: '{"token":"request-token-original","ac":"actual-ac-original"}'
    }, response: {
        statusCode: 200, headers: { 'Set-Cookie': 'response-cookie-original', 'Content-Type': 'application/json' },
        body: '{"success":true,"token":"captcha-response-original","phone":"13800000000"}'
    } })
    const logs = result.logs.join('\n')
    for (const value of ['query-original', 'request-cookie-original', 'request-token-original', 'actual-ac-original', 'response-cookie-original', 'captcha-response-original', '13800000000', 'response.status=200']) assert.ok(logs.includes(value), value)
    assert.equal(result.calls.length, 0)
    assert.equal(result.notices.length, 0)
    assert.deepEqual(result.store, {})
})

test('response phase only logs and does not recapture credentials', async () => {
    const store = {}
    const result = await run({ store, request: { method: 'POST', url: signURL, headers: miniHeaders, body: '{"activity_no":"mini"}' }, response: { status: 200, body: '{"code":"0000"}' } })
    assert.deepEqual(store, {})
    assert.equal(result.notices.length, 0)
    assert.ok(result.logs.some(line => line.includes('【响应】')))
})

test('text bodies are logged fully across chunks', async () => {
    const body = 'raw-start-' + 'x'.repeat(7000) + '-raw-end'
    const result = await run({ request: { method: 'POST', url: base + '/diagnostic-test', headers: { 'Content-Type': 'text/plain' }, body } })
    const parts = result.logs.filter(line => line.includes(' request.body [')).map(line => line.slice(line.indexOf(']=') + 2))
    assert.equal(parts.join(''), body)
    assert.equal(parts.length, 4)
})

test('long query strings are chunked without losing the original URL', async () => {
    const url = 'https://devops-prod.longfor.com/api?payload=' + 'z'.repeat(6000)
    const result = await run({ request: { method: 'GET', url, headers: {} } })
    const parts = result.logs.filter(line => line.includes(' request.url [')).map(line => line.slice(line.indexOf(']=') + 2))
    assert.equal(parts.join(''), url)
    assert.ok(result.logs.every(line => line.length < 2400))
})

test('binary images keep headers and metadata rather than dumping image bytes', async () => {
    const result = await run({ request: { method: 'GET', url: 'https://ly-ver.longhu.net/slider.png', headers: {} }, response: { status: 200, headers: { 'Content-Type': 'image/png', 'Set-Cookie': 'raw-image-cookie' }, body: 'FAKE_BINARY_PAYLOAD' } })
    assert.ok(result.logs.some(line => line.includes('raw-image-cookie')))
    assert.ok(result.logs.some(line => line.includes('binary/static body omitted')))
    assert.ok(!result.logs.some(line => line.includes('FAKE_BINARY_PAYLOAD')))
})

test('unrelated domains do not produce diagnostic dumps or credential updates', async () => {
    const result = await run({ request: { method: 'GET', url: 'https://longfor.com.evil.example/api', headers: { token: 'unrelated-token' } } })
    assert.equal(result.logs.length, 0)
    assert.equal(result.calls.length, 0)
    assert.deepEqual(result.store, {})
})
