import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./tests/wrangler.jsonc" },
      miniflare: {
        bindings: {
          ADMIN_TOKEN: "admin-test-token-01234567890123456789",
          BRIDGE_TOKEN: "bridge-test-token-01234567890123456789",
          TOKEN_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          TEST_MODE: "true",
          OWNER_EMAIL: "owner@example.com",
          WHATSAPP_APP_SECRET: "meta-secret",
          WHATSAPP_OWNER: "15551234567",
          WHATSAPP_PHONE_ID: "123",
          WHATSAPP_BUSINESS_ID: "456",
          WHATSAPP_VERIFY_TOKEN: "verify",
        },
      },
    }),
  ],
  resolve: {
    dedupe: [
      "@earendil-works/chord",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-durable",
      "@earendil-works/pi-telemetry",
    ],
  },
  test: { include: ["tests/**/*.test.ts"], testTimeout: 30000 },
});
