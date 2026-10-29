const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, makeClient } = require('./helpers/testServer');

let server;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.stop();
});

test('signup rejects an email outside the bank domain', async () => {
  const client = makeClient(server.baseUrl);
  const res = await client.post('/api/auth/signup', {
    username: 'outsider',
    email: 'outsider@gmail.com',
    password: 'password123',
    department: 'IT',
  });
  assert.equal(res.status, 403);
});

test('signup succeeds with a valid bank email and the account can log in', async () => {
  const client = makeClient(server.baseUrl);
  const signupRes = await client.post('/api/auth/signup', {
    username: 'testuser1',
    email: 'testuser1@amenfimanbank.com',
    password: 'password123',
    department: 'IT',
  });
  assert.equal(signupRes.status, 200);

  await client.post('/api/auth/logout');

  const loginRes = await client.post('/api/auth/login', {
    identifier: 'testuser1',
    password: 'password123',
  });
  assert.equal(loginRes.status, 200);
  const data = await loginRes.json();
  assert.equal(data.user.username, 'testuser1');
});

test('account locks after 5 failed login attempts, and the correct password is rejected while locked', async () => {
  const client = makeClient(server.baseUrl);
  await client.post('/api/auth/signup', {
    username: 'lockouttest',
    email: 'lockouttest@amenfimanbank.com',
    password: 'correctpassword',
    department: 'IT',
  });
  await client.post('/api/auth/logout');

  let lastStatus;
  for (let i = 0; i < 5; i++) {
    const res = await client.post('/api/auth/login', { identifier: 'lockouttest', password: 'wrongpassword' });
    lastStatus = res.status;
  }
  assert.equal(lastStatus, 429, 'the 5th failed attempt should lock the account');

  const correctAttempt = await client.post('/api/auth/login', { identifier: 'lockouttest', password: 'correctpassword' });
  assert.equal(correctAttempt.status, 429, 'a correct password must still be rejected while locked');
});

test('an admin resetting a locked account\'s password also clears the lock', async () => {
  const db = server.openDb();
  try {
    const locked = db.prepare('SELECT id, locked_until FROM users WHERE username = ?').get('lockouttest');
    assert.ok(locked.locked_until, 'precondition: account should still be locked from the previous test');

    const admin = makeClient(server.baseUrl);
    await admin.post('/api/auth/signup', {
      username: 'testadmin1',
      email: 'testadmin1@amenfimanbank.com',
      password: 'password123',
      department: 'IT',
    });
    db.prepare(`UPDATE users SET role = 'admin' WHERE username = 'testadmin1'`).run();
    await admin.post('/api/auth/logout');
    await admin.post('/api/auth/login', { identifier: 'testadmin1', password: 'password123' });

    const resetRes = await admin.post(`/api/admin/users/${locked.id}/reset-password`);
    assert.equal(resetRes.status, 200);

    const afterReset = db.prepare('SELECT locked_until, failed_login_count FROM users WHERE id = ?').get(locked.id);
    assert.equal(afterReset.locked_until, null);
    assert.equal(afterReset.failed_login_count, 0);
  } finally {
    db.close();
  }
});
