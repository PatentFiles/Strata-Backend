import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const liveNotificationEventTable = pgTable("live_notification_events", {
  id: text("id").primaryKey(),
  eventType: text("event_type").notNull(),
  severity: text("severity").notNull().default("INFO"),
  message: text("message").notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("live_notification_events_created_at").on(table.createdAt),
  check("live_notification_events_type_check", sql`${table.eventType} IN ('API','FEED','RISK','KILL','ENTRY','EXIT')`),
  check("live_notification_events_severity_check", sql`${table.severity} IN ('INFO','WARN','ERROR')`),
]);

export const insertLiveNotificationEventSchema = createInsertSchema(liveNotificationEventTable);
export type LiveNotificationEvent = typeof liveNotificationEventTable.$inferSelect;
export type InsertLiveNotificationEvent = z.infer<typeof insertLiveNotificationEventSchema>;