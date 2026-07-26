import { z } from "@hono/zod-openapi";
import { JsonApiLinkSchema, JsonApiObjectSchema } from "./json-api.js";

export const ITEM_CATEGORIES = ["electronics", "tools", "accessories", "robotics", "power", "components"] as const;

export const ItemCategorySchema = z.enum(ITEM_CATEGORIES);

const itemFields = {
  id: z.string().openapi({
    description: "Unique item identifier",
    example: "item-001",
  }),
  name: z.string().openapi({
    description: "Item name",
    example: "Alpha Widget",
  }),
  category: ItemCategorySchema.openapi({
    description: "Item category",
    example: "electronics",
  }),
  priceCents: z.int().min(0).openapi({
    description: "Item price in US cents",
    example: 2999,
  }),
  inStock: z.boolean().openapi({
    description: "Availability status",
    example: true,
  }),
  description: z.string().openapi({
    description: "Detailed description of the item",
    example: "A versatile electronic widget for everyday use",
  }),
};

export const ItemSchema = z.strictObject({
  ...itemFields,
  createdAt: z.date(),
});

export const ItemAttributesSchema = z
  .strictObject({
    name: itemFields.name,
    category: itemFields.category,
    priceCents: itemFields.priceCents,
    inStock: itemFields.inStock,
    createdAt: z.iso.datetime({ precision: 3 }).openapi({
      description: "Creation timestamp",
      example: "2024-01-15T10:30:00.000Z",
    }),
    description: itemFields.description,
  })
  .openapi("ItemAttributes");

export const ItemResourceSchema = z
  .strictObject({
    type: z.literal("items"),
    id: ItemSchema.shape.id,
    attributes: ItemAttributesSchema,
    links: z.strictObject({ self: JsonApiLinkSchema }),
  })
  .openapi("ItemResource");

export const ItemDocumentSchema = z
  .strictObject({
    jsonapi: JsonApiObjectSchema,
    links: z.strictObject({
      self: JsonApiLinkSchema,
    }),
    data: ItemResourceSchema,
  })
  .openapi("ItemDocument");

export const ItemCollectionDocumentSchema = z
  .strictObject({
    jsonapi: JsonApiObjectSchema,
    links: z.strictObject({
      self: JsonApiLinkSchema,
      next: JsonApiLinkSchema.optional(),
      prev: JsonApiLinkSchema.optional(),
    }),
    data: z.array(ItemResourceSchema).openapi({
      description: "Items in the current page",
    }),
    meta: z.strictObject({
      total: z.int().min(0).openapi({
        description: "Total number of items matching the filter",
        example: 30,
      }),
    }),
  })
  .openapi("ItemCollectionDocument");

export type ItemCategory = z.infer<typeof ItemCategorySchema>;
export type Item = z.infer<typeof ItemSchema>;
export type ItemResource = z.infer<typeof ItemResourceSchema>;
export type ItemDocument = z.infer<typeof ItemDocumentSchema>;
export type ItemCollectionDocument = z.infer<typeof ItemCollectionDocumentSchema>;
