import { describe, expect, it } from "vitest";
import { PrBusy, PrLock } from "../src/pr-lock.js";

describe("PrLock", () => {
  it("refuses a second pull request change while one runs, then frees up", async () => {
    const lock = new PrLock();
    let finishPush!: () => void;
    const push = lock.hold("the push", () => new Promise<string>((resolve) => (finishPush = () => resolve("pushed"))));
    await expect(lock.hold("the pull request", async () => "opened")).rejects.toThrow(PrBusy);
    await expect(lock.hold("the merge", async () => "merged")).rejects.toThrow("wait for the push to finish");
    finishPush();
    expect(await push).toBe("pushed");
    expect(await lock.hold("the pull request", async () => "opened")).toBe("opened");
  });

  it("frees the lock when the change fails", async () => {
    const lock = new PrLock();
    await expect(lock.hold("the merge", async () => Promise.reject(new Error("GitHub refused")))).rejects.toThrow("GitHub refused");
    expect(lock.label).toBeNull();
  });

  it("lets background work wait for a user's change instead of failing", async () => {
    const lock = new PrLock();
    let finishPush!: () => void;
    const push = lock.hold("the push", () => new Promise<void>((resolve) => (finishPush = resolve)));
    const order: string[] = [];
    const repair = lock.whenFree(1).then(() => lock.hold("the test repair", async () => void order.push("repair")));
    order.push("push");
    finishPush();
    await push;
    await repair;
    expect(order).toEqual(["push", "repair"]);
  });
});
