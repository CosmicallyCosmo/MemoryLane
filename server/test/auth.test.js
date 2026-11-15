// The household access code. Every request here is treated as coming from another machine,
// by injecting `isLoopback`, so nothing depends on real networking.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

process.env.ML_RECOGNISER = "rehearsal";
const { createApp } = await import("../src/app.js");
const { createStore } = await import("../src/store.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-auth-"));
const store = createStore(dir);
let server;
let base;

const call = (url, { method = "GET", headers = {}, body } = {}) =>
  fetch(base + url, {
    method,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

before(async () => {
  fs.writeFileSync(path.join(store.mediaDir, "photo.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const app = createApp({ store, isLoopback: () => false });
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the code is eight characters with no look-alike letters or digits", () => {
  assert.match(store.accessCode, /^[A-HJ-NP-Z2-9]{8}$/);
});

test("the code survives a restart", () => {
  assert.equal(createStore(dir).accessCode, store.accessCode);
});

test("another machine gets nothing without the code", async () => {
  for (const url of ["/api/profile", "/api/keepsakes", "/api/pack", "/api/pairing", "/media/photo.jpg"]) {
    const response = await call(url);
    assert.equal(response.status, 401, url);
  }
  const blocked = await call("/api/profile");
  assert.deepEqual(await blocked.json(), { error: "code_required" });
});

test("health answers without the code but says nothing about the household", async () => {
  const response = await call("/api/health");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, recogniser: "rehearsal", codeRequired: true });
});

test("the code is accepted as a header or a query parameter", async () => {
  const byHeader = await call("/api/profile", { headers: { "x-memorylane-code": store.accessCode } });
  assert.equal(byHeader.status, 200);
  const lowerCase = await call("/api/profile", {
    headers: { "x-memorylane-code": store.accessCode.toLowerCase() },
  });
  assert.equal(lowerCase.status, 200, "typing it in lower case still works");
  const byQuery = await call(`/media/photo.jpg?code=${store.accessCode}`);
  assert.equal(byQuery.status, 200);
  const full = await call("/api/health", { headers: { "x-memorylane-code": store.accessCode } });
  assert.equal((await full.json()).keepsakes, 0);
});

test("a wrong code is refused", async () => {
  const response = await call("/api/profile", { headers: { "x-memorylane-code": "WRONGWRG" } });
  assert.equal(response.status, 401);
});

test("typing the code once gives a cookie that also unlocks media", async () => {
  const refused = await call("/api/session", { method: "POST", body: { code: "NOPENOPE" } });
  assert.equal(refused.status, 401);

  const accepted = await call("/api/session", { method: "POST", body: { code: store.accessCode } });
  assert.equal(accepted.status, 200);
  const setCookie = accepted.headers.get("set-cookie");
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.ok(!setCookie.includes(store.accessCode), "the cookie does not carry the code itself");
  const cookie = setCookie.split(";")[0];

  assert.equal((await call("/media/photo.jpg", { headers: { cookie } })).status, 200);
  assert.equal((await call("/api/keepsakes", { headers: { cookie } })).status, 200);
});

test("pairing gives the code and a link the phone's camera app can open", async () => {
  const response = await call("/api/pairing", { headers: { "x-memorylane-code": store.accessCode } });
  const pairing = await response.json();
  assert.equal(pairing.code, store.accessCode);
  assert.ok(Array.isArray(pairing.urls));
  if (pairing.urls.length) {
    const link = new URL(pairing.link);
    assert.equal(link.protocol, "memorylane:");
    assert.equal(link.searchParams.get("code"), store.accessCode);
    assert.equal(link.searchParams.get("server"), pairing.urls[0]);
  } else {
    assert.equal(pairing.link, null);
  }
});

test("a new code shuts out the old code and old sessions", async () => {
  const oldCode = store.accessCode;
  const session = await call("/api/session", { method: "POST", body: { code: oldCode } });
  const oldCookie = session.headers.get("set-cookie").split(";")[0];

  const rotated = await call("/api/pairing/rotate", {
    method: "POST",
    headers: { "x-memorylane-code": oldCode },
  });
  assert.equal(rotated.status, 200);
  const { code: newCode } = await rotated.json();
  assert.notEqual(newCode, oldCode);
  assert.equal(store.accessCode, newCode);

  assert.equal((await call("/api/profile", { headers: { "x-memorylane-code": oldCode } })).status, 401);
  assert.equal((await call("/api/profile", { headers: { cookie: oldCookie } })).status, 401);
  assert.equal((await call("/api/profile", { headers: { "x-memorylane-code": newCode } })).status, 200);

  // Whoever asked for the new code stays signed in.
  const freshCookie = rotated.headers.get("set-cookie").split(";")[0];
  assert.equal((await call("/api/profile", { headers: { cookie: freshCookie } })).status, 200);
});

// Last, because it locks this address out for the rest of the window.
test("ten wrong codes lock the address out, even for the right code", async () => {
  // A new code clears earlier failures, so the count starts from zero here.
  const reset = await call("/api/pairing/rotate", {
    method: "POST",
    headers: { "x-memorylane-code": store.accessCode },
  });
  assert.equal(reset.status, 200);

  for (let attempt = 1; attempt <= 10; attempt++) {
    const response = await call("/api/profile", { headers: { "x-memorylane-code": "BADBADBD" } });
    assert.equal(response.status, 401, `attempt ${attempt}`);
  }
  const locked = await call("/api/profile", { headers: { "x-memorylane-code": store.accessCode } });
  assert.equal(locked.status, 429);
  assert.equal((await call("/api/session", { method: "POST", body: { code: store.accessCode } })).status, 429);
});
