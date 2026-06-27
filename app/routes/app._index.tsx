import { useMemo, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

const MATERIAL_PROFILE_NAMESPACE = "custom";
const MATERIAL_PROFILE_KEY = "materialprofil";
const DEFAULT_COLOR_OPTION_NAME = "Farbe";
const ENABLE_LINKED_SWATCH_OPTIONS = false;
const INCLUDE_HEX_IN_NON_SWATCH_OPTION_VALUES = false;
const TARGET_VARIANT_STOCK = 10;
const SHOPIFY_COLOR_PATTERN_NAMESPACE = "shopify";
const SHOPIFY_COLOR_PATTERN_KEY = "color-pattern";
const SHOPIFY_COLOR_PATTERN_TYPE = "shopify--color-pattern";

type PickerProduct = {
  id: string;
  title: string;
};

type LoaderData = {
  products: PickerProduct[];
};

type MetaobjectFieldNode = {
  key: string;
  value: string | null;
  jsonValue: unknown;
  reference: {
    __typename: string;
    id: string;
    displayName: string | null;
    type: string;
    fields: Array<{
      key: string;
      value: string | null;
      jsonValue: unknown;
    }>;
  } | null;
  references: {
    nodes: Array<{
      __typename: string;
      id: string;
      displayName: string | null;
      type: string;
      fields: Array<{
        key: string;
        value: string | null;
        jsonValue: unknown;
      }>;
    }>;
  } | null;
};

type ProductQueryData = {
  product: {
    id: string;
    title: string;
    options: Array<{
      id: string;
      name: string;
      linkedMetafield: {
        namespace: string;
        key: string;
      } | null;
      optionValues: Array<{
        id: string;
        name: string;
        linkedMetafieldValue: string | null;
      }>;
    }>;
    variants: {
      nodes: Array<{
        id: string;
        title: string;
        selectedOptions: Array<{
          name: string;
          value: string;
        }>;
      }>;
    };
    materialProfileMetafields: {
      nodes: Array<{
        id: string;
        key: string;
        namespace: string;
        value: string | null;
        type: string;
        reference: {
          __typename: string;
          id: string;
          displayName: string | null;
          type: string;
          fields: MetaobjectFieldNode[];
          farbenField: MetaobjectFieldNode | null;
        } | null;
      }>;
    };
  } | null;
};

type ProductSummary = {
  id: string;
  title: string;
  options: Array<{
    id: string;
    name: string;
    linkedMetafield: {
      namespace: string;
      key: string;
    } | null;
    optionValues: Array<{
      id: string;
      name: string;
      linkedMetafieldValue: string | null;
    }>;
    values: string[];
  }>;
  variants: Array<{
    id: string;
    title: string;
    selectedOptions: Array<{ name: string; value: string }>;
  }>;
};

type ColorSummary = {
  id: string;
  name: string;
  colorValue: string | null;
};

type MaterialProfileSummary = {
  metafieldKey: string;
  id: string;
  type: string;
  displayName: string | null;
  metafieldValue: string | null;
  colors: ColorSummary[];
};

type SyncPreview = {
  optionName: string;
  existingValues: string[];
  desiredValues: string[];
  missingValues: string[];
  variantsToCreate: Array<{ optionValue: string }>;
};

type ActionMode = "load" | "preview" | "sync";

type ActionData = {
  ok: boolean;
  mode: ActionMode;
  productGid: string;
  product: ProductSummary | null;
  materialProfiles: MaterialProfileSummary[];
  previews: SyncPreview[] | null;
  errors: string[];
  notices: string[];
};

type ProductVariantInput = {
  optionValues: Array<{
    optionName: string;
    id?: string;
    name?: string;
    linkedMetafieldValue?: string;
  }>;
};

const PRODUCTS_FOR_PICKER_QUERY = `#graphql
  query ProductsForPicker {
    products(first: 250, sortKey: TITLE) {
      nodes {
        id
        title
      }
    }
  }
`;

const PRODUCT_WITH_MATERIAL_PROFILE_QUERY = `#graphql
  query ProductWithMaterialProfile($productId: ID!) {
    product(id: $productId) {
      id
      title
      options {
        id
        name
        linkedMetafield {
          namespace
          key
        }
        optionValues {
          id
          name
          linkedMetafieldValue
        }
      }
      variants(first: 250) {
        nodes {
          id
          title
          selectedOptions {
            name
            value
          }
        }
      }
      materialProfileMetafields: metafields(namespace: "custom", first: 100) {
        nodes {
          id
          namespace
          key
          value
          type
          reference {
            __typename
            ... on Metaobject {
              id
              displayName
              type
              fields {
                key
                value
                jsonValue
                reference {
                  __typename
                  ... on Metaobject {
                    id
                    displayName
                    type
                    fields {
                      key
                      value
                      jsonValue
                    }
                  }
                }
                references(first: 250) {
                  nodes {
                    __typename
                    ... on Metaobject {
                      id
                      displayName
                      type
                      fields {
                        key
                        value
                        jsonValue
                      }
                    }
                  }
                }
              }
              farbenField: field(key: "farben") {
                key
                value
                jsonValue
                references(first: 250) {
                  nodes {
                    __typename
                    ... on Metaobject {
                      id
                      displayName
                      type
                      fields {
                        key
                        value
                        jsonValue
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const PRODUCT_OPTIONS_CREATE_MUTATION = `#graphql
  mutation ProductOptionsCreate(
    $productId: ID!
    $options: [OptionCreateInput!]!
    $variantStrategy: ProductOptionCreateVariantStrategy
  ) {
    productOptionsCreate(
      productId: $productId
      options: $options
      variantStrategy: $variantStrategy
    ) {
      userErrors {
        field
        message
      }
    }
  }
`;

const PRODUCT_VARIANTS_BULK_CREATE_MUTATION = `#graphql
  mutation ProductVariantsBulkCreate(
    $productId: ID!
    $variants: [ProductVariantsBulkInput!]!
  ) {
    productVariantsBulkCreate(productId: $productId, variants: $variants) {
      productVariants {
        id
        title
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const PRODUCT_VARIANT_INVENTORY_QUERY = `#graphql
  query ProductVariantInventory($productId: ID!) {
    product(id: $productId) {
      id
      variants(first: 250) {
        nodes {
          id
          inventoryItem {
            id
          }
        }
      }
    }
    locations(first: 1) {
      nodes {
        id
      }
    }
  }
`;

const INVENTORY_SET_QUANTITIES_MUTATION = `#graphql
  mutation InventorySetQuantities(
    $input: InventorySetQuantitiesInput!
    $idempotencyKey: String!
  ) {
    inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
      userErrors {
        field
        message
      }
    }
  }
`;

const PRODUCT_OPTION_UPDATE_MUTATION = `#graphql
  mutation ProductOptionUpdate(
    $productId: ID!
    $option: OptionUpdateInput!
    $optionValuesToAdd: [OptionValueCreateInput!]
  ) {
    productOptionUpdate(
      productId: $productId
      option: $option
      optionValuesToAdd: $optionValuesToAdd
      variantStrategy: LEAVE_AS_IS
    ) {
      userErrors {
        field
        message
      }
    }
  }
`;

function getFieldValue(
  fields: Array<{ key: string; value: string | null; jsonValue: unknown }>,
  keys: string[],
): string | null {
  const keySet = new Set(keys.map((key) => key.toLowerCase()));
  const match = fields.find((field) => keySet.has(field.key.toLowerCase()));
  if (!match) return null;

  if (typeof match.jsonValue === "string") {
    return match.jsonValue;
  }

  if (
    match.jsonValue &&
    typeof match.jsonValue === "object" &&
    !Array.isArray(match.jsonValue)
  ) {
    const objectValue = match.jsonValue as Record<string, unknown>;
    for (const candidate of ["color", "hex", "value"]) {
      const value = objectValue[candidate];
      if (typeof value === "string" && value.trim()) return value;
    }
  }

  if (typeof match.value === "string" && match.value.trim()) {
    return match.value;
  }

  return null;
}

function toProductSummary(
  product: NonNullable<ProductQueryData["product"]>,
): ProductSummary {
  return {
    id: product.id,
    title: product.title,
    options: product.options.map((option) => ({
      id: option.id,
      name: option.name,
      linkedMetafield: option.linkedMetafield,
      optionValues: option.optionValues,
      values: option.optionValues.map((value) => value.name),
    })),
    variants: product.variants.nodes.map((variant) => ({
      id: variant.id,
      title: variant.title,
      selectedOptions: variant.selectedOptions,
    })),
  };
}

function isMaterialProfileMetafieldKey(key: string): boolean {
  return /^materialprofil(e)?([_-].+)?$/i.test(key.trim());
}

function stripMaterialProfilePrefix(key: string): string {
  return key.trim().replace(/^materialprofil(e)?[_-]*/i, "").trim();
}

function toMaterialProfileSummary(metafield: {
  key: string;
  value: string | null;
  reference: {
    __typename: string;
    id: string;
    displayName: string | null;
    type: string;
    fields: MetaobjectFieldNode[];
    farbenField: MetaobjectFieldNode | null;
  } | null;
}): MaterialProfileSummary | null {
  if (!metafield.reference || metafield.reference.__typename !== "Metaobject") {
    return null;
  }

  const colorNodes =
    metafield.reference.farbenField?.references?.nodes
      ?.filter((node) => node.__typename === "Metaobject")
      .map((node) => ({
        id: node.id,
        name:
          getFieldValue(node.fields, ["farbname", "name", "title"]) ??
          node.displayName ??
          "Unbenannte Farbe",
        colorValue: getFieldValue(node.fields, [
          "farbe",
          "farbwert",
          "color",
          "colour",
        ]),
      })) ?? [];

  return {
    metafieldKey: metafield.key,
    id: metafield.reference.id,
    type: metafield.reference.type,
    displayName: metafield.reference.displayName,
    metafieldValue: metafield.value,
    colors: colorNodes,
  };
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeHexColor(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;

  if (/^#[0-9a-f]{3}$/i.test(normalized)) {
    const [r, g, b] = normalized.slice(1).split("");
    return `#${r}${r}${g}${g}${b}${b}`;
  }

  if (/^#[0-9a-f]{6}$/i.test(normalized)) {
    return normalized;
  }

  return null;
}

function toTitleWords(value: string): string {
  return value
    .split(/[\s_-]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getColorOptionName(materialProfileKey: string): string {
  const suffix = stripMaterialProfilePrefix(materialProfileKey);

  return suffix
    ? `${DEFAULT_COLOR_OPTION_NAME} ${toTitleWords(suffix)}`
    : DEFAULT_COLOR_OPTION_NAME;
}

function getColorValueLabel(color: ColorSummary, includeHex: boolean): string {
  const name = color.name.trim();
  const hex = normalizeHexColor(color.colorValue);
  if (!includeHex || !hex) {
    return name;
  }

  return `${name} (${hex})`;
}

function getMaterialProfileOptionValues(
  materialProfile: MaterialProfileSummary | null,
  includeHex: boolean,
): string[] {
  return Array.from(
    new Set(
      (materialProfile?.colors ?? [])
        .map((color) => getColorValueLabel(color, includeHex))
        .filter(Boolean),
    ),
  );
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function fetchShopifyColorPatternMap(
  admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"],
): Promise<Map<string, string>> {
  const response = await admin.graphql(
    `#graphql
      query ShopifyColorPatterns($type: String!) {
        metaobjects(type: $type, first: 250) {
          nodes {
            id
            displayName
            fields {
              key
              value
              jsonValue
            }
          }
        }
      }
    `,
    {
      variables: {
        type: SHOPIFY_COLOR_PATTERN_TYPE,
      },
    },
  );

  const responseJson = (await response.json()) as {
    data?: {
      metaobjects?: {
        nodes?: Array<{
          id: string;
          displayName: string | null;
          fields: Array<{ key: string; value: string | null; jsonValue: unknown }>;
        }>;
      };
    };
    errors?: Array<{ message: string }>;
  };

  if (responseJson.errors?.length) {
    throw new Error(responseJson.errors.map((error) => error.message).join(" | "));
  }

  const byKey = new Map<string, string>();
  const nodes = responseJson.data?.metaobjects?.nodes ?? [];
  for (const node of nodes) {
    const displayName = node.displayName ? normalize(node.displayName) : null;
    if (displayName) {
      byKey.set(`name:${displayName}`, node.id);
    }

    const colorValue = getFieldValue(node.fields, ["color", "farbe", "hex", "value"]);
    const normalizedHex = normalizeHexColor(colorValue);
    if (normalizedHex) {
      byKey.set(`hex:${normalizedHex}`, node.id);
    }
  }

  return byKey;
}

async function createMissingShopifyColorPatterns(
  admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"],
  materialProfile: MaterialProfileSummary,
  existingMap: Map<string, string>,
): Promise<number> {
  const definitionResponse = await admin.graphql(
    `#graphql
      query ColorPatternDefinition($type: String!) {
        metaobjectDefinitionByType(type: $type) {
          displayNameKey
          fieldDefinitions {
            key
            required
            type {
              name
            }
          }
        }
      }
    `,
    {
      variables: { type: SHOPIFY_COLOR_PATTERN_TYPE },
    },
  );

  const definitionJson = (await definitionResponse.json()) as {
    data?: {
      metaobjectDefinitionByType?: {
        displayNameKey: string | null;
        fieldDefinitions: Array<{
          key: string;
          required: boolean;
          type: { name: string };
        }>;
      } | null;
    };
    errors?: Array<{ message: string }>;
  };

  if (definitionJson.errors?.length) {
    throw new Error(definitionJson.errors.map((error) => error.message).join(" | "));
  }

  const definition = definitionJson.data?.metaobjectDefinitionByType;
  if (!definition) {
    return 0;
  }

  const colorField = definition.fieldDefinitions.find(
    (field) => field.type.name === "color",
  );
  if (!colorField) {
    return 0;
  }

  let created = 0;

  for (const color of materialProfile.colors) {
    const normalizedName = normalize(color.name);
    const normalizedHex = normalizeHexColor(color.colorValue);

    const existsByName = existingMap.has(`name:${normalizedName}`);
    const existsByHex = normalizedHex ? existingMap.has(`hex:${normalizedHex}`) : false;
    if (existsByName || existsByHex || !normalizedHex) {
      continue;
    }

    const fields: Array<{ key: string; value: string }> = [
      { key: colorField.key, value: normalizedHex },
    ];

    const displayNameKey = definition.displayNameKey;
    if (displayNameKey && displayNameKey !== colorField.key) {
      fields.push({ key: displayNameKey, value: color.name });
    } else {
      const labelField = definition.fieldDefinitions.find(
        (field) =>
          field.key !== colorField.key &&
          (field.key.includes("label") || field.key.includes("name")) &&
          field.type.name === "single_line_text_field",
      );
      if (labelField) {
        fields.push({ key: labelField.key, value: color.name });
      }
    }

    const createResponse = await admin.graphql(
      `#graphql
        mutation CreateColorPattern($metaobject: MetaobjectCreateInput!) {
          metaobjectCreate(metaobject: $metaobject) {
            metaobject {
              id
            }
            userErrors {
              message
            }
          }
        }
      `,
      {
        variables: {
          metaobject: {
            type: SHOPIFY_COLOR_PATTERN_TYPE,
            handle: `${slugify(color.name)}-${normalizedHex.replace("#", "")}`,
            fields,
          },
        },
      },
    );

    const createJson = (await createResponse.json()) as {
      data?: {
        metaobjectCreate?: {
          metaobject?: { id: string } | null;
          userErrors?: Array<{ message: string }>;
        };
      };
      errors?: Array<{ message: string }>;
    };

    if (createJson.errors?.length) {
      continue;
    }

    const userErrors = createJson.data?.metaobjectCreate?.userErrors ?? [];
    if (userErrors.length > 0) {
      continue;
    }

    if (createJson.data?.metaobjectCreate?.metaobject?.id) {
      created += 1;
      existingMap.set(`hex:${normalizedHex}`, createJson.data.metaobjectCreate.metaobject.id);
      existingMap.set(`name:${normalizedName}`, createJson.data.metaobjectCreate.metaobject.id);
    }
  }

  return created;
}

function buildLinkedColorIdByName(
  materialProfile: MaterialProfileSummary,
  colorPatternMap: Map<string, string>,
): Map<string, string> {
  const linkedByName = new Map<string, string>();

  for (const color of materialProfile.colors) {
    const byHex = normalizeHexColor(color.colorValue);
    if (byHex) {
      const idByHex = colorPatternMap.get(`hex:${byHex}`);
      if (idByHex) {
        linkedByName.set(normalize(color.name), idByHex);
        continue;
      }
    }

    const idByName = colorPatternMap.get(`name:${normalize(color.name)}`);
    if (idByName) {
      linkedByName.set(normalize(color.name), idByName);
    }
  }

  return linkedByName;
}

function buildPreview(
  product: ProductSummary,
  materialProfile: MaterialProfileSummary | null,
  colorOptionName: string,
  includeHex: boolean,
): SyncPreview {
  const desiredValues = getMaterialProfileOptionValues(materialProfile, includeHex);

  const existingValues = Array.from(
    new Set(
      product.variants
        .flatMap((variant) => variant.selectedOptions)
        .filter((option) => option.name === colorOptionName)
        .map((option) => option.value.trim())
        .filter(Boolean),
    ),
  );

  const existingNormalized = new Set(existingValues.map(normalize));
  const missingValues = desiredValues.filter(
    (value) => !existingNormalized.has(normalize(value)),
  );

  return {
    optionName: colorOptionName,
    existingValues,
    desiredValues,
    missingValues,
    variantsToCreate: missingValues.map((optionValue) => ({ optionValue })),
  };
}

function buildVariantInputs(
  product: ProductSummary,
  linkedColorIdByName: Map<string, string>,
  desiredValues: string[],
  colorOptionName: string,
  useLinkedOptionValues: boolean,
): ProductVariantInput[] {
  const existingVariantKeys = new Set(
    product.variants.map((variant) =>
      variant.selectedOptions
        .map((selectedOption) =>
          `${normalize(selectedOption.name)}=${normalize(selectedOption.value)}`,
        )
        .sort()
        .join("|"),
    ),
  );

  const plannedVariantKeys = new Set<string>();

  const baseVariantMaps =
    product.variants.length > 0
      ? product.variants.map(
          (variant) =>
            new Map(variant.selectedOptions.map((selectedOption) => [selectedOption.name, selectedOption.value])),
        )
      : [new Map<string, string>()];

  const results: ProductVariantInput[] = [];

  for (const baseVariant of baseVariantMaps) {
    for (const targetValue of desiredValues) {
      const optionValues = product.options.map((option) => {
        if (option.name === colorOptionName) {
          const linkedMetafieldValue = linkedColorIdByName.get(normalize(targetValue));
          if (useLinkedOptionValues) {
            if (!linkedMetafieldValue) {
              throw new Error(
                `Kein linkedMetafieldValue fuer ${colorOptionName} / ${targetValue} gefunden.`,
              );
            }

            const linkedOptionValue = option.optionValues.find(
              (value) => value.linkedMetafieldValue === linkedMetafieldValue,
            );
            if (!linkedOptionValue) {
              throw new Error(
                `Linked Option-Value fuer ${colorOptionName} / ${targetValue} wurde nicht gefunden.`,
              );
            }

            return {
              optionName: option.name,
              id: linkedOptionValue.id,
              linkedMetafieldValue,
            };
          }

          return {
            optionName: option.name,
            name: targetValue,
          };
        }

        const fallbackValue = baseVariant.get(option.name) ?? option.values[0];
        if (!fallbackValue) {
          throw new Error(
            `Kein Fallback-Optionswert fuer Option ${option.name} vorhanden.`,
          );
        }

        return {
          optionName: option.name,
          name: fallbackValue,
        };
      });

      const hasCurrentOption = optionValues.some(
        (option) => option.optionName === colorOptionName,
      );

      if (!hasCurrentOption) {
        const linkedMetafieldValue = linkedColorIdByName.get(normalize(targetValue));
        if (useLinkedOptionValues) {
          if (!linkedMetafieldValue) {
            throw new Error(
              `Kein linkedMetafieldValue fuer ${colorOptionName} / ${targetValue} gefunden.`,
            );
          }

          const targetOption = product.options.find(
            (option) => option.name === colorOptionName,
          );
          const linkedOptionValue = targetOption?.optionValues.find(
            (value) => value.linkedMetafieldValue === linkedMetafieldValue,
          );
          if (!linkedOptionValue) {
            throw new Error(
              `Linked Option-Value fuer ${colorOptionName} / ${targetValue} wurde nicht gefunden.`,
            );
          }

          optionValues.push({
            optionName: colorOptionName,
            id: linkedOptionValue.id,
            linkedMetafieldValue,
          });
        } else {
          optionValues.push({
            optionName: colorOptionName,
            name: targetValue,
          });
        }
      }

      const variantKey = optionValues
        .map((option) => {
          const value = option.optionName === colorOptionName ? targetValue : option.name ?? "";
          return `${normalize(option.optionName)}=${normalize(value)}`;
        })
        .sort()
        .join("|");

      if (existingVariantKeys.has(variantKey) || plannedVariantKeys.has(variantKey)) {
        continue;
      }

      plannedVariantKeys.add(variantKey);
      results.push({ optionValues });
    }
  }

  return results;
}

async function fetchProductDetails(
  admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"],
  productGid: string,
): Promise<{ product: ProductSummary; materialProfiles: MaterialProfileSummary[] }> {
  const response = await admin.graphql(PRODUCT_WITH_MATERIAL_PROFILE_QUERY, {
    variables: { productId: productGid },
  });
  const responseJson = (await response.json()) as {
    data?: ProductQueryData;
    errors?: Array<{ message: string }>;
  };

  if (responseJson.errors?.length) {
    throw new Error(responseJson.errors.map((error) => error.message).join(" | "));
  }

  const productNode = responseJson.data?.product;
  if (!productNode) {
    throw new Error("Produkt nicht gefunden oder kein Zugriff.");
  }

  const product = toProductSummary(productNode);
  const materialProfiles = (productNode.materialProfileMetafields?.nodes ?? [])
    .filter((metafield) => isMaterialProfileMetafieldKey(metafield.key))
    .map((metafield) => toMaterialProfileSummary(metafield))
    .filter((profile): profile is MaterialProfileSummary => Boolean(profile));

  return { product, materialProfiles };
}

async function ensureShellColorOptionExists(
  admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"],
  productId: string,
  optionName: string,
  desiredValues: string[],
  desiredColorMetaobjectIds: string[],
): Promise<void> {
  const optionInput =
    desiredColorMetaobjectIds.length > 0
      ? {
          name: optionName,
          linkedMetafield: {
            namespace: SHOPIFY_COLOR_PATTERN_NAMESPACE,
            key: SHOPIFY_COLOR_PATTERN_KEY,
            values: desiredColorMetaobjectIds,
          },
        }
      : {
          name: optionName,
          values: desiredValues.map((name) => ({ name })),
        };

  const response = await admin.graphql(PRODUCT_OPTIONS_CREATE_MUTATION, {
    variables: {
      productId,
      options: [optionInput],
      variantStrategy: "LEAVE_AS_IS",
    },
  });

  const responseJson = (await response.json()) as {
    data?: {
      productOptionsCreate?: {
        userErrors?: Array<{ message: string }>;
      };
    };
    errors?: Array<{ message: string }>;
  };

  if (responseJson.errors?.length) {
    throw new Error(responseJson.errors.map((error) => error.message).join(" | "));
  }

  const userErrors = responseJson.data?.productOptionsCreate?.userErrors ?? [];
  const relevantErrors = userErrors.filter(
    (error) => !error.message.toLowerCase().includes("already exists"),
  );
  if (relevantErrors.length > 0) {
    throw new Error(relevantErrors.map((error) => error.message).join(" | "));
  }
}

async function ensureShellColorOptionLinkedAndValues(
  admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"],
  product: ProductSummary,
  optionName: string,
  linkedColorIds: string[],
): Promise<void> {
  const shellOption = product.options.find(
    (option) => option.name === optionName,
  );
  if (!shellOption) {
    return;
  }

  if (linkedColorIds.length === 0) {
    return;
  }

  const response = await admin.graphql(PRODUCT_OPTION_UPDATE_MUTATION, {
    variables: {
      productId: product.id,
      option: {
        id: shellOption.id,
        linkedMetafield: {
          namespace: SHOPIFY_COLOR_PATTERN_NAMESPACE,
          key: SHOPIFY_COLOR_PATTERN_KEY,
        },
      },
      optionValuesToAdd: linkedColorIds.map((linkedMetafieldValue) => ({
        linkedMetafieldValue,
      })),
    },
  });

  const responseJson = (await response.json()) as {
    data?: {
      productOptionUpdate?: {
        userErrors?: Array<{ message: string }>;
      };
    };
    errors?: Array<{ message: string }>;
  };

  if (responseJson.errors?.length) {
    throw new Error(responseJson.errors.map((error) => error.message).join(" | "));
  }

  const userErrors = responseJson.data?.productOptionUpdate?.userErrors ?? [];
  const relevantErrors = userErrors.filter(
    (error) => !error.message.toLowerCase().includes("already exists"),
  );
  if (relevantErrors.length > 0) {
    throw new Error(relevantErrors.map((error) => error.message).join(" | "));
  }
}

async function createMissingVariants(
  admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"],
  productId: string,
  variants: ProductVariantInput[],
): Promise<number> {
  const response = await admin.graphql(PRODUCT_VARIANTS_BULK_CREATE_MUTATION, {
    variables: {
      productId,
      variants,
    },
  });

  const responseJson = (await response.json()) as {
    data?: {
      productVariantsBulkCreate?: {
        productVariants?: Array<{ id: string }>;
        userErrors?: Array<{ message: string }>;
      };
    };
    errors?: Array<{ message: string }>;
  };

  if (responseJson.errors?.length) {
    throw new Error(responseJson.errors.map((error) => error.message).join(" | "));
  }

  const userErrors = responseJson.data?.productVariantsBulkCreate?.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new Error(userErrors.map((error) => error.message).join(" | "));
  }

  return responseJson.data?.productVariantsBulkCreate?.productVariants?.length ?? 0;
}

async function restockProductVariants(
  admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"],
  productId: string,
  quantity: number,
): Promise<{ count: number }> {
  const inventoryResponse = await admin.graphql(PRODUCT_VARIANT_INVENTORY_QUERY, {
    variables: {
      productId,
    },
  });

  const inventoryJson = (await inventoryResponse.json()) as {
    data?: {
      product?: {
        variants?: {
          nodes?: Array<{
            id: string;
            inventoryItem?: { id: string } | null;
          }>;
        };
      } | null;
      locations?: {
        nodes?: Array<{
          id: string;
        }>;
      };
    };
    errors?: Array<{ message: string }>;
  };

  if (inventoryJson.errors?.length) {
    throw new Error(inventoryJson.errors.map((error) => error.message).join(" | "));
  }

  const location = inventoryJson.data?.locations?.nodes?.[0];
  if (!location) {
    throw new Error("Kein aktiver Lagerstandort gefunden. Inventar konnte nicht gesetzt werden.");
  }

  const inventoryItemIds = (inventoryJson.data?.product?.variants?.nodes ?? [])
    .map((variant) => variant.inventoryItem?.id)
    .filter((id): id is string => Boolean(id));

  if (inventoryItemIds.length === 0) {
    return { count: 0 };
  }

  const setResponse = await admin.graphql(INVENTORY_SET_QUANTITIES_MUTATION, {
    variables: {
      input: {
        ignoreCompareQuantity: true,
        name: "available",
        reason: "correction",
        referenceDocumentUri: `filamentsync://restock/${encodeURIComponent(productId)}`,
        quantities: inventoryItemIds.map((inventoryItemId) => ({
          inventoryItemId,
          locationId: location.id,
          quantity,
          compareQuantity: null,
        })),
      },
      idempotencyKey: `${productId}-${quantity}-${Date.now()}`,
    },
  });

  const setJson = (await setResponse.json()) as {
    data?: {
      inventorySetQuantities?: {
        userErrors?: Array<{ message: string }>;
      };
    };
    errors?: Array<{ message: string }>;
  };

  if (setJson.errors?.length) {
    throw new Error(setJson.errors.map((error) => error.message).join(" | "));
  }

  const userErrors = setJson.data?.inventorySetQuantities?.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new Error(userErrors.map((error) => error.message).join(" | "));
  }

  return { count: inventoryItemIds.length };
}

export const loader = async ({ request }: LoaderFunctionArgs): Promise<LoaderData> => {
  const { admin } = await authenticate.admin(request);
  const response = await admin.graphql(PRODUCTS_FOR_PICKER_QUERY);
  const responseJson = (await response.json()) as {
    data?: { products?: { nodes?: Array<{ id: string; title: string | null }> } };
    errors?: Array<{ message: string }>;
  };

  if (responseJson.errors?.length) {
    throw new Error(responseJson.errors.map((error) => error.message).join(" | "));
  }

  const products = (responseJson.data?.products?.nodes ?? []).map((product) => ({
    id: product.id,
    title: product.title || "(ohne Titel)",
  }));

  return { products };
};

export const action = async ({ request }: ActionFunctionArgs): Promise<ActionData> => {
  const { admin } = await authenticate.admin(request);

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return {
      ok: true,
      mode: "load",
      productGid: "",
      product: null,
      materialProfiles: [],
      previews: null,
      errors: [],
      notices: [],
    };
  }

  const hasIntent = formData.has("intent");
  const hasProductGid = formData.has("productGid");
  if (!hasIntent && !hasProductGid) {
    return {
      ok: true,
      mode: "load",
      productGid: "",
      product: null,
      materialProfiles: [],
      previews: null,
      errors: [],
      notices: [],
    };
  }

  const intent = String(formData.get("intent") ?? "load");
  const mode: ActionMode =
    intent === "sync" ? "sync" : intent === "preview" ? "preview" : "load";
  const productGid = String(formData.get("productGid") ?? "").trim();
  const errors: string[] = [];
  const notices: string[] = [];

  if (!productGid) {
    errors.push("Bitte ein Produkt auswaehlen.");
  } else if (!productGid.startsWith("gid://shopify/Product/")) {
    errors.push(
      "Ungueltige Product GID. Erwartet wird z. B. gid://shopify/Product/123456789.",
    );
  }

  if (errors.length > 0) {
    return {
      ok: false,
      mode,
      productGid,
      product: null,
      materialProfiles: [],
      previews: null,
      errors,
      notices,
    };
  }

  try {
    let { product, materialProfiles } = await fetchProductDetails(admin, productGid);
    let previews = materialProfiles.map((materialProfile) =>
      buildPreview(
        product,
        materialProfile,
        getColorOptionName(materialProfile.metafieldKey),
        INCLUDE_HEX_IN_NON_SWATCH_OPTION_VALUES,
      ),
    );

    if (materialProfiles.length === 0) {
      errors.push(
        `Keine gueltigen Materialprofil-Metafelder unter ${MATERIAL_PROFILE_NAMESPACE}.materialprofil* gefunden.`,
      );
    }

    if (mode === "sync" && errors.length === 0) {
      const colorPatternMap = new Map<string, string>();

      if (ENABLE_LINKED_SWATCH_OPTIONS) {
        let loadedMap = await fetchShopifyColorPatternMap(admin);

        let createdColorPatterns = 0;
        for (const materialProfile of materialProfiles) {
          createdColorPatterns += await createMissingShopifyColorPatterns(
            admin,
            materialProfile,
            loadedMap,
          );
        }

        if (createdColorPatterns > 0) {
          notices.push(
            `${createdColorPatterns} shopify.color-pattern Eintrag(e) wurden automatisch erzeugt.`,
          );
          loadedMap = await fetchShopifyColorPatternMap(admin);
        }

        for (const [key, value] of loadedMap.entries()) {
          colorPatternMap.set(key, value);
        }
      } else {
        notices.push(
          "Text-Modus aktiv: Variantenoptionen werden ohne shopify.color-pattern Verknuepfung erzeugt.",
        );
      }

      for (const initialProfile of materialProfiles) {
        let activeProfile = materialProfiles.find(
          (profile) => profile.metafieldKey === initialProfile.metafieldKey,
        );
        if (!activeProfile) {
          continue;
        }

        const colorOptionName = getColorOptionName(activeProfile.metafieldKey);
        const linkedColorIdByName = ENABLE_LINKED_SWATCH_OPTIONS
          ? buildLinkedColorIdByName(activeProfile, colorPatternMap)
          : new Map<string, string>();
        const desiredColorMetaobjectIds = ENABLE_LINKED_SWATCH_OPTIONS
          ? Array.from(new Set(Array.from(linkedColorIdByName.values())))
          : [];
        const isSwatchProfile =
          ENABLE_LINKED_SWATCH_OPTIONS && desiredColorMetaobjectIds.length > 0;
        const includeHexInOptionValues =
          !isSwatchProfile && INCLUDE_HEX_IN_NON_SWATCH_OPTION_VALUES;

        const hasShellOption = product.options.some(
          (option) => option.name === colorOptionName,
        );

        if (!hasShellOption) {
          const profilePreview = buildPreview(
            product,
            activeProfile,
            colorOptionName,
            includeHexInOptionValues,
          );
          await ensureShellColorOptionExists(
            admin,
            product.id,
            colorOptionName,
            profilePreview.desiredValues,
            desiredColorMetaobjectIds,
          );
          if (isSwatchProfile && desiredColorMetaobjectIds.length > 0) {
            notices.push(
              `Option ${colorOptionName} wurde als Farb-Swatch-Option angelegt.`,
            );
          } else {
            notices.push(
              `Option ${colorOptionName} wurde als Text-Option angelegt${includeHexInOptionValues ? " (mit Hex-Werten)" : ""}.`,
            );
          }
          const refreshed = await fetchProductDetails(admin, productGid);
          product = refreshed.product;
          materialProfiles = refreshed.materialProfiles;
          activeProfile = materialProfiles.find(
            (profile) => profile.metafieldKey === initialProfile.metafieldKey,
          );
          if (!activeProfile) {
            continue;
          }
        }

        if (isSwatchProfile) {
          await ensureShellColorOptionLinkedAndValues(
            admin,
            product,
            colorOptionName,
            desiredColorMetaobjectIds,
          );
          if (desiredColorMetaobjectIds.length > 0) {
            notices.push(`Option ${colorOptionName} wurde mit shopify.color-pattern verknuepft.`);
          } else {
            notices.push(
              `Keine passende Shopify Color-Pattern-Zuordnung fuer ${colorOptionName} gefunden, Varianten werden ohne Swatch-Link erzeugt.`,
            );
          }
        }

        let profilePreview = buildPreview(
          product,
          activeProfile,
          colorOptionName,
          includeHexInOptionValues,
        );
        const variantInputs = buildVariantInputs(
          product,
          linkedColorIdByName,
          profilePreview.desiredValues,
          colorOptionName,
          isSwatchProfile,
        );

        if (variantInputs.length > 0) {
          const createdCount = await createMissingVariants(admin, product.id, variantInputs);
          notices.push(
            `${createdCount} Variante(n) wurden fuer ${colorOptionName} erzeugt.`,
          );

          const refreshed = await fetchProductDetails(admin, productGid);
          product = refreshed.product;
          materialProfiles = refreshed.materialProfiles;
          activeProfile = materialProfiles.find(
            (profile) => profile.metafieldKey === initialProfile.metafieldKey,
          );
          if (!activeProfile) {
            continue;
          }
          profilePreview = buildPreview(
            product,
            activeProfile,
            colorOptionName,
            includeHexInOptionValues,
          );
        }

        if (variantInputs.length === 0) {
          notices.push(`Keine neuen Varianten fuer ${colorOptionName} noetig.`);
        }
      }

      const restocked = await restockProductVariants(
        admin,
        product.id,
        TARGET_VARIANT_STOCK,
      );
      notices.push(
        `${restocked.count} Variante(n) wurden auf ${TARGET_VARIANT_STOCK} Stueck gesetzt.`,
      );

      previews = materialProfiles.map((materialProfile) =>
        buildPreview(
          product,
          materialProfile,
          getColorOptionName(materialProfile.metafieldKey),
          INCLUDE_HEX_IN_NON_SWATCH_OPTION_VALUES,
        ),
      );
    }

    return {
      ok: errors.length === 0,
      mode,
      productGid,
      product,
      materialProfiles,
      previews: mode === "load" ? null : previews,
      errors,
      notices,
    };
  } catch (error) {
    return {
      ok: false,
      mode,
      productGid,
      product: null,
      materialProfiles: [],
      previews: null,
      errors: [error instanceof Error ? error.message : "Unbekannter Fehler"],
      notices,
    };
  }
};

export default function Index() {
  const { products } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [productGid, setProductGid] = useState(products[0]?.id ?? "");

  const isLoading =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";

  const submit = (intent: ActionMode) => {
    fetcher.submit(
      { intent, productGid },
      {
        method: "POST",
        encType: "application/x-www-form-urlencoded",
      },
    );
  };

  const data = fetcher.data;
  const previews = data?.previews ?? [];

  const selectedProductTitle = useMemo(() => {
    return products.find((product) => product.id === productGid)?.title ?? "";
  }, [products, productGid]);

  return (
    <s-page heading="FilamentSync MVP">
      <s-section heading="Produkt laden">
        <s-stack direction="block" gap="base">
          <label htmlFor="product-picker">Produkt</label>
          <select
            id="product-picker"
            value={productGid}
            onChange={(event) => setProductGid(event.currentTarget.value)}
            style={{
              width: "100%",
              padding: "8px 10px",
              borderRadius: "8px",
              border: "1px solid #c9cccf",
              background: "#fff",
            }}
          >
            {products.length === 0 ? (
              <option value="">Keine Produkte gefunden</option>
            ) : (
              products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.title}
                </option>
              ))
            )}
          </select>
          <s-paragraph>
            <strong>Ausgewaehlt:</strong> {selectedProductTitle || "-"}
          </s-paragraph>
          <s-stack direction="inline" gap="base">
            <s-button
              type="button"
              onClick={() => submit("load")}
              {...(isLoading ? { loading: true } : {})}
              disabled={!productGid}
            >
              Produkt laden
            </s-button>
            <s-button
              type="button"
              variant="secondary"
              onClick={() => submit("preview")}
              {...(isLoading ? { loading: true } : {})}
              disabled={!productGid}
            >
              Vorschau berechnen
            </s-button>
            <s-button
              type="button"
              variant="primary"
              onClick={() => submit("sync")}
              {...(isLoading ? { loading: true } : {})}
              disabled={!productGid}
            >
              Varianten synchronisieren
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>

      {data?.notices?.length ? (
        <s-section heading="Hinweise">
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <ul style={{ margin: 0, paddingLeft: "20px" }}>
              {data.notices.map((notice) => (
                <li key={notice}>{notice}</li>
              ))}
            </ul>
          </s-box>
        </s-section>
      ) : null}

      {data?.errors?.length ? (
        <s-section heading="Fehler">
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <ul style={{ margin: 0, paddingLeft: "20px" }}>
              {data.errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </s-box>
        </s-section>
      ) : null}

      {data?.product ? (
        <s-section heading="Produktdaten">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              <strong>Titel:</strong> {data.product.title}
            </s-paragraph>

            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-heading>Optionen</s-heading>
              {data.product.options.length === 0 ? (
                <s-paragraph>Keine Optionen vorhanden.</s-paragraph>
              ) : (
                <ul style={{ margin: "8px 0 0", paddingLeft: "20px" }}>
                  {data.product.options.map((option) => (
                    <li key={option.name}>
                      <strong>{option.name}:</strong>{" "}
                      {option.values.length ? option.values.join(", ") : "Keine Werte"}
                    </li>
                  ))}
                </ul>
              )}
            </s-box>

            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-heading>Varianten</s-heading>
              {data.product.variants.length === 0 ? (
                <s-paragraph>Keine Varianten vorhanden.</s-paragraph>
              ) : (
                <ul style={{ margin: "8px 0 0", paddingLeft: "20px" }}>
                  {data.product.variants.map((variant) => (
                    <li key={variant.id}>
                      {variant.title} ({variant.selectedOptions
                        .map(
                          (selectedOption) =>
                            `${selectedOption.name}: ${selectedOption.value}`,
                        )
                        .join(" | ")})
                    </li>
                  ))}
                </ul>
              )}
            </s-box>
          </s-stack>
        </s-section>
      ) : null}

      {data?.product ? (
        <s-section heading="Materialprofile (custom.materialprofil*)">
          {data.materialProfiles.length === 0 ? (
            <s-paragraph>Keine Materialprofile aufloesbar.</s-paragraph>
          ) : (
            <s-stack direction="block" gap="base">
              {data.materialProfiles.map((profile) => (
                <s-box
                  key={profile.metafieldKey}
                  padding="base"
                  borderWidth="base"
                  borderRadius="base"
                >
                  <s-paragraph>
                    <strong>Metafield:</strong> {MATERIAL_PROFILE_NAMESPACE}.
                    {profile.metafieldKey}
                  </s-paragraph>
                  <s-paragraph>
                    <strong>Metaobject:</strong> {profile.displayName ?? profile.id} ({profile.type})
                  </s-paragraph>
                  <s-paragraph>
                    <strong>Zieloption:</strong> {getColorOptionName(profile.metafieldKey)}
                  </s-paragraph>
                  <s-heading>Farben</s-heading>
                  {profile.colors.length === 0 ? (
                    <s-paragraph>Keine Farben im Feld farben gefunden.</s-paragraph>
                  ) : (
                    <ul style={{ margin: "8px 0 0", paddingLeft: "20px" }}>
                      {profile.colors.map((color) => (
                        <li key={`${profile.metafieldKey}-${color.id}`}>
                          <strong>{color.name}</strong>
                          {color.colorValue ? ` - ${color.colorValue}` : " - Kein Farbwert"}
                        </li>
                      ))}
                    </ul>
                  )}
                </s-box>
              ))}
            </s-stack>
          )}
        </s-section>
      ) : null}

      {previews.length > 0 ? (
        <s-section
          heading={
            data?.mode === "sync"
              ? "Ergebnis Varianten synchronisieren"
              : "Preview Varianten synchronisieren"
          }
        >
          <s-stack direction="block" gap="base">
            {previews.map((preview) => (
              <s-box
                key={preview.optionName}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-paragraph>
                  <strong>Option:</strong> {preview.optionName}
                </s-paragraph>
                <s-paragraph>
                  <strong>Bestehende Werte:</strong>{" "}
                  {preview.existingValues.length ? preview.existingValues.join(", ") : "Keine"}
                </s-paragraph>
                <s-paragraph>
                  <strong>Zielwerte aus Materialprofil:</strong>{" "}
                  {preview.desiredValues.length ? preview.desiredValues.join(", ") : "Keine"}
                </s-paragraph>
                <s-heading>Zu erzeugende Varianten</s-heading>
                {preview.variantsToCreate.length === 0 ? (
                  <s-paragraph>Keine neuen Varianten noetig.</s-paragraph>
                ) : (
                  <ul style={{ margin: "8px 0 0", paddingLeft: "20px" }}>
                    {preview.variantsToCreate.map((variant) => (
                      <li key={`${preview.optionName}-${variant.optionValue}`}>
                        {preview.optionName}: {variant.optionValue}
                      </li>
                    ))}
                  </ul>
                )}
              </s-box>
            ))}
          </s-stack>
        </s-section>
      ) : null}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
