import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import {
  fetchProductDetails,
  mergeMaterialProfilesByOptionName,
  runMaterialProfileSync,
  setProductAutoSyncRunStatus,
} from "../routes/app._index";

type AdminContext = Awaited<ReturnType<typeof unauthenticated.admin>>["admin"];

const WORKER_ENABLED = process.env.AUTO_SYNC_WORKER_ENABLED !== "false";
const WORKER_INTERVAL_SECONDS = Number(
  process.env.AUTO_SYNC_WORKER_INTERVAL_SECONDS ??
    process.env.AUTO_SYNC_MIN_INTERVAL_SECONDS ??
    "60",
);
const WORKER_MAX_PRODUCTS_PER_SHOP = Number(
  process.env.AUTO_SYNC_WORKER_MAX_PRODUCTS_PER_SHOP ?? "50",
);
const AUTO_SYNC_MIN_INTERVAL_SECONDS = Number(
  process.env.AUTO_SYNC_MIN_INTERVAL_SECONDS ?? "60",
);
const AUTO_SYNC_RUNNING_LOCK_SECONDS = Number(
  process.env.AUTO_SYNC_RUNNING_LOCK_SECONDS ?? "120",
);
const PRODUCTS_PAGE_SIZE = 100;

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

declare global {
  // eslint-disable-next-line no-var
  var filamentSyncWorkerStarted: boolean | undefined;
  // eslint-disable-next-line no-var
  var filamentSyncWorkerRunning: boolean | undefined;
  // eslint-disable-next-line no-var
  var filamentSyncWorkerTimer: ReturnType<typeof setInterval> | undefined;
}

function toSafePositiveInt(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

async function fetchAutoSyncProductIds(admin: AdminContext): Promise<string[]> {
  const result: string[] = [];
  const limit = toSafePositiveInt(WORKER_MAX_PRODUCTS_PER_SHOP, 50);

  let after: string | null = null;
  let hasNextPage = true;

  while (hasNextPage && result.length < limit) {
    const response = await admin.graphql(PRODUCTS_WITH_AUTOSYNC_QUERY, {
      variables: {
        first: PRODUCTS_PAGE_SIZE,
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

      if (result.length >= limit) {
        break;
      }
    }

    const pageInfo = json.data?.products?.pageInfo;
    hasNextPage = Boolean(pageInfo?.hasNextPage);
    after = pageInfo?.endCursor ?? null;
  }

  return result;
}

function shouldSkipForCooldown(product: {
  autoSyncLastRunAt: string | null;
  autoSyncLastStatus: string | null;
}): boolean {
  const minInterval = toSafePositiveInt(AUTO_SYNC_MIN_INTERVAL_SECONDS, 60);
  const runningLock = toSafePositiveInt(AUTO_SYNC_RUNNING_LOCK_SECONDS, 120);

  if (!product.autoSyncLastRunAt) return false;

  const lastRunAt = new Date(product.autoSyncLastRunAt);
  if (Number.isNaN(lastRunAt.getTime())) return false;

  const elapsedSeconds = Math.floor((Date.now() - lastRunAt.getTime()) / 1000);

  if (product.autoSyncLastStatus === "running" && elapsedSeconds < runningLock) {
    return true;
  }

  return elapsedSeconds < minInterval;
}

async function runAutoSyncForProduct(admin: AdminContext, productGid: string): Promise<void> {
  const { product, materialProfiles } = await fetchProductDetails(admin, productGid);

  if (!product.autoSyncEnabled) {
    return;
  }

  if (shouldSkipForCooldown(product)) {
    return;
  }

  const merged = mergeMaterialProfilesByOptionName(materialProfiles);
  if (merged.profiles.length === 0) {
    return;
  }

  try {
    await setProductAutoSyncRunStatus(admin, product.id, "running", "Background Auto-Sync gestartet.");

    const result = await runMaterialProfileSync(
      admin,
      product.id,
      product,
      merged.profiles,
    );

    const summary =
      result.notices.length > 0
        ? result.notices.join(" | ").slice(0, 1000)
        : "Background Auto-Sync erfolgreich abgeschlossen.";

    await setProductAutoSyncRunStatus(admin, product.id, "success", summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unbekannter Fehler";
    await setProductAutoSyncRunStatus(admin, product.id, "error", message);
  }
}

async function runCycle(): Promise<void> {
  const offlineSessions = await prisma.session.findMany({
    where: { isOnline: false },
    select: { shop: true },
    distinct: ["shop"],
  });

  for (const { shop } of offlineSessions) {
    try {
      const { admin } = await unauthenticated.admin(shop);
      const productIds = await fetchAutoSyncProductIds(admin);

      for (const productId of productIds) {
        await runAutoSyncForProduct(admin, productId);
      }
    } catch (error) {
      console.error(`Background auto-sync failed for shop ${shop}:`, error);
    }
  }
}

export function startAutoSyncWorker(): void {
  if (!WORKER_ENABLED) {
    console.log("Background auto-sync worker is disabled.");
    return;
  }

  const intervalSeconds = toSafePositiveInt(WORKER_INTERVAL_SECONDS, 60);

  if (global.filamentSyncWorkerStarted) {
    return;
  }

  global.filamentSyncWorkerStarted = true;
  global.filamentSyncWorkerRunning = false;

  const runGuardedCycle = async () => {
    if (global.filamentSyncWorkerRunning) {
      return;
    }

    global.filamentSyncWorkerRunning = true;

    try {
      await runCycle();
    } catch (error) {
      console.error("Background auto-sync worker cycle failed:", error);
    } finally {
      global.filamentSyncWorkerRunning = false;
    }
  };

  // Trigger a first cycle shortly after startup.
  setTimeout(() => {
    void runGuardedCycle();
  }, 10_000);

  global.filamentSyncWorkerTimer = setInterval(() => {
    void runGuardedCycle();
  }, intervalSeconds * 1000);

  if (typeof global.filamentSyncWorkerTimer.unref === "function") {
    global.filamentSyncWorkerTimer.unref();
  }

  console.log(`Background auto-sync worker started (every ${intervalSeconds}s).`);
}
