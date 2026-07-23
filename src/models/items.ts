import { z } from "@hono/zod-openapi";

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
    price: z.number().min(0).openapi({
      description: "Item price in USD",
      example: 29.99,
    }),
    in_stock: z.boolean().openapi({
      description: "Availability status",
      example: true,
    }),
    created_at: z.iso.datetime({ precision: 3 }).openapi({
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

export const ItemListSchema = z
  .object({
    items: z.array(ItemSchema).openapi({
      description: "List of items in the current page",
    }),
    total: z.number().int().min(0).openapi({
      description: "Total number of items matching the filter",
      example: 30,
    }),
  })
  .strict()
  .openapi("ItemList");

export type ItemCategory = z.infer<typeof ItemCategorySchema>;
export type Item = z.infer<typeof ItemSchema>;
export type ItemList = z.infer<typeof ItemListSchema>;
