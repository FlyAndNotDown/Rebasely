import { describe, expect, it } from "vitest";
import { normalizeHttpProxy, proxyValidationError } from "./network";

describe("client proxy preferences", () => {
  it("defaults old preferences to system routing and discards unused URLs", () => {
    expect(normalizeHttpProxy(null)).toEqual({ mode: "system", url: "" });
    expect(normalizeHttpProxy({ mode: "none", url: "unused" })).toEqual({ mode: "none", url: "" });
    expect(normalizeHttpProxy({ mode: "manual", url: "http://proxy.example.com:8080" })).toEqual({ mode: "manual", url: "http://proxy.example.com:8080" });
  });

  it("accepts supported proxy protocols and IPv6 hosts", () => {
    for (const url of ["http://proxy.example.com:8080", "https://proxy.example.com", "socks5://proxy.example.com:1080", "socks5h://[::1]:1080"]) {
      expect(proxyValidationError({ mode: "manual", url })).toBeNull();
    }
    expect(proxyValidationError({ mode: "none", url: "" })).toBeNull();
  });

  it("rejects malformed or credential-bearing URLs without reflecting their content", () => {
    for (const url of ["proxy.example.com:8080", "ftp://proxy.example.com", "http://proxy.example.com:0", "http://proxy.example.com:99999", "http://proxy.example.com/path", "http://proxy.example.com?token=fixture-secret", "http://alice:fixture-secret@proxy.example.com", "http://proxy.example.com#fragment", "http://proxy.example.com\n:8080"]) {
      const error = proxyValidationError({ mode: "manual", url });
      expect(error).toBeTruthy();
      expect(error).not.toContain("fixture-secret");
      expect(error).not.toContain("alice");
      expect(error).not.toContain("proxy.example.com");
    }
  });
});
