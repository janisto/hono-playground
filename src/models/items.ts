import { z } from "@hono/zod-openapi";
import { JsonApiLinkSchema, JsonApiObjectSchema } from "./json-api.js";

export const ITEM_CATEGORIES = [
  "electronics",
  "tools",
  "accessories",
  "robotics",
  "power",
  "components",
] as const;

export const ItemCategorySchema = z.enum(ITEM_CATEGORIES);

export const ItemSchema = z
  .object({
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
    priceCents: z.number().int().min(0).openapi({
      description: "Item price in US cents",
      example: 2999,
    }),
    inStock: z.boolean().openapi({
      description: "Availability status",
      example: true,
    }),
    createdAt: z.iso.datetime({ precision: 3 }).openapi({
      description: "Creation timestamp",
      example: "2024-01-15T10:30:00.000Z",
    }),
    description: z.string().openapi({
      description: "Detailed description of the item",
      example: "A versatile electronic widget for everyday use",
    }),
  })
  .strict()
  .openapi("Item");

export const ItemAttributesSchema = ItemSchema.omit({ id: true }).openapi("ItemAttributes");

export const ItemResourceSchema = z
  .object({
    type: z.literal("items"),
    id: ItemSchema.shape.id,
    attributes: ItemAttributesSchema,
    links: z.object({ self: JsonApiLinkSchema }).strict(),
  })
  .strict()
  .openapi("ItemResource");

export const ItemDocumentSchema = z
  .object({
    jsonapi: JsonApiObjectSchema,
    links: z
      .object({
        self: JsonApiLinkSchema,
      })
      .strict(),
    data: ItemResourceSchema,
  })
  .strict()
  .openapi("ItemDocument");

export const ItemCollectionDocumentSchema = z
  .object({
    jsonapi: JsonApiObjectSchema,
    links: z
      .object({
        self: JsonApiLinkSchema,
        next: JsonApiLinkSchema.optional(),
        prev: JsonApiLinkSchema.optional(),
      })
      .strict(),
    data: z.array(ItemResourceSchema).openapi({
      description: "Items in the current page",
    }),
    meta: z
      .object({
        total: z.number().int().min(0).openapi({
          description: "Total number of items matching the filter",
          example: 30,
        }),
      })
      .strict(),
  })
  .strict()
  .openapi("ItemCollectionDocument");

export type ItemCategory = z.infer<typeof ItemCategorySchema>;
export type Item = z.infer<typeof ItemSchema>;
export type ItemResource = z.infer<typeof ItemResourceSchema>;
export type ItemDocument = z.infer<typeof ItemDocumentSchema>;
export type ItemCollectionDocument = z.infer<typeof ItemCollectionDocumentSchema>;
