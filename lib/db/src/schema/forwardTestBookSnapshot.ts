import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/** Historical, append-only research receipts. Never joined into live order admission.
 * REST snapshots are captured AFTER a paper event, so never label as execution
 * time or actual available historical depth. */
export const forwardTestBookSnapshotTable=pgTable("forward_test_book_snapshots",{
 id:text("id").primaryKey(),
 engineId:text("engine_id").notNull(),
 paperPositionId:text("paper_position_id").notNull(),
 marketTicker:text("market_ticker").notNull(),
 phase:text("phase").notNull(),
 positionDirection:text("position_direction").notNull(),
 requestedContracts:integer("requested_contracts").notNull(),
 eventAt:timestamp("event_at",{withTimezone:true}).notNull(),
 startedAt:timestamp("started_at",{withTimezone:true}).notNull(),
 receivedAt:timestamp("received_at",{withTimezone:true}),
 status:text("status").notNull(),
 bidLevels:jsonb("bid_levels").$type<{yes:Array<{priceTicks:number;contractsHundredths:number}>;no:Array<{priceTicks:number;contractsHundredths:number}>}>(),
 capacity:jsonb("capacity").$type<{requestedContracts:number;modeledFilledContracts:number;modeledUnfilledContracts:number;modeledCashMicros:string;modeledAveragePriceTicks:number|null;bestPriceTicks:number|null;usedPriceLevels:number;interpretation:"BOOK_CAPACITY_ONLY_NOT_EXECUTION";observationPhase?:"PRE_QUALIFICATION"|"POST_ACTION";sourceEvaluationId?:string;quoteEvidence?:unknown}>(),
 errorCode:text("error_code"),
 createdAt:timestamp("created_at",{withTimezone:true}).notNull().defaultNow(),
},t=>[
 uniqueIndex("paper_book_unique_position_phase").on(t.paperPositionId,t.phase),
 check("paper_book_phase_check",sql`${t.phase} IN ('ENTRY','EXIT')`),
 check("paper_book_status_check",sql`${t.status} IN ('CAPTURED','UNAVAILABLE')`),
 check("paper_book_direction_check",sql`${t.positionDirection} IN ('UP','DOWN')`),
 check("paper_book_quantity_check",sql`${t.requestedContracts} BETWEEN 1 AND 1000000`),
]);
