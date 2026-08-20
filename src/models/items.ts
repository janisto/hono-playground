import { z } from "@hono/zod-openapi";
import { JsonApiLinkSchema, JsonApiObjectSchema } from "./json-api.ts";
import { BoundedNameSchema, OpaqueIdSchema, SafeIntegerSchema, TimestampSchema } from "./portable.ts";

export const ITEM_CATEGORIES = ["electronics", "tools", "accessories", "robotics", "power", "components"] as const;

export const ItemCategorySchema = z.enum(ITEM_CATEGORIES);

const itemFields = {
  id: OpaqueIdSchema.openapi({
    description: "Unique item identifier",
    example: "item-001",
  }),
  name: BoundedNameSchema.openapi({
    description: "Item name",
    example: "Alpha Widget",
  }),
  category: ItemCategorySchema.openapi({
    description: "Item category",
    example: "electronics",
  }),
  price: z
    .strictObject({
      amountMinor: SafeIntegerSchema,
      currency: z.literal("USD"),
    })
    .openapi("Money", { example: { amountMinor: 2999, currency: "USD" } }),
  inStock: z.boolean().openapi({
    description: "Availability status",
    example: true,
  }),
  description: z.string().min(1).max(500).openapi({
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
    price: itemFields.price,
    inStock: itemFields.inStock,
    createdAt: TimestampSchema.openapi({
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
    data: z.array(ItemResourceSchema).max(100).openapi({
      description: "Items in the current page",
    }),
    meta: z.strictObject({
      total: SafeIntegerSchema.openapi({
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
