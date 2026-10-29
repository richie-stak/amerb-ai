// Logins are stored in the database: they survive a server restart, and an admin resetting a
// password (or deleting the account) signs that person out everywhere.
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

async function signup(client, username) {
  const res = await client.post('/api/auth/signup', {
    username,
    email: `${username}@amenfimanbank.com`,
    password: 'password123',
    department: 'IT',
  });
  return (await res.json()).user;
}

const isLoggedIn = async (client) => (await (await client.get('/api/session')).json()).authenticated;

test('a login survives a server restart', async () => {
  const client = makeClient(server.baseUrl);
  await signup(client, 'staysignedin');
  assert.equal(await isLoggedIn(client), true);

  await server.restart();
  const sameCookie = makeClient(server.baseUrl);
  sameCookie.setCookie(client.getCookie());
  assert.equal(await isLoggedIn(sameCookie), true);
});

test('logging out ends the stored session', async () => {
  const client = makeClient(server.baseUrl);
  await signup(client, 'logsout');
  await client.post('/api/auth/logout');
  assert.equal(await isLoggedIn(client), false);
});

test("an admin's password reset signs that person out everywhere", async () => {
  const admin = makeClient(server.baseUrl);
  const adminUser = await signup(admin, 'resetadmin');
  const staff = makeClient(server.baseUrl);
  const staffUser = await signup(staff, 'resetstaff');
  const db = server.openDb();
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(adminUser.id);
  db.close();

  assert.equal(await isLoggedIn(staff), true);
  const res = await admin.post(`/api/admin/users/${staffUser.id}/reset-password`);
  assert.equal(res.status, 200);
  assert.equal(await isLoggedIn(staff), false);
  assert.equal(await isLoggedIn(admin), true, "the admin's own login is untouched");
});
