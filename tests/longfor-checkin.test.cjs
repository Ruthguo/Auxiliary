const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { test } = require('node:test')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, '../Script/longfor/longfor-checkin.js'), 'utf8')
const base = 'https://gw2c-hw-open.longfor.com'
const signURL = base + '/lmarketing-task-api-mvc-prod/openapi/task/v1/signature/clock'
const pageURL = base + '/llt-gateway-prod/api/v1/page/info?activityNo=current&pageNo=page'
const appToken = 'app-token-for-testing-only'
const savedPage = '{"activityNo":"current","pageNo":"page"}'
const miniHeaders = { token: 'mini-token-for-testing-only', 'X-LF-UserToken': 'mini-user-token-distinct', 'X-LF-Channel': 'C2' }
const turntable = { code: '0000', data: { activity_no: 'dynamic-activity', info: JSON.stringify({ list: [{ comName: 'turntablecom', data: { component_no: 'dynamic-component' } }] }) } }

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

test('capture mini credentials separately, normalize headers, never log secrets', async () => {
    const store = { longfor_token: appToken }
    const result = await run({ store, request: { method: 'POST', url: signURL, headers: { ...miniHeaders, Authorization: 'must-not-store' }, body: JSON.stringify({ activity_no: 'mini-activity' }) } })
    const captured = JSON.parse(store.longfor_mini_signin_v1)
    assert.equal(captured.headers['x-lf-usertoken'], miniHeaders['X-LF-UserToken'])
    assert.equal(captured.headers.authorization, undefined)
    assert.equal(store.longfor_token, appToken)
    assert.equal(result.calls.length, 0)
    assert.ok(!JSON.stringify(result.logs.concat(result.notices)).includes(miniHeaders.token))
})

test('APP signature request does not overwrite mini profile', async () => {
    const store = { longfor_mini_signin_v1: 'existing' }
    await run({ store, request: { method: 'POST', url: signURL, headers: { ...miniHeaders, 'X-LF-Channel': 'L0' }, body: '{}' } })
    assert.equal(store.longfor_mini_signin_v1, 'existing')
})

test('invalid request body is reported and done is still called', async () => {
    const result = await run({ request: { method: 'POST', url: signURL, headers: miniHeaders, body: 'not json' } })
    assert.equal(result.store.longfor_mini_signin_v1, undefined)
    assert.ok(result.notices.some(n => n[1] === '请求捕获失败'))
})

test('storage failure is not reported as captured successfully', async () => {
    const result = await run({ failWrite: true, request: { method: 'POST', url: signURL, headers: miniHeaders, body: '{"activity_no":"mini"}' } })
    assert.ok(result.notices.some(n => n[1] === '请求捕获失败'))
    assert.ok(!result.notices.some(n => n[1] === '小程序签到配置已保存'))
})

test('only actual turntable response updates lottery page', async () => {
    const store = {}
    const request = { method: 'GET', url: pageURL, headers: { authtoken: 'lottery-token-for-test' } }
    await run({ store, request, response: { body: JSON.stringify(turntable) } })
    assert.equal(JSON.parse(store.longfor_lottery_page_v1).activityNo, 'current')
    const previous = JSON.stringify(store)
    await run({ store, request: { ...request, url: pageURL.replace('current', 'unrelated') }, response: { body: JSON.stringify({ code: '0000', data: { info: '{"list":[]}' } }) } })
    assert.equal(JSON.stringify(store), previous)
})

