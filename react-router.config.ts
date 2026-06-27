import type { Config } from "@react-router/dev/config";

const appUrl = process.env.SHOPIFY_APP_URL;
const appHost = appUrl ? new URL(appUrl).hostname : undefined;

const allowedActionOrigins = [
  "admin.shopify.com",
  "*.myshopify.com",
  "**.myshopify.com",
  "druckbar3d.com",
  "*.druckbar3d.com",
  ...(appHost ? [appHost] : []),
];

export default {
  allowedActionOrigins,
} satisfies Config;
