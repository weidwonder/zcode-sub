import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startFakeZcode } from "./helpers/fake-zcode.js";
import { parseStatusState, postIngress, queryStatus } from "../src/ingress.js";

let fake;
const config = {
  botId: "bot-1",
  secret: "s1",
  userId: "zcode-sub",
  ingressPort: 0,
};

before(async () => {
  fake = await startFakeZcode();
  config.ingressPort = fake.port;
});

after(() => fake.stop());

test("postIngress：body 携带 botId/userId/messageId，messageId 前缀 zsub-", async () => {
  const result = await postIngress(config, "你好");
  assert.deepEqual(result.replies, []);
  const last = fake.calls.at(-1);
  assert.equal(last.body.botId, "bot-1");
  assert.equal(last.body.userId, "zcode-sub");
  assert.match(last.body.messageId, /^zsub-/u);
  assert.equal(last.headers["x-zcode-bot-secret"], "s1");
});

test("postIngress：401 抛 zcode_secret_mismatch（exit 5）", async () => {
  await assert.rejects(
    () => postIngress({ ...config, secret: "wrong" }, "你好"),
    (error) => error.code === "zcode_secret_mismatch" && error.exitCode === 5,
  );
});

test("postIngress：连不上抛 zcode_ingress_unreachable（exit 2）", async () => {
  await assert.rejects(
    () => postIngress({ ...config, ingressPort: 1 }, "你好"),
    (error) => error.code === "zcode_ingress_unreachable" && error.exitCode === 2,
  );
});

test("parseStatusState：六态 zh/en 与不可解析", () => {
  assert.equal(parseStatusState("工作区: x\n状态: ⏳ 运行中"), "running");
  assert.equal(parseStatusState("State: Running"), "running");
  assert.equal(parseStatusState("状态: ✅ 已完成"), "completed");
  assert.equal(parseStatusState("State: Completed"), "completed");
  assert.equal(parseStatusState("状态: 失败"), "failed");
  assert.equal(parseStatusState("状态: 已取消"), "cancelled");
  assert.equal(parseStatusState("状态: 已停止"), "stopped");
  assert.equal(parseStatusState("状态: 草稿"), "draft");
  assert.equal(parseStatusState("随便一段话"), "unknown");
});

test("queryStatus：解析假 ZCode 的状态行", async () => {
  fake.setStatusState("running");
  let status = await queryStatus(config);
  assert.equal(status.state, "running");
  fake.setStatusState("completed");
  status = await queryStatus(config);
  assert.equal(status.state, "completed");
  assert.match(status.raw, /状态: ✅ 已完成/u);
});
