import assert from "node:assert/strict";
import test from "node:test";

import {
  CanvasHttpClient,
  OriginPolicyError,
  PaginationError,
  PublicHttpClient,
  RequestTimeoutError,
  ResponseTooLargeError,
  validateCanvasUrl,
} from "../dist/lib/http.js";
import { configFixture, mockServer, workspace } from "./helpers.mjs";

test("same-origin Canvas requests carry authorization", async () => {
  let authorization;
  const place = await workspace();
  const canvas = await mockServer((request, response) => {
    authorization = request.headers.authorization;
    response.setHeader("content-type", "application/json");
    response.end('{"ok":true}');
  });
  try {
    const client = new CanvasHttpClient(configFixture(canvas.baseUrl, { cacheDir: place.cache }));
    const result = await client.getJson(client.canvasUrl("profile"));
    assert.deepEqual(result.data, { ok: true });
    assert.equal(authorization, "Bearer test-token");
  } finally {
    await Promise.all([canvas.close(), place.cleanup()]);
  }
});

test("an absolute cross-origin API URL is rejected before authorization can leave", async () => {
  let requests = 0;
  const place = await workspace();
  const canvas = await mockServer((_request, response) => response.end("[]"));
  const attacker = await mockServer((_request, response) => {
    requests += 1;
    response.end("[]");
  });
  try {
    const client = new CanvasHttpClient(configFixture(canvas.baseUrl, { cacheDir: place.cache }));
    await assert.rejects(client.getJson(`${attacker.baseUrl}/steal`), OriginPolicyError);
    assert.equal(requests, 0);
  } finally {
    await Promise.all([canvas.close(), attacker.close(), place.cleanup()]);
  }
});

test("same-origin pagination links are accepted", async () => {
  const place = await workspace();
  const canvas = await mockServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/v1/items") {
      const address = response.socket.address();
      response.setHeader("link", `<http://127.0.0.1:${address.port}/api/v1/items?page=2>; rel="next"`);
      response.end('[{"id":1}]');
      return;
    }
    response.end('[{"id":2}]');
  });
  try {
    const client = new CanvasHttpClient(configFixture(canvas.baseUrl, { cacheDir: place.cache }));
    const result = await client.getPaginated(client.canvasUrl("items"));
    assert.deepEqual(result, [{ id: 1 }, { id: 2 }]);
  } finally {
    await Promise.all([canvas.close(), place.cleanup()]);
  }
});

test("a cross-origin pagination link is rejected without contacting the target", async () => {
  let attackerRequests = 0;
  const place = await workspace();
  const attacker = await mockServer((_request, response) => {
    attackerRequests += 1;
    response.end("[]");
  });
  const canvas = await mockServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.setHeader("link", `<${attacker.baseUrl}/next>; rel="next"`);
    response.end("[]");
  });
  try {
    const client = new CanvasHttpClient(configFixture(canvas.baseUrl, { cacheDir: place.cache }));
    await assert.rejects(client.getPaginated(client.canvasUrl("items")), OriginPolicyError);
    assert.equal(attackerRequests, 0);
  } finally {
    await Promise.all([canvas.close(), attacker.close(), place.cleanup()]);
  }
});

test("a redirect cannot forward authorization to another origin", async () => {
  let attackerRequests = 0;
  const place = await workspace();
  const attacker = await mockServer((_request, response) => {
    attackerRequests += 1;
    response.end("{} ");
  });
  const canvas = await mockServer((_request, response) => {
    response.statusCode = 302;
    response.setHeader("location", `${attacker.baseUrl}/steal?verifier=secret-value`);
    response.end();
  });
  try {
    const client = new CanvasHttpClient(configFixture(canvas.baseUrl, { cacheDir: place.cache }));
    await assert.rejects(client.getJson(client.canvasUrl("redirect")), OriginPolicyError);
    assert.equal(attackerRequests, 0);
  } finally {
    await Promise.all([canvas.close(), attacker.close(), place.cleanup()]);
  }
});

