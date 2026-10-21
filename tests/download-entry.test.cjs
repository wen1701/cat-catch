const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Exercise the shipped scripts with browser APIs held at their async boundaries.
function browserFixture(options = {}) {
    const elements = new Map();
    const tabs = [];
    const downloads = [];
    const storage = new Map();
    const messages = [];
    const timers = [];
    const rules = [];
    const ruleCallbacks = [];
    class Element {
        constructor(markup = '') {
            this.markup = markup;
            this.children = new Map();
            this.properties = new Map();
            this[0] = { offsetHeight: 0 };
        }
        find(selector) {
            if (!this.children.has(selector)) this.children.set(selector, new Element());
            return this.children.get(selector);
        }
        click(callback) {
            if (callback) this.onClick = callback;
            else this.onClick?.call(this, { target: {}, originalEvent: {} });
            return this;
        }
        prop(key, value) {
            if (arguments.length === 1) return this.properties.get(key);
            this.properties.set(key, value);
            return this;
        }
        val(value) {
            if (arguments.length === 0) return this.value;
            this.value = value;
            return this;
        }
    }
    for (const method of ['bind', 'show', 'hide', 'append', 'toggle']) {
        Element.prototype[method] = function () { return this; };
    }
    const $ = selector => {
        if (selector.startsWith('<')) return new Element(selector);
        if (!elements.has(selector)) elements.set(selector, new Element());
        return elements.get(selector);
    };
    const context = vm.createContext({
        $, console, URL, URLSearchParams,
        location: { href: 'https://extension.test/popup.html' },
        window: { addEventListener() {} },
        navigator: {},
        reFilterFileName: /[<>:"|?*]/g,
        G: { tabId: 7, chromeLimitSize: 2 ** 31, downActive: false, ...options },
        i18n: new Proxy(key => key, { get: (_, key) => key }),
        confirm: () => true,
        setTimeout: callback => timers.push(callback),
        setInterval: callback => timers.push(callback),
        localStorage: {
            getItem: key => storage.get(key) ?? null,
            setItem: (key, value) => storage.set(key, value)
        },
        chrome: {
            runtime: {
                id: 'test-extension',
                sendMessage(...args) {
                    const message = args.find(arg => arg?.Message);
                    messages.push(message);
                    const callback = args.at(-1);
                    if (typeof callback === 'function') {
                        callback(message.Message === 'getData' ? context.media : undefined);
                    }
                }
            },
            tabs: {
                get: (_, callback) => callback({ index: 0 }),
                getCurrent: callback => callback({ id: 42, index: 0 }),
                create(options, callback) {
                    tabs.push(options);
                    callback?.({ id: 42 });
                }
            },
            downloads: {
                download: options => downloads.push(options),
                onChanged: { addListener() {} }
            },
            declarativeNetRequest: {
                updateSessionRules(value, callback) {
                    rules.push(value);
                    ruleCallbacks.push(callback);
                }
            }
        }
    });
    const load = file => vm.runInContext(
        readFileSync(path.join(__dirname, '..', file), 'utf8'), context, { filename: file }
    );
    load('js/function.js');
    load('js/popup-utils.js');
    return { context, $, tabs, downloads, storage, messages, timers, rules, ruleCallbacks, load };
}

function media(requestId, ext = 'mp4') {
    return {
        requestId, ext, tabId: 7, title: 'recording', name: `recording-${requestId}.${ext}`,
        url: `https://media.test/recording-${requestId}.${ext}`, size: 512,
        type: ext === 'm3u8' ? 'application/vnd.apple.mpegurl' : 'video/mp4',
        requestHeaders: { referer: 'https://meeting.test/' }, cookie: 'session=fixture'
    };
}

function popup(options) {
    const fixture = browserFixture(options);
    fixture.load('js/popup.js');
    fixture.context.Tips = () => {};
    return fixture;
}

test('the normal single-file button preserves authentication in a standalone downloader task', () => {
    const f = popup();
    const data = media('11');
    f.context.AddMedia(data);
    data.html.find('#download').click();
    assert.equal(f.downloads.length, 0);
    assert.equal(f.tabs.length, 1);
    assert.equal(new URL(f.tabs[0].url, 'https://extension.test').pathname, '/downloader.html');
    const [saved] = JSON.parse(f.storage.get('downloadData'));
    assert.equal(saved.cookie, data.cookie);
    assert.equal(saved.requestHeaders.referer, data.requestHeaders.referer);
    assert.equal(saved.downFileName, data.name);
    assert.equal(data.html.markup.includes('id="catDown"'), false);
});

test('batch download hands every selected file to one task before the popup can close', () => {
    const f = popup();
    const selected = [media('11'), media('12')];
    selected.forEach(data => f.context.AddMedia(data));
    const excluded = media('13');
    f.context.AddMedia(excluded);
    excluded.checked = false;
    const timersBefore = f.timers.length;
    f.$('#DownFile').click();
    assert.equal(f.downloads.length, 0);
    assert.equal(f.tabs.length, 1);
    const url = new URL(f.tabs[0].url, 'https://extension.test');
    assert.equal(url.searchParams.get('requestId'), '11,12');
    assert.equal(f.timers.length, timersBefore + 1); // Only the existing tab-load monitor.
    assert.equal(f.context.G.downActive, false);
    assert.equal(JSON.parse(f.storage.get('downloadData')).length, 2);
});

test('mixed MP4 and HLS batches keep the HLS parser route', () => {
    const f = popup({ m3u8AutoDown: true });
    [media('11'), media('12', 'm3u8')].forEach(data => f.context.AddMedia(data));
    f.$('#DownFile').click();
    assert.equal(f.tabs.length, 2);
    const urls = f.tabs.map(tab => new URL(tab.url, 'https://extension.test'));
    assert.equal(urls[0].pathname, '/m3u8.html');
    assert.equal(urls[0].searchParams.get('autoDown'), '1');
    assert.equal(urls[1].searchParams.get('requestId'), '11');
});

test('single-file HLS downloads still use the configured parser', () => {
    const f = popup({ m3u8AutoDown: true });
    const data = media('11', 'm3u8');
    f.context.AddMedia(data);
    data.html.find('#download').click();
    assert.equal(f.tabs.length, 1);
    assert.match(f.tabs[0].url, /^\/m3u8\.html\?/);
    assert.equal(f.storage.has('downloadData'), false);
});

test('explicitly disabling the built-in downloader preserves browser downloads', () => {
    const f = popup({ catDownload: true, saveAs: true });
    const data = media('11');
    f.context.AddMedia(data);
    data.html.find('#download').click();
    f.$('#DownFile').click();
    assert.equal(f.downloads.length, 2);
    assert.equal(f.downloads[0].saveAs, true);
    assert.equal(f.downloads[1].filename, data.name);
    assert.equal(f.tabs.length, 0);
});

test('batch downloads still honor an explicitly configured Aria2 integration', () => {
    const f = popup({ enableAria2Rpc: true });
    const sent = [];
    f.context.aria2AddUri = data => sent.push(data.requestId);
    [media('11'), media('12')].forEach(data => f.context.AddMedia(data));
    f.$('#DownFile').click();
    assert.deepEqual(sent, ['11', '12']);
    assert.equal(f.tabs.length, 0);
    assert.equal(f.downloads.length, 0);
});

test('an empty selection does not create a download task', () => {
    const f = popup();
    f.$('#DownFile').click();
    assert.equal(f.tabs.length, 0);
    assert.equal(f.downloads.length, 0);
});

test('batch downloads retain explicitly configured HLS and DASH protocol handlers', () => {
    const f = popup({ m3u8dl: 2 });
    f.context.templates = (_, data) => data.url;
    [media('11', 'm3u8'), media('12', 'mpd')].forEach(data => f.context.AddMedia(data));
    f.$('#DownFile').click();
    assert.equal(f.tabs.length, 2);
    assert.ok(f.tabs.every(tab => tab.url.startsWith('m3u8dl:')));
    assert.equal(f.storage.has('downloadData'), false);
});

for (const source of ['saved task', 'background task', 'manual URL']) {
    test(`the downloader waits for request-header rules before starting a ${source}`, () => {
        const f = browserFixture();
        const data = media('11');
        f.context.location.href = 'https://extension.test/downloader.html';
        if (source !== 'manual URL') f.context.location.href += '?requestId=11';
        if (source === 'saved task') f.storage.set('downloadData', JSON.stringify([data]));
        f.context.media = [data];
        let initialize;
        let starts = 0;
        f.context.awaitG = callback => { initialize = callback; };
        f.context.loadCSS = () => {};
        f.load('js/downloader.js');
        f.context.start = () => { starts++; };
        initialize();
        if (source === 'manual URL') {
            f.$('#getURL #url').val(data.url);
            f.$('#getURL #referer').val(JSON.stringify({ Cookie: data.cookie }));
            f.$('#getURL_btn').click();
        }
        assert.equal(starts, 0, 'No request may start while the browser is still installing rules');
        assert.equal(f.rules.length, 1);
        const [rule] = f.rules[0].addRules;
        assert.equal(rule.condition.tabIds[0], 42);
        assert.equal(rule.condition.urlFilter, data.url);
        assert.ok(rule.action.requestHeaders.some(header =>
            header.header.toLowerCase() === 'cookie' && header.value === data.cookie
        ));
        f.ruleCallbacks[0]();
        assert.equal(starts, 1);
    });
}
