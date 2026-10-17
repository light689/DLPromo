const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup() {
  const handlers = {}, stored = new Map(), deleted = [], navigated = [];
  const cache = {
    match: async key => stored.get(typeof key === 'string' ? key : key.url),
    put: async (key, value) => stored.set(typeof key === 'string' ? key : key.url, value),
    addAll: async requests => { assert.ok(requests.every(r => r.cache === 'reload')); }
  };
  class LocalRequest extends Request {
    constructor(input, options) { super(typeof input === 'string' ? new URL(input, 'https://app.test') : input, options); }
  }
  const ctx = {URL, Request: LocalRequest, fetch: async () => new Response('new'),
    caches: {open: async () => cache, keys: async () => ['dlpromo-shell-v2', 'other-app'],
      delete: async key => deleted.push(key)},
    self: {location: {origin: 'https://app.test'}, skipWaiting: async () => {ctx.skipped = true;},
      addEventListener: (name, fn) => {handlers[name] = fn;},
      clients: {claim: async () => {}, matchAll: async () => [{url: 'https://app.test/',
        navigate: async url => navigated.push(url)}]}}};
  vm.runInNewContext(fs.readFileSync(__dirname + '/static/sw.js', 'utf8'), ctx);
  const run = name => new Promise((resolve, reject) => handlers[name]({waitUntil: p => p.then(resolve, reject)}));
  const get = (path, mode) => {
    const request = new Request('https://app.test' + path);
    if (mode) Object.defineProperty(request, 'mode', {value: mode});
    let result;
    handlers.fetch({request, respondWith: p => {result = p;}});
    return result;
  };
  return {ctx, stored, deleted, navigated, run, get};
}

test('online navigation replaces stale shell; offline and server errors use last good copy', async () => {
  const {ctx, stored, get} = setup();
  stored.set('/', new Response('old'));
  assert.equal(await (await get('/', 'navigate')).text(), 'new');
  ctx.fetch = async () => {throw new Error('offline');};
  assert.equal(await (await get('/', 'navigate')).clone().text(), 'new');
  ctx.fetch = async () => new Response('failure', {status: 503});
  assert.equal(await (await get('/', 'navigate')).clone().text(), 'new');
});

test('static assets update online while API requests remain untouched', async () => {
  const {ctx, get} = setup();
  assert.equal(await (await get('/static/app.js')).text(), 'new');
  ctx.fetch = async () => {throw new Error('offline');};
  assert.equal(await (await get('/static/app.js')).text(), 'new');
  assert.equal(get('/api/settings'), undefined);
});

test('install activates immediately and migrates legacy clients without deleting unrelated caches', async () => {
  const {ctx, run, deleted, navigated} = setup();
  await run('install');
  assert.equal(ctx.skipped, true);
  await run('activate');
  assert.deepEqual(deleted, ['dlpromo-shell-v2']);
  assert.deepEqual(navigated, ['https://app.test/']);
});