test('APP and mini signin use distinct tokens, dynamically discovered lottery IDs are used', async () => {
    const store = {
        longfor_token: appToken,
        longfor_mini_signin_v1: JSON.stringify({ headers: { token: miniHeaders.token, 'x-lf-usertoken': miniHeaders['X-LF-UserToken'] }, activity_no: 'mini-captured' }),
        longfor_lottery_page_v1: '{"activityNo":"current","pageNo":"page"}',
        longfor_lottery_headers_v1: '{"authtoken":"lottery-token-for-test"}'
    }
    const result = await run({ store, reply: call => {
        if (call.url.includes('/page/info')) return turntable
        if (call.url.endsWith('/lottery/sign')) return { code: '0000', data: { chance: 3 } }
        return { code: '0000', data: { is_popup: 1, reward_info: [{ reward_num: 10 }] } }
    } })
    const signs = result.calls.filter(c => c.url === signURL)
    assert.equal(signs.length, 2)
    assert.equal(signs[0].headers.token, appToken)
    assert.equal(signs[1].headers.token, miniHeaders.token)
    assert.equal(JSON.parse(signs[1].body).activity_no, 'mini-captured')
    const draw = result.calls.filter(c => c.url.endsWith('/lottery/click'))
    assert.equal(draw.length, 1)
    assert.deepEqual(JSON.parse(draw[0].body), { activity_no: 'dynamic-activity', component_no: 'dynamic-component', batch_no: '' })
    assert.ok(result.calls.some(c => c.method === 'GET' && c.url === pageURL))
})

test('expired lottery page does not fall back to old activity or break APP success', async () => {
    const result = await run({ store: { longfor_token: appToken, longfor_lottery_page_v1: savedPage }, reply: call => call.url === signURL ? { code: '0000', message: '获得积分' } : { code: '803012', message: '活动已结束，下次早点来' } })
    assert.ok(result.notices.some(n => n[1] === '签到成功'))
    assert.ok(result.notices.some(n => n[1] === '抽奖签到失败' && n[2].includes('803012')))
    assert.ok(!result.calls.some(c => /lottery\/(sign|click)$/.test(c.url)))
})

for (const chance of [undefined, null, '', 'oops', -1, 0, 1.5]) {
    test(`invalid or zero chance ${String(chance)} never draws`, async () => {
        const result = await run({ store: { longfor_lottery_headers_v1: '{"authtoken":"lottery-token-for-test"}', longfor_lottery_page_v1: savedPage }, reply: call => call.url.includes('/page/info') ? turntable : { code: '0000', data: { chance } } })
        assert.ok(!result.calls.some(c => c.url.endsWith('/lottery/click')))
    })
}

test('business failure in mini signin is never mislabeled as already signed in', async () => {
    const result = await run({ store: { longfor_mini_signin_v1: JSON.stringify({ headers: miniHeaders, activity_no: 'mini' }) }, reply: () => ({ code: '803012', message: '活动已结束' }) })
    assert.ok(result.notices.some(n => n[1] === '小程序签到失败' && n[2].includes('803012')))
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
    assert.ok(result.notices.some(n => n[1] === '小程序签到成功'))
})

test('APP token capture handles arbitrary header casing without leaking token', async () => {
    const result = await run({ request: { method: 'GET', url: base + '/supera/member/api/bff/pages/v1_30_0/v1/user-info', headers: { LmToKeN: appToken } } })
    assert.equal(result.store.longfor_token, appToken)
    assert.ok(!JSON.stringify(result.logs.concat(result.notices)).includes(appToken))
})

test('no captured lottery page never sends requests with old reference IDs', async () => {
    const result = await run({ store: { longfor_lottery_headers_v1: '{"authtoken":"lottery-token-for-test"}' } })
    assert.equal(result.calls.length, 0)
    assert.ok(result.notices.some(n => n[2].includes('尚未捕获抽奖入口')))
})

test('HTTP error status is not treated as business success', async () => {
    const result = await run({ status: 503, store: { longfor_mini_signin_v1: JSON.stringify({ headers: miniHeaders, activity_no: 'mini' }) } })
    assert.equal(result.calls.length, 1)
    assert.ok(result.notices.some(n => n[1] === '小程序签到失败' && n[2].includes('HTTP 503')))
})

test('Quantumult X rejected fetch finishes once and reports failure', async () => {
    const result = await run({ qx: true, store: { longfor_mini_signin_v1: JSON.stringify({ headers: miniHeaders, activity_no: 'mini' }) }, reply: () => { throw { error: 'network failure' } } })
    assert.equal(result.calls.length, 1)
    assert.ok(result.notices.some(n => n[1] === '小程序签到失败'))
})
