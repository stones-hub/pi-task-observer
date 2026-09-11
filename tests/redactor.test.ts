import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITS } from "../src/constants.ts";
import { boundText, fingerprint, redactSecrets, stableStringify, summarize, truncateText } from "../src/redactor.ts";

test("常见凭证模式被脱敏", () => {
  const samples = [
    "sk-abcdefghijklmnopqrstuvwxyz",
    "sk-ant-abcdefghijklmnopqrstuvwxyz",
    "ghp_abcdefghijklmnopqrstuvwxyz1234",
    "github_pat_abcdefghijklmnopqrstuvwxyz",
    "xoxb-1234567890-abcdefghij",
    "AIzaSyAabcdefghijklmnopqrstuvwxyz12",
    "AKIAIOSFODNN7EXAMPLE",
    "Bearer abcdefghijklmnop.qrstuv",
    "api_key=super-secret-value",
    "password: hunter2",
    "OPENAI_API_KEY=sk-live-not-this",
    "-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----",
  ];
  for (const sample of samples) {
    const redacted = redactSecrets(sample);
    assert.match(redacted, /REDACTED/);
    assert.doesNotMatch(redacted, /super-secret-value|hunter2|abcdefghijklmnopqrstuvwxyz1234/);
  }
});

test("截断保留首尾并标明省略，同时不超过字符和字节预算", () => {
  const text = `start ${"x".repeat(4000)} end-token`;
  const out = truncateText(text, 80, 200);
  assert.ok(out.length <= 200);
  assert.match(out, /省略/);
  assert.match(out, /start/);
});

test("摘要会先脱敏再截断", () => {
  const summary = summarize(`token sk-abcdefghijklmnopqrstuvwxyz ${"y".repeat(2000)}`, 40, 80);
  assert.ok(summary);
  assert.match(summary ?? "", /REDACTED/);
  assert.doesNotMatch(summary ?? "", /sk-abcdefghijklmnopqrstuvwxyz/);
});

test("fingerprint 对相同文本稳定，超长文本与其有界窗口指纹一致", () => {
  assert.equal(fingerprint("hello"), fingerprint("hello"));
  assert.notEqual(fingerprint("hello"), fingerprint("hello!"));
  assert.equal(fingerprint("hello").length, 16);
  const huge = `head-${"x".repeat(50_000)}-tail`;
  assert.equal(boundText(boundText(huge)), boundText(huge));
  assert.ok(boundText(huge).length <= LIMITS.fingerprintWindowChars * 2);
  assert.equal(fingerprint(huge), fingerprint(boundText(huge)));
  assert.notEqual(fingerprint(huge), fingerprint(`${huge}!`));
});

test("Prompt 限制符合默认参数", () => {
  const huge = "你".repeat(LIMITS.promptChars + 50);
  const summary = summarize(huge, LIMITS.promptChars, LIMITS.promptBytes) ?? "";
  assert.ok(summary.length <= LIMITS.promptChars + 40);
  assert.ok(Buffer.byteLength(summary, "utf8") <= LIMITS.promptBytes + 80);
});

test("超大字符串先裁剪再脱敏，首尾与裁剪边界上的 secret 不会漏网", () => {
  const secret = "sk-abcdefghijklmnopqrstuvwxyz";
  const huge = `${secret}${"x".repeat(2_000_000)}${secret}`;
  const started = Date.now();
  const out = summarize(huge, 80, 400) ?? "";
  assert.ok(Date.now() - started < 2_000);
  assert.match(out, /REDACTED/);
  assert.doesNotMatch(out, /sk-abcdefghijklmnopqrstuvwxyz/);
  assert.match(out, /省略/);

  const prefix = `${"P".repeat(30)} `;
  const boundary = `${prefix}${secret}${"Q".repeat(8_000)}`;
  const clipped = truncateText(boundary, 80, 400);
  assert.match(clipped, /REDACTED/);
  assert.doesNotMatch(clipped, /sk-abcdefghijklmnopqrstuvwxyz/);
});

