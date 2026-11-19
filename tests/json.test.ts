import test from "node:test";
import assert from "node:assert/strict";
import { parseUnambiguousJson } from "../shared/json.js";

test("strict JSON compares decoded names and keeps scopes separate", () => {
  for (const text of ['{"a":1,"\\u0061":1}', '{"𠮷":1,"\\ud842\\udfb7":2}', '{"__proto__":0,"__proto__":1}']) {
    assert.throws(() => parseUnambiguousJson(text), /Invalid JSON structure/);
  }
  const text = '{"a":{"x":1},"b":{"x":2},"__proto__":{"safe":true},"constructor":3}';
  const result = parseUnambiguousJson(text);
  assert.deepEqual(result, JSON.parse(text));
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
});

test("strict JSON rejects permissive parser syntax before returning data", () => {
  for (const text of ['', '/* comment */ {}', '{"x":1,}', '[1,]', '{"x":01}', '{"x":undefined}', '{} {}']) {
    assert.throws(() => parseUnambiguousJson(text));
  }
});

test("strict JSON admits finite exponent boundaries and refuses numeric overflow", () => {
  assert.deepEqual(parseUnambiguousJson('[1.7976931348623157e308,-1.7976931348623157e308,5e-324,-1e-9999,"1e309"]'),
    [Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE, -0, "1e309"]);
  for (const text of ['1e309', '{"extra":[-1e309]}']) {
    assert.throws(() => parseUnambiguousJson(text), { message: "Invalid JSON structure." });
  }
});