test("public cross-origin requests never inherit Canvas authorization", async () => {
  let authorization;
  const place = await workspace();
  const publicServer = await mockServer((request, response) => {
    authorization = request.headers.authorization;
    response.end("public");
  });
  try {
    const config = configFixture("http://127.0.0.1:9", { cacheDir: place.cache });
    const client = new PublicHttpClient(config, { allowAnyHttpsOrigin: true, useRateLimiter: false });
    const result = await client.getText(`${publicServer.baseUrl}/signed?verifier=secret`, {
      headers: { Authorization: "Bearer caller-supplied-secret" },
    });
    assert.equal(result.data, "public");
    assert.equal(authorization, undefined);
  } finally {
    await Promise.all([publicServer.close(), place.cleanup()]);
  }
});

test("protocol downgrade is rejected unless explicit localhost development policy applies", () => {
  const trusted = new URL("https://canvas.example.test");
  assert.throws(() => validateCanvasUrl(new URL("http://canvas.example.test/api/v1/courses"), trusted, false), OriginPolicyError);
  assert.doesNotThrow(() => validateCanvasUrl(new URL("http://localhost:3000/api/v1/courses"), new URL("http://localhost:3000"), true));
});

test("request deadlines abort work and do not become empty results", async () => {
  const place = await workspace();
  const canvas = await mockServer((_request, response) => setTimeout(() => response.end("[]"), 250));
  try {
    const client = new CanvasHttpClient(configFixture(canvas.baseUrl, { cacheDir: place.cache, requestTimeoutMs: 30 }));
    await assert.rejects(client.getJson(client.canvasUrl("slow")), RequestTimeoutError);
  } finally {
    await Promise.all([canvas.close(), place.cleanup()]);
  }
});

test("repeated pagination links stop with a clear error", async () => {
  const place = await workspace();
  const canvas = await mockServer((_request, response) => {
    const address = response.socket.address();
    response.setHeader("content-type", "application/json");
    response.setHeader("link", `<http://127.0.0.1:${address.port}/api/v1/items>; rel="next"`);
    response.end("[]");
  });
  try {
    const client = new CanvasHttpClient(configFixture(canvas.baseUrl, { cacheDir: place.cache }));
    await assert.rejects(client.getPaginated(client.canvasUrl("items")), PaginationError);
  } finally {
    await Promise.all([canvas.close(), place.cleanup()]);
  }
});

test("pagination page and item caps fail explicitly", async () => {
  const place = await workspace();
  const canvas = await mockServer((_request, response) => {
    const address = response.socket.address();
    const next = Math.random();
    response.setHeader("content-type", "application/json");
    response.setHeader("link", `<http://127.0.0.1:${address.port}/api/v1/items?page=${next}>; rel="next"`);
    response.end('[{"id":1},{"id":2}]');
  });
  try {
    const client = new CanvasHttpClient(configFixture(canvas.baseUrl, { cacheDir: place.cache, maxItems: 3 }));
    await assert.rejects(client.getPaginated(client.canvasUrl("items")), PaginationError);
  } finally {
    await Promise.all([canvas.close(), place.cleanup()]);
  }
});

test("response byte limits fail explicitly", async () => {
  const place = await workspace();
  const canvas = await mockServer((_request, response) => response.end("x".repeat(100)));
  try {
    const client = new CanvasHttpClient(configFixture(canvas.baseUrl, { cacheDir: place.cache, maxResponseBytes: 20 }));
    await assert.rejects(client.getText(client.canvasUrl("large")), ResponseTooLargeError);
  } finally {
    await Promise.all([canvas.close(), place.cleanup()]);
  }
});

test("errors redact signed query values and bearer secrets", async () => {
  const place = await workspace();
  const canvas = await mockServer((_request, response) => {
    response.statusCode = 500;
    response.end("request failed for verifier=secret-value and token test-token");
  });
  try {
    const client = new CanvasHttpClient(configFixture(canvas.baseUrl, { cacheDir: place.cache }));
    const error = await client.getJson(client.canvasUrl("failure?verifier=secret-value&access_token=other-secret")).then(
      () => undefined,
      (caught) => caught,
    );
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /secret-value|other-secret|test-token/);
    assert.doesNotMatch(error.url ?? "", /\?/);
  } finally {
    await Promise.all([canvas.close(), place.cleanup()]);
  }
});
