import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  fetchProductDetails,
  mergeMaterialProfilesByOptionName,
  runMaterialProfileSync,
  setProductAutoSyncRunStatus,
} from "./app._index";

type MetaobjectUpdatePayload = {
  id?: string;
  admin_graphql_api_id?: string;
};

const AUTO_SYNC_SCAN_PAGE_SIZE = 100;
const AUTO_SYNC_SCAN_MAX_PRODUCTS = 250;

const PRODUCTS_WITH_AUTOSYNC_QUERY = `#graphql
  query ProductsWithAutoSync($first: Int!, $after: String) {
    products(first: $first, after: $after, sortKey: UPDATED_AT, reverse: true) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        autoSyncMetafield: metafield(namespace: "custom", key: "filamentsync_auto_sync") {
          value
        }
      }
    }
  }
`;

function toMetaobjectGid(payload: MetaobjectUpdatePayload): string | null {
  if (typeof payload.admin_graphql_api_id === "string" && payload.admin_graphql_api_id) {
    return payload.admin_graphql_api_id;
  }

  if (typeof payload.id === "string" && payload.id.startsWith("gid://")) {
    return payload.id;
  }

  return null;
}

async function fetchAutoSyncProductIds(
  admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"],
): Promise<string[]> {
  const result: string[] = [];
  let after: string | null = null;
  let hasNextPage = true;

  while (hasNextPage && result.length < AUTO_SYNC_SCAN_MAX_PRODUCTS) {
    const response = await admin.graphql(PRODUCTS_WITH_AUTOSYNC_QUERY, {
      variables: {
        first: AUTO_SYNC_SCAN_PAGE_SIZE,
        after,
      },
    });

    const json = (await response.json()) as {
      data?: {
        products?: {
          pageInfo?: {
            hasNextPage: boolean;
            endCursor: string | null;
          };
          nodes?: Array<{
            id: string;
            autoSyncMetafield?: { value: string | null } | null;
          }>;
        };
      };
      errors?: Array<{ message: string }>;
    };

    if (json.errors?.length) {
      throw new Error(json.errors.map((error) => error.message).join(" | "));
    }

    const nodes = json.data?.products?.nodes ?? [];
    for (const node of nodes) {
      if (node.autoSyncMetafield?.value === "true") {
        result.push(node.id);
      }

      if (result.length >= AUTO_SYNC_SCAN_MAX_PRODUCTS) {
        break;
      }
    }

    const pageInfo = json.data?.products?.pageInfo;
    hasNextPage = Boolean(pageInfo?.hasNextPage);
    after = pageInfo?.endCursor ?? null;
  }

  return result;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload, admin } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  if (!admin) {
    return new Response();
  }

  const metaobjectGid = toMetaobjectGid((payload ?? {}) as MetaobjectUpdatePayload);
  if (!metaobjectGid) {
    return new Response();
  }

  try {
    const autoSyncProductIds = await fetchAutoSyncProductIds(admin);
    if (autoSyncProductIds.length === 0) {
      return new Response();
    }

    for (const productId of autoSyncProductIds) {
      try {
        const { product, materialProfiles } = await fetchProductDetails(admin, productId);
        const isAffected = materialProfiles.some(
          (profile) =>
            profile.id === metaobjectGid ||
            profile.colors.some((color) => color.id === metaobjectGid),
        );

        if (!isAffected) {
          continue;
        }

        const merged = mergeMaterialProfilesByOptionName(materialProfiles);
        if (merged.profiles.length === 0) {
          continue;
        }

        const result = await runMaterialProfileSync(
          admin,
          product.id,
          product,
          merged.profiles,
        );
        const summary =
          result.notices.length > 0
            ? result.notices.join(" | ").slice(0, 1000)
            : "Auto-Sync nach Metaobject-Update erfolgreich abgeschlossen.";

        await setProductAutoSyncRunStatus(admin, product.id, "success", summary);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unbekannter Fehler";
        try {
          await setProductAutoSyncRunStatus(admin, productId, "error", message);
        } catch (statusError) {
          console.error("Failed to persist metaobject auto-sync error status:", statusError);
        }
      }
    }

    return new Response();
  } catch (error) {
    console.error("Auto-sync via metaobjects/update webhook failed:", error);
    return new Response();
  }
};
