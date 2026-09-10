CREATE INDEX "model_sort" ON "model" USING btree ("sort_order","created_at");--> statement-breakpoint
CREATE INDEX "cac_sort" ON "chat_api_config" USING btree ("sort_order","created_at");