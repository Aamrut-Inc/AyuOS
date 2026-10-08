import { expect, test } from "bun:test";
import { providersWithPossibleNewData, syncWindowStart } from "./sync";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-10-09T00:00:00Z");

test("starts from the provider furthest behind, minus overlap", () => {
  const latest = new Map([
    ["oura", new Date(now.getTime() - 1 * DAY)],
    ["whoop", new Date(now.getTime() - 10 * DAY)]
  ]);
  const start = syncWindowStart(["oura", "whoop"], latest, now);
  expect(start.getTime()).toBe(now.getTime() - 13 * DAY);
});

test("a newly connected provider with no local readings gets full history", () => {
  const latest = new Map([["oura", new Date(now.getTime() - 1 * DAY)]]);
  const start = syncWindowStart(["oura", "whoop"], latest, now);
  expect(now.getTime() - start.getTime()).toBe(3650 * DAY);
});

test("disconnected providers don't hold the window back", () => {
  const latest = new Map([
    ["oura", new Date(now.getTime() - 1 * DAY)],
    ["apple_health", new Date(now.getTime() - 100 * DAY)]
  ]);
  const start = syncWindowStart(["oura"], latest, now);
  expect(start.getTime()).toBe(now.getTime() - 4 * DAY);
});

test("a connection that hasn't synced since our newest reading is left out", () => {
  const latest = new Map([
    ["oura", new Date(now.getTime() - 1 * DAY)],
    ["whoop", new Date(now.getTime() - 40 * DAY)]
  ]);
  const providers = providersWithPossibleNewData(
    [
      { provider: "oura", status: "active", last_synced_at: now.toISOString() },
      { provider: "whoop", status: "active", last_synced_at: new Date(now.getTime() - 55 * DAY).toISOString() },
      { provider: "garmin", status: "active", last_synced_at: null }
    ],
    latest
  );
  expect(providers).toEqual(["oura", "garmin"]);
});
