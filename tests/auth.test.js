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
    password: 'password12345',
    department: 'IT',
  });
  assert.equal(res.status, 403);
});

test('signup succeeds with a valid bank email and the account can log in', async () => {
  const client = makeClient(server.baseUrl);
  const signupRes = await client.post('/api/auth/signup', {
    username: 'testuser1',
    email: 'testuser1@amenfimanbank.com',
    password: 'password12345',
    department: 'IT',
  });
  assert.equal(signupRes.status, 200);

  await client.post('/api/auth/logout');

  const loginRes = await client.post('/api/auth/login', {
    identifier: 'testuser1',
    password: 'password12345',
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
  assert.equal(lastStatus, 401, 'failures stay indistinguishable from a wrong password');

  const correctAttempt = await client.post('/api/auth/login', { identifier: 'lockouttest', password: 'correctpassword' });
  assert.equal(correctAttempt.status, 401, 'a correct password must still be rejected while locked');
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
      password: 'password12345',
      department: 'IT',
    });
    db.prepare(`UPDATE users SET role = 'admin' WHERE username = 'testadmin1'`).run();
    await admin.post('/api/auth/logout');
    await admin.post('/api/auth/login', { identifier: 'testadmin1', password: 'password12345' });

    const resetRes = await admin.post(`/api/admin/users/${locked.id}/reset-password`);
    assert.equal(resetRes.status, 200);

    const afterReset = db.prepare('SELECT locked_until, failed_login_count FROM users WHERE id = ?').get(locked.id);
    assert.equal(afterReset.locked_until, null);
    assert.equal(afterReset.failed_login_count, 0);
  } finally {
    db.close();
  }
});

test('a renamed account can still sign in with its old address, without shadowing real identifiers', async () => {
  const db = server.openDb();
  try {
    const client = makeClient(server.baseUrl);
    const signup = await client.post('/api/auth/signup', {
      username: 'renamedadmin',
      email: 'renamedadmin@amenfimanbank.com',
      password: 'password12345',
      department: 'IT',
    });
    assert.equal(signup.status, 200);
    const user = db.prepare('SELECT id FROM users WHERE username = ?').get('renamedadmin');
    db.prepare("UPDATE users SET email = 'renamedadmin@amenfimanbank.local' WHERE id = ?").run(user.id);
    // The browser still has the old address saved.
    db.prepare(
      "INSERT INTO app_settings (key, value) VALUES ('login_aliases', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(JSON.stringify({ 'renamedadmin@amenfimanbank.com': user.id, 'nobody@amenfimanbank.com': 999999 }));
    await client.post('/api/auth/logout');

    const viaAlias = await makeClient(server.baseUrl).post('/api/auth/login', {
      identifier: 'renamedadmin@amenfimanbank.com',
      password: 'password12345',
    });
    assert.equal(viaAlias.status, 200, 'the old saved address still signs in to the same account');
    assert.equal((await viaAlias.json()).user.username, 'renamedadmin');

    const viaNewEmail = await makeClient(server.baseUrl).post('/api/auth/login', {
      identifier: 'renamedadmin@amenfimanbank.local',
      password: 'password12345',
    });
    assert.equal(viaNewEmail.status, 200, 'the current address works too');

    const wrongPassword = await makeClient(server.baseUrl).post('/api/auth/login', {
      identifier: 'renamedadmin@amenfimanbank.com',
      password: 'not-the-password',
    });
    assert.equal(wrongPassword.status, 401, 'an alias is not a bypass');

    const danglingAlias = await makeClient(server.baseUrl).post('/api/auth/login', {
      identifier: 'nobody@amenfimanbank.com',
      password: 'password12345',
    });
    assert.equal(danglingAlias.status, 401, 'an alias pointing at no account cannot be used');

    // The alias use is recorded, so an auditor can see which address was submitted.
    const row = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth.login_alias_used'").get();
    assert.ok(row.n >= 1, 'alias sign-ins are audited');
  } finally {
    db.close();
  }
});
