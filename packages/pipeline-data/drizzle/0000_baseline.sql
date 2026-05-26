CREATE TABLE "compliance_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar(255) NOT NULL,
	"user_id" text NOT NULL,
	"target" varchar(20) NOT NULL,
	"action" varchar(20) NOT NULL,
	"entity_id" varchar(255),
	"entity_name" varchar(255),
	"result" varchar(10) NOT NULL,
	"violations" jsonb DEFAULT '[]'::jsonb,
	"rule_count" integer NOT NULL,
	"scan_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compliance_exemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar(255) NOT NULL,
	"rule_id" uuid NOT NULL,
	"entity_type" varchar(20) NOT NULL,
	"entity_id" uuid NOT NULL,
	"entity_name" varchar(255),
	"reason" text NOT NULL,
	"approved_by" text,
	"rejection_reason" text,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compliance_notification_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar(255) NOT NULL,
	"channel" varchar(20) NOT NULL,
	"status" varchar(20) NOT NULL,
	"payload" jsonb NOT NULL,
	"webhook_response_code" integer,
	"webhook_error" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"related_audit_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compliance_notification_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar(255) NOT NULL,
	"notify_on_block" boolean DEFAULT true NOT NULL,
	"notify_on_warning" boolean DEFAULT false NOT NULL,
	"digest_mode" varchar(20) DEFAULT 'immediate' NOT NULL,
	"digest_schedule" varchar(100),
	"last_digest_at" timestamp with time zone,
	"target_users" jsonb,
	"webhook_url" varchar(500),
	"webhook_secret" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compliance_notification_preferences_org_id_unique" UNIQUE("org_id")
);
--> statement-breakpoint
CREATE TABLE "compliance_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar(255) DEFAULT 'system' NOT NULL,
	"created_by" text DEFAULT 'system' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text DEFAULT 'system' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"version" varchar(50) DEFAULT '1.0.0' NOT NULL,
	"is_template" boolean DEFAULT false NOT NULL,
	"access_modifier" varchar(10) DEFAULT 'private' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" text
);
--> statement-breakpoint
CREATE TABLE "compliance_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar(255) NOT NULL,
	"report_type" varchar(30) NOT NULL,
	"target" varchar(20) NOT NULL,
	"date_from" timestamp with time zone,
	"date_to" timestamp with time zone,
	"compare_from" timestamp with time zone,
	"compare_to" timestamp with time zone,
	"data" jsonb NOT NULL,
	"format" varchar(10) DEFAULT 'json' NOT NULL,
	"generated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compliance_report_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar(255) NOT NULL,
	"report_type" varchar(30) NOT NULL,
	"target" varchar(20) NOT NULL,
	"format" varchar(10) DEFAULT 'json' NOT NULL,
	"cron_expression" varchar(100) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"deliver_to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compliance_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar(255) NOT NULL,
	"user_id" text NOT NULL,
	"role" varchar(30) NOT NULL,
	"granted_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compliance_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar(255) DEFAULT 'system' NOT NULL,
	"created_by" text DEFAULT 'system' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text DEFAULT 'system' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"policy_id" uuid,
	"priority" integer DEFAULT 0 NOT NULL,
	"target" varchar(20) NOT NULL,
	"severity" varchar(10) DEFAULT 'error' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"effective_from" timestamp with time zone,
	"effective_until" timestamp with time zone,
	"scope" varchar(10) DEFAULT 'org' NOT NULL,
	"forked_from_rule_id" uuid,
	"suppress_notification" boolean DEFAULT false NOT NULL,
	"field" varchar(100),
	"operator" varchar(20),
	"value" jsonb,
	"conditions" jsonb,
	"condition_mode" varchar(5) DEFAULT 'all',
	"access_modifier" varchar(10) DEFAULT 'private' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" text
);
--> statement-breakpoint
CREATE TABLE "compliance_rule_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_id" uuid NOT NULL,
	"org_id" varchar(255) NOT NULL,
	"change_type" varchar(20) NOT NULL,
	"previous_state" jsonb,
	"changed_by" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compliance_rule_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar(255) NOT NULL,
	"rule_id" uuid NOT NULL,
	"subscribed_by" text NOT NULL,
	"subscribed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"pinned_version" jsonb,
	"unsubscribed_at" timestamp with time zone,
	"unsubscribed_by" text
);
--> statement-breakpoint
CREATE TABLE "compliance_scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar(255) NOT NULL,
	"target" varchar(20) NOT NULL,
	"filter" jsonb,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"triggered_by" varchar(20) NOT NULL,
	"user_id" text NOT NULL,
	"total_entities" integer DEFAULT 0 NOT NULL,
	"processed_entities" integer DEFAULT 0 NOT NULL,
	"pass_count" integer DEFAULT 0 NOT NULL,
	"warn_count" integer DEFAULT 0 NOT NULL,
	"block_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compliance_scan_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar(255) NOT NULL,
	"target" varchar(20) NOT NULL,
	"cron_expression" varchar(100) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dashboards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar(255) DEFAULT 'system' NOT NULL,
	"created_by" text DEFAULT 'system' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text DEFAULT 'system' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" varchar(150) NOT NULL,
	"description" text,
	"layout_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"visibility" varchar(10) DEFAULT 'private' NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" text
);
--> statement-breakpoint
CREATE TABLE "dashboard_panels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dashboard_id" uuid NOT NULL,
	"query_key" varchar(100) NOT NULL,
	"viz_kind" varchar(30) DEFAULT 'line' NOT NULL,
	"title" varchar(200) NOT NULL,
	"span" integer DEFAULT 6 NOT NULL,
	"group_by" varchar(50),
	"format" varchar(20),
	"position" integer DEFAULT 0 NOT NULL,
	"vars" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar(255) DEFAULT 'system' NOT NULL,
	"created_by" text DEFAULT 'system' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text DEFAULT 'system' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"thread_id" uuid,
	"recipient_org_id" varchar(255) NOT NULL,
	"message_type" varchar(20) DEFAULT 'conversation' NOT NULL,
	"subject" varchar(500) NOT NULL,
	"content" text NOT NULL,
	"read_by" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"priority" varchar(20) DEFAULT 'normal' NOT NULL,
	"access_modifier" varchar(10) DEFAULT 'private' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" text
);
--> statement-breakpoint
CREATE TABLE "org_alert_destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar(255) NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"channel" varchar(20) NOT NULL,
	"target" text DEFAULT '' NOT NULL,
	"label" varchar(100) NOT NULL,
	"min_severity" varchar(10) DEFAULT 'warning' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" text
);
--> statement-breakpoint
CREATE TABLE "org_alert_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar(255) NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" varchar(100) NOT NULL,
	"expr" text NOT NULL,
	"for_duration" varchar(20) DEFAULT '5m' NOT NULL,
	"severity" varchar(20) DEFAULT 'warning' NOT NULL,
	"summary" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" text
);
--> statement-breakpoint
CREATE TABLE "pipelines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar(255) DEFAULT 'system' NOT NULL,
	"created_by" text DEFAULT 'system' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text DEFAULT 'system' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project" varchar(255) NOT NULL,
	"organization" varchar(255) NOT NULL,
	"pipeline_name" varchar(255),
	"description" text,
	"keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"props" jsonb NOT NULL,
	"access_modifier" varchar(10) DEFAULT 'private' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" text
);
--> statement-breakpoint
CREATE TABLE "pipeline_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pipeline_id" uuid,
	"org_id" varchar(255) NOT NULL,
	"event_source" varchar(50) NOT NULL,
	"event_type" varchar(50) NOT NULL,
	"status" varchar(20) NOT NULL,
	"pipeline_arn" varchar(512),
	"execution_id" varchar(255),
	"stage_name" varchar(255),
	"action_name" varchar(255),
	"error_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"duration_ms" integer,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_registry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"org_id" varchar(255) NOT NULL,
	"pipeline_arn" varchar(512) NOT NULL,
	"pipeline_name" varchar(255) NOT NULL,
	"account_id" varchar(12),
	"region" varchar(30),
	"project" varchar(255),
	"organization" varchar(255),
	"last_deployed" timestamp with time zone,
	"stack_name" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_registry_pipeline_arn_unique" UNIQUE("pipeline_arn")
);
--> statement-breakpoint
CREATE TABLE "plugins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar(255) DEFAULT 'system' NOT NULL,
	"created_by" text DEFAULT 'system' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text DEFAULT 'system' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" varchar(50) DEFAULT '1.0.0' NOT NULL,
	"category" varchar(50) DEFAULT 'unknown' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"plugin_type" varchar(50) DEFAULT 'CodeBuildStep' NOT NULL,
	"compute_type" varchar(50) DEFAULT 'SMALL' NOT NULL,
	"timeout" integer,
	"failure_behavior" varchar(10) DEFAULT 'fail' NOT NULL,
	"secrets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"primary_output_directory" varchar(28),
	"env" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"build_args" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"install_commands" text[] DEFAULT '{}' NOT NULL,
	"commands" text[] DEFAULT '{}' NOT NULL,
	"dockerfile" text,
	"build_type" varchar(20) DEFAULT 'build_image' NOT NULL,
	"access_modifier" varchar(10) DEFAULT 'private' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" text,
	CONSTRAINT "plugin_version_check" CHECK ("plugins"."version" ~ '^[0-9]+.[0-9]+.[0-9]+(-[a-zA-Z0-9.-]+)?(+[a-zA-Z0-9.-]+)?$')
);
--> statement-breakpoint
ALTER TABLE "compliance_exemptions" ADD CONSTRAINT "compliance_exemptions_rule_id_compliance_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."compliance_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_rules" ADD CONSTRAINT "compliance_rules_policy_id_compliance_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."compliance_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_rule_history" ADD CONSTRAINT "compliance_rule_history_rule_id_compliance_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."compliance_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_rule_subscriptions" ADD CONSTRAINT "compliance_rule_subscriptions_rule_id_compliance_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."compliance_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "compliance_audit_org_created_idx" ON "compliance_audit_log" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "compliance_audit_org_target_result_idx" ON "compliance_audit_log" USING btree ("org_id","target","result");--> statement-breakpoint
CREATE INDEX "compliance_audit_scan_id_idx" ON "compliance_audit_log" USING btree ("scan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "compliance_exemption_org_rule_entity_unique" ON "compliance_exemptions" USING btree ("org_id","rule_id","entity_id");--> statement-breakpoint
CREATE INDEX "compliance_exemption_org_status_idx" ON "compliance_exemptions" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "compliance_exemption_expires_at_idx" ON "compliance_exemptions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "compliance_exemption_entity_id_idx" ON "compliance_exemptions" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "compliance_notification_org_created_idx" ON "compliance_notification_log" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "compliance_notification_status_retry_idx" ON "compliance_notification_log" USING btree ("status","next_retry_at");--> statement-breakpoint
CREATE INDEX "compliance_notification_related_audit_idx" ON "compliance_notification_log" USING btree ("related_audit_id");--> statement-breakpoint
CREATE INDEX "compliance_policy_org_active_idx" ON "compliance_policies" USING btree ("org_id","is_active");--> statement-breakpoint
CREATE INDEX "compliance_policy_template_idx" ON "compliance_policies" USING btree ("is_template");--> statement-breakpoint
CREATE UNIQUE INDEX "compliance_policy_name_org_version_unique" ON "compliance_policies" USING btree ("org_id","name","version");--> statement-breakpoint
CREATE INDEX "compliance_report_org_created_idx" ON "compliance_reports" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "compliance_report_schedule_active_next_idx" ON "compliance_report_schedules" USING btree ("is_active","next_run_at");--> statement-breakpoint
CREATE INDEX "compliance_report_schedule_org_idx" ON "compliance_report_schedules" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "compliance_role_org_user_unique" ON "compliance_roles" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "compliance_role_org_role_idx" ON "compliance_roles" USING btree ("org_id","role");--> statement-breakpoint
CREATE INDEX "compliance_rule_org_target_active_idx" ON "compliance_rules" USING btree ("org_id","target","is_active");--> statement-breakpoint
CREATE INDEX "compliance_rule_org_policy_idx" ON "compliance_rules" USING btree ("org_id","policy_id");--> statement-breakpoint
CREATE INDEX "compliance_rule_priority_idx" ON "compliance_rules" USING btree ("priority");--> statement-breakpoint
CREATE INDEX "compliance_rule_scope_idx" ON "compliance_rules" USING btree ("scope");--> statement-breakpoint
CREATE INDEX "compliance_rule_effective_from_idx" ON "compliance_rules" USING btree ("effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "compliance_rule_name_org_unique" ON "compliance_rules" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "compliance_rule_history_rule_changed_idx" ON "compliance_rule_history" USING btree ("rule_id","changed_at");--> statement-breakpoint
CREATE INDEX "compliance_rule_history_org_changed_idx" ON "compliance_rule_history" USING btree ("org_id","changed_at");--> statement-breakpoint
CREATE INDEX "compliance_rule_history_rule_id_idx" ON "compliance_rule_history" USING btree ("rule_id");--> statement-breakpoint
CREATE UNIQUE INDEX "compliance_rule_sub_org_rule_unique" ON "compliance_rule_subscriptions" USING btree ("org_id","rule_id");--> statement-breakpoint
CREATE INDEX "compliance_rule_sub_org_active_idx" ON "compliance_rule_subscriptions" USING btree ("org_id","is_active");--> statement-breakpoint
CREATE INDEX "compliance_rule_sub_rule_idx" ON "compliance_rule_subscriptions" USING btree ("rule_id");--> statement-breakpoint
CREATE INDEX "compliance_scan_org_created_idx" ON "compliance_scans" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "compliance_scan_org_status_idx" ON "compliance_scans" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "compliance_scan_schedule_active_next_idx" ON "compliance_scan_schedules" USING btree ("is_active","next_run_at");--> statement-breakpoint
CREATE INDEX "compliance_scan_schedule_org_idx" ON "compliance_scan_schedules" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "dashboard_org_visibility_idx" ON "dashboards" USING btree ("org_id","visibility");--> statement-breakpoint
CREATE INDEX "dashboard_created_by_idx" ON "dashboards" USING btree ("created_by");--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_org_name_unique" ON "dashboards" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "dashboard_panel_dashboard_position_idx" ON "dashboard_panels" USING btree ("dashboard_id","position");--> statement-breakpoint
CREATE INDEX "message_org_id_idx" ON "messages" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "message_recipient_org_id_idx" ON "messages" USING btree ("recipient_org_id");--> statement-breakpoint
CREATE INDEX "message_thread_id_idx" ON "messages" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "message_message_type_idx" ON "messages" USING btree ("message_type");--> statement-breakpoint
CREATE INDEX "message_created_at_idx" ON "messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "message_active_idx" ON "messages" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "message_recipient_active_created_idx" ON "messages" USING btree ("recipient_org_id","is_active","created_at");--> statement-breakpoint
CREATE INDEX "message_org_active_idx" ON "messages" USING btree ("org_id","is_active");--> statement-breakpoint
CREATE INDEX "org_alert_destination_org_idx" ON "org_alert_destinations" USING btree ("org_id","enabled");--> statement-breakpoint
CREATE INDEX "org_alert_rule_org_enabled_idx" ON "org_alert_rules" USING btree ("org_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "org_alert_rule_org_name_uq" ON "org_alert_rules" USING btree ("org_id","name") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "pipeline_project_idx" ON "pipelines" USING btree ("project");--> statement-breakpoint
CREATE INDEX "pipeline_organization_idx" ON "pipelines" USING btree ("organization");--> statement-breakpoint
CREATE INDEX "pipeline_org_id_idx" ON "pipelines" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "pipeline_active_idx" ON "pipelines" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "pipeline_created_at_idx" ON "pipelines" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "pipeline_updated_at_idx" ON "pipelines" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "pipeline_org_active_idx" ON "pipelines" USING btree ("org_id","is_active");--> statement-breakpoint
CREATE INDEX "pipeline_org_access_active_idx" ON "pipelines" USING btree ("org_id","access_modifier","is_active");--> statement-breakpoint
CREATE INDEX "pipeline_active_only_org_idx" ON "pipelines" USING btree ("org_id","created_at") WHERE is_active = true;--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_project_org_unique" ON "pipelines" USING btree ("project","organization","org_id");--> statement-breakpoint
CREATE INDEX "event_pipeline_id_idx" ON "pipeline_events" USING btree ("pipeline_id");--> statement-breakpoint
CREATE INDEX "event_org_id_idx" ON "pipeline_events" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "event_type_idx" ON "pipeline_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "event_status_idx" ON "pipeline_events" USING btree ("status");--> statement-breakpoint
CREATE INDEX "event_pipeline_arn_idx" ON "pipeline_events" USING btree ("pipeline_arn");--> statement-breakpoint
CREATE INDEX "event_execution_id_idx" ON "pipeline_events" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "event_created_at_idx" ON "pipeline_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "event_org_type_created_idx" ON "pipeline_events" USING btree ("org_id","event_type","created_at");--> statement-breakpoint
CREATE INDEX "event_org_source_status_idx" ON "pipeline_events" USING btree ("org_id","event_source","status");--> statement-breakpoint
CREATE INDEX "registry_pipeline_id_idx" ON "pipeline_registry" USING btree ("pipeline_id");--> statement-breakpoint
CREATE INDEX "registry_org_id_idx" ON "pipeline_registry" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "registry_org_region_idx" ON "pipeline_registry" USING btree ("org_id","region");--> statement-breakpoint
CREATE INDEX "plugin_name_idx" ON "plugins" USING btree ("name");--> statement-breakpoint
CREATE INDEX "plugin_org_id_idx" ON "plugins" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "plugin_version_idx" ON "plugins" USING btree ("version");--> statement-breakpoint
CREATE INDEX "plugin_active_idx" ON "plugins" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "plugin_created_at_idx" ON "plugins" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "plugin_updated_at_idx" ON "plugins" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "plugin_category_idx" ON "plugins" USING btree ("category");--> statement-breakpoint
CREATE INDEX "plugin_org_active_idx" ON "plugins" USING btree ("org_id","is_active");--> statement-breakpoint
CREATE INDEX "plugin_org_access_active_idx" ON "plugins" USING btree ("org_id","access_modifier","is_active");--> statement-breakpoint
CREATE INDEX "plugin_active_only_org_idx" ON "plugins" USING btree ("org_id","created_at") WHERE is_active = true;--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_name_version_org_unique" ON "plugins" USING btree ("name","version","org_id");