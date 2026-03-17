import test from "node:test";
import assert from "node:assert/strict";
import { formatPublishedDate } from "../shared/kagi.js";

test("formatPublishedDate normalizes unix timestamps", () => {
  assert.equal(formatPublishedDate(1735689600), "2025-01-01");
});

test("formatPublishedDate preserves unparseable strings", () => {
  assert.equal(formatPublishedDate("not-a-date"), "not-a-date");
});

test("formatPublishedDate returns undefined for empty values", () => {
  assert.equal(formatPublishedDate(undefined), undefined);
  assert.equal(formatPublishedDate(""), undefined);
});