test("stableStringify 有界深度/数组/键，getter 异常不拖垮", () => {
  let deep: unknown = "leaf";
  for (let i = 0; i < 40; i += 1) deep = { nested: deep };
  const deepOut = stableStringify(deep);
  assert.match(deepOut, /\[…\]/);
  assert.ok(deepOut.length < LIMITS.stringifyMaxChars);

  const many = Array.from({ length: 10_000 }, (_, index) => `item-${index}`);
  const arrOut = stableStringify(many);
  assert.match(arrOut, /item-0/);
  assert.doesNotMatch(arrOut, /item-50/);
  assert.match(arrOut, /…/);

  const obj: Record<string, string> = {};
  Object.defineProperty(obj, "bad", {
    enumerable: true,
    get() {
      throw new Error("boom");
    },
  });
  obj.ok = "safe";
  assert.doesNotThrow(() => stableStringify(obj));
  const objOut = stableStringify(obj);
  assert.match(objOut, /ok=safe/);
  assert.match(objOut, /\[throw\]/);

  const hugeArg = { token: "sk-abcdefghijklmnopqrstuvwxyz", cmd: "x".repeat(200_000) };
  const dumped = stableStringify(hugeArg);
  assert.ok(dumped.length < LIMITS.stringifyMaxChars * 3);
  const summarized = summarize(dumped, LIMITS.toolArgChars, LIMITS.toolArgBytes) ?? "";
  assert.match(summarized, /REDACTED/);
  assert.doesNotMatch(summarized, /sk-abcdefghijklmnopqrstuvwxyz/);
});

function pem4096Like(): string {
  const body = Array.from({ length: 64 }, () => "MIIEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
}

test("超长 PEM：BEGIN 在头部、END 远超窗口时不泄露 body", () => {
  const pem = pem4096Like();
  assert.ok(pem.length > 4000);
  const out = truncateText(`${pem}\n${"x".repeat(2000)}`, 120, 400);
  assert.match(out, /REDACTED/);
  assert.match(out, /省略/);
  assert.doesNotMatch(out, /BEGIN|END PRIVATE|MIIE/);
  assert.ok(out.length <= 400);
});

test("PEM BEGIN 靠近裁剪边界时整段替换，不泄露 body", () => {
  const pem = pem4096Like();
  const text = `${"n".repeat(36)} ${pem}`;
  const out = truncateText(text, 80, 400);
  assert.match(out, /REDACTED/);
  assert.doesNotMatch(out, /BEGIN PRIVATE|MIIE|END PRIVATE/);
});

test("尾部孤立 PEM END 不泄露此前窗口内的 key body", () => {
  const body = Array.from({ length: 20 }, () => "MIIEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").join("\n");
  const text = `${"z".repeat(8000)}\n${body}\n-----END PRIVATE KEY-----`;
  const out = truncateText(text, 80, 400);
  assert.match(out, /REDACTED|省略/);
  assert.doesNotMatch(out, /MIIE|END PRIVATE KEY/);
});

test("JWT 与 API key 跨窗口边界不得因切窗泄露", () => {
  const jwt = `eyJ${"a".repeat(180)}.${"b".repeat(180)}.${"c".repeat(180)}`;
  const jwtText = `${"h".repeat(30)}${jwt}${"t".repeat(8000)}`;
  const jwtOut = truncateText(jwtText, 80, 400);
  assert.match(jwtOut, /REDACTED/);
  assert.doesNotMatch(jwtOut, /eyJaaaaaaaa|bbbbbbbbbb|cccccccccc/);

  const key = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
  const keyText = `${"p".repeat(35)}${key}${"q".repeat(8000)}`;
  const keyOut = truncateText(keyText, 80, 400);
  assert.match(keyOut, /REDACTED/);
  assert.doesNotMatch(keyOut, /sk-abcdefghijklmnopqrstuvwxyz0123456789/);
});
