import { expect, test } from "bun:test";
import { writtenSince } from "./sync";

test("first copy has no storage-time filter (full history)", () => {
  expect(writtenSince(null)).toBeNull();
});

test("later copies ask for rows stored since shortly before the last copy started", () => {
  const last = new Date("2026-10-12T10:00:00Z");
  expect(writtenSince(last)!.toISOString()).toBe("2026-10-12T09:50:00.000Z");
});
