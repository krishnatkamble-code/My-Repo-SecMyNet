const test = require('node:test');
const assert = require('node:assert/strict');

const api = require('../server');

test('server exposes API bootstrap', async () => {
  assert.ok(api && typeof api.listen === 'function');
});
