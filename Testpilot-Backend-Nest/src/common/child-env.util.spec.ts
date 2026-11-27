import { buildSafeChildEnv, redactSensitiveOutput } from "./child-env.util";

describe("child-env.util", () => {
  describe("buildSafeChildEnv", () => {
    it("copies allowlisted runtime vars and drops backend secrets", () => {
      const env = buildSafeChildEnv({
        homeDir: "/tmp/run-1",
        extra: {
          K6_NO_USAGE_REPORT: "true",
          OPTIONAL_UNSET: undefined
        },
        sourceEnv: {
          PATH: "/usr/local/bin:/usr/bin",
          NODE_ENV: "production",
          PLAYWRIGHT_BROWSERS_PATH: "/app/pw-browsers",
          DATABASE_URL: "postgresql://postgres:supersecret@db:5432/tesbo",
          SECRETS_ENCRYPTION_KEY: "base64-secret-key",
          JWT_SECRET: "jwt-signing-secret",
          OPENAI_API_KEY: "sk-test-12345"
        }
      });

      expect(env.PATH).toBe("/usr/local/bin:/usr/bin");
      expect(env.NODE_ENV).toBe("production");
      expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe("/app/pw-browsers");
      expect(env.HOME).toBe("/tmp/run-1");
      expect(env.K6_NO_USAGE_REPORT).toBe("true");
      expect("OPTIONAL_UNSET" in env).toBe(false);

      expect(env.DATABASE_URL).toBeUndefined();
      expect(env.SECRETS_ENCRYPTION_KEY).toBeUndefined();
      expect(env.JWT_SECRET).toBeUndefined();
      expect(env.OPENAI_API_KEY).toBeUndefined();
    });
  });

  describe("redactSensitiveOutput", () => {
    it("masks Bearer tokens, Authorization headers, DB credentials, and known secrets", () => {
      const input = [
        "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def",
        "Token: Bearer another-secret-token",
        "Failed connecting to postgresql://postgres:myPass123@localhost:5433/tesbo",
        "Using key my-secret-api-key+v1"
      ].join("\n");

      const output = redactSensitiveOutput(input, ["my-secret-api-key+v1", "ab"]);

      expect(output).not.toContain("eyJhbGciOiJIUzI1NiJ9");
      expect(output).not.toContain("another-secret-token");
      expect(output).not.toContain("myPass123");
      expect(output).not.toContain("my-secret-api-key+v1");
      expect(output).toContain("Authorization: [REDACTED]");
      expect(output).toContain("Token: Bearer [REDACTED]");
      expect(output).toContain("postgresql://postgres:[REDACTED]@localhost:5433/tesbo");
      expect(output).toContain("Using key [REDACTED]");
    });
  });
});
