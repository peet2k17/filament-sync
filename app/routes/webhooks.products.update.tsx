import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  fetchProductDetails,
  mergeMaterialProfilesByOptionName,
  runMaterialProfileSync,
  setProductAutoSyncRunStatus,
} from "./app._index";

type ProductUpdatePayload = {
  id?: number;
  admin_graphql_api_id?: string;
};

function toProductGid(payload: ProductUpdatePayload): string | null {
  if (typeof payload.admin_graphql_api_id === "string" && payload.admin_graphql_api_id) {
    return payload.admin_graphql_api_id;
  }

  if (typeof payload.id === "number") {
    return `gid://shopify/Product/${payload.id}`;
  }

  return null;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload, admin } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  if (!admin) {
    return new Response();
  }

  const productGid = toProductGid((payload ?? {}) as ProductUpdatePayload);
  if (!productGid) {
    return new Response();
  }

  const writeStatus = async (
    status: "running" | "success" | "error" | "skipped",
    message: string,
  ) => {
    try {
      await setProductAutoSyncRunStatus(admin, productGid, status, message);
    } catch (statusError) {
      console.error("Failed to persist auto-sync status:", statusError);
    }
  };

  try {
    const { product, materialProfiles } = await fetchProductDetails(admin, productGid);

    if (!product.autoSyncEnabled) {
      await writeStatus("skipped", "Auto-Sync ist fuer dieses Produkt deaktiviert.");
      return new Response();
    }

    const merged = mergeMaterialProfilesByOptionName(materialProfiles);
    if (merged.profiles.length === 0) {
      await writeStatus("skipped", "Keine gueltigen Materialprofil-Metafelder gefunden.");
      return new Response();
    }

    await writeStatus("running", "Auto-Sync gestartet.");
    const result = await runMaterialProfileSync(admin, productGid, product, merged.profiles);
    const summary =
      result.notices.length > 0
        ? result.notices.join(" | ").slice(0, 1000)
        : "Auto-Sync erfolgreich abgeschlossen.";
    await writeStatus("success", summary);
    return new Response();
  } catch (error) {
    console.error("Auto-sync via products/update webhook failed:", error);
    const message = error instanceof Error ? error.message : "Unbekannter Fehler";
    await writeStatus("error", message);
    return new Response();
  }
};
